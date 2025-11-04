const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const AdvancedFeatureEngineer = require('./advancedFeatureService');
const FeatureEngineeringService = require('./featureEngineeringService');

const { DateTime } = require('luxon');


const NN_MODEL_NAME = 'GDB_MULTIHEAD_TFJS_V1'; // Đổi tên model để lưu trạng thái mới
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
    console.log(`🏗️ Bắt đầu xây dựng kiến trúc Multi-Head Model với ${inputNodes} features...`);
    this.inputNodes = inputNodes;

    // --- Input Layer ---
    const inputLayer = tf.input({shape: [SEQUENCE_LENGTH, inputNodes]});

    // --- Shared LSTM Layers (Phần thân chung) ---
    // Lớp LSTM đầu tiên
    const lstm1 = tf.layers.lstm({
        units: 192,
        returnSequences: true,
        kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }).apply(inputLayer);
    const batchNorm1 = tf.layers.batchNormalization().apply(lstm1);
    const dropout1 = tf.layers.dropout({rate: 0.25}).apply(batchNorm1);

    // Lớp LSTM thứ hai
    const lstm2 = tf.layers.lstm({
        units: 96,
        kernelRegularizer: tf.regularizers.l2({l2: 0.001}),
        recurrentRegularizer: tf.regularizers.l2({l2: 0.001})
    }).apply(dropout1);
    const batchNorm2 = tf.layers.batchNormalization().apply(lstm2);
    const sharedOutput = tf.layers.dropout({rate: 0.25}).apply(batchNorm2);

    // --- Multi-Head Output Layers (5 cái đầu riêng biệt) ---
    const outputLayers = [];
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        // Mỗi "đầu" là một lớp Dense riêng
        const denseHead = tf.layers.dense({
            units: 48,
            activation: 'relu',
            name: `${headName}_dense`
        }).apply(sharedOutput);
        
        // Lớp output cuối cùng cho mỗi "đầu"
        const outputHead = tf.layers.dense({
            units: NUM_CLASSES, // 10 output (cho 10 chữ số)
            activation: 'softmax', // DÙNG SOFTMAX
            name: headName
        }).apply(denseHead);

        outputLayers.push(outputHead);
    }

    // Tạo model với 1 input và 5 output
    this.model = tf.model({inputs: inputLayer, outputs: outputLayers});

    this.model.summary();
    return this.model;
}

  async trainModel(trainingData) {
    const { inputs, targets } = trainingData;

    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, this.inputNodes]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    const history = await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationSplit: 0.1,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          // Chỉ in ra loss để đảm bảo không có lỗi nào khác xảy ra.
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}`);
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
            
            let finalFeatureVector = [...basicFeatures, ...advancedFeatures];

            for(let k = 0; k < finalFeatureVector.length; k++) {
                const val = finalFeatureVector[k];
                if (!isFinite(val)) {
                    console.error(`Lỗi dữ liệu nghiêm trọng tại feature index ${k} cho ngày ${dateStr}. Giá trị: ${val}`);
                    throw new Error(`Invalid data detected: ${val}`);
                }
            }

            inputSequence.push(finalFeatureVector);
        }

        const targetGDB = (grouped[targetDayString] || []).find(r => r.giai === 'ĐB');
        if (targetGDB?.so && String(targetGDB.so).length >= 5) {
            const gdbString = String(targetGDB.so).padStart(5, '0');
            
            // =================================================================
            // ĐÂY LÀ PHẦN SỬA LỖI - Tạo target trực tiếp tại đây
            // =================================================================
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
                 // targets bây giờ là mảng của 5 mảng one-hot
                 trainingData.push({ inputSequence, targets });
            }
            // =================================================================
        }
    }

    if (trainingData.length > 0) {
        this.inputNodes = trainingData[0].inputSequence[0].length;
        console.log(`✅ Đã chuẩn bị ${trainingData.length} chuỗi dữ liệu huấn luyện hợp lệ với feature size: ${this.inputNodes}`);
    } else {
        throw new Error("Không có dữ liệu training hợp lệ.");
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
    
    const trainingData = await this.prepareTrainingData(); 
    if (trainingData.length === 0) throw new Error('Không có dữ liệu training');

    // TÁCH INPUTS VÀ TARGETS
    const inputs = trainingData.map(d => d.inputSequence);
    
    // Tạo 5 mảng target riêng biệt
    const targets = {};
    for (let i = 0; i < NUM_POSITIONS; i++) {
        const headName = `pos${i + 1}`;
        targets[headName] = trainingData.map(d => d.targets[i]);
    }
    
    await this.buildModel(this.inputNodes); 

    // COMPILE VỚI 5 LOSSES VÀ 5 METRICS
    this.model.compile({
        optimizer: tf.train.adam({
            learningRate: 0.0001, // Bắt đầu với learning rate thấp hơn nữa cho an toàn
            clipvalue: 1.0
        }),
        loss: 'categoricalCrossentropy', // DÙNG CATEGORICAL_CROSSENTROPY
    });
    
    console.log('✅ Model đã được compile. Bắt đầu quá trình training...');

    // Huấn luyện model
    await this.trainModel({ inputs, targets }); 
       
    // Lưu model sau khi huấn luyện xong
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
