const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const { DateTime } = require('luxon');
const NN_MODEL_NAME = 'GDB_LSTM_TFJS_PREMIUM_V1'; // Đổi tên model để lưu trạng thái mới
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 50; // Có thể tăng lên 70-100 với model phức tạp hơn
const BATCH_SIZE = 32;
class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    this.inputNodes = 0;
  }
  async buildModel(inputNodes) {
    console.log(`🏗️ Bắt đầu xây dựng kiến trúc Premium Model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;
    const model = tf.sequential();
    model.add(tf.layers.lstm({
      units: 192,
      returnSequences: true,
      inputShape: [SEQUENCE_LENGTH, inputNodes],
      kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
      recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }));
    model.add(tf.layers.batchNormalization({epsilon: 1e-5})); // Tăng epsilon tránh div 0
    model.add(tf.layers.dropout({rate: 0.25}));
    model.add(tf.layers.lstm({
      units: 96,
      returnSequences: false,
      kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
      recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }));
    model.add(tf.layers.batchNormalization({epsilon: 1e-5}));
    model.add(tf.layers.dropout({rate: 0.25}));
    model.add(tf.layers.dense({
      units: 48,
      activation: 'relu',
      kernelRegularizer: tf.regularizers.l2({l2: 0.001})
    }));
    model.add(tf.layers.dense({
      units: OUTPUT_NODES,
      activation: 'sigmoid'
    }));
    model.summary();
    this.model = model;
    return model;
  }
  async trainModel(trainingData) {
    const { inputs, targets } = trainingData;
    if (!inputs || !targets || inputs.length === 0 || targets.length === 0) {
      throw new Error('Dữ liệu training rỗng hoặc không hợp lệ');
    }
    // KIỂM TRA TỪNG PHẦN TỬ
    inputs.forEach((input, idx) => {
      if (!input || input.length !== SEQUENCE_LENGTH) {
        throw new Error(`Input tại index ${idx} không hợp lệ: ${input}`);
      }
    });
    targets.forEach((target, idx) => {
      if (!target || target.length !== OUTPUT_NODES) {
        throw new Error(`Target tại index ${idx} không hợp lệ: ${target}`);
      }
    });
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);
    if (inputTensor.shape.some(dim => dim === 0) || targetTensor.shape.some(dim => dim === 0)) {
      throw new Error('Tensor có shape không hợp lệ');
    }
    // Debug min/max input
    const inputData = await inputTensor.data();
    const minInput = Math.min(...inputData);
    const maxInput = Math.max(...inputData);
    console.log(`Input data min/max: ${minInput} / ${maxInput}`);
    if (isNaN(minInput) || isNaN(maxInput)) {
      throw new Error('Input chứa NaN');
    }
    const validationSplit = inputs.length >= 100 ? 0.1 : 0; // Tránh val empty
    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationSplit: validationSplit,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (isNaN(logs.loss)) {
            console.error('NaN loss detected! Stopping training.');
            this.model.stopTraining = true;
          }
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss ? logs.loss.toFixed(4) : 'NaN'}`);
        }
      }
    });
    inputTensor.dispose();
    targetTensor.dispose();
    return history;
  }
  async predict(inputSequence) {
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const prediction = this.model.predict(inputTensor);
    const output = await prediction.data();
    prediction.dispose();
    inputTensor.dispose();
    return Array.from(output);
  }
  prepareTarget(gdbString) {
    const target = Array(OUTPUT_NODES).fill(0);
    gdbString.split('').forEach((digit, index) => {
      const d = parseInt(digit);
      if (!isNaN(d) && index < 5) {
        target[index * 10 + d] = 1; // Đổi thành 1/0 để ổn định loss
      }
    });
    return target;
  }
  async prepareTrainingData() {
    console.log('📝 Bắt đầu chuẩn bị dữ liệu huấn luyện...');
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < SEQUENCE_LENGTH + 1) {
      throw new Error(`Không đủ dữ liệu. Cần ít nhất ${SEQUENCE_LENGTH + 1} ngày.`);
    }
    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.ngay]) grouped[r.ngay] = [];
      grouped[r.ngay].push(r);
    });
    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    const trainingData = [];
    let allFeatures = []; // Để normalize sau
    for (let i = 0; i < days.length - SEQUENCE_LENGTH; i++) {
      const sequenceDaysStrings = days.slice(i, i + SEQUENCE_LENGTH);
      const targetDayString = days[i + SEQUENCE_LENGTH);
      const allHistoryForSequence = days.slice(0, i + SEQUENCE_LENGTH).map(dayStr => grouped[dayStr] || []);
      const inputSequence = [];
      let sequenceHasInvalidData = false;
      for(let j = 0; j < SEQUENCE_LENGTH; j++) {
        const currentDayForFeature = grouped[sequenceDaysStrings[j]] || [];
        const dateStr = sequenceDaysStrings[j];
        const previousDaysForBasicFeatures = allHistoryForSequence.slice(0, i + j);
        const previousDaysForAdvancedFeatures = previousDaysForBasicFeatures.slice().reverse();
        const basicFeatures = this.featureService.extractAllFeatures(currentDayForFeature, previousDaysForBasicFeatures, dateStr);
        const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
        let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
        if (finalFeatureVector.some(isNaN) || finalFeatureVector.some(val => val === null || val === undefined)) {
          console.warn(`⚠️ Giá trị không hợp lệ cho ngày ${dateStr}. Làm sạch...`);
          finalFeatureVector = finalFeatureVector.map(val => isNaN(val) || val == null ? 0 : val);
        }
        const EXPECTED_FEATURE_SIZE = 346;
        if (finalFeatureVector.length !== EXPECTED_FEATURE_SIZE) {
          console.warn(`Sai size cho ngày ${dateStr}: ${finalFeatureVector.length}. Điều chỉnh...`);
          finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_FEATURE_SIZE).concat(Array(Math.max(0, EXPECTED_FEATURE_SIZE - finalFeatureVector.length)).fill(0));
        }
        inputSequence.push(finalFeatureVector);
        allFeatures = allFeatures.concat(finalFeatureVector); // Thu thập để normalize
      }
      const targetGDB = (grouped[targetDayString] || []).find(r => r.giai === 'ĐB');
      if (targetGDB?.so && String(targetGDB.so).length >= 5) {
        const targetGDBString = String(targetGDB.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);
        if (targetArray.some(isNaN)) {
          console.error(`Target invalid cho ngày ${targetDayString}. Bỏ qua.`);
          continue;
        }
        trainingData.push({ inputSequence, targetArray });
      }
    }
    if (trainingData.length > 0) {
      // Normalize toàn bộ features (min-max)
      const min = Math.min(...allFeatures);
      const max = Math.max(...allFeatures);
      console.log(`Normalizing features: min=${min}, max=${max}`);
      trainingData.forEach(d => {
        d.inputSequence = d.inputSequence.map(seq => seq.map(v => (v - min) / (max - min + 1e-8)));
      });
      this.inputNodes = trainingData[0].inputSequence[0].length;
      console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi với feature size: ${this.inputNodes}`);
    } else {
      throw new Error("❌ Không có dữ liệu training hợp lệ.");
    }
    return trainingData;
  }
  // Các hàm còn lại giữ nguyên...
  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử với kiến trúc Premium...');
    const trainingData = await this.prepareTrainingData();
    if (trainingData.length === 0 || trainingData.some(d => d.inputSequence.length !== SEQUENCE_LENGTH || d.inputSequence.flat().some(isNaN))) {
      throw new Error('Dữ liệu training rỗng hoặc invalid. Kiểm tra DB.');
    }
    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);
    this.buildModel(this.inputNodes);
    this.model.compile({
      optimizer: tf.train.adam({learningRate: 0.0005, clipnorm: 1.0}), // Clip gradients tránh explosion
      loss: 'binaryCrossentropy',
      metrics: [] // Bỏ metrics tạm nếu gây issue
    });
    console.log('✅ Model compile OK. Training...');
    await this.trainModel({ inputs, targets });
    await this.saveModel();
    return {
      message: `Huấn luyện OK: ${trainingData.length} sequences, ${EPOCHS} epochs.`,
      sequences: trainingData.length,
      epochs: EPOCHS,
      featureSize: this.inputNodes,
      modelName: NN_MODEL_NAME
    };
  }
  
  async runLearning() {
  console.log('🔔 [TensorFlow Service] Learning from new results...');
  
  if (!this.model) {
    const modelLoaded = await this.loadModel();
    if (!modelLoaded) {
      throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện lịch sử trước.');
    }
  }

  // Lấy các dự đoán chưa được học
  const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
  if (predictionsToLearn.length === 0) {
    return { message: 'Không có dự đoán mới nào để học.' };
  }

  const results = await Result.find().sort({ 'ngay': 1 }).lean();
  const grouped = {};
  results.forEach(r => {
    if (!grouped[r.ngay]) grouped[r.ngay] = [];
    grouped[r.ngay].push(r);
  });

  const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
  
  let learnedCount = 0;
  const trainingData = [];

  for (const pred of predictionsToLearn) {
    const targetDayStr = pred.ngayDuDoan;
    const targetDayIndex = days.indexOf(targetDayStr);

    if (targetDayIndex >= SEQUENCE_LENGTH) {
      const actualResult = (grouped[targetDayStr] || []).find(r => r.giai === 'ĐB');
      
      if (actualResult?.so && String(actualResult.so).length >= 5) {
        // Lấy chuỗi input
        const sequenceDays = days.slice(targetDayIndex - SEQUENCE_LENGTH, targetDayIndex);
        const previousDays = [];
        const inputSequence = sequenceDays.map(day => {
          const dayResults = grouped[day] || [];
          const prevDays = previousDays.slice();
          previousDays.push(dayResults);
          return this.featureService.extractAllFeatures(dayResults, prevDays, day);
        });

        // Lấy target
        const targetGDBString = String(actualResult.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);
        
        trainingData.push({ inputSequence, targetArray });
        learnedCount++;
      }
    }
    // Đánh dấu đã học
    await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
  }

  if (trainingData.length > 0) {
    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);

    // Huấn luyện thêm với dữ liệu mới
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    await this.model.fit(inputTensor, targetTensor, {
      epochs: 3, // Số epoch ít hơn để học nhanh
      batchSize: Math.min(BATCH_SIZE, inputs.length),
      validationSplit: 0.1
    });

    inputTensor.dispose();
    targetTensor.dispose();

    await this.saveModel();
  }
  
  return { message: `TensorFlow LSTM đã học xong. Đã xử lý ${learnedCount} kết quả mới.` };
}

  async runNextDayPrediction() {
    console.log('🔔 [TensorFlow Service] Generating next day prediction...');
    
    if (!this.model) {
      const modelLoaded = await this.loadModel();
      if (!modelLoaded) {
        throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện trước.');
      }
    }

    const results = await Result.find().lean();
    if (results.length < SEQUENCE_LENGTH) {
      throw new Error(`Không đủ dữ liệu. Cần ít nhất ${SEQUENCE_LENGTH} ngày.`);
    }

    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.ngay]) grouped[r.ngay] = [];
      grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    const latestSequenceDays = days.slice(-SEQUENCE_LENGTH);

    const previousDays = [];
    const inputSequence = latestSequenceDays.map(day => {
      const dayResults = grouped[day] || [];
      const prevDays = previousDays.slice();
      previousDays.push(dayResults);
      return this.featureService.extractAllFeatures(dayResults, prevDays, day);
    });

    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = latestSequenceDays[latestSequenceDays.length - 1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    await NNPrediction.findOneAndUpdate(
      { ngayDuDoan: nextDayStr },
      { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false },
      { upsert: true, new: true }
    );

    return {
      message: `TensorFlow LSTM đã tạo dự đoán cho ngày ${nextDayStr}.`,
      ngayDuDoan: nextDayStr
    };
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

module.exports = TensorFlowService;
