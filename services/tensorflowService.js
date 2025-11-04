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
    console.log(`🏗️ Xây dựng model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    // GIẢM ĐỘ PHỨC TẠP CỦA MÔ HÌNH
    model.add(tf.layers.lstm({
        units: 64,  // GIẢM từ 192 xuống 64
        returnSequences: true,
        inputShape: [SEQUENCE_LENGTH, inputNodes],
        kernelRegularizer: tf.regularizers.l2({l2: 0.01}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.01})
    }));

    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({rate: 0.3}));

    model.add(tf.layers.lstm({
        units: 32,  // GIẢM từ 96 xuống 32
        returnSequences: false,
        kernelRegularizer: tf.regularizers.l2({l2: 0.01}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.01})
    }));

    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({rate: 0.3}));
    
    model.add(tf.layers.dense({
        units: 24,  // GIẢM từ 48 xuống 24
        activation: 'relu',
        kernelRegularizer: tf.regularizers.l2({l2: 0.01})
    }));

    model.add(tf.layers.dense({
        units: OUTPUT_NODES,
        activation: 'sigmoid'
    }));
    
    model.summary();

    // COMPILE VỚI CÀI ĐẶT AN TOÀN
    model.compile({
        optimizer: tf.train.adam(0.001), // Learning rate nhỏ hơn
        loss: 'binaryCrossentropy',
        metrics: [] // TẠM THỜI BỎ METRICS
    });

    this.model = model;
    return this.model;
}
  async trainModel(trainingData) {
    const { inputs, targets } = trainingData;
    
    // KIỂM TRA CUỐI CÙNG
    console.log('🔍 Kiểm tra cuối cùng trước khi training:');
    console.log('- Inputs length:', inputs.length);
    console.log('- Targets length:', targets.length);
    
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    // THÊM GRADIENT CLIPPING
    const optimizer = tf.train.adam(0.001);
    
    const history = await this.model.fit(inputTensor, targetTensor, {
        epochs: EPOCHS,
        batchSize: BATCH_SIZE,
        validationSplit: 0.1,
        callbacks: {
            onEpochEnd: (epoch, logs) => {
                if (isNaN(logs.loss)) {
                    console.error('❌ NaN loss detected! Stopping training.');
                    this.model.stopTraining = true;
                    // IN THÊM THÔNG TIN DEBUG
                    console.log('📊 Debug info:', {
                        epoch,
                        inputShape: inputTensor.shape,
                        targetShape: targetTensor.shape,
                        inputMin: inputTensor.min().dataSync()[0],
                        inputMax: inputTensor.max().dataSync()[0],
                        targetMin: targetTensor.min().dataSync()[0],
                        targetMax: targetTensor.max().dataSync()[0]
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
// ... target[index * 10 + d] = 1;
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
  
  // DEBUG: Kiểm tra dữ liệu gốc
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
      
      // KIỂM TRA KỸ LƯỠNG HƠN
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
      
      // ĐẢM BẢO KÍCH THƯỚC CHUẨN
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

      // KIỂM TRA TARGET
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
    
    // Kiểm tra giá trị min/max của features
    const allFeatures = trainingData.flatMap(d => d.inputSequence.flat());
    const allTargets = trainingData.flatMap(d => d.targetArray);
    
    console.log(`- Features - Min: ${Math.min(...allFeatures)}, Max: ${Math.max(...allFeatures)}`);
    console.log(`- Targets - Min: ${Math.min(...allTargets)}, Max: ${Math.max(...allTargets)}`);
    
    // Kiểm tra NaN
    const nanFeatures = allFeatures.filter(v => isNaN(v));
    const nanTargets = allTargets.filter(v => isNaN(v));
    console.log(`- NaN trong features: ${nanFeatures.length}`);
    console.log(`- NaN trong targets: ${nanTargets.length}`);
    
    this.inputNodes = trainingData[0].inputSequence[0].length;
    console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu hợp lệ`);
  } else {
    throw new Error("❌ Không có dữ liệu training hợp lệ sau khi kiểm tra.");
  }

  return trainingData;
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
    // Lưu model dưới dạng JSON (có thể lưu vào file hoặc database)
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
  // =================================================================
  // CẬP NHẬT HÀM runHistoricalTraining ĐỂ SỬ DỤNG MODEL MỚI
  // =================================================================
  async runHistoricalTraining() {
   
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử với kiến trúc Premium...');
   
    const trainingData = await this.prepareTrainingData(); // Hàm này đã được cập nhật ở Bước 1
    if (trainingData.length === 0 || trainingData.some(d => d.inputSequence.length !== SEQUENCE_LENGTH || d.inputSequence.flat().some(isNaN))) {
    throw new Error('Dữ liệu training rỗng hoặc chứa giá trị không hợp lệ. Kiểm tra DB và feature engineering.');
}
    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);
    // Xây dựng model mới dựa trên số features thực tế
    // this.inputNodes đã được cập nhật trong prepareTrainingData
    this.buildModel(this.inputNodes);
    // COMPILE MODEL: Cấu hình quá trình học
    this.model.compile({
  optimizer: tf.train.adam({learningRate: 0.0005}),
  loss: 'binaryCrossentropy',
  // TẠM BỎ METRICS ĐỂ DEBUG
  // metrics: [tf.metrics.binaryAccuracy()]
  metrics: [] // Bỏ trống để tránh lỗi
});
    console.log('✅ Model đã được compile. Bắt đầu quá trình training...');
    // Huấn luyện model
    await this.trainModel({ inputs, targets });
   
    // Lưu model sau khi huấn luyện xong
    await this.saveModel();
    return {
      message: Huấn luyện Premium Model hoàn tất. Đã xử lý ${trainingData.length} chuỗi, ${EPOCHS} epochs.,
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
 
  return { message: TensorFlow LSTM đã học xong. Đã xử lý ${learnedCount} kết quả mới. };
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
      throw new Error(Không đủ dữ liệu. Cần ít nhất ${SEQUENCE_LENGTH} ngày.);
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
      message: TensorFlow LSTM đã tạo dự đoán cho ngày ${nextDayStr}.,
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
      prediction[pos${i + 1}] = digitsWithValues;
    }
    return prediction;
  }
}
module.exports = TensorFlowService;
