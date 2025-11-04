const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const { DateTime } = require('luxon');

const NN_MODEL_NAME = 'GDB_LSTM_TFJS_PREMIUM_V1';
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 50;
const BATCH_SIZE = 32;

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    this.inputNodes = 0;
  }

  async buildModel(inputNodes) {
    console.log(`🏗️ Xây dựng model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    // LỚP ĐẦU TIÊN: GIẢM ĐƠN GIẢN HÓA
    model.add(tf.layers.lstm({
        units: 32,  // GIẢM XUỐNG 32
        returnSequences: false, // KHÔNG return sequences để giảm độ phức tạp
        inputShape: [SEQUENCE_LENGTH, inputNodes],
        kernelInitializer: 'glorotNormal', // Initializer ổn định hơn
        recurrentInitializer: 'orthogonal',
        kernelRegularizer: tf.regularizers.l2({l2: 0.001}), // Giảm regularization
        recurrentRegularizer: tf.regularizers.l2({l2: 0.001}),
        // THÊM gradient clipping ở cấp độ layer
        kernelConstraint: tf.constraints.maxNorm({maxValue: 1}),
        recurrentConstraint: tf.constraints.maxNorm({maxValue: 1})
    }));

    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({rate: 0.2})); // Giảm dropout
    
    model.add(tf.layers.dense({
        units: 16,  // GIẢM XUỐNG 16
        activation: 'relu',
        kernelInitializer: 'glorotNormal',
        kernelRegularizer: tf.regularizers.l2({l2: 0.001})
    }));

    model.add(tf.layers.dense({
        units: OUTPUT_NODES,
        activation: 'sigmoid',
        kernelInitializer: 'glorotNormal'
    }));
    
    model.summary();

    // COMPILE VỚI CÀI ĐẶT AN TOÀN HƠN
    const optimizer = tf.train.adam(0.0005); // Learning rate nhỏ hơn
    
    model.compile({
    optimizer: tf.train.adam(0.0005),
    loss: 'meanSquaredError', // THỬ HÀM LOSS KHÁC
    metrics: []
});

    this.model = model;
    return this.model;
}

  async trainModel(trainingData) {
    const { inputs, targets } = trainingData;
    
    console.log('🔍 Kiểm tra cuối cùng trước khi training:');
    console.log('- Inputs length:', inputs.length);
    console.log('- Targets length:', targets.length);
    
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    // SỬ DỤNG OPTIMIZER VỚI GRADIENT CLIPPING
    const optimizer = tf.train.adam(0.0005);
    
    // CẬP NHẬT OPTIMIZER CHO MODEL
    this.model.compile({
        optimizer: optimizer,
        loss: 'binaryCrossentropy',
        metrics: []
    });

    const history = await this.model.fit(inputTensor, targetTensor, {
        epochs: EPOCHS,
        batchSize: Math.min(BATCH_SIZE, inputs.length), // Đảm bảo batch size không quá lớn
        validationSplit: 0.1,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if (isNaN(logs.loss)) {
                    console.error('❌ NaN loss detected! Stopping training.');
                    this.model.stopTraining = true;
                    console.log('📊 Debug info:', {
                        epoch,
                        inputShape: inputTensor.shape,
                        targetShape: targetTensor.shape
                    });
                } else {
                    console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}`);
                }
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
        target[index * 10 + d] = 0.99;
      }
    });
    return target;
  }

  async prepareTrainingData() {
    console.log('📝 Bắt đầu chuẩn bị dữ liệu huấn luyện...');
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    // KIỂM TRA TÍNH ỔN ĐỊNH CỦA FEATURES
const featureStabilityCheck = (features) => {
    const mean = features.reduce((a, b) => a + b, 0) / features.length;
    const variance = features.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / features.length;
    const std = Math.sqrt(variance);
    
    console.log(`📊 Feature stability - Mean: ${mean.toFixed(4)}, Std: ${std.toFixed(4)}`);
    
    // Nếu std quá thấp, có thể features không đa dạng
    if (std < 0.01) {
        console.warn('⚠️ Feature std quá thấp, có thể cần đa dạng hóa features');
    }
};

if (trainingData.length > 0) {
    const sampleFeatures = trainingData[0].inputSequence.flat();
    featureStabilityCheck(sampleFeatures);
    
    this.inputNodes = trainingData[0].inputSequence[0].length;
    console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu hợp lệ`);
}
    console.log(`📊 Tổng số bản ghi trong DB: ${results.length}`);
    console.log('📋 5 bản ghi đầu tiên:', results.slice(0, 5).map(r => ({ ngay: r.ngay, giai: r.giai, so: r.so })));

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

    console.log(`📅 Tổng số ngày có dữ liệu: ${days.length}`);
    console.log('📅 5 ngày đầu:', days.slice(0, 5));

    for (let i = 0; i < days.length - SEQUENCE_LENGTH; i++) {
      const sequenceDaysStrings = days.slice(i, i + SEQUENCE_LENGTH);
      const targetDayString = days[i + SEQUENCE_LENGTH];
      
      const inputSequence = [];
      let sequenceValid = true;

      for(let j = 0; j < SEQUENCE_LENGTH; j++) {
        const currentDayForFeature = grouped[sequenceDaysStrings[j]] || [];
        const dateStr = sequenceDaysStrings[j];
        
        const previousDaysForBasicFeatures = days.slice(0, i + j).map(day => grouped[day] || []);
        const previousDaysForAdvancedFeatures = previousDaysForBasicFeatures.slice().reverse();

        const basicFeatures = this.featureService.extractAllFeatures(currentDayForFeature, previousDaysForBasicFeatures, dateStr);
        const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(currentDayForFeature, previousDaysForAdvancedFeatures);
        
        let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
        
        const hasInvalid = finalFeatureVector.some(val => 
          isNaN(val) || val === null || val === undefined || !isFinite(val)
        );
        
        if (hasInvalid) {
          console.error(`❌ Dữ liệu không hợp lệ ở ngày ${dateStr}:`, {
            basicFeatures: basicFeatures.some(v => isNaN(v)),
            advancedFeatures: Object.values(advancedFeatures).flat().some(v => isNaN(v)),
            finalVector: finalFeatureVector.filter(v => isNaN(v)).length
          });
          sequenceValid = false;
          break;
        }
        
        const EXPECTED_SIZE = 346;
        if (finalFeatureVector.length !== EXPECTED_SIZE) {
          console.warn(`⚠️ Điều chỉnh kích thước feature vector: ${finalFeatureVector.length} -> ${EXPECTED_SIZE}`);
          if (finalFeatureVector.length > EXPECTED_SIZE) {
            finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_SIZE);
          } else {
            finalFeatureVector = [...finalFeatureVector, ...Array(EXPECTED_SIZE - finalFeatureVector.length).fill(0)];
          }
        }
        
        inputSequence.push(finalFeatureVector);
      }

      if (!sequenceValid) continue;

      const targetGDB = (grouped[targetDayString] || []).find(r => r.giai === 'ĐB');
      if (targetGDB?.so && String(targetGDB.so).length >= 5) {
        const targetGDBString = String(targetGDB.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);

        const invalidTargets = targetArray.filter(val => isNaN(val) || val === null || val === undefined);
        if (invalidTargets.length > 0) {
          console.error(`❌ Target không hợp lệ cho ngày ${targetDayString}:`, invalidTargets.length);
          continue;
        }

        trainingData.push({ inputSequence, targetArray });
      }
    }

    // DEBUG CHI TIẾT
if (trainingData.length > 0) {
  console.log('🔍 DEBUG - Kiểm tra dữ liệu training:');
  console.log(`- Số chuỗi: ${trainingData.length}`);
  console.log(`- Kích thước input sequence: ${trainingData[0].inputSequence.length}`);
  console.log(`- Kích thước feature vector: ${trainingData[0].inputSequence[0].length}`);
  
  // THAY THẾ flatMap BẰNG VÒNG LẶP THÔNG THƯỜNG ĐỂ TRÁNH TRÀN STACK
  let allFeatures = [];
  let allTargets = [];
  
  // Sử dụng vòng lặp thay vì flatMap để tránh tràn stack
  for (let i = 0; i < trainingData.length; i++) {
    const data = trainingData[i];
    
    // Xử lý features
    for (let j = 0; j < data.inputSequence.length; j++) {
      allFeatures = allFeatures.concat(data.inputSequence[j]);
    }
    
    // Xử lý targets
    allTargets = allTargets.concat(data.targetArray);
  }
  
  // Kiểm tra min/max an toàn hơn
  let featuresMin = Infinity, featuresMax = -Infinity;
  let targetsMin = Infinity, targetsMax = -Infinity;
  
  for (let i = 0; i < allFeatures.length; i++) {
    const val = allFeatures[i];
    if (val < featuresMin) featuresMin = val;
    if (val > featuresMax) featuresMax = val;
  }
  
  for (let i = 0; i < allTargets.length; i++) {
    const val = allTargets[i];
    if (val < targetsMin) targetsMin = val;
    if (val > targetsMax) targetsMax = val;
  }
  
  console.log(`- Features - Min: ${featuresMin}, Max: ${featuresMax}`);
  console.log(`- Targets - Min: ${targetsMin}, Max: ${targetsMax}`);
  
  // Kiểm tra NaN an toàn hơn
  let nanFeaturesCount = 0;
  let nanTargetsCount = 0;
  
  for (let i = 0; i < allFeatures.length; i++) {
    if (isNaN(allFeatures[i])) nanFeaturesCount++;
  }
  
  for (let i = 0; i < allTargets.length; i++) {
    if (isNaN(allTargets[i])) nanTargetsCount++;
  }
  
  console.log(`- NaN trong features: ${nanFeaturesCount}`);
  console.log(`- NaN trong targets: ${nanTargetsCount}`);
  
  this.inputNodes = trainingData[0].inputSequence[0].length;
  console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu hợp lệ`);
} else {
  throw new Error("❌ Không có dữ liệu training hợp lệ sau khi kiểm tra.");
}

    return trainingData;
  }

  dateKey(s) {
    if (!s || typeof s !== 'string') return '';
    const parts = s.split('/');
    return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }

  async saveModel() {
    if (!this.model) {
      throw new Error('No model to save');
    }
    const modelInfo = {
      modelName: NN_MODEL_NAME,
      inputNodes: this.inputNodes,
      savedAt: new Date().toISOString()
    };
    
    const saveResult = await this.model.save('file://./models/tfjs_model');
   
    await NNState.findOneAndUpdate(
      { modelName: NN_MODEL_NAME },
      {
        state: modelInfo,
        modelArtifacts: saveResult
      },
      { upsert: true }
    );
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

  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử với kiến trúc Premium...');
   
    const trainingData = await this.prepareTrainingData();
    if (trainingData.length === 0 || trainingData.some(d => d.inputSequence.length !== SEQUENCE_LENGTH || d.inputSequence.flat().some(isNaN))) {
      throw new Error('Dữ liệu training rỗng hoặc chứa giá trị không hợp lệ. Kiểm tra DB và feature engineering.');
    }
    
    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);
    
    await this.buildModel(this.inputNodes);
    
    this.model.compile({
      optimizer: tf.train.adam({learningRate: 0.0005}),
      loss: 'binaryCrossentropy',
      metrics: []
    });
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training...');
    
    await this.trainModel({ inputs, targets });
   
    await this.saveModel();
    
    return {
      message: `Huấn luyện Premium Model hoàn tất. Đã xử lý ${trainingData.length} chuỗi, ${EPOCHS} epochs.`,
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
          const sequenceDays = days.slice(targetDayIndex - SEQUENCE_LENGTH, targetDayIndex);
          const previousDays = [];
          const inputSequence = sequenceDays.map(day => {
            const dayResults = grouped[day] || [];
            const prevDays = previousDays.slice();
            previousDays.push(dayResults);
            return this.featureService.extractAllFeatures(dayResults, prevDays, day);
          });

          const targetGDBString = String(actualResult.so).padStart(5, '0');
          const targetArray = this.prepareTarget(targetGDBString);
          
          trainingData.push({ inputSequence, targetArray });
          learnedCount++;
        }
      }
      
      await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }

    if (trainingData.length > 0) {
      const inputs = trainingData.map(d => d.inputSequence);
      const targets = trainingData.map(d => d.targetArray);

      const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
      const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

      await this.model.fit(inputTensor, targetTensor, {
        epochs: 3,
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
