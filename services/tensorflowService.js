const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const { DateTime } = require('luxon');

// Hằng số cấu hình
const NN_MODEL_NAME = 'GDB_SINGLEHEAD_ULTRASTABLE_V1'; // Tên mới
const SEQUENCE_LENGTH = 7;
const EPOCHS = 50;
const BATCH_SIZE = 32;
const OUTPUT_NODES = 50;

// Hàm tiện ích
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
    console.log(`🏗️ Bắt đầu xây dựng kiến trúc Tối giản và Siêu ổn định...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    model.add(tf.layers.lstm({
      units: 128,
      inputShape: [SEQUENCE_LENGTH, inputNodes],
      returnSequences: false
    }));
    
    model.add(tf.layers.dropout({rate: 0.3}));

    model.add(tf.layers.dense({
      units: OUTPUT_NODES,
      activation: 'sigmoid'
    }));
    
    model.summary();
    this.model = model;
    return this.model;
  }

  // HÀM BỊ THIẾU ĐÃ ĐƯỢC KHÔI PHỤC
  async trainModel({ inputs, targets }) {
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    const history = await this.model.fit(inputTensor, targetTensor, {
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
    targetTensor.dispose();
    return history;
  }

  async predict(inputSequence) {
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const probabilities = this.model.predict(inputTensor); 
    const output = await probabilities.data();

    inputTensor.dispose();
    probabilities.dispose();
    
    return Array.from(output);
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
  
  prepareTarget(gdbString) {
    const target = Array(OUTPUT_NODES).fill(0.0);
    gdbString.slice(0, 5).split('').forEach((digitChar, index) => {
        const digit = parseInt(digitChar, 10);
        if (Number.isInteger(digit) && digit >= 0 && digit <= 9) {
            const targetIndex = index * 10 + digit;
            if (targetIndex >= 0 && targetIndex < OUTPUT_NODES) {
                target[targetIndex] = 1.0;
            }
        }
    });
    return target;
  }

  async prepareTrainingData() {
    console.log('📝 Bắt đầu chuẩn bị dữ liệu huấn luyện...');
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < SEQUENCE_LENGTH + 1) throw new Error(`Không đủ dữ liệu.`);

    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });

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
            const advancedFeaturesObject = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
            
            let finalFeatureVector = [
                ...basicFeatures,
                ...advancedFeaturesObject.prizeCorrelationFeatures,
                ...advancedFeaturesObject.sumFrequencyFeatures,
                ...advancedFeaturesObject.chanLePatterns,
                ...advancedFeaturesObject.gapAnalysis
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
            const targetArray = this.prepareTarget(gdbString);
            trainingData.push({ inputSequence, targetArray });
        }
    }

    if (trainingData.length === 0) throw new Error("Không có dữ liệu training hợp lệ.");
    this.inputNodes = trainingData[0].inputSequence[0].length;
    console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu huấn luyện hợp lệ với feature size: ${this.inputNodes}`);
    return trainingData;
  }
  
  async runHistoricalTraining() {
    console.log('🔔 Bắt đầu Huấn luyện Lịch sử với kiến trúc Tối giản...');
    const trainingData = await this.prepareTrainingData(); 
    if (trainingData.length === 0) throw new Error('Không có dữ liệu training');

    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);
    
    await this.buildModel(this.inputNodes); 

    this.model.compile({
        optimizer: tf.train.adam({ 
            learningRate: 0.0001 // Bắt đầu với learning rate thấp
        }),
        loss: 'binaryCrossentropy',
    });
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training...');
    await this.trainModel({ inputs, targets }); 
    await this.saveModel(); 
    return { message: `Huấn luyện Single-Head Tối giản hoàn tất.`, /*...*/ };
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
    // Tạm thời vô hiệu hóa để tập trung vào lỗi chính
    console.warn("⚠️ Chức năng 'Học hỏi' (runLearning) đang được tạm vô hiệu hóa.");
    return { message: 'Chức năng học hỏi tạm vô hiệu hóa.' };
  }

  async runNextDayPrediction() {
    console.log('🔔 Generating next day prediction with Stable Single-Head Model...');
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
        const advancedFeaturesObject = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
        let finalFeatureVector = [
            ...basicFeatures,
            ...advancedFeaturesObject.prizeCorrelationFeatures,
            ...advancedFeaturesObject.sumFrequencyFeatures,
            ...advancedFeaturesObject.chanLePatterns,
            ...advancedFeaturesObject.gapAnalysis
        ];
        inputSequence.push(finalFeatureVector);
    }
    
    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = latestSequenceDays[latestSequenceDays.length - 1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    await NNPrediction.findOneAndUpdate({ ngayDuDoan: nextDayStr }, { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false }, { upsert: true, new: true });
    return { message: `Stable Single-Head Model đã tạo dự đoán cho ngày ${nextDayStr}.`, ngayDuDoan: nextDayStr };
  }
}

module.exports = TensorFlowService;
