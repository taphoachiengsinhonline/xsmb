const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedTraining = require('./advancedTrainingService');
const { Storage } = require('@google-cloud/storage');
const { DateTime } = require('luxon');

// --- Cấu hình GCS (Giữ nguyên) ---
const gcsCredentialsJSON = process.env.GCS_CREDENTIALS;
const bucketName = process.env.GCS_BUCKET_NAME;
let storage, bucket;
if (gcsCredentialsJSON && bucketName) {
    try {
        const credentials = JSON.parse(gcsCredentialsJSON);
        storage = new Storage({ credentials, projectId: credentials.project_id });
        bucket = storage.bucket(bucketName);
        console.log(`✅ [GCS] Đã khởi tạo Google Cloud Storage thành công cho bucket: ${bucketName}`);
    } catch (error) {
        console.error("❌ [GCS] LỖI NGHIÊM TRỌNG: Không thể parse GCS_CREDENTIALS. Vui lòng kiểm tra biến môi trường.", error);
        process.exit(1);
    }
} else {
    console.warn("⚠️ [GCS] Cảnh báo: GCS_CREDENTIALS hoặc GCS_BUCKET_NAME chưa được thiết lập.");
}

// --- Các Hằng Số ---
const NN_MODEL_NAME = 'GDB_LSTM_TFJS_PREMIUM_V1'; // Giữ nguyên tên model của bạn
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 100;
const BATCH_SIZE = 128;

// --- Custom GCS IO Handler (Giữ nguyên) ---
const getGcsIoHandler = (modelPath) => {
    if (!bucket) {
        throw new Error("GCS Bucket chưa được khởi tạo. Vui lòng kiểm tra cấu hình biến môi trường.");
    }
    const modelJsonPath = `${modelPath}/model.json`;
    const weightsBinPath = `${modelPath}/weights.bin`;
    return {
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
};

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    this.advancedTrainer = new AdvancedTraining();
    this.inputNodes = 0;
    this.ensembleModels = [];
  }

  // =================================================================
  // CÁC HÀM GỐC CỦA BẠN - GIỮ NGUYÊN 100%
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
      optimizer: optimizer,
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

    // =================================================================
    // SỬA LỖI NAN: Thêm Gradient Clipping vào optimizer
    // =================================================================
    const optimizer = tf.train.adam(0.0005);
    optimizer.clipNorm = 1.0; // Giới hạn gradient để chống bùng nổ

    this.model.compile({
      optimizer: optimizer,
      loss: 'binaryCrossentropy',
      metrics: []
    });
    // =================================================================

    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: Math.min(BATCH_SIZE, inputs.length),
      validationSplit: 0.1,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          if (isNaN(logs.loss)) {
            console.error('❌ NaN loss detected! Stopping training.');
            this.model.stopTraining = true;
            console.log('📊 Debug info:', { epoch, inputShape: inputTensor.shape, targetShape: targetTensor.shape });
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
    // Thêm kiểm tra NaN ở đầu ra
    if (this.model.getWeights().some(w => w.dataSync().some(isNaN))) {
        console.error("❌ LỖI: Trọng số của model chứa NaN. Không thể dự đoán.");
        // Cân nhắc tải lại model hoặc huấn luyện lại
        await this.loadModel(); 
        if (this.model.getWeights().some(w => w.dataSync().some(isNaN))) {
            throw new Error("Model weights are NaN even after reloading.");
        }
    }
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
    const prediction = this.model.predict(inputTensor);
    const output = await prediction.data();
    if (output.some(isNaN)) {
        console.error("❌ LỖI: Kết quả dự đoán là NaN.");
        // Trả về một mảng rỗng hoặc giá trị mặc định thay vì NaN
        return Array(OUTPUT_NODES).fill(0);
    }
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
        const hasInvalid = finalFeatureVector.some(val => isNaN(val) || val === null || val === undefined || !isFinite(val));
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
    if (trainingData.length > 0) {
      console.log('🔍 DEBUG - Kiểm tra dữ liệu training:');
      console.log(`- Số chuỗi: ${trainingData.length}`);
      console.log(`- Kích thước input sequence: ${trainingData[0].inputSequence.length}`);
      console.log(`- Kích thước feature vector: ${trainingData[0].inputSequence[0].length}`);
      const sampleFeatures = trainingData[0].inputSequence.flat();
      const sampleTargets = trainingData[0].targetArray;
      console.log(`- Sample features - Min: ${Math.min(...sampleFeatures)}, Max: ${Math.max(...sampleFeatures)}`);
      console.log(`- Sample targets - Min: ${Math.min(...sampleTargets)}, Max: ${Math.max(...sampleTargets)}`);
      const nanSampleFeatures = sampleFeatures.filter(v => isNaN(v)).length;
      const nanSampleTargets = sampleTargets.filter(v => isNaN(v)).length;
      console.log(`- NaN trong sample features: ${nanSampleFeatures}`);
      console.log(`- NaN trong sample targets: ${nanSampleTargets}`);
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
        { state: modelInfo, modelArtifacts: saveResult },
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
            console.error(`❌ [LoadModel] Lỗi khi tải model từ GCS (${modelState.state.gcsPath}):`, error);
            return false;
        }
    } else {
        console.log('❌ [LoadModel] Không tìm thấy đường dẫn GCS trong database. Model cần được huấn luyện lại.');
        return false;
    }
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
            const basicFeatures = this.featureService.extractAllFeatures(dayResults, prevDays, day);
            const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, prevDays);
            let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
            console.log(`📊 [Learning] Ngày ${day}: Basic=${basicFeatures.length}, Advanced=${Object.values(advancedFeatures).flat().length}, Total=${finalFeatureVector.length}`);
            const EXPECTED_SIZE = 346;
            if (finalFeatureVector.length !== EXPECTED_SIZE) {
              console.warn(`⚠️ Điều chỉnh features: ${finalFeatureVector.length} -> ${EXPECTED_SIZE}`);
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
          console.log(`🔢 [Learning] Tổng số values: ${totalValues}, Expected: ${expectedValues}`);
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

      // =================================================================
      // SỬA LỖI NAN: Thêm Gradient Clipping vào optimizer khi học
      // =================================================================
      const learningOptimizer = tf.train.adam(0.0001); // Learning rate nhỏ hơn khi học thêm
      learningOptimizer.clipNorm = 1.0;

      await this.model.fit(inputTensor, targetTensor, {
        epochs: 3,
        batchSize: Math.min(BATCH_SIZE, inputs.length),
        validationSplit: 0.1,
        optimizer: learningOptimizer // Sử dụng optimizer đã được cấu hình
      });
      // =================================================================

      inputTensor.dispose();
      targetTensor.dispose();
      await this.saveModel();
      console.log(`✅ [Learning] Đã học xong từ ${learnedCount} kết quả mới`);
    } else {
      console.log('ℹ️ [Learning] Không có dữ liệu training hợp lệ để học');
    }
    return { message: `TensorFlow LSTM đã học xong. Đã xử lý ${learnedCount} kết quả mới.` };
  }

  async runNextDayPrediction() {
    console.log('🔔 [TensorFlow Service] Generating next day prediction...');
    if (!this.model) {
      const modelLoaded = await this.loadModel();
      if (!modelLoaded) {
        throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện lịch sử trước.');
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
      console.log(`📊 Ngày ${day}: Basic=${basicFeatures.length}, Advanced=${Object.values(advancedFeatures).flat().length}, Total=${finalFeatureVector.length}`);
      const EXPECTED_SIZE = 346;
      if (finalFeatureVector.length !== EXPECTED_SIZE) {
        console.warn(`⚠️ Điều chỉnh features: ${finalFeatureVector.length} -> ${EXPECTED_SIZE}`);
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
    console.log(`🔢 Tổng số values: ${totalValues}, Expected: ${expectedValues}`);
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
