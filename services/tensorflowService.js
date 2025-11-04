const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const { DateTime } = require('luxon');

// Hằng số cấu hình
const NN_MODEL_NAME = 'GDB_SINGLEHEAD_STABLE_V1';
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
    console.log(`🏗️ [CHẨN ĐOÁN] Bắt đầu xây dựng kiến trúc TỐI GIẢN...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    // CHỈ CÒN MỘT LỚP LSTM DUY NHẤT
    model.add(tf.layers.lstm({
      units: 128, // Giảm số units một chút
      inputShape: [SEQUENCE_LENGTH, inputNodes],
      returnSequences: false // Output trực tiếp ra vector cuối cùng
    }));
    
    // Giữ lại Dropout để chống overfitting
    model.add(tf.layers.dropout({rate: 0.3}));

    // LỚP OUTPUT CUỐI CÙNG
    model.add(tf.layers.dense({
      units: OUTPUT_NODES,
      activation: 'linear' // Vẫn giữ 'linear' để đi cặp với sigmoidCrossentropy
    }));
    
    model.summary();
    this.model = model;
    return this.model;
  }

  async buildModel(inputNodes) {
    console.log(`🏗️ [CHẨN ĐOÁN] Bắt đầu xây dựng kiến trúc TỐI GIẢN và ỔN ĐỊNH...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    model.add(tf.layers.lstm({
      units: 128,
      inputShape: [SEQUENCE_LENGTH, inputNodes],
      returnSequences: false
    }));
    
    model.add(tf.layers.dropout({rate: 0.3}));

    // LỚP OUTPUT CUỐI CÙNG SỬ DỤNG 'sigmoid'
    model.add(tf.layers.dense({
      units: OUTPUT_NODES,
      activation: 'sigmoid' // Quay lại với 'sigmoid'
    }));
    
    model.summary();
    this.model = model;
    return this.model;
  }

  async predict(inputSequence) {
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const logits = this.model.predict(inputTensor);
    const probabilities = logits.sigmoid(); 
    const output = await probabilities.data();

    inputTensor.dispose();
    logits.dispose();
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
    console.log('🔔 [CHẨN ĐOÁN] Bắt đầu Huấn luyện Lịch sử với kiến trúc TỐI GIẢN...');
    const trainingData = await this.prepareTrainingData(); 
    if (trainingData.length === 0) throw new Error('Không có dữ liệu training');

    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);
    
    await this.buildModel(this.inputNodes); 

    // =================================================================
    // GIẢI PHÁP CUỐI CÙNG: CẶP ĐÔI KINH ĐIỂN VỚI LEARNING RATE CỰC THẤP
    // =================================================================
    this.model.compile({
        optimizer: tf.train.adam({ 
            learningRate: 0.00001 // Bắt đầu với learning rate cực kỳ thấp để đảm bảo ổn định
        }),
        loss: 'binaryCrossentropy', // Quay lại với chuỗi ký tự loss đúng
    });
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training...');
    await this.trainModel({ inputs, targets }); 
    await this.saveModel(); 
    return { message: `Huấn luyện Single-Head TỐI GIẢN hoàn tất.`, /*...*/ };
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
    console.log('🔔 [TensorFlow Service] Learning from new results (Single-Head)...');
    if (!this.model) {
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) throw new Error('Model chưa được huấn luyện.');
    }

    const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
    if (predictionsToLearn.length === 0) return { message: 'Không có dự đoán mới nào để học.' };

    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    
    const trainingData = [];
    for (const pred of predictionsToLearn) {
        const targetDayStr = pred.ngayDuDoan;
        const targetDayIndex = days.indexOf(targetDayStr);

        if (targetDayIndex >= SEQUENCE_LENGTH) {
            const actualResult = (grouped[targetDayStr] || []).find(r => r.giai === 'ĐB');
            if (actualResult?.so && String(actualResult.so).length >= 5) {
                const sequenceDays = days.slice(targetDayIndex - SEQUENCE_LENGTH, targetDayIndex);
                
                const inputSequence = [];
                for(let j=0; j < sequenceDays.length; j++) {
                    const dateStr = sequenceDays[j];
                    const currentDayForFeature = grouped[dateStr] || [];
                    const historyIndex = days.indexOf(dateStr);
                    const previousDaysForBasicFeatures = days.slice(0, historyIndex).map(d => grouped[d] || []);
                    const previousDaysForAdvancedFeatures = previousDaysForBasicFeatures.slice().reverse();
                    const basicFeatures = this.featureService.extractAllFeatures(currentDayForFeature, previousDaysForBasicFeatures, dateStr);
                    const advancedFeaturesObject = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
                    let finalFeatureVector = [
                        ...basicFeatures, ...advancedFeaturesObject.prizeCorrelationFeatures,
                        ...advancedFeaturesObject.sumFrequencyFeatures, ...advancedFeaturesObject.chanLePatterns,
                        ...advancedFeaturesObject.gapAnalysis
                    ];
                    inputSequence.push(finalFeatureVector);
                }
                
                const targetGDBString = String(actualResult.so).padStart(5, '0');
                const targetArray = this.prepareTarget(targetGDBString);
                trainingData.push({ inputSequence, targetArray });
            }
        }
        await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }

    if (trainingData.length > 0) {
        const inputs = trainingData.map(d => d.inputSequence);
        const targets = trainingData.map(d => d.targetArray);
        
        // Huấn luyện thêm với số Epoch ít hơn
        const tempFitConfig = {
            epochs: 5,
            batchSize: BATCH_SIZE,
            // Không có validationSplit khi học thêm
        };
        const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
        const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);
        await this.model.fit(inputTensor, targetTensor, tempFitConfig);
        inputTensor.dispose();
        targetTensor.dispose();

        await this.saveModel();
        console.log(`✅ AI đã học hỏi từ ${trainingData.length} kết quả mới.`);
    }
    
    return { message: `AI đã xử lý ${predictionsToLearn.length} kết quả mới.` };
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
