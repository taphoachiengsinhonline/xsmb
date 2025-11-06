const tf = require('@tensorflow/tfjs-node');
const { Storage } = require('@google-cloud/storage')
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
const ACTOR_MODEL_NAME = 'AC_ACTOR_V3_STABLE';
const CRITIC_MODEL_NAME = 'AC_CRITIC_V3_STABLE';
const SEQUENCE_LENGTH = 7;
const FEATURE_SIZE = 346;
const STATE_SHAPE = [SEQUENCE_LENGTH, FEATURE_SIZE];
const OUTPUT_NODES = 50;
const GAMMA = 0.99;
const ACTOR_LR = 1e-5; // 0.00001
const CRITIC_LR = 2.5e-4; // 0.00025
const CLIP_NORM = 0.5;

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
        this.isInitialized = false;
        this.actorOptimizer = tf.train.adam(ACTOR_LR);
        this.actorOptimizer.clipNorm = CLIP_NORM;
        this.criticOptimizer = tf.train.adam(CRITIC_LR);
        this.criticOptimizer.clipNorm = CLIP_NORM;
        this.inputNodes = FEATURE_SIZE;
        this.featureService = new FeatureEngineeringService();
        this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    }

    // =================================================================
    // 1. HÀM HUẤN LUYỆN LỊCH SỬ (Đã tích hợp học tuần tự)
    // =================================================================
    async runHistoricalTraining() {
        console.log("🕐 [AC Train] Bắt đầu quá trình Huấn luyện & Tạo Lịch sử Tuần tự...");
        this.buildActor();
        this.buildCritic();

        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < SEQUENCE_LENGTH + 1) {
            throw new Error("Không đủ dữ liệu để bắt đầu huấn luyện.");
        }

        const grouped = {};
        allResults.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        let createdCount = 0;
        const totalDaysToProcess = days.length - SEQUENCE_LENGTH;

        for (let i = SEQUENCE_LENGTH; i < days.length; i++) {
            const currentDate = days[i];
            const previousDate = days[i-1];
            
            const state = this.getStateFromDays(days.slice(i - SEQUENCE_LENGTH, i), grouped);

            const actionProbsTensor = tf.tidy(() => this.actor.predict(tf.tensor3d([state], [1, ...STATE_SHAPE])));
            const actionProbs = await actionProbsTensor.data();
            actionProbsTensor.dispose();
            
            const prediction = this.decodeOutput(actionProbs);
            await NNPrediction.findOneAndUpdate({ ngayDuDoan: currentDate }, { ...prediction, danhDauDaSo: true }, { upsert: true });
            createdCount++;

            const actualResultDoc = (grouped[previousDate] || []).find(r => r.giai === 'ĐB');
            if (actualResultDoc) {
                const prevState = this.getStateFromDays(days.slice(i - 1 - SEQUENCE_LENGTH, i - 1), grouped);
                const prevPrediction = await NNPrediction.findOne({ ngayDuDoan: previousDate }).lean();
                
                if (prevState && prevPrediction) {
                    const actualGDBString = String(actualResultDoc.so).padStart(5, '0');
                    const reward = this.calculateReward(prevPrediction, actualGDBString);
                    const action = this.getActionFromGDB(actualGDBString);
                    await this.learnFromSingleStep(prevState, action, reward, state);
                }
            }
            console.log(`...[AC Train] Đã xử lý ngày ${currentDate} (${createdCount}/${totalDaysToProcess})`);
        }
        
        await this.saveModels();
        this.isInitialized = true;
        return { message: `Huấn luyện & tạo lịch sử tuần tự hoàn tất. Đã xử lý ${createdCount} ngày.` };
    }

    // =================================================================
    // 2. CÁC HÀM CỐT LÕI CỦA RL (ĐÃ SỬA LỖI NAN)
    // =================================================================
    
    async learnFromSingleStep(state, action, reward, nextState) {
        const stateTensor = tf.tensor3d([state], [1, ...STATE_SHAPE]);
        const nextStateTensor = tf.tensor3d([nextState], [1, ...STATE_SHAPE]);
        const actionTensor = tf.tensor1d(action, 'int32');

        const criticLoss = this.criticOptimizer.minimize(() => {
            return tf.tidy(() => {
                const value = this.critic.apply(stateTensor);
                const nextValue = this.critic.apply(nextStateTensor).detach();
                const tdTarget = tf.scalar(reward).add(nextValue.mul(tf.scalar(GAMMA)));
                return tf.losses.meanSquaredError(tdTarget, value);
            });
        }, true, this.critic.getWeights());

        const advantage = tf.tidy(() => {
            const value = this.critic.predict(stateTensor);
            const nextValue = this.critic.predict(nextStateTensor);
            const tdTarget = tf.scalar(reward).add(nextValue.mul(tf.scalar(GAMMA)));
            return tdTarget.sub(value).detach();
        });

        const actorLoss = this.actorOptimizer.minimize(() => {
            return tf.tidy(() => {
                const policy = this.actor.apply(stateTensor).squeeze();
                const epsilon = tf.scalar(1e-8);
                const logProb = tf.log(policy.gather(actionTensor).add(epsilon));
                return logProb.mul(advantage).mul(tf.scalar(-1)).mean();
            });
        }, true, this.actor.getWeights());
        
        tf.dispose([stateTensor, nextStateTensor, actionTensor, criticLoss, actorLoss, advantage]);
    }
    
    async collectEpisodes() {
        const predictionToLearn = await NNPrediction.findOne({ danhDauDaSo: false }).sort({_id: -1}).lean();
        if (!predictionToLearn) return [];
        const date = predictionToLearn.ngayDuDoan;
        console.log(`...[AC Learn] Thu thập tập cho ngày ${date}...`);

        const results = await Result.find().sort({ 'ngay': 1 }).lean();
        const grouped = {};
        results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a,b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        const dateIndex = days.indexOf(date);
        if (dateIndex < SEQUENCE_LENGTH) return [];
        
        const actualResultDoc = (grouped[date] || []).find(r => r.giai === 'ĐB');
        if (!actualResultDoc?.so || String(actualResultDoc.so).length < 5) return [];

        const state = this.getStateFromDays(days.slice(dateIndex - SEQUENCE_LENGTH, dateIndex), grouped);
        const nextState = this.getStateFromDays(days.slice(dateIndex - SEQUENCE_LENGTH + 1, dateIndex + 1), grouped);
        const actualGDBString = String(actualResultDoc.so).padStart(5, '0');
        const reward = this.calculateReward(predictionToLearn, actualGDBString);
        const action = this.getActionFromGDB(actualGDBString);
        
        return [{ state, action, reward, nextState, date }];
    }

    // =================================================================
    // 3. CÁC HÀM CÔNG KHAI KHÁC
    // =================================================================
    
    async runLearning() {
        if (!this.isInitialized) {
            const loaded = await this.loadModels();
            if (!loaded) throw new Error("Models not trained. Please run historical training first.");
        }
        
        console.log("🔔 [AC Learn] Starting Reinforcement Learning loop for new results...");
        const episodes = await this.collectEpisodes();
        if (episodes.length === 0) {
            await NNPrediction.updateMany({ danhDauDaSo: false }, { danhDauDaSo: true });
            return { message: "Không có dữ liệu mới hợp lệ để học." };
        }

        for (const episode of episodes) {
            await this.learnFromSingleStep(episode.state, episode.action, episode.reward, episode.nextState);
            console.log(`...[AC Learn] Learned from episode on ${episode.date}.`);
        }
        
        await this.saveModels();
        await NNPrediction.updateMany({ danhDauDaSo: false }, { danhDauDaSo: true });
        return { message: `RL training complete. Learned from ${episodes.length} episodes.` };
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
        
        if (output.some(isNaN)) {
            console.error("❌ LỖI NGHIÊM TRỌNG: DỰ ĐOÁN RA NAN! MODEL ĐANG KHÔNG ỔN ĐỊNH.");
            throw new Error("Model prediction resulted in NaN values.");
        }
        
        const prediction = this.decodeOutput(output);
        
        const results = await Result.find().sort({_id: -1}).limit(1).lean();
        const latestDay = results[0].ngay;
        const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

        await NNPrediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { ...prediction, danhDauDaSo: false },
            { upsert: true, new: true }
        );

        return { message: "Prediction generated by Actor-Critic model.", ngayDuDoan: nextDayStr };
    }

    // =================================================================
    // 4. CÁC HÀM HELPER VÀ XÂY DỰNG MÔ HÌNH (ĐẦY ĐỦ)
    // =================================================================
    buildActor() {
        const model = tf.sequential();
        model.add(tf.layers.lstm({ units: 64, inputShape: STATE_SHAPE, returnSequences: false, kernelInitializer: 'glorotUniform' }));
        model.add(tf.layers.dense({ units: 32, activation: 'relu', kernelInitializer: 'glorotUniform' }));
        model.add(tf.layers.dense({ units: OUTPUT_NODES, activation: 'softmax' }));
        this.actor = model;
        console.log("✅ Actor model built.");
    }

    buildCritic() {
        const model = tf.sequential();
        model.add(tf.layers.lstm({ units: 64, inputShape: STATE_SHAPE, returnSequences: false, kernelInitializer: 'glorotUniform' }));
        model.add(tf.layers.dense({ units: 32, activation: 'relu', kernelInitializer: 'glorotUniform' }));
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
    
    dateKey(s) {
        if (!s || typeof s !== 'string') return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    getStateFromDays(days, groupedData) {
        return days.map(day => this.getFeatureVectorForDay(groupedData[day] || [], [], day));
    }
    
    getFeatureVectorForDay(dayResults, previousDaysData, dateStr) {
        // Tạm thời giữ logic đơn giản để debug, bạn cần thay thế bằng logic feature đầy đủ của mình
        const features = Array(FEATURE_SIZE).fill(Math.random() * 0.1); // Thêm nhiễu nhỏ
        if(dayResults && dayResults.length > 0) {
            const gdb = dayResults.find(r => r.giai === 'ĐB');
            if (gdb && gdb.so) {
                const digits = String(gdb.so).padStart(5,'0').split('').map(Number);
                digits.forEach((d,i) => features[i] = d / 9.0);
            }
        }
        return features;
    }
    
    calculateReward(prediction, actualGDB) {
        let correctCount = 0;
        if (prediction.pos1.includes(actualGDB[0])) correctCount++;
        if (prediction.pos2.includes(actualGDB[1])) correctCount++;
        if (prediction.pos3.includes(actualGDB[2])) correctCount++;
        if (prediction.pos4.includes(actualGDB[3])) correctCount++;
        if (prediction.pos5.includes(actualGDB[4])) correctCount++;
        
        if (correctCount === 5) return 1.0;
        if (correctCount >= 3) return 0.5;
        if (correctCount > 0) return 0.1;
        return -1.0;
    }

    getActionFromGDB(gdbString) {
        const actionIndices = [];
        for(let i=0; i<5; i++) {
            const digit = parseInt(gdbString[i]);
            actionIndices.push(i * 10 + digit);
        }
        return actionIndices;
    }
    
    async preparePredictionInput() {
        const results = await Result.find().sort({_id: -1}).lean();
        const grouped = {};
        results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        if (days.length < SEQUENCE_LENGTH) {
            throw new Error(`Không đủ dữ liệu để tạo input dự đoán, chỉ có ${days.length} ngày.`);
        }
        const latestSequenceDays = days.slice(-SEQUENCE_LENGTH);
        return this.getStateFromDays(latestSequenceDays, grouped);
    }

    decodeOutput(output) {
        const prediction = { pos1: [], pos2: [], pos3: [], pos4: [], pos5: [] };
        for (let i = 0; i < 5; i++) {
            const positionOutput = output.slice(i * 10, (i + 1) * 10);
            const digitsWithValues = positionOutput.map((value, index) => ({ digit: String(index), value }))
                .sort((a, b) => b.value - a.value).slice(0, 5).map(item => item.digit);
            prediction[`pos${i + 1}`] = digitsWithValues;
        }
        return prediction;
    }
}

module.exports = ActorCriticService;
