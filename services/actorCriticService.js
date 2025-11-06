// services/actorCriticService.js (phiên bản đầy đủ)
const tf = require('@tensorflow/tfjs-node');
const { Storage } = require('@google-cloud/storage');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const { DateTime } = require('luxon');

// --- Cấu hình GCS ---
const gcsCredentialsJSON = process.env.GCS_CREDENTIALS;
const bucketName = process.env.GCS_BUCKET_NAME;
let storage, bucket;
if (gcsCredentialsJSON && bucketName) {
    try {
        const credentials = JSON.parse(gcsCredentialsJSON);
        storage = new Storage({ credentials, projectId: credentials.project_id });
        bucket = storage.bucket(bucketName);
        console.log(`✅ [GCS] Đã khởi tạo GCS cho Actor-Critic Service.`);
    } catch (error) { console.error("❌ [GCS] Lỗi khởi tạo GCS.", error); process.exit(1); }
} else {
    console.warn("⚠️ [GCS] Cảnh báo: Biến môi trường GCS chưa được thiết lập.");
}

// --- Các Hằng Số ---
const ACTOR_MODEL_NAME = 'AC_ACTOR_V1';
const CRITIC_MODEL_NAME = 'AC_CRITIC_V1';
const SEQUENCE_LENGTH = 7;
const FEATURE_SIZE = 346;
const STATE_SHAPE = [SEQUENCE_LENGTH, FEATURE_SIZE];
const OUTPUT_NODES = 50;

// --- Hyperparameters cho RL ---
const GAMMA = 0.99;
const ACTOR_LR = 0.0001;
const CRITIC_LR = 0.0005;

// --- Custom GCS IO Handler ---
const getGcsIoHandler = (modelPath) => {
    if (!bucket) throw new Error("GCS Bucket chưa được khởi tạo.");
    const modelJsonPath = `${modelPath}/model.json`;
    const weightsBinPath = `${modelPath}/weights.bin`;
    return {
        save: async (modelArtifacts) => {
            const weightsBuffer = Buffer.from(modelArtifacts.weightData);
            await Promise.all([
                bucket.file(modelJsonPath).save(JSON.stringify(modelArtifacts.modelTopology)),
                bucket.file(weightsBinPath).save(weightsBuffer)
            ]);
            return { modelArtifactsInfo: { dateSaved: new Date() } };
        },
        load: async () => {
            const [modelJsonFile, weightsBinFile] = await Promise.all([
                bucket.file(modelJsonPath).download(),
                bucket.file(weightsBinPath).download()
            ]);
            const modelTopology = JSON.parse(modelJsonFile[0].toString());
            const weightData = weightsBinFile[0].buffer;
            return { modelTopology, weightData };
        }
    };
};

class ActorCriticService {
    constructor() {
        this.actor = null;
        this.critic = null;
        this.inputNodes = FEATURE_SIZE;
        this.featureService = new FeatureEngineeringService();
        this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
        this.isInitialized = false;
    }

    // =================================================================
    // 1. XÂY DỰNG & LƯU/TẢI MÔ HÌNH
    // =================================================================
    buildActor() {
        const model = tf.sequential();
        model.add(tf.layers.lstm({ units: 64, inputShape: STATE_SHAPE, returnSequences: false }));
        model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
        model.add(tf.layers.dense({ units: OUTPUT_NODES, activation: 'softmax' }));
        this.actor = model;
        console.log("✅ Actor model built.");
    }

    buildCritic() {
        const model = tf.sequential();
        model.add(tf.layers.lstm({ units: 64, inputShape: STATE_SHAPE, returnSequences: false }));
        model.add(tf.layers.dense({ units: 32, activation: 'relu' }));
        model.add(tf.layers.dense({ units: 1, activation: 'tanh' }));
        this.critic = model;
        console.log("✅ Critic model built.");
    }
    
    async saveModels() {
        if (!this.actor || !this.critic) throw new Error("Models not built.");
        console.log("💾 [AC Save] Saving Actor and Critic models to GCS...");
        await Promise.all([
            this.actor.save(getGcsIoHandler(`models/${ACTOR_MODEL_NAME}`)),
            this.critic.save(getGcsIoHandler(`models/${CRITIC_MODEL_NAME}`))
        ]);
        await NNState.findOneAndUpdate(
            { modelName: ACTOR_MODEL_NAME },
            { state: { savedAt: new Date(), gcsPath: `gs://${bucketName}/models/${ACTOR_MODEL_NAME}` } },
            { upsert: true }
        );
        console.log("✅ [AC Save] Models saved successfully.");
    }

    async loadModels() {
        try {
            console.log("🔍 [AC Load] Loading Actor and Critic models from GCS...");
            const [actor, critic] = await Promise.all([
                tf.loadLayersModel(getGcsIoHandler(`models/${ACTOR_MODEL_NAME}`)),
                tf.loadLayersModel(getGcsIoHandler(`models/${CRITIC_MODEL_NAME}`))
            ]);
            this.actor = actor;
            this.critic = critic;
            this.isInitialized = true;
            console.log("✅ [AC Load] Models loaded successfully.");
            return true;
        } catch (error) {
            console.log("❌ [AC Load] Could not load models. Need training.", error.message);
            return false;
        }
    }
    
    // =================================================================
    // 2. QUY TRÌNH HỌC TĂNG CƯỜNG
    // =================================================================
    async runLearning() {
        if (!this.isInitialized) {
            const loaded = await this.loadModels();
            if (!loaded) throw new Error("Models not trained. Please run historical training first.");
        }
        
        console.log("🔔 [AC Learn] Starting Reinforcement Learning loop...");
        const episodes = await this.collectEpisodes();
        if (episodes.length === 0) {
            await NNPrediction.updateMany({ danhDauDaSo: false }, { danhDauDaSo: true });
            return { message: "Không có dữ liệu mới hợp lệ để học." };
        }

        const actorOptimizer = tf.train.adam(ACTOR_LR);
        const criticOptimizer = tf.train.adam(CRITIC_LR);

        for (const episode of episodes) {
            const { state, action, reward, nextState, date } = episode;

            const stateTensor = tf.tensor3d([state], [1, ...STATE_SHAPE]);
            const nextStateTensor = tf.tensor3d([nextState], [1, ...STATE_SHAPE]);
            
            await tf.tidy(async () => {
                // --- Cập nhật Critic ---
                const criticGrads = tf.variableGrads(() => tf.tidy(() => {
                    const value = this.critic.apply(stateTensor);
                    const nextValue = this.critic.apply(nextStateTensor);
                    const tdTarget = tf.scalar(reward).add(nextValue.mul(tf.scalar(GAMMA)));
                    const tdError = tdTarget.sub(value);
                    return tdError.square().mean();
                }));
                criticOptimizer.applyGradients(criticGrads.grads);
                tf.dispose(criticGrads.grads);

                // --- Cập nhật Actor ---
                const advantage = tf.tidy(() => {
                    const value = this.critic.predict(stateTensor);
                    const nextValue = this.critic.predict(nextStateTensor);
                    const tdTarget = tf.scalar(reward).add(nextValue.mul(tf.scalar(GAMMA)));
                    return tdTarget.sub(value).detach();
                });

                const actorGrads = tf.variableGrads(() => tf.tidy(() => {
                    const policy = this.actor.apply(stateTensor);
                    const logProb = tf.log(policy.gather(action, 1));
                    return logProb.mul(advantage).mul(tf.scalar(-1)).mean(); // Lấy mean để loss là scalar
                }));
                actorOptimizer.applyGradients(actorGrads.grads);
                tf.dispose(actorGrads.grads);
                advantage.dispose();
            });

            stateTensor.dispose();
            nextStateTensor.dispose();
            action.dispose();
            console.log(`...[AC Learn] Learned from episode on ${date}.`);
        }
        
        await this.saveModels();
        await NNPrediction.updateMany({ danhDauDaSo: { $in: episodes.map(e => e.date) } }, { danhDauDaSo: true });
        return { message: `RL training complete. Learned from ${episodes.length} episodes.` };
    }

    // =================================================================
    // 3. HUẤN LUYỆN LỊCH SỬ & DỰ ĐOÁN
    // =================================================================
    async runHistoricalTraining() {
        console.log("🕐 [AC Train] Starting historical pre-training...");
        this.buildActor();
        this.buildCritic();

        const trainingData = await this.prepareHistoricalData();
        if (!trainingData) {
            throw new Error("Không thể chuẩn bị dữ liệu huấn luyện lịch sử.");
        }
        
        const { inputs, actorTargets, criticTargets } = trainingData;

        console.log(`...Training Actor with ${inputs.shape[0]} samples...`);
        this.actor.compile({ optimizer: tf.train.adam(ACTOR_LR), loss: 'categoricalCrossentropy' });
        await this.actor.fit(inputs, actorTargets, { epochs: 30, batchSize: 64, shuffle: true, verbose: 0, callbacks: { onEpochEnd: (e) => console.log(`  Actor Epoch ${e+1}`) } });

        console.log(`...Training Critic with ${inputs.shape[0]} samples...`);
        this.critic.compile({ optimizer: tf.train.adam(CRITIC_LR), loss: 'meanSquaredError' });
        await this.critic.fit(inputs, criticTargets, { epochs: 20, batchSize: 64, shuffle: true, verbose: 0, callbacks: { onEpochEnd: (e) => console.log(`  Critic Epoch ${e+1}`) } });
        
        inputs.dispose();
        actorTargets.dispose();
        criticTargets.dispose();

        await this.saveModels();
        this.isInitialized = true;
        return { message: "Actor-Critic models pre-trained successfully." };
    }

    async runNextDayPrediction() {
        if (!this.isInitialized) {
            const loaded = await this.loadModels();
            if (!loaded) throw new Error("Models not trained.");
        }
        
        const inputSequence = await this.preparePredictionInput();
        
        const actionProbsTensor = tf.tidy(() => this.actor.predict(tf.tensor3d([inputSequence], [1, ...STATE_SHAPE])));
        const output = await actionProbsTensor.data();
        actionProbsTensor.dispose();
        
        const prediction = this.decodeOutput(output);
        
        const results = await Result.find().sort({_id: -1}).limit(1).lean();
        const latestDay = results[0].ngay;
        const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

        await NNPrediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false },
            { upsert: true, new: true }
        );

        return { message: "Prediction generated by Actor-Critic model.", ngayDuDoan: nextDayStr };
    }

    // =================================================================
    // 4. CÁC HÀM HELPER (HOÀN CHỈNH)
    // =================================================================
    dateKey(s) {
        if (!s) return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    getFeatureVectorForDay(dayResults, previousDaysData, dateStr) {
        const basicFeatures = this.featureService.extractAllFeatures(dayResults, previousDaysData, dateStr);
        const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, previousDaysData);
        let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
        if (finalFeatureVector.some(v => isNaN(v) || v === null)) {
            finalFeatureVector = finalFeatureVector.map(v => (isNaN(v) || v === null) ? 0 : v);
        }
        if (finalFeatureVector.length !== FEATURE_SIZE) {
            finalFeatureVector = [...finalFeatureVector, ...Array(FEATURE_SIZE - finalFeatureVector.length).fill(0)].slice(0, FEATURE_SIZE);
        }
        return finalFeatureVector;
    }

    async prepareHistoricalData() {
        const results = await Result.find().sort({ 'ngay': 1 }).lean();
        if (results.length < SEQUENCE_LENGTH + 2) return null;

        const grouped = {};
        results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));

        const inputs = [];
        const actorTargets = [];
        const criticTargets = [];

        for (let i = SEQUENCE_LENGTH; i < days.length -1; i++) {
            const stateDays = days.slice(i - SEQUENCE_LENGTH, i);
            const targetDay = days[i];

            const state = stateDays.map(day => this.getFeatureVectorForDay(grouped[day] || [], [], day));
            const targetGDB = (grouped[targetDay] || []).find(r => r.giai === 'ĐB');

            if (targetGDB?.so && String(targetGDB.so).length >= 5) {
                inputs.push(state);
                const targetGDBString = String(targetGDB.so).padStart(5, '0');
                const actorTarget = this.prepareTarget(targetGDBString);
                actorTargets.push(actorTarget);
                
                // Reward giả định cho pre-training: 1.0 cho mọi dữ liệu lịch sử
                criticTargets.push([1.0]); 
            }
        }
        return {
            inputs: tf.tensor3d(inputs),
            actorTargets: tf.tensor2d(actorTargets),
            criticTargets: tf.tensor2d(criticTargets)
        };
    }
    
    async collectEpisodes() {
        console.log("...[AC Learn] Bắt đầu thu thập các 'tập' (ngày) để học...");
        const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
        if (predictionsToLearn.length === 0) {
            return [];
        }
        
        const results = await Result.find().sort({ 'ngay': 1 }).lean();
        const grouped = {};
        results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a,b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        const episodes = [];

        for (const pred of predictionsToLearn) {
            const date = pred.ngayDuDoan;
            const dateIndex = days.indexOf(date);
            
            if (dateIndex < SEQUENCE_LENGTH || dateIndex >= days.length - 1) {
                console.log(`...Bỏ qua ngày ${date}: không đủ dữ liệu trước/sau.`);
                continue;
            }
            
            const actualResultDoc = (grouped[date] || []).find(r => r.giai === 'ĐB');
            if (!actualResultDoc?.so || String(actualResultDoc.so).length < 5) {
                 console.log(`...Bỏ qua ngày ${date}: không có kết quả GĐB thực tế.`);
                continue;
            }

            const stateDays = days.slice(dateIndex - SEQUENCE_LENGTH, dateIndex);
            const state = stateDays.map(d => this.getFeatureVectorForDay(grouped[d] || [], [], d));

            const nextStateDays = days.slice(dateIndex - SEQUENCE_LENGTH + 1, dateIndex + 1);
            const nextState = nextStateDays.map(d => this.getFeatureVectorForDay(grouped[d] || [], [], d));

            const actualGDBString = String(actualResultDoc.so).padStart(5, '0');
            const reward = this.calculateReward(pred, actualGDBString);
            
            const action = tf.tidy(() => {
                const actionIndices = [];
                for(let i=0; i<5; i++) {
                    const digit = parseInt(actualGDBString[i]);
                    actionIndices.push(i * 10 + digit);
                }
                return tf.tensor2d(actionIndices, [5, 1], 'int32');
            });
            
            episodes.push({ state, action, reward, nextState, date });
        }
        
        console.log(`✅ [AC Learn] Đã thu thập thành công ${episodes.length} tập.`);
        return episodes;
    }

    calculateReward(prediction, actualGDB) {
        let correctCount = 0;
        if (prediction.pos1.includes(actualGDB[0])) correctCount++;
        if (prediction.pos2.includes(actualGDB[1])) correctCount++;
        if (prediction.pos3.includes(actualGDB[2])) correctCount++;
        if (prediction.pos4.includes(actualGDB[3])) correctCount++;
        if (prediction.pos5.includes(actualGDB[4])) correctCount++;
        
        if (correctCount === 5) return 1.0; // Thưởng lớn nếu trúng cả 5
        if (correctCount > 0) return 0.5; // Thưởng nhỏ nếu trúng 1-4
        return -1.0; // Phạt nếu trượt hoàn toàn
    }

    prepareTarget(gdbString) {
        const target = Array(OUTPUT_NODES).fill(0.001); // Small probability for all
        gdbString.split('').forEach((digit, index) => {
            const d = parseInt(digit);
            if (!isNaN(d) && index < 5) {
                target[index * 10 + d] = 0.99; // High probability for correct ones
            }
        });
        return target;
    }
    
    async preparePredictionInput() {
        const results = await Result.find().sort({_id: -1}).limit(SEQUENCE_LENGTH * 2).lean(); // Lấy nhiều hơn để đảm bảo đủ ngày
        const grouped = {};
        results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        const latestSequenceDays = days.slice(-SEQUENCE_LENGTH);
        if (latestSequenceDays.length < SEQUENCE_LENGTH) {
            throw new Error(`Không đủ dữ liệu để tạo input dự đoán, chỉ có ${latestSequenceDays.length} ngày.`);
        }
        const inputSequence = latestSequenceDays.map(day => this.getFeatureVectorForDay(grouped[day], [], day));
        return inputSequence;
    }

    decodeOutput(output) {
        const prediction = { pos1: [], pos2: [], pos3: [], pos4: [], pos5: [] };
        for (let i = 0; i < 5; i++) {
            const positionOutput = output.slice(i * 10, (i + 1) * 10);
            const digitsWithValues = positionOutput
                .map((value, index) => ({ digit: String(index), value }))
                .sort((a, b) => b.value - a.value)
                .slice(0, 5)
                .map(item => item.digit);
            prediction[`pos${i + 1}`] = digitsWithValues;
        }
        return prediction;
    }
}

module.exports = ActorCriticService;
