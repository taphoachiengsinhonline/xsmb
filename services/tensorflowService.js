const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const { DateTime } = require('luxon');

const NN_MODEL_NAME = 'GDB_MULTIHEAD_TFJS_V1';
const SEQUENCE_LENGTH = 7;
const EPOCHS = 50;
const BATCH_SIZE = 32;
const NUM_POSITIONS = 5;
const NUM_CLASSES = 10;

const dateKey = (s) => {
    if (!s || typeof s !== 'string') return '';
    const parts = s.split('/');
    return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
};

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    this.inputNodes = 0;
  }

  async buildModel(inputNodes) {
    console.log(`🏗️ Bắt đầu xây dựng kiến trúc Multi-Head Model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;

    const inputLayer = tf.input({shape: [SEQUENCE_LENGTH, inputNodes]});

    const lstm1 = tf.layers.lstm({
        units: 192, returnSequences: true,
        kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }).apply(inputLayer);
    const batchNorm1 = tf.layers.batchNormalization().apply(lstm1);
    const dropout1 = tf.layers.dropout({rate: 0.25}).apply(batchNorm1);

    const lstm2 = tf.layers.lstm({
        units: 96,
        kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }).apply(dropout1);
    const batchNorm2 = tf.layers.batchNormalization().apply(lstm2);
    const sharedOutput = tf.layers.dropout({rate: 0.25}).apply(batchNorm2);

    const outputLayers = [];
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        const denseHead = tf.layers.dense({ units: 48, activation: 'relu', name: `${headName}_dense` }).apply(sharedOutput);
        const outputHead = tf.layers.dense({ units: NUM_CLASSES, activation: 'softmax', name: headName }).apply(denseHead);
        outputLayers.push(outputHead);
    }

    this.model = tf.model({inputs: inputLayer, outputs: outputLayers});
    this.model.summary();
    return this.model;
  }

  async trainModel({ inputs, targets }) {
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    
    const targetTensors = {};
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        targetTensors[headName] = tf.tensor2d(targets[headName], [targets[headName].length, NUM_CLASSES]);
    }

    const history = await this.model.fit(inputTensor, targetTensors, {
        epochs: EPOCHS,
        batchSize: BATCH_SIZE,
        validationSplit: 0.1,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                const valLossLog = logs.val_loss ? `, Val_Loss = ${logs.val_loss.toFixed(4)}` : '';
                console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}${valLossLog}`);
            }
        }
    });

    inputTensor.dispose();
    Object.values(targetTensors).forEach(t => t.dispose());
    return history;
  }
  
  async prepareTrainingData() {
    console.log('📝 Bắt đầu chuẩn bị dữ liệu huấn luyện...');
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < SEQUENCE_LENGTH + 1) {
        throw new Error(`Không đủ dữ liệu.`);
    }

    const grouped = {};
    results.forEach(r => {
        if (!grouped[r.ngay]) grouped[r.ngay] = [];
        grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    const trainingData = [];

    for (let i = 0; i < days.length - SEQUENCE_LENGTH; i++) {
        const sequenceDaysStrings = days.slice(i, i + SEQUENCE_LENGTH);
        const targetDayString = days[i + SEQUENCE_LENGTH];
        const allHistoryForSequence = days.slice(0, i + SEQUENCE_LENGTH).map(dayStr => grouped[dayStr] || []);
        const inputSequence = [];
        
        for(let j = 0; j < SEQUENCE_LENGTH; j++) {
            const currentDayForFeature = grouped[sequenceDaysStrings[j]] || [];
            const dateStr = sequenceDaysStrings[j];
            const previousDaysForBasicFeatures = allHistoryForSequence.slice(0, i + j);
            const previousDaysForAdvancedFeatures = previousDaysForBasicFeatures.slice().reverse();
            const basicFeatures = this.featureService.extractAllFeatures(currentDayForFeature, previousDaysForBasicFeatures, dateStr);
            const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
            
            // BẮT ĐẦU KIỂM TRA TỪNG NHÓM
            let finalFeatureVector = [
                ...basicFeatures, 
                ...advancedFeatures.prizeCorrelationFeatures,
                // ...advancedFeatures.sumFrequencyFeatures,
                // ...advancedFeatures.chanLePatterns,
                // ...advancedFeatures.gapAnalysis
            ];

            for(let k = 0; k < finalFeatureVector.length; k++) {
                const val = finalFeatureVector[k];
                if (!isFinite(val)) {
                    throw new Error(`Invalid data detected: ${val} at feature index ${k} for date ${dateStr}`);
                }
            }
            inputSequence.push(finalFeatureVector);
        }

        const targetGDB = (grouped[targetDayString] || []).find(r => r.giai === 'ĐB');
        if (targetGDB?.so && String(targetGDB.so).length >= 5) {
            const gdbString = String(targetGDB.so).padStart(5, '0');
            const targets = [];
            let isValidTarget = true;
            for(let pos = 0; pos < NUM_POSITIONS; pos++) {
                const digit = parseInt(gdbString[pos], 10);
                if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
                    const oneHotTarget = Array(NUM_CLASSES).fill(0);
                    oneHotTarget[digit] = 1;
                    targets.push(oneHotTarget);
                } else {
                    isValidTarget = false;
                    break;
                }
            }
            if (isValidTarget) {
                 trainingData.push({ inputSequence, targets });
            }
        }
    }

    if (trainingData.length === 0) throw new Error("Không có dữ liệu training hợp lệ.");
    this.inputNodes = trainingData[0].inputSequence[0].length;
    console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu huấn luyện hợp lệ với feature size: ${this.inputNodes}`);
    return trainingData;
  }
  
  async runHistoricalTraining() {
    console.log('🔔 [CHẨN ĐOÁN] Bắt đầu Huấn luyện với bộ features cơ bản...');
    const trainingData = await this.prepareTrainingData(); 
    if (trainingData.length === 0) throw new Error('Không có dữ liệu training');

    const inputs = trainingData.map(d => d.inputSequence);
    const targets = {};
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        targets[headName] = trainingData.map(d => d.targets[i]);
    }
    
    // =================================================================
    // KHỐI PHÂN TÍCH DỮ LIỆU CHẨN ĐOÁN (THÊM VÀO ĐÂY)
    // =================================================================
    console.log('📊 [CHẨN ĐOÁN] Bắt đầu phân tích toàn bộ dữ liệu training...');
    // Làm phẳng mảng 3D [samples, timesteps, features] thành 1D để tính toán
    const flatInputs = inputs.flat(2);
    
    const stats = flatInputs.reduce((acc, val) => {
        acc.min = Math.min(acc.min, val);
        acc.max = Math.max(acc.max, val);
        acc.sum += val;
        return acc;
    }, { min: Infinity, max: -Infinity, sum: 0 });

    const mean = stats.sum / flatInputs.length;
    
    const variance = flatInputs.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / flatInputs.length;
    const stdDev = Math.sqrt(variance);

    console.log(`
    ============================================================
    [CHẨN ĐOÁN] KẾT QUẢ PHÂN TÍCH DỮ LIỆU ĐẦU VÀO:
    ------------------------------------------------------------
    - Tổng số điểm dữ liệu: ${flatInputs.length}
    - Giá trị NHỎ NHẤT (Min): ${stats.min}
    - Giá trị LỚN NHẤT (Max): ${stats.max}
    - Giá trị TRUNG BÌNH (Mean): ${mean.toFixed(4)}
    - ĐỘ LỆCH CHUẨN (StdDev): ${stdDev.toFixed(4)}
    ============================================================
    `);
    
    // Nếu giá trị max quá lớn, dừng lại và báo lỗi.
    if (stats.max > 100) { // Đặt một ngưỡng hợp lý
        throw new Error(`[CHẨN ĐOÁN] DỮ LIỆU BẤT THƯỜNG! Giá trị Max quá lớn (${stats.max}). Vui lòng kiểm tra lại các hàm feature engineering.`);
    }
    // =================================================================

    await this.buildModel(this.inputNodes); 
    await this.saveModel(); 
    return { message: `Huấn luyện Multi-Head Model hoàn tất.`, /*...*/ };
  }
  
  async predict(inputSequence) {
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const predictions = this.model.predict(inputTensor);
    const outputs = [];
    for (const predTensor of Array.isArray(predictions) ? predictions : [predictions]) {
        outputs.push(await predTensor.data());
    }
    inputTensor.dispose();
    (Array.isArray(predictions) ? predictions : [predictions]).forEach(t => t.dispose());
    return outputs;
  }

  decodeOutput(outputs) {
    const prediction = {};
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        const positionOutput = outputs[i];
        const digitsWithValues = Array.from(positionOutput)
            .map((value, index) => ({ digit: String(index), value }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 5)
            .map(item => item.digit);
        prediction[headName] = digitsWithValues;
    }
    return prediction;
  }

  async saveModel() {
    if (!this.model) throw new Error('No model to save');
    const modelInfo = { modelName: NN_MODEL_NAME, inputNodes: this.inputNodes, savedAt: new Date().toISOString() };
    const saveResult = await this.model.save('file://./models/tfjs_model');
    await NNState.findOneAndUpdate({ modelName: NN_MODEL_NAME }, { state: modelInfo, modelArtifacts: saveResult }, { upsert: true });
    console.log(`💾 TensorFlow model saved với ${this.inputNodes} input nodes`);
  }

  async loadModel() {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.modelArtifacts) {
        this.model = await tf.loadLayersModel('file://./models/tfjs_model/model.json');
        this.inputNodes = modelState.state.inputNodes;
        console.log(`✅ TensorFlow model loaded với ${this.inputNodes} input nodes`);
        return true;
    }
    return false;
  }

  async runLearning() {
    console.warn("⚠️ Chức năng 'Học hỏi' (runLearning) đang được tạm vô hiệu hóa cho kiến trúc Multi-Head.");
    return { message: 'Chức năng học hỏi chưa được triển khai cho model mới.' };
  }

  async runNextDayPrediction() {
    console.log('🔔 [TensorFlow Service] Generating next day prediction with Multi-Head Model...');
    if (!this.model) {
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) throw new Error('Model chưa được huấn luyện.');
    }

    const results = await Result.find().lean();
    if (results.length < SEQUENCE_LENGTH) throw new Error(`Không đủ dữ liệu.`);
    
    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    const latestSequenceDays = days.slice(-SEQUENCE_LENGTH);
    console.log(`🔮 Sử dụng dữ liệu từ các ngày: ${latestSequenceDays.join(', ')} để dự đoán.`);

    const inputSequence = [];
    for(let j = 0; j < SEQUENCE_LENGTH; j++) {
        const currentDayForFeature = grouped[latestSequenceDays[j]] || [];
        const dateStr = latestSequenceDays[j];
        const historyIndex = days.indexOf(dateStr);
        const previousDaysForBasicFeatures = days.slice(0, historyIndex).map(d => grouped[d] || []);
        const previousDaysForAdvancedFeatures = previousDaysForBasicFeatures.slice().reverse();
        const basicFeatures = this.featureService.extractAllFeatures(currentDayForFeature, previousDaysForBasicFeatures, dateStr);
        const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
        let finalFeatureVector = [...basicFeatures, ...advancedFeatures];
        inputSequence.push(finalFeatureVector);
    }
    
    const outputs = await this.predict(inputSequence);
    const prediction = this.decodeOutput(outputs);

    const latestDay = latestSequenceDays[latestSequenceDays.length - 1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    await NNPrediction.findOneAndUpdate({ ngayDuDoan: nextDayStr }, { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false }, { upsert: true, new: true });
    return { message: `Multi-Head Model đã tạo dự đoán cho ngày ${nextDayStr}.`, ngayDuDoan: nextDayStr };
  }
}

module.exports = TensorFlowService;
