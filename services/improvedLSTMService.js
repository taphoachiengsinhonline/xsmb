const tf = require('@tensorflow/tfjs');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');

// Cấu hình
const NN_MODEL_NAME = 'GDB_LSTM_TFJS';
const INPUT_NODES = 135;
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 50;
const BATCH_SIZE = 32;

class ImprovedLSTMService {
  constructor() {
    this.model = null;
  }

  async buildModel() {
    const model = tf.sequential({
      layers: [
        tf.layers.lstm({
          units: 128,
          returnSequences: true,
          inputShape: [SEQUENCE_LENGTH, INPUT_NODES]
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.lstm({
          units: 64,
          returnSequences: false
        }),
        tf.layers.dropout({ rate: 0.2 }),
        tf.layers.dense({
          units: OUTPUT_NODES,
          activation: 'sigmoid'
        })
      ]
    });

    model.compile({
      optimizer: 'adam',
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });

    this.model = model;
    return model;
  }

  async trainModel(trainingData) {
    const { inputs, targets } = trainingData;

    const inputTensor = tf.tensor3d(inputs, [inputs.length, SEQUENCE_LENGTH, INPUT_NODES]);
    const targetTensor = tf.tensor2d(targets, [targets.length, OUTPUT_NODES]);

    await this.model.fit(inputTensor, targetTensor, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationSplit: 0.1,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss}, Accuracy = ${logs.acc}`);
        }
      }
    });

    // Giải phóng bộ nhớ
    inputTensor.dispose();
    targetTensor.dispose();
  }

  async predict(inputSequence) {
    const inputTensor = tf.tensor3d([inputSequence], [1, SEQUENCE_LENGTH, INPUT_NODES]);
    const prediction = this.model.predict(inputTensor);
    const output = await prediction.data();
    prediction.dispose();
    inputTensor.dispose();
    return Array.from(output);
  }

  // Các hàm tiện ích để chuẩn bị dữ liệu (sẽ được cải thiện trong mục 4)
  prepareInput(resultsForDay) {
    // Tạm thời giữ nguyên, sẽ cải thiện ở mục 4
    const input = [];
    const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];
    PRIZE_ORDER.forEach(prize => {
      const result = resultsForDay.find(r => r.giai === prize);
      const numStr = String(result?.so || '0').padStart(5, '0');
      numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
    });
    return input;
  }

  prepareTarget(gdbString) {
    // Tạm thời giữ nguyên
    const target = Array(OUTPUT_NODES).fill(0.01);
    gdbString.split('').forEach((digit, index) => {
      const d = parseInt(digit);
      if (!isNaN(d) && index < 5) { target[index * 10 + d] = 0.99; }
    });
    return target;
  }

  // Hàm để lưu và tải model
  async saveModel() {
    const modelInfo = {
      modelName: NN_MODEL_NAME,
      modelArtifacts: await this.model.save('indexeddb://' + NN_MODEL_NAME)
    };
    // Lưu vào NNState hoặc cơ sở dữ liệu
    await NNState.findOneAndUpdate(
      { modelName: NN_MODEL_NAME },
      { state: modelInfo },
      { upsert: true }
    );
  }

  async loadModel() {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.state) {
      this.model = await tf.loadLayersModel('indexeddb://' + NN_MODEL_NAME);
    } else {
      await this.buildModel();
    }
  }
}

module.exports = ImprovedLSTMService;
