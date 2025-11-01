const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');
const FeatureEngineeringService = require('./featureEngineeringService');

const NN_MODEL_NAME = 'GDB_LSTM_TFJS';
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50; // 5 vị trí * 10 số
const EPOCHS = 50;
const BATCH_SIZE = 32;

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.inputNodes = 0; // Sẽ được xác định khi chuẩn bị dữ liệu
  }

  async buildModel(inputNodes) {
    this.inputNodes = inputNodes;
    this.model = tf.sequential({
      layers: [
        tf.layers.lstm({
          units: 128,
          returnSequences: true,
          inputShape: [SEQUENCE_LENGTH, inputNodes]
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.lstm({
          units: 64,
          returnSequences: false
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: 32,
          activation: 'relu'
        }),
        tf.layers.dense({
          units: OUTPUT_NODES,
          activation: 'sigmoid'
        })
      ]
    });

    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });

    console.log('✅ TensorFlow LSTM model built successfully');
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
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}, Accuracy = ${logs.acc.toFixed(4)}`);
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
    const target = Array(OUTPUT_NODES).fill(0.01);
    gdbString.split('').forEach((digit, index) => {
      const d = parseInt(digit);
      if (!isNaN(d) && index < 5) {
        target[index * 10 + d] = 0.99;
      }
    });
    return target;
  }

  async prepareTrainingData() {
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
      const sequenceDays = days.slice(i, i + SEQUENCE_LENGTH);
      const targetDay = days[i + SEQUENCE_LENGTH];

      const previousDays = [];
      const inputSequence = sequenceDays.map(day => {
        const dayResults = grouped[day] || [];
        // Lấy các ngày trước đó để tính pattern features
        const prevDays = previousDays.slice();
        previousDays.push(dayResults);
        return this.featureService.extractAllFeatures(dayResults, prevDays, day);
      });

      const targetGDB = (grouped[targetDay] || []).find(r => r.giai === 'ĐB');
      if (targetGDB?.so && String(targetGDB.so).length >= 5) {
        const targetGDBString = String(targetGDB.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);
        trainingData.push({ inputSequence, targetArray });
      }
    }

    // Xác định inputNodes từ dữ liệu training
    if (trainingData.length > 0) {
      this.inputNodes = trainingData[0].inputSequence[0].length;
    }

    console.log(`📊 Prepared ${trainingData.length} training sequences với feature size: ${this.inputNodes}`);
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

  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Starting Historical Training...');
    
    const trainingData = await this.prepareTrainingData();
    if (trainingData.length === 0) {
      throw new Error('Không có dữ liệu training');
    }

    const inputs = trainingData.map(d => d.inputSequence);
    const targets = trainingData.map(d => d.targetArray);

    await this.buildModel(this.inputNodes);
    await this.trainModel({ inputs, targets });
    await this.saveModel();

    return {
      message: `TensorFlow LSTM training completed. ${trainingData.length} sequences, ${EPOCHS} epochs.`,
      sequences: trainingData.length,
      epochs: EPOCHS,
      featureSize: this.inputNodes
    };
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
