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
    this.errorPatterns = null; // Lưu trữ phân tích lỗi
  }

  // =================================================================
  // PHÂN TÍCH LỖI TOÀN DIỆN - CHẠY NGAY KHI CÓ DỮ LIỆU 90+ NGÀY
  // =================================================================
  async analyzeHistoricalErrors() {
    console.log('🔍 Bắt đầu phân tích lỗi toàn diện từ 90+ ngày dữ liệu...');
    
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    const predictions = await NNPrediction.find().lean();

    if (results.length === 0 || predictions.length === 0) {
      console.log('⚠️ Chưa đủ dữ liệu để phân tích lỗi');
      return this.getDefaultErrorPatterns();
    }

    const groupedResults = {};
    results.forEach(r => {
      if (!groupedResults[r.ngay]) groupedResults[r.ngay] = [];
      groupedResults[r.ngay].push(r);
    });

    const errorAnalysis = {
      weakPositions: [],
      temporalWeaknesses: {},
      featureMistakes: new Set(),
      confidenceErrors: [],
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

      // PHÂN TÍCH THEO THỜI GIAN
      const date = DateTime.fromFormat(pred.ngayDuDoan, 'dd/MM/yyyy');
      const dayOfWeek = date.weekdayShort;
      const month = date.monthShort;
      
      if (!errorAnalysis.temporalWeaknesses[dayOfWeek]) {
        errorAnalysis.temporalWeaknesses[dayOfWeek] = { total: 0, errors: 0 };
      }
      errorAnalysis.temporalWeaknesses[dayOfWeek].total++;
      if (!positionCorrect) {
        errorAnalysis.temporalWeaknesses[dayOfWeek].errors++;
      }

      // PHÂN TÍCH THEO THÁNG
      if (!errorAnalysis.temporalWeaknesses[month]) {
        errorAnalysis.temporalWeaknesses[month] = { total: 0, errors: 0 };
      }
      errorAnalysis.temporalWeaknesses[month].total++;
      if (!positionCorrect) {
        errorAnalysis.temporalWeaknesses[month].errors++;
      }
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
        errorRate: count / totalPredictions,
        weight: 1 + (count / totalPredictions) * 2 // Tỷ lệ sai càng cao -> weight càng lớn
      }));

    // TÍNH TỶ LỆ LỖI THEO THỜI GIAN
    for (const [key, data] of Object.entries(errorAnalysis.temporalWeaknesses)) {
      data.errorRate = data.errors / data.total;
      data.weight = 1 + data.errorRate; // Tỷ lệ lỗi cao -> weight cao
    }

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
        { position: 'pos1', errorRate: 0.7, weight: 2.4 },
        { position: 'pos2', errorRate: 0.6, weight: 2.2 },
        { position: 'pos3', errorRate: 0.5, weight: 2.0 },
        { position: 'pos4', errorRate: 0.4, weight: 1.8 },
        { position: 'pos5', errorRate: 0.3, weight: 1.6 }
      ],
      temporalWeaknesses: {},
      overallAccuracy: 0,
      totalAnalyzed: 0
    };
  }

  // =================================================================
  // TÍNH TRỌNG SỐ THÔNG MINH CHO TỪNG MẪU HUẤN LUYỆN
  // =================================================================
  calculateSmartWeights(trainingData) {
    console.log('🎯 Tính trọng số thông minh cho từng mẫu huấn luyện...');
    
    if (!this.errorPatterns) {
      console.log('⚠️ Chưa có phân tích lỗi, sử dụng weights mặc định');
      return Array(trainingData.length).fill(1.0);
    }

    const weights = trainingData.map((sample, index) => {
      let weight = 1.0; // Weight mặc định

      try {
        // 1. TĂNG TRỌNG SỐ CHO CÁC MẪU LIÊN QUAN ĐẾN VỊ TRÍ YẾU
        this.errorPatterns.weakPositions.forEach(weakPos => {
          if (weakPos.errorRate > 0.5) { // Chỉ xét các vị trí sai > 50%
            weight += weakPos.weight * 0.3;
          }
        });

        // 2. TĂNG TRỌNG SỐ CHO CÁC MẪU CÓ FEATURES ĐẶC BIỆT
        const featureVector = sample.inputSequence.flat();
        const hasExtremeValues = featureVector.some(val => Math.abs(val) > 0.8);
        if (hasExtremeValues) {
          weight += 0.4; // Các features cực trị thường quan trọng
        }

        // 3. TĂNG TRỌNG SỐ CHO CÁC MẪU CÓ PATTERN PHỨC TẠP
        const featureComplexity = this.calculateFeatureComplexity(featureVector);
        weight += featureComplexity * 0.2;

        // 4. GIẢM TRỌNG SỐ CHO CÁC MẪU QUÁ ĐƠN GIẢN
        const simpleFeatureCount = featureVector.filter(val => Math.abs(val) < 0.1).length;
        if (simpleFeatureCount > featureVector.length * 0.8) {
          weight *= 0.8; // Giảm weight cho mẫu quá đơn giản
        }

      } catch (error) {
        console.warn(`⚠️ Lỗi tính weight cho sample ${index}:`, error.message);
        weight = 1.0; // Fallback về weight mặc định
      }

      return Math.min(Math.max(weight, 0.5), 3.0); // Giới hạn weight từ 0.5 đến 3.0
    });

    console.log(`✅ Đã tính weights cho ${weights.length} mẫu:`);
    console.log(`- Weight trung bình: ${(weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(2)}`);
    console.log(`- Weight min: ${Math.min(...weights).toFixed(2)}, max: ${Math.max(...weights).toFixed(2)}`);

    return weights;
  }

  calculateFeatureComplexity(featureVector) {
    // Tính độ phức tạp của feature vector dựa trên variance
    const mean = featureVector.reduce((a, b) => a + b, 0) / featureVector.length;
    const variance = featureVector.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / featureVector.length;
    return Math.min(variance * 10, 1.0); // Chuẩn hóa về 0-1
  }

  // =================================================================
  // HUẤN LUYỆN VỚI SMART WEIGHTING
  // =================================================================
  async trainModelWithSmartWeights(trainingData) {
    console.log('🚀 Bắt đầu huấn luyện với Smart Weighting...');
    
    // PHÂN TÍCH LỖI TRƯỚC KHI HUẤN LUYỆN
    await this.analyzeHistoricalErrors();
    
    // TÍNH TRỌNG SỐ THÔNG MINH
    const weights = this.calculateSmartWeights(trainingData);
    
    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);

    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);
    const weightTensor = tf.tensor1d(weights);

    console.log('🔧 Bắt đầu training với smart weights...');
    
    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: Math.min(BATCH_SIZE, inputs.length),
      validationSplit: 0.1,
      verbose: 0, // ✅ TẮT TIẾN TRÌNH ĐỂ KHÔNG LỖI TICK
      sampleWeight: weightTensor,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (isNaN(logs.loss)) {
            console.error('❌ NaN loss detected! Stopping training.');
            this.model.stopTraining = true;
          } else if (epoch % 10 === 0) {
            console.log(`📈 Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}, Val Loss = ${logs.val_loss?.toFixed(4) || 'N/A'}`);
          }
        }
      }
    });

    // GIẢI PHÓNG BỘ NHỚ
    inputTensor.dispose();
    targetTensor.dispose();
    weightTensor.dispose();

    console.log('✅ Huấn luyện với Smart Weighting hoàn tất!');
    return history;
  }

  // =================================================================
  // CÁC PHƯƠNG THỨC GỐC - GIỮ NGUYÊN NHƯNG THÊM VERBOSE: 0
  // =================================================================
  async runAdvancedTraining() {
    console.log('🚀 Bắt đầu Advanced Training...');
    
    const trainingData = await this.prepareTrainingData();
    
    const result = await this.advancedTrainer.trainWithAdvancedStrategies(
      trainingData, 
      ['ensemble', 'augmentation']
    );
    
    if (result.type === 'ensemble') {
      this.ensembleModels = result.models;
      console.log(`✅ Đã train ${result.models.length} models cho ensemble`);
    } else {
      this.model = result.model;
      await this.saveModel();
    }
    
    return {
      message: 'Advanced training hoàn tất',
      strategy: 'ensemble + augmentation',
      modelsCount: result.models?.length || 1
    };
  }

  async advancedPredict(inputSequence) {
    if (this.ensembleModels && this.ensembleModels.length > 0) {
      return await this.advancedTrainer.ensemblePredict(inputSequence);
    } else {
      return await this.predict(inputSequence);
    }
  }

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
      loss: 'meanSquaredError',
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
      verbose: 0, // ✅ TẮT TIẾN TRÌNH
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

  // =================================================================
  // PHƯƠNG THỨC CHÍNH - SỬA ĐỔI ĐỂ DÙNG SMART WEIGHTING
  // =================================================================
  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử với Smart Weighting...');
   
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
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training với Smart Weighting...');
    
    // ✅ SỬ DỤNG SMART WEIGHTING THAY VÌ TRAINING THÔNG THƯỜNG
    await this.trainModelWithSmartWeights(trainingData);
   
    await this.saveModel();
    
    return {
      message: `Huấn luyện với Smart Weighting hoàn tất. Đã xử lý ${trainingData.length} chuỗi, ${EPOCHS} epochs.`,
      sequences: trainingData.length,
      epochs: EPOCHS,
      featureSize: this.inputNodes,
      modelName: NN_MODEL_NAME,
      smartWeighting: true
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
            console.error(`❌ [Learning] Lỗi dimension: có ${totalValues} values, cần ${expectedValues} values`);
            continue;
          }

          const targetGDBString = String(actualResult.so).padStart(5, '0');
          const targetArray = this.prepareTarget(targetGDBString);
          
          trainingData.push({ inputSequence, targetArray });
          learnedCount++;
        }
      }
      await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }

    if (trainingData.length > 0) {
      console.log(`🎯 [Learning] Bắt đầu học từ ${trainingData.length} chuỗi dữ liệu mới`);
      
      const inputs = trainingData.map(d => d.inputSequence);
      const targets = trainingData.map(d => d.targetArray);

      const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
      const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

      await this.model.fit(inputTensor, targetTensor, {
        epochs: 3,
        batchSize: Math.min(BATCH_SIZE, inputs.length),
        validationSplit: 0.1,
        verbose: 0 // ✅ TẮT TIẾN TRÌNH
      });

      inputTensor.dispose();
      targetTensor.dispose();

      await this.saveModel();
      console.log(`✅ [Learning] Đã học xong từ ${learnedCount} kết quả mới`);
    } else {
      console.log('ℹ️ [Learning] Không có dữ liệu training hợp lệ để học');
    }
    
    return { message: `TensorFlow LSTM đã học xong. Đã xử lý ${learnedCount} kết quả mới.` };
  }

  // =================================================================
  // CÁC PHƯƠNG THỨC CÒN LẠI - GIỮ NGUYÊN
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
          isNaN(val) || val === null || val === undefined || !isFinite(val)
        );
        
        if (hasInvalid) {
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
