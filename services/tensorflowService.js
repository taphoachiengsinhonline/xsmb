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
  // PHÂN TÍCH LỖI TOÀN DIỆN - GIỮ NGUYÊN
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
  // OVERSAMPLING THÔNG MINH - THAY THẾ CHO SAMPLE WEIGHTING
  // =================================================================
  applySmartOversampling(trainingData) {
    console.log('🎯 Áp dụng Smart Oversampling...');
    
    if (!this.errorPatterns || trainingData.length === 0) {
      console.log('⚠️ Chưa có phân tích lỗi hoặc dữ liệu rỗng, không áp dụng oversampling');
      return trainingData;
    }

    const oversampledData = [...trainingData];
    const samplesToAdd = [];

    // GIỚI HẠN OVERSAMPLING - CHỈ THÊM TỐI ĐA 50% SỐ MẪU GỐC
    const maxOversamples = Math.floor(trainingData.length * 0.5);
    let addedCount = 0;

    // CHỈ TẬP TRUNG VÀO CÁC VỊ TRÍ RẤT YẾU (errorRate > 70%)
    const veryWeakPositions = this.errorPatterns.weakPositions.filter(pos => pos.errorRate > 0.7);
    
    if (veryWeakPositions.length === 0) {
      console.log('⚠️ Không có vị trí nào quá yếu, không áp dụng oversampling');
      return trainingData;
    }

    trainingData.forEach((sample, index) => {
      if (addedCount >= maxOversamples) return;

      const featureVector = sample.inputSequence.flat();
      
      // CHỈ THÊM MẪU NẾU CÓ FEATURES QUAN TRỌNG
      const hasImportantFeatures = featureVector.some(val => Math.abs(val) > 0.5);
      const featureComplexity = this.calculateFeatureComplexity(featureVector);
      
      if (hasImportantFeatures && featureComplexity > 0.3) {
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
  // HUẤN LUYỆN VỚI SMART OVERSAMPLING - SỬA LỖI
  // =================================================================
  async trainModelWithSmartOversampling(trainingData) {
    console.log('🚀 Bắt đầu huấn luyện với Smart Oversampling...');
    
    // PHÂN TÍCH LỖI TRƯỚC KHI HUẤN LUYỆN
    await this.analyzeHistoricalErrors();
    
    // ÁP DỤNG OVERSAMPLING THÔNG MINH
    const enhancedData = this.applySmartOversampling(trainingData);
    
    const inputs = enhancedData.map(d => d.inputSequence);
    const targets = enhancedData.map(d => d.targetArray);

    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    console.log('🔧 Bắt đầu training với dữ liệu đã được oversampling...');
    
    // ✅ SỬA: DÙNG callback tfjs thay vì custom callback bị loạn
    const history = await this.model.fit(inputTensor, targetTensor, {
        epochs: EPOCHS,
        batchSize: Math.min(BATCH_SIZE, inputs.length),
        validationSplit: 0.1,
        verbose: 1, // ✅ ĐỂ TENSORFLOW TỰ XỬ LÝ LOG
        callbacks: tf.callbacks.earlyStopping({ patience: 10 }) // ✅ CALLBACK CHUẨN
    });

    inputTensor.dispose();
    targetTensor.dispose();

    console.log('✅ Huấn luyện với Smart Oversampling hoàn tất!');
    return history;
}
  // =================================================================
  // PHƯƠNG THỨC CHÍNH - SỬA ĐỔI ĐỂ DÙNG SMART OVERSAMPLING
  // =================================================================
  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Bắt đầu Huấn luyện Lịch sử TUẦN TỰ...');
    
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
    
    // XÂY DỰNG MODEL
    await this.buildModel(346);
    
    let totalProcessed = 0;
    let correctPredictions = 0;

    console.log(`📊 Bắt đầu quá trình học tuần tự từ ${days[SEQUENCE_LENGTH]} đến ${days[days.length-1]}`);
    console.log(`📊 Tổng số ngày cần xử lý: ${days.length - SEQUENCE_LENGTH}`);

    // ✅ HUẤN LUYỆN TUẦN TỰ TỪNG NGÀY
    for (let currentIndex = SEQUENCE_LENGTH; currentIndex < days.length; currentIndex++) {
        const currentDay = days[currentIndex];
        const sequenceDays = days.slice(currentIndex - SEQUENCE_LENGTH, currentIndex);
        
        // 1. CHUẨN BỊ DỮ LIỆU ĐẦU VÀO
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

        // 2. TẠO DỰ ĐOÁN CHO NGÀY HIỆN TẠI
        const predictionOutput = await this.predict(inputSequence);
        const prediction = this.decodeOutput(predictionOutput);

        // 3. LẤY KẾT QUẢ THỰC TẾ
        const targetGDB = (grouped[currentDay] || []).find(r => r.giai === 'ĐB');
        if (!targetGDB?.so || String(targetGDB.so).length < 5) {
            console.log(`⚠️ Ngày ${currentDay}: Không có kết quả GĐB, bỏ qua`);
            continue;
        }

        const targetGDBString = String(targetGDB.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);

        // 4. LƯU DỰ ĐOÁN
        const predictionRecord = {
            ngayDuDoan: currentDay,
            ...prediction,
            danhDauDaSo: false, // Chưa học từ dự đoán này
            modelVersion: NN_MODEL_NAME,
            createdAt: new Date(),
            confidenceScore: this.calculateConfidence(predictionOutput),
            isTrainingPrediction: true
        };

        await NNPrediction.findOneAndUpdate(
            { ngayDuDoan: currentDay },
            predictionRecord,
            { upsert: true, new: true }
        );

        // 5. TÍNH ĐỘ CHÍNH XÁC
        const actualStr = String(targetGDB.so).padStart(5, '0');
        let correctCount = 0;
        for (let i = 0; i < 5; i++) {
            const predictedDigits = prediction[`pos${i+1}`] || [];
            if (predictedDigits.includes(actualStr[i])) {
                correctCount++;
            }
        }
        
        const accuracy = correctCount / 5;
        if (accuracy > 0) correctPredictions++;

        // 6. HUẤN LUYỆN MODEL VỚI DỮ LIỆU HIỆN TẠI
        const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, 346]);
        const targetTensor = tf.tensor2d([targetArray], [1, OUTPUT_NODES]);

        await this.model.fit(inputTensor, targetTensor, {
            epochs: 3,
            batchSize: 1,
            verbose: 0 // ✅ TẮT LOG ĐỂ KHÔNG LOẠN
        });

        inputTensor.dispose();
        targetTensor.dispose();

        // 7. ĐÁNH DẤU ĐÃ HỌC
        await NNPrediction.updateOne(
            { ngayDuDoan: currentDay },
            { 
                danhDauDaSo: true,
                actualAccuracy: accuracy,
                learnedAt: new Date()
            }
        );

        totalProcessed++;

        // HIỂN THỊ TIẾN TRÌNH
        if (totalProcessed % 10 === 0 || totalProcessed === days.length - SEQUENCE_LENGTH) {
            const progress = (totalProcessed / (days.length - SEQUENCE_LENGTH) * 100).toFixed(1);
            console.log(`📈 Đã xử lý ${totalProcessed}/${days.length - SEQUENCE_LENGTH} ngày (${progress}%)`);
        }
    }

    // ✅ TỰ ĐỘNG TẠO DỰ ĐOÁN CHO NGÀY TIẾP THEO SAU KHI HUẤN LUYỆN
    console.log('🔮 Tự động tạo dự đoán cho ngày tiếp theo...');
    const nextDayPrediction = await this.runNextDayPrediction();

    await this.saveModel();

    return {
        message: `Huấn luyện TUẦN TỰ hoàn tất. Đã xử lý ${totalProcessed} ngày. Đã tạo dự đoán cho ${nextDayPrediction.ngayDuDoan}.`,
        totalProcessed: totalProcessed,
        nextPrediction: nextDayPrediction.ngayDuDoan,
        modelName: NN_MODEL_NAME
    };
}

  // =================================================================
  // CÁC PHƯƠNG THỨC KHÁC GIỮ NGUYÊN
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

 // TỰ ĐỘNG TẠO DỰ ĐOÁN SAU KHI HUẤN LUYỆN
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

    // 2. TẠO DỰ ĐOÁN CHO CÁC NGÀY TRONG QUÁ KHỨ (để có lịch sử đánh giá)
    console.log('🕐 Tạo dự đoán cho các ngày trong quá khứ...');
    
    // Lấy danh sách các ngày đã có kết quả nhưng chưa có dự đoán
    const existingPredictions = await NNPrediction.find().lean();
    const existingPredictionDates = new Set(existingPredictions.map(p => p.ngayDuDoan));
    
    // Tạo dự đoán cho 30 ngày gần nhất có kết quả nhưng chưa có dự đoán
    const recentDays = days.slice(-30); // 30 ngày gần nhất
    
    for (const day of recentDays) {
        if (existingPredictionDates.has(day)) {
            continue; // Đã có dự đoán rồi
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

            // ✅ LƯU DỰ ĐOÁN VỚI THÔNG TIN ĐẦY ĐỦ
            const predictionRecord = {
                ngayDuDoan: day,
                ...prediction,
                danhDauDaSo: true, // Đánh dấu đã có kết quả thực tế
                modelVersion: NN_MODEL_NAME,
                createdAt: new Date(),
                confidenceScore: this.calculateConfidence(output),
                isHistorical: true // Đánh dấu là dự đoán lịch sử
            };

            await NNPrediction.findOneAndUpdate(
                { ngayDuDoan: day },
                predictionRecord,
                { upsert: true, new: true }
            );

            generatedCount++;
            console.log(`✅ Đã tạo dự đoán lịch sử cho: ${day}`);

            // Giới hạn số lượng để không quá tải
            if (generatedCount >= 10) {
                break;
            }

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
  // PHƯƠNG THỨC CHÍNH - SỬA ĐỔI ĐỂ DÙNG SMART WEIGHTING
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

    // ✅ THÊM: TỰ ĐỘNG TẠO DỰ ĐOÁN SAU KHI HUẤN LUYỆN
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

  async runLearning() {
    console.log('🔔 [TensorFlow Service] Học từ kết quả mới...');
    
    if (!this.model) {
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) {
            throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện lịch sử trước.');
        }
    }

    // ✅ CHỈ LẤY DỰ ĐOÁN CHƯA ĐƯỢC HỌC VÀ ĐÃ CÓ KẾT QUẢ
    const predictionsToLearn = await NNPrediction.find({ 
        danhDauDaSo: false
    }).lean();

    if (predictionsToLearn.length === 0) {
        console.log('ℹ️ Không có dự đoán mới để học, tạo dự đoán cho ngày tiếp theo...');
        const nextDayPrediction = await this.runNextDayPrediction();
        return { 
            message: `Không có dự đoán mới. Đã tạo dự đoán cho ${nextDayPrediction.ngayDuDoan}.`,
            learnedCount: 0,
            nextPrediction: nextDayPrediction.ngayDuDoan
        };
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

        // TÌM DỮ LIỆU ĐẦU VÀO CHO DỰ ĐOÁN NÀY
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

        // ✅ HUẤN LUYỆN TỪ DỰ ĐOÁN SAI
        const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, 346]);
        const targetTensor = tf.tensor2d([targetArray], [1, OUTPUT_NODES]);

        await this.model.fit(inputTensor, targetTensor, {
            epochs: 5,
            batchSize: 1,
            verbose: 0
        });

        inputTensor.dispose();
        targetTensor.dispose();

        // TÍNH ĐỘ CHÍNH XÁC VÀ CẬP NHẬT
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
    }

    // ✅ TỰ ĐỘNG TẠO DỰ ĐOÁN CHO NGÀY TIẾP THEO
    console.log('🔮 Tự động tạo dự đoán tiếp theo sau khi học...');
    const nextDayPrediction = await this.runNextDayPrediction();

    return { 
        message: `Đã học từ ${learnedCount} dự đoán mới. Đã tạo dự đoán cho ${nextDayPrediction.ngayDuDoan}.`,
        learnedCount: learnedCount,
        nextPrediction: nextDayPrediction.ngayDuDoan
    };
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
        
        // ✅ THÊM KIỂM TRA KỸ HƠN
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

    // ✅ THÊM KIỂM TRA CUỐI CÙNG
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
    console.log('🔔 [TensorFlow Service] Tạo dự đoán cho ngày tiếp theo...');
    
    if (!this.model) {
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) {
            throw new Error('Model chưa được huấn luyện.');
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

    console.log(`🔍 Sử dụng dữ liệu từ ${latestSequenceDays.length} ngày gần nhất`);

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

    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = latestSequenceDays[latestSequenceDays.length - 1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    // ✅ LƯU DỰ ĐOÁN VỚI danhDauDaSo = false (chưa có kết quả)
    await NNPrediction.findOneAndUpdate(
        { ngayDuDoan: nextDayStr },
        { 
            ngayDuDoan: nextDayStr, 
            ...prediction, 
            danhDauDaSo: false,
            modelVersion: NN_MODEL_NAME,
            createdAt: new Date(),
            confidenceScore: this.calculateConfidence(output)
        },
        { upsert: true, new: true }
    );

    console.log(`✅ Đã tạo dự đoán cho: ${nextDayStr}`);

    return {
        message: `Đã tạo dự đoán cho ngày ${nextDayStr}.`,
        ngayDuDoan: nextDayStr
    };
}

// ✅ THÊM PHƯƠNG THỨC TÍNH ĐỘ TIN CẬY
calculateConfidence(output) {
    if (!output || output.length === 0) return 0;
    
    let confidence = 0;
    for (let i = 0; i < 5; i++) {
        const positionProbs = output.slice(i * 10, (i + 1) * 10);
        const maxProb = Math.max(...positionProbs);
        
        // ✅ CÔNG THỨC ĐƠN GIẢN VÀ CHÍNH XÁC: trung bình maxProb của 5 vị trí
        confidence += maxProb;
    }
    
    const finalConfidence = confidence / 5;
    console.log(`🎯 Confidence score: ${finalConfidence.toFixed(4)}`);
    
    return Math.min(finalConfidence, 1.0); // Đảm bảo không vượt quá 1
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
