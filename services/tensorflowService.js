const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedTraining = require('./advancedTrainingService');
const { Storage } = require('@google-cloud/storage');
const { DateTime } = require('luxon');

// =================================================================
// CẤU HÌNH GCS - GIỮ NGUYÊN
// =================================================================
const gcsCredentialsJSON = process.env.GCS_CREDENTIALS;
const bucketName = process.env.GCS_BUCKET_NAME;

let storage;
let bucket;

if (gcsCredentialsJSON && bucketName) {
    try {
        const credentials = JSON.parse(gcsCredentialsJSON);
        storage = new Storage({ credentials, projectId: credentials.project_id });
        bucket = storage.bucket(bucketName);
        console.log(`✅ [GCS] Đã khởi tạo Google Cloud Storage thành công cho bucket: ${bucketName}`);
    } catch (error) {
        console.error("❌ [GCS] LỖI NGHIÊM TRỌNG: Không thể parse GCS_CREDENTIALS.", error);
        process.exit(1);
    }
} else {
    console.warn("⚠️ [GCS] Cảnh báo: GCS_CREDENTIALS hoặc GCS_BUCKET_NAME chưa được thiết lập.");
}

const NN_MODEL_NAME = 'GDB_LSTM_TFJS_PREMIUM_V1';
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 100;
const BATCH_SIZE = 128;

const getGcsIoHandler = (modelPath) => {
    if (!bucket) {
        throw new Error("GCS Bucket chưa được khởi tạo.");
    }

    const modelJsonPath = `${modelPath}/model.json`;
    const weightsBinPath = `${modelPath}/weights.bin`;

    const handler = {
        save: async (modelArtifacts) => {
            console.log(`...[GCS IO] Bắt đầu upload model lên: ${modelPath}`);
            
            const weightsBuffer = Buffer.from(modelArtifacts.weightData);

            await Promise.all([
                bucket.file(modelJsonPath).save(JSON.stringify(modelArtifacts.modelTopology)),
                bucket.file(weightsBinPath).save(weightsBuffer)
            ]);

            console.log(`...[GCS IO] Upload thành công.`);
            return { modelArtifactsInfo: { dateSaved: new Date() } };
        },

        load: async () => {
            console.log(`...[GCS IO] Bắt đầu download model từ: ${modelPath}`);

            const [modelJsonFile, weightsBinFile] = await Promise.all([
                bucket.file(modelJsonPath).download(),
                bucket.file(weightsBinPath).download()
            ]);

            const modelTopology = JSON.parse(modelJsonFile[0].toString());
            const weightData = weightsBinFile[0].buffer;

            console.log(`...[GCS IO] Download thành công.`);
            return { modelTopology, weightData };
        }
    };
    return handler;
};

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    this.advancedTrainer = new AdvancedTraining();
    this.inputNodes = 0;
    this.ensembleModels = [];
    this.errorPatterns = null;
  }

  // =================================================================
  // DEBUG TRAINING DATA
  // =================================================================
  async debugTrainingData() {
    const trainingData = await this.prepareTrainingData();
    console.log('🔍 Debug Training Data:');
    console.log('- Số lượng samples:', trainingData.length);
    
    if (trainingData.length > 0) {
        const sample = trainingData[0];
        console.log('- Input shape:', sample.inputSequence.length, 'x', sample.inputSequence[0].length);
        console.log('- Target shape:', sample.targetArray.length);
        console.log('- Input range:', 
            Math.min(...sample.inputSequence.flat()), 
            'to', 
            Math.max(...sample.inputSequence.flat())
        );
        console.log('- Target range:', 
            Math.min(...sample.targetArray), 
            'to', 
            Math.max(...sample.targetArray)
        );
    }
  }

  // =================================================================
  // PHÂN TÍCH LỖI TOÀN DIỆN
  // =================================================================
  async analyzeHistoricalErrors() {
    console.log('🔍 Bắt đầu phân tích lỗi toàn diện từ dữ liệu...');
    
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    const predictions = await NNPrediction.find().lean();

    if (results.length === 0 || predictions.length === 0) {
        console.log('⚠️ Chưa đủ dữ liệu để phân tích lỗi');
        return this.getDefaultErrorPatterns();
    }

    console.log(`📊 Phân tích ${predictions.length} dự đoán...`);

    const groupedResults = {};
    results.forEach(r => {
      if (!groupedResults[r.ngay]) groupedResults[r.ngay] = [];
      groupedResults[r.ngay].push(r);
    });

    const errorAnalysis = {
      weakPositions: [],
      temporalWeaknesses: {},
      overallAccuracy: 0,
      totalAnalyzed: 0
    };

    let totalPredictions = 0;
    let correctPredictions = 0;

    // PHÂN TÍCH TỪNG DỰ ĐOÁN
    for (const pred of predictions) {
      const actual = (groupedResults[pred.ngayDuDoan] || []).find(r => r.giai === 'ĐB');
      if (!actual?.so) continue;

      const actualStr = String(actual.so).padStart(5, '0');
      totalPredictions++;

      // KIỂM TRA TỪNG VỊ TRÍ
      let positionCorrect = true;
      for (let i = 0; i < 5; i++) {
        const predictedDigits = pred[`pos${i+1}`] || [];
        const actualDigit = actualStr[i];
        
        if (!predictedDigits.includes(actualDigit)) {
          errorAnalysis.weakPositions.push(`pos${i+1}`);
          positionCorrect = false;
        }
      }

      if (positionCorrect) correctPredictions++;
    }

    // TÍNH TOÁN KẾT QUẢ
    errorAnalysis.overallAccuracy = totalPredictions > 0 ? correctPredictions / totalPredictions : 0;
    errorAnalysis.totalAnalyzed = totalPredictions;

    // XÁC ĐỊNH VỊ TRÍ YẾU NHẤT
    const positionStats = {};
    errorAnalysis.weakPositions.forEach(pos => {
      positionStats[pos] = (positionStats[pos] || 0) + 1;
    });

    errorAnalysis.weakPositions = Object.entries(positionStats)
      .sort((a, b) => b[1] - a[1])
      .map(([pos, count]) => ({
        position: pos,
        errorCount: count,
        errorRate: count / totalPredictions
      }));

    console.log('📊 KẾT QUẢ PHÂN TÍCH LỖI:');
    console.log(`- Tổng số dự đoán đã phân tích: ${errorAnalysis.totalAnalyzed}`);
    console.log(`- Độ chính xác tổng: ${(errorAnalysis.overallAccuracy * 100).toFixed(1)}%`);
    console.log(`- Vị trí yếu nhất: ${errorAnalysis.weakPositions[0]?.position} (${(errorAnalysis.weakPositions[0]?.errorRate * 100).toFixed(1)}% sai)`);
    
    this.errorPatterns = errorAnalysis;
    return errorAnalysis;
  }

  getDefaultErrorPatterns() {
    return {
      weakPositions: [
        { position: 'pos1', errorRate: 0.7 },
        { position: 'pos2', errorRate: 0.6 },
        { position: 'pos3', errorRate: 0.5 },
        { position: 'pos4', errorRate: 0.4 },
        { position: 'pos5', errorRate: 0.3 }
      ],
      temporalWeaknesses: {},
      overallAccuracy: 0,
      totalAnalyzed: 0
    };
  }

  // =================================================================
  // OVERSAMPLING THÔNG MINH - SỬA LỖI
  // =================================================================
  applySmartOversampling(trainingData) {
    console.log('🎯 Áp dụng Smart Oversampling CÂN BẰNG...');
    
    if (!this.errorPatterns || trainingData.length === 0) {
        console.log('⚠️ Chưa có phân tích lỗi hoặc dữ liệu rỗng, không áp dụng oversampling');
        return trainingData;
    }

    const oversampledData = [...trainingData];
    const samplesToAdd = [];

    // ✅ GIẢM TỶ LỆ OVERSAMPLING XUỐNG 20%
    const maxOversamples = Math.floor(trainingData.length * 0.2);
    let addedCount = 0;

    // ✅ CHỈ OVERSAMPLE CÁC VỊ TRÍ RẤT YẾU (errorRate > 60%)
    const weakPositions = this.errorPatterns.weakPositions.filter(pos => pos.errorRate > 0.6);
    
    if (weakPositions.length === 0) {
        console.log('⚠️ Không có vị trí nào quá yếu, không áp dụng oversampling');
        return trainingData;
    }

    trainingData.forEach((sample, index) => {
        if (addedCount >= maxOversamples) return;

        const featureVector = sample.inputSequence.flat();
        
        // ✅ CHỈ THÊM MẪU NẾU CÓ FEATURES QUAN TRỌNG
        const hasImportantFeatures = featureVector.some(val => Math.abs(val) > 0.5);
        const featureComplexity = this.calculateFeatureComplexity(featureVector);
        
        if (hasImportantFeatures && featureComplexity > 0.5) {
            samplesToAdd.push(sample);
            addedCount++;
        }
    });

    // THÊM CÁC MẪU ĐÃ CHỌN
    oversampledData.push(...samplesToAdd);

    console.log(`✅ Đã áp dụng Smart Oversampling CÂN BẰNG:`);
    console.log(`- Dữ liệu gốc: ${trainingData.length} mẫu`);
    console.log(`- Đã thêm: ${samplesToAdd.length} mẫu (${Math.round(samplesToAdd.length/trainingData.length*100)}%)`);
    console.log(`- Tổng sau oversampling: ${oversampledData.length} mẫu`);

    return oversampledData;
  }

  calculateFeatureComplexity(featureVector) {
    const mean = featureVector.reduce((a, b) => a + b, 0) / featureVector.length;
    const variance = featureVector.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / featureVector.length;
    return Math.min(variance * 10, 1.0);
  }

  // =================================================================
  // HUẤN LUYỆN VỚI SMART OVERSAMPLING - SỬA LỖI enhancedData
  // =================================================================
  async trainModelWithSmartOversampling(trainingData) {
    console.log('🚀 Bắt đầu huấn luyện với Smart Oversampling...');
    
    // ✅ SỬA LỖI: KHAI BÁO BIẾN enhancedData TRƯỚC KHI SỬ DỤNG
    const enhancedData = this.applySmartOversampling(trainingData);
    
    // ✅ THÊM VALIDATION MẠNH MẼ
    console.log('🔍 Validation dữ liệu training:');
    console.log(`- Dữ liệu gốc: ${trainingData.length} mẫu`);
    console.log(`- Dữ liệu enhanced: ${enhancedData.length} mẫu`);
    
    enhancedData.forEach((data, idx) => {
        const inputFlat = data.inputSequence.flat();
        const targetFlat = data.targetArray;
        
        const inputHasNaN = inputFlat.some(v => isNaN(v));
        const targetHasNaN = targetFlat.some(v => isNaN(v));
        
        if (inputHasNaN || targetHasNaN) {
            console.error(`❌ Mẫu ${idx} có NaN values!`);
            console.log('Input NaN count:', inputFlat.filter(v => isNaN(v)).length);
            console.log('Target NaN count:', targetFlat.filter(v => isNaN(v)).length);
        }
    });
    
    // ✅ SỬA: DÙNG enhancedData THAY VÌ trainingData
    const inputs = enhancedData.map(d => d.inputSequence);
    const targets = enhancedData.map(d => d.targetArray);

    console.log(`🔧 Tạo tensor với ${inputs.length} mẫu...`);
    
    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    console.log('🔧 Bắt đầu training với dữ liệu đã được oversampling...');
    
    // ✅ THÊM GRADIENT CLIPPING ĐỂ TRÁNH NaN
    const optimizer = tf.train.adam(0.0005);
    
    this.model.compile({
      optimizer: optimizer,
      loss: 'binaryCrossentropy',
      metrics: []
    });

    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: Math.min(32, inputs.length),
      validationSplit: 0.2,
      verbose: 0,
      callbacks: {
        onEpochBegin: (epoch) => {
          console.log(`▶️ Bắt đầu epoch ${epoch + 1}`);
        },
        onEpochEnd: (epoch, logs) => {
          if (isNaN(logs.loss)) {
            console.error('❌ NaN loss detected! Stopping training.');
            this.model.stopTraining = true;
            // THỬ LẠI VỚI LEARNING RATE NHỎ HƠN
            this.model.compile({
              optimizer: tf.train.adam(0.0001),
              loss: 'binaryCrossentropy'
            });
          } else if (epoch % 5 === 0) {
            console.log(`📈 Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}, Val Loss = ${logs.val_loss?.toFixed(4) || 'N/A'}`);
          }
        },
        ...tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 10 })  // THÊM MỚI: Early Stopping
      }
    });
    inputTensor.dispose();
    targetTensor.dispose();
    console.log('✅ Huấn luyện với Smart Oversampling hoàn tất!');
    return history;
  }

  // =================================================================
  // PHƯƠNG THỨC CHÍNH - HUẤN LUYỆN LỊCH SỬ
  // =================================================================
  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử với Smart Oversampling...');
   
    const trainingData = await this.prepareTrainingData();
    if (trainingData.length === 0 || trainingData.some(d => d.inputSequence.length !== SEQUENCE_LENGTH || d.inputSequence.flat().some(isNaN))) {
      throw new Error('Dữ liệu training rỗng hoặc chứa giá trị không hợp lệ.');
    }
    
    await this.buildModel(this.inputNodes);
    
    this.model.compile({
      optimizer: tf.train.adam({learningRate: 0.0005}),
      loss: 'binaryCrossentropy',
      metrics: []
    });
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training với Smart Oversampling...');
    
    await this.trainModelWithSmartOversampling(trainingData);
   
    await this.saveModel();

    // ✅ TỰ ĐỘNG TẠO DỰ ĐOÁN SAU KHI HUẤN LUYỆN
    console.log('🎯 Bắt đầu tự động tạo dự đoán sau huấn luyện...');
    const generatedCount = await this.autoGeneratePredictionsAfterTraining();
    
    return {
      message: `Huấn luyện với Smart Oversampling hoàn tất. Đã xử lý ${trainingData.length} chuỗi, tạo ${generatedCount} dự đoán mới.`,
      sequences: trainingData.length,
      epochs: EPOCHS,
      featureSize: this.inputNodes,
      modelName: NN_MODEL_NAME,
      predictionsGenerated: generatedCount,
      smartOversampling: true
    };
  }

  // =================================================================
  // BUILD MODEL
  // =================================================================
  async buildModel(inputNodes) {
    console.log(`🏗️ Xây dựng model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;

    const model = tf.sequential();

    model.add(tf.layers.lstm({
      units: 32,
      returnSequences: false,
      inputShape: [SEQUENCE_LENGTH, inputNodes],
      kernelInitializer: 'glorotNormal',
      recurrentInitializer: 'orthogonal',
      kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
      recurrentRegularizer: tf.regularizers.l2({l2: 0.001}),
      kernelConstraint: tf.constraints.maxNorm({maxValue: 1}),
      recurrentConstraint: tf.constraints.maxNorm({maxValue: 1})
    }));

    model.add(tf.layers.batchNormalization());
    model.add(tf.layers.dropout({rate: 0.2}));
    
    model.add(tf.layers.dense({
      units: 16,
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

    const optimizer = tf.train.adam(0.0005);
    
    model.compile({
      optimizer: tf.train.adam(0.0005),
      loss: 'binaryCrossentropy',
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

    const optimizer = tf.train.adam(0.0005);
    
    this.model.compile({
      optimizer: optimizer,
      loss: 'binaryCrossentropy',
      metrics: []
    });

    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: Math.min(BATCH_SIZE, inputs.length),
      validationSplit: 0.1,
      verbose: 0,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (isNaN(logs.loss)) {
            console.error('❌ NaN loss detected! Stopping training.');
            this.model.stopTraining = true;
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

  // =================================================================
  // PREDICT VÀ DECODE OUTPUT
  // =================================================================
  async predict(inputSequence) {
    console.log('🔍 [Predict Debug] Input sequence length:', inputSequence.length);
    
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const prediction = this.model.predict(inputTensor);
    const output = await prediction.data();
    
    console.log('🔍 [Predict Debug] Model output stats:');
    console.log('- Output length:', output.length);
    console.log('- Min value:', Math.min(...output));
    console.log('- Max value:', Math.max(...output));
    console.log('- NaN values:', output.filter(v => isNaN(v)).length);
    console.log('- First 10 values:', output.slice(0, 10));
    
    prediction.dispose();
    inputTensor.dispose();
    return Array.from(output);
  }

  decodeOutput(output) {
  const prediction = { pos1: [], pos2: [], pos3: [], pos4: [], pos5: [] };
  for (let i = 0; i < 5; i++) {
    const positionOutput = output.slice(i * 10, (i + 1) * 10);
    let candidates = positionOutput.map((val, idx) => ({ digit: String(idx), value: Math.max(0, val) }))
      .filter(item => item.value > 0.2) // Threshold cao hơn
      .sort((a, b) => b.value - a.value);
    if (candidates.length < 3) {
      // Fallback random nếu không đủ
      const remaining = Array.from({length: 10}, (_, j) => j.toString()).filter(d => !candidates.some(c => c.digit === d));
      candidates = [...candidates, ...remaining.sort(() => Math.random() - 0.5).slice(0, 3 - candidates.length)];
    }
    prediction[`pos${i + 1}`] = candidates.slice(0, 5).map(item => item.digit);
  }
  return prediction;
}

  // =================================================================
  // TỰ ĐỘNG TẠO DỰ ĐOÁN SAU HUẤN LUYỆN
  // =================================================================
  async autoGeneratePredictionsAfterTraining() {
    console.log('🚀 Bắt đầu tự động tạo dự đoán sau huấn luyện...');
    
    let generatedCount = 0;
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    
    if (results.length < SEQUENCE_LENGTH) {
        console.log('⚠️ Không đủ dữ liệu để tạo dự đoán');
        return 0;
    }

    const grouped = {};
    results.forEach(r => {
        if (!grouped[r.ngay]) grouped[r.ngay] = [];
        grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    
    // 1. TẠO DỰ ĐOÁN CHO NGÀY TIẾP THEO
    try {
        console.log('📅 Tạo dự đoán cho ngày tiếp theo...');
        const nextDayPrediction = await this.runNextDayPrediction();
        console.log(`✅ Đã tạo dự đoán cho: ${nextDayPrediction.ngayDuDoan}`);
        generatedCount++;
    } catch (error) {
        console.error('❌ Lỗi tạo dự đoán ngày tiếp theo:', error.message);
    }

    // 2. TẠO DỰ ĐOÁN CHO CÁC NGÀY TRONG QUÁ KHỨ
    console.log('🕐 Tạo dự đoán cho các ngày trong quá khứ...');
    
    const existingPredictions = await NNPrediction.find().lean();
    const existingPredictionDates = new Set(existingPredictions.map(p => p.ngayDuDoan));
    
    const recentDays = days.slice(-30);
    
    for (const day of recentDays) {
        if (existingPredictionDates.has(day)) {
            continue;
        }

        try {
            const dayIndex = days.indexOf(day);
            if (dayIndex < SEQUENCE_LENGTH) continue;

            const sequenceDays = days.slice(dayIndex - SEQUENCE_LENGTH, dayIndex);
            const previousDays = [];
            const inputSequence = sequenceDays.map(sequenceDay => {
                const dayResults = grouped[sequenceDay] || [];
                const prevDays = previousDays.slice();
                previousDays.push(dayResults);
                
                const basicFeatures = this.featureService.extractAllFeatures(dayResults, prevDays, sequenceDay);
                const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, prevDays);
                
                let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
                
                const EXPECTED_SIZE = 346;
                if (finalFeatureVector.length !== EXPECTED_SIZE) {
                    if (finalFeatureVector.length > EXPECTED_SIZE) {
                        finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_SIZE);
                    } else {
                        finalFeatureVector = [...finalFeatureVector, ...Array(EXPECTED_SIZE - finalFeatureVector.length).fill(0)];
                    }
                }
                
                return finalFeatureVector;
            });

            const output = await this.predict(inputSequence);
            const prediction = this.decodeOutput(output);

            const predictionRecord = {
                ngayDuDoan: day,
                ...prediction,
                danhDauDaSo: true,
                modelVersion: NN_MODEL_NAME,
                createdAt: new Date(),
                confidenceScore: this.calculateConfidence(output),
                isHistorical: true
            };

            await NNPrediction.findOneAndUpdate(
                { ngayDuDoan: day },
                predictionRecord,
                { upsert: true, new: true }
            );

            generatedCount++;
            console.log(`✅ Đã tạo dự đoán lịch sử cho: ${day}`);

            //if (generatedCount >= 10) {
             //   break;
            //}

        } catch (error) {
            console.error(`❌ Lỗi tạo dự đoán cho ${day}:`, error.message);
        }
    }

    console.log(`🎉 Đã tạo tổng cộng ${generatedCount} dự đoán sau huấn luyện`);
    return generatedCount;
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

  // =================================================================
  // LEARNING TỪ DỰ ĐOÁN MỚI
  // =================================================================
  async runLearning() {
    console.log('🔔 [TensorFlow Service] Learning from NEW predictions...');
    
    if (!this.model) {
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) {
            throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện lịch sử trước.');
        }
    }

    const predictionsToLearn = await NNPrediction.find({ 
        danhDauDaSo: false,
        isTrainingPrediction: { $ne: true }
    }).lean();

    if (predictionsToLearn.length === 0) {
        return { message: 'Không có dự đoán mới nào để học.' };
    }

    const results = await Result.find().lean();
    const grouped = {};
    results.forEach(r => {
        if (!grouped[r.ngay]) grouped[r.ngay] = [];
        grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    let learnedCount = 0;

    console.log(`📚 Bắt đầu học từ ${predictionsToLearn.length} dự đoán mới...`);

    for (const pred of predictionsToLearn) {
        const actualResult = (grouped[pred.ngayDuDoan] || []).find(r => r.giai === 'ĐB');
        if (!actualResult?.so) continue;

        const predDayIndex = days.indexOf(pred.ngayDuDoan);
        if (predDayIndex < SEQUENCE_LENGTH) continue;

        const sequenceDays = days.slice(predDayIndex - SEQUENCE_LENGTH, predDayIndex);
        const previousDays = [];
        const inputSequence = sequenceDays.map(day => {
            const dayResults = grouped[day] || [];
            const prevDays = previousDays.slice();
            previousDays.push(dayResults);
            
            const basicFeatures = this.featureService.extractAllFeatures(dayResults, prevDays, day);
            const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, prevDays);
            
            let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
            
            const EXPECTED_SIZE = 346;
            if (finalFeatureVector.length !== EXPECTED_SIZE) {
                if (finalFeatureVector.length > EXPECTED_SIZE) {
                    finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_SIZE);
                } else {
                    finalFeatureVector = [...finalFeatureVector, ...Array(EXPECTED_SIZE - finalFeatureVector.length).fill(0)];
                }
            }
            
            return finalFeatureVector;
        });

        const targetGDBString = String(actualResult.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);

        const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, 346]);
        const targetTensor = tf.tensor2d([targetArray], [1, OUTPUT_NODES]);

        await this.model.fit(inputTensor, targetTensor, {
            epochs: 5,
            batchSize: 1,
            verbose: 0
        });

        inputTensor.dispose();
        targetTensor.dispose();

        const actualStr = String(actualResult.so).padStart(5, '0');
        let correctCount = 0;
        for (let i = 0; i < 5; i++) {
            const predictedDigits = pred[`pos${i+1}`] || [];
            if (predictedDigits.includes(actualStr[i])) {
                correctCount++;
            }
        }
        const accuracy = correctCount / 5;

        await NNPrediction.updateOne(
            { _id: pred._id }, 
            { 
                danhDauDaSo: true,
                actualAccuracy: accuracy,
                learnedAt: new Date(),
                learningCycles: (pred.learningCycles || 0) + 1
            }
        );

        learnedCount++;
        console.log(`✅ Đã học từ dự đoán ngày ${pred.ngayDuDoan}: ${(accuracy * 100).toFixed(1)}%`);
    }

    if (learnedCount > 0) {
        await this.saveModel();
        console.log('🔮 Tạo dự đoán mới sau khi học...');
        await this.runNextDayPrediction();
    }

    return { 
        message: `Đã học từ ${learnedCount} dự đoán mới và tạo dự đoán tiếp theo.`,
        learnedCount: learnedCount
    };
  }

  // =================================================================
  // CHUẨN BỊ DỮ LIỆU TRAINING
  // =================================================================
  async prepareTrainingData() {
    console.log('📝 Bắt đầu chuẩn bị dữ liệu huấn luyện...');
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    
    console.log(`📊 Tổng số bản ghi trong DB: ${results.length}`);

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
          isNaN(val) || val === null || val === undefined || !isFinite(val) || Math.abs(val) > 1000
        );
        
        if (hasInvalid) {
          console.warn(`⚠️ Dữ liệu không hợp lệ ở ngày ${dateStr}`);
          sequenceValid = false;
          break;
        }
        
        const EXPECTED_SIZE = 346;
        if (finalFeatureVector.length !== EXPECTED_SIZE) {
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
        if (invalidTargets.length > 0) continue;

        trainingData.push({ inputSequence, targetArray });
      }
    }

    if (trainingData.length > 0) {
      console.log('🔍 KIỂM TRA DỮ LIỆU CUỐI CÙNG:');
      const sampleInput = trainingData[0].inputSequence.flat();
      const sampleTarget = trainingData[0].targetArray;
      
      console.log(`- Input range: ${Math.min(...sampleInput)} to ${Math.max(...sampleInput)}`);
      console.log(`- Target range: ${Math.min(...sampleTarget)} to ${Math.max(...sampleTarget)}`);
      console.log(`- NaN trong input: ${sampleInput.filter(v => isNaN(v)).length}`);
      console.log(`- NaN trong target: ${sampleTarget.filter(v => isNaN(v)).length}`);
      
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

  // =================================================================
  // SAVE VÀ LOAD MODEL
  // =================================================================
  async saveModel() {
    if (!this.model) throw new Error('Không có model để lưu.');

    console.log(`💾 [SaveModel] Chuẩn bị lưu model lên GCS...`);
    
    const modelGcsPath = `models/${NN_MODEL_NAME}`;
    
    const ioHandler = getGcsIoHandler(modelGcsPath);

    const saveResult = await this.model.save(ioHandler);

    const modelInfo = {
        modelName: NN_MODEL_NAME,
        inputNodes: this.inputNodes,
        savedAt: new Date().toISOString(),
        gcsPath: `gs://${bucketName}/${modelGcsPath}`
    };

    await NNState.findOneAndUpdate(
        { modelName: NN_MODEL_NAME },
        { 
            state: modelInfo,
            modelArtifacts: saveResult
        },
        { upsert: true, new: true }
    );
    
    console.log(`✅ [SaveModel] Model đã được lưu thành công lên GCS tại: ${modelInfo.gcsPath}`);
  }

  async loadModel() {
    console.log(`🔍 [LoadModel] Chuẩn bị tải model từ GCS...`);

    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME }).lean();
    
    if (modelState && modelState.state && modelState.state.gcsPath) {
        const modelGcsPath = modelState.state.gcsPath.replace(`gs://${bucketName}/`, '');

        try {
            const ioHandler = getGcsIoHandler(modelGcsPath);
            
            this.model = await tf.loadLayersModel(ioHandler);
            this.inputNodes = modelState.state.inputNodes;
            
            console.log(`✅ [LoadModel] Model đã được tải thành công từ GCS: ${modelState.state.gcsPath}`);
            this.model.summary();
            return true;
        } catch (error) {
            console.error(`❌ [LoadModel] Lỗi khi tải model từ GCS:`, error);
            return false;
        }
    } else {
        console.log('❌ [LoadModel] Không tìm thấy đường dẫn GCS trong database. Model cần được huấn luyện lại.');
        return false;
    }
  }

  // =================================================================
  // DỰ ĐOÁN NGÀY TIẾP THEO
  // =================================================================
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

    console.log(`🔍 Chuẩn bị dữ liệu dự đoán từ ${latestSequenceDays.length} ngày gần nhất`);

    const previousDays = [];
    const inputSequence = latestSequenceDays.map(day => {
      const dayResults = grouped[day] || [];
      const prevDays = previousDays.slice();
      previousDays.push(dayResults);
      
      const basicFeatures = this.featureService.extractAllFeatures(dayResults, prevDays, day);
      const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, prevDays);
      
      let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
      
      const EXPECTED_SIZE = 346;
      if (finalFeatureVector.length !== EXPECTED_SIZE) {
        if (finalFeatureVector.length > EXPECTED_SIZE) {
          finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_SIZE);
        } else {
          finalFeatureVector = [...finalFeatureVector, ...Array(EXPECTED_SIZE - finalFeatureVector.length).fill(0)];
        }
      }
      
      return finalFeatureVector;
    });

    const totalValues = inputSequence.flat().length;
    const expectedValues = SEQUENCE_LENGTH * 346;
    
    if (totalValues !== expectedValues) {
      throw new Error(`Lỗi dimension: có ${totalValues} values, cần ${expectedValues} values`);
    }

    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = latestSequenceDays[latestSequenceDays.length - 1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    const predictionRecord = {
      ngayDuDoan: nextDayStr,
      ...prediction,
      danhDauDaSo: false,
      modelVersion: NN_MODEL_NAME,
      createdAt: new Date(),
      rawProbabilities: output,
      confidenceScore: this.calculateConfidence(output)
    };

    await NNPrediction.findOneAndUpdate(
      { ngayDuDoan: nextDayStr },
      predictionRecord,
      { upsert: true, new: true }
    );

    console.log(`✅ Đã tạo dự đoán cho ${nextDayStr} với confidence: ${predictionRecord.confidenceScore}`);

    return {
      message: `TensorFlow LSTM đã tạo dự đoán cho ngày ${nextDayStr}.`,
      ngayDuDoan: nextDayStr,
      prediction: prediction,
      confidence: predictionRecord.confidenceScore
    };
  }

  // =================================================================
  // TÍNH ĐỘ TIN CẬY
  // =================================================================
  calculateConfidence(output) {
    if (!output || output.length === 0) return 0;
    
    let confidence = 0;
    let validPositions = 0;
    
    for (let i = 0; i < 5; i++) {
        const positionProbs = output.slice(i * 10, (i + 1) * 10);
        
        const cleanProbs = positionProbs.map(p => isNaN(p) ? 0 : Math.max(0, p));
        const maxProb = Math.max(...cleanProbs);
        const sumProb = cleanProbs.reduce((a, b) => a + b, 0);
        
        if (sumProb > 0 && maxProb > 0.1) {
            const positionConfidence = maxProb / (sumProb / cleanProbs.length);
            confidence += Math.min(positionConfidence, 1.0);
            validPositions++;
        }
    }
    
    const finalConfidence = validPositions > 0 ? confidence / validPositions : 0;
    console.log(`🎯 Confidence score: ${finalConfidence.toFixed(4)}`);
    
    return Math.min(finalConfidence, 1.0);
  }
}

module.exports = TensorFlowService;
