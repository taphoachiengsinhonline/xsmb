const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');
const FeatureEngineeringService = require('./featureEngineeringService');

const NN_MODEL_NAME = 'GDB_LSTM_TFJS';
const SEQUENCE_LENGTH = 7;
const OUTPUT_NODES = 50;
const EPOCHS = 50;
const BATCH_SIZE = 32;
const MODEL_VERSION = 'v1.0';

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.inputNodes = 0;
  }

  async buildModel(inputNodes) {
    this.inputNodes = inputNodes;
    this.model = tf.sequential({
      layers: [
        tf.layers.bidirectional({
          layer: tf.layers.lstm({
            units: 128,
            returnSequences: true,
            inputShape: [SEQUENCE_LENGTH, inputNodes]
          }),
          mergeMode: 'concat'
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

    console.log('✅ TensorFlow LSTM model built with Bidirectional');
    return this.model;
  }

  async hyperparameterTuning(trainingSplit, paramGrid) {
    const { trainData, valData } = trainingSplit;
    let bestValLoss = Infinity;
    const bestParams = {};

    for (const lr of paramGrid.learningRates || [0.001]) {
      for (const units of paramGrid.units || [64, 128]) {
        for (const dropout of paramGrid.dropouts || [0.2, 0.3]) {
          console.log(`Tuning: lr=${lr}, units=${units}, dropout=${dropout}`);

          const tempModel = this.buildTempModel(this.inputNodes, units, dropout);
          tempModel.compile({
            optimizer: tf.train.adam(lr),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy']
          });

          const trainInputs = trainData.slice(0, 100).map(d => d.inputSequence); // Limit to 100 samples for tuning speed
          const trainTargets = trainData.slice(0, 100).map(d => d.targetArray);
          const valInputs = valData.slice(0, 20).map(d => d.inputSequence);
          const valTargets = valData.slice(0, 20).map(d => d.targetArray);

          const tempHistory = await tempModel.fit(
            tf.tensor3d(trainInputs),
            tf.tensor2d(trainTargets),
            { 
              epochs: 3, 
              validationData: [tf.tensor3d(valInputs), tf.tensor2d(valTargets)],
              verbose: 0
            }
          );

          const valLoss = tempHistory.history.val_loss[tempHistory.history.val_loss.length - 1];
          if (valLoss < bestValLoss) {
            bestValLoss = valLoss;
            bestParams = { lr, units, dropout };
          }

          tempModel.dispose();
        }
      }
    }

    console.log(`Best params: ${JSON.stringify(bestParams)}, Val Loss: ${bestValLoss}`);
    return bestParams;
  }

  buildTempModel(inputNodes, units, dropout) {
    return tf.sequential({
      layers: [
        tf.layers.lstm({ units, returnSequences: true, inputShape: [SEQUENCE_LENGTH, inputNodes] }),
        tf.layers.dropout({ rate: dropout }),
        tf.layers.lstm({ units: units / 2 }),
        tf.layers.dense({ units: OUTPUT_NODES, activation: 'sigmoid' })
      ]
    });
  }

  async trainModel(trainingSplit, params = { lr: 0.001, units: 128, dropout: 0.2 }) {
    const { trainData, valData } = trainingSplit;

    const classWeights = this.calculateClassWeights(trainData.map(d => d.targetArray));

    await this.buildModelWithParams(this.inputNodes, params.units, params.dropout);

    const trainInputs = trainData.map(d => d.inputSequence);
    const trainTargets = trainData.map(d => d.targetArray);
    const valInputs = valData.map(d => d.inputSequence);
    const valTargets = valData.map(d => d.targetArray);

    const trainInputTensor = tf.tensor3d(trainInputs);
    const trainTargetTensor = tf.tensor2d(trainTargets);
    const valInputTensor = tf.tensor3d(valInputs);
    const valTargetTensor = tf.tensor2d(valTargets);

    const history = await this.model.fit(trainInputTensor, trainTargetTensor, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationData: [valInputTensor, valTargetTensor],
      classWeight: classWeights,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss?.toFixed(4)}, Val Loss = ${logs.val_loss?.toFixed(4)}`);
        },
        onTrainEnd: () => {
          console.log('Training ended with early stopping if applicable');
        }
      },
      optimizer: tf.train.adam(params.lr)
    });

    trainInputTensor.dispose();
    trainTargetTensor.dispose();
    valInputTensor.dispose();
    valTargetTensor.dispose();

    return history;
  }

  buildModelWithParams(inputNodes, units, dropout) {
    this.inputNodes = inputNodes;
    this.model = tf.sequential({
      layers: [
        tf.layers.bidirectional({
          layer: tf.layers.lstm({ units, returnSequences: true, inputShape: [SEQUENCE_LENGTH, inputNodes] })
        }),
        tf.layers.dropout({ rate: dropout }),
        tf.layers.lstm({ units: units / 2 }),
        tf.layers.dropout({ rate: dropout }),
        tf.layers.dense({ units: 32, activation: 'relu' }),
        tf.layers.dense({ units: OUTPUT_NODES, activation: 'sigmoid' })
      ]
    });

    this.model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'binaryCrossentropy',
      metrics: ['accuracy']
    });

    console.log(`✅ Model built with params: units=${units}, dropout=${dropout}`);
    return this.model;
  }

  async loadPretrainedModel(pretrainedPath = 'file://./models/pretrained_lottery_model/model.json') {
    try {
      const pretrainedModel = await tf.loadLayersModel(pretrainedPath);
      for (let i = 0; i < 2; i++) {
        pretrainedModel.layers[i].trainable = false;
      }
      console.log('✅ Pre-trained model loaded and partially frozen');
      return pretrainedModel;
    } catch (error) {
      console.warn('❌ Failed to load pre-trained model, building new one:', error.message);
      return null;
    }
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

    if (trainingData.length > 0) {
      this.inputNodes = trainingData[0].inputSequence[0].length;
    }

    console.log(`📊 Prepared ${trainingData.length} training sequences với feature size: ${this.inputNodes}`);

    const total = trainingData.length;
    const trainEnd = Math.floor(total * 0.8);
    const valEnd = Math.floor(total * 0.9);

    const trainData = trainingData.slice(0, trainEnd);
    const valData = trainingData.slice(trainEnd, valEnd);
    const testData = trainingData.slice(valEnd);

    console.log(`📊 Split data: Train ${trainData.length}, Val ${valData.length}, Test ${testData.length}`);
    return { trainData, valData, testData };
  }

  dateKey(s) {
    if (!s || typeof s !== 'string') return '';
    const parts = s.split('/');
    return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }

  calculateClassWeights(targets) {
    const freq = Array(OUTPUT_NODES).fill(0);
    targets.forEach(t => t.forEach((val, idx) => { if (val > 0.5) freq[idx]++; }));
    return freq.map(f => f > 0 ? (targets.length / (OUTPUT_NODES * f)) : 1);
  }

  async saveModel() {
    if (!this.model) {
      throw new Error('No model to save');
    }

    const modelTopology = this.model.toJSON();
    const weightSpecs = this.model.weights.map(w => w.read().dataSync());
    const weightData = weightSpecs.map(ws => Array.from(ws));

    const modelInfo = {
      modelName: NN_MODEL_NAME,
      inputNodes: this.inputNodes,
      topology: modelTopology,
      weights: weightData,
      version: MODEL_VERSION,
      savedAt: new Date().toISOString()
    };

    await NNState.findOneAndUpdate(
      { modelName: NN_MODEL_NAME },
      { state: modelInfo },
      { upsert: true }
    );

    console.log(`💾 TensorFlow model saved to DB với ${this.inputNodes} input nodes`);
  }

  async loadModel() {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.state && modelState.state.topology && modelState.state.weights) {
      if (modelState.state.version !== MODEL_VERSION) {
        console.warn(`❌ Model version mismatch: expected ${MODEL_VERSION}, got ${modelState.state.version}. Will rebuild.`);
        return false;
      }

      this.model = tf.models.modelFromJSON(modelState.state.topology);
      const weightTensors = modelState.state.weights.map(w => tf.tensor(w));
      this.model.setWeights(weightTensors);

      this.inputNodes = modelState.state.inputNodes;
      console.log(`✅ TensorFlow model loaded từ DB với ${this.inputNodes} input nodes`);
      return true;
    }
    return false;
  }

  async runHistoricalTraining() {
    console.log('🔔 [TensorFlow Service] Starting Historical Training with Tuning...');
    
    const trainingSplit = await this.prepareTrainingData();
    if (trainingSplit.trainData.length === 0) {
      throw new Error('Không có dữ liệu training');
    }

    const pretrained = await this.loadPretrainedModel();
    if (pretrained) {
      this.model = pretrained;
    } else {
      await this.buildModelWithParams(this.inputNodes, 128, 0.2);
    }

    const paramGrid = {
      learningRates: [0.0001, 0.001, 0.01],
      units: [64, 128, 256],
      dropouts: [0.1, 0.2, 0.3]
    };
    const tunedParams = await this.hyperparameterTuning(trainingSplit, paramGrid);

    await this.trainModel(trainingSplit, tunedParams);
    await this.saveModel();

    return {
      message: `Training completed with tuning. Best params: ${JSON.stringify(tunedParams)}`,
      sequences: trainingSplit.trainData.length,
      epochs: EPOCHS,
      featureSize: this.inputNodes
    };
  }

  async runNNLearning() {
    console.log('🔔 [TensorFlow Service] Incremental Learning from new results...');
    
    if (!this.model) {
      const loaded = await this.loadModel();
      if (!loaded) throw new Error('Model chưa được load. Chạy training trước.');
    }

    const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
    if (!predictionsToLearn.length) return { message: 'Không có dự đoán mới để học.' };

    const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
    const grouped = {};
    allResults.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));

    let learnedCount = 0;
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
          const newData = [{ inputSequence, targetArray }];

          const originalOptimizer = this.model.optimizer;
          const fineTuneOptimizer = tf.train.adam(0.0001);
          this.model.compile({ optimizer: fineTuneOptimizer, loss: 'binaryCrossentropy' });

          await this.model.fit(
            tf.tensor3d(newData.map(d => d.inputSequence)),
            tf.tensor2d(newData.map(d => d.targetArray)),
            { epochs: 10, verbose: 0 }
          );

          this.model.compile({ optimizer: originalOptimizer, loss: 'binaryCrossentropy' });

          learnedCount++;
        }
      }
      await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }
    
    await this.saveModel();
    return { message: `Incremental learning completed. Learned ${learnedCount} new results.` };
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
    if (results.length < 1) {
      throw new Error('Không có dữ liệu.');
    }

    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.ngay]) grouped[r.ngay] = [];
      grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    let latestSequenceDays = days.slice(-SEQUENCE_LENGTH);

    const paddingDay = Array(this.inputNodes).fill(0);
    while (latestSequenceDays.length < SEQUENCE_LENGTH) {
      latestSequenceDays.unshift('padding');
    }

    const previousDays = [];
    const inputSequence = latestSequenceDays.map((day, index) => {
      if (day === 'padding') {
        return paddingDay;
      }
      const dayResults = grouped[day] || [];
      const prevDays = previousDays.slice();
      previousDays.push(dayResults);
      return this.featureService.extractAllFeatures(dayResults, prevDays, day);
    });

    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = days[days.length - 1];
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

  async runLearning() {
    console.log('🔔 [TensorFlow Service] Learning from new results...');
    
    if (!this.model) {
      const modelLoaded = await this.loadModel();
      if (!modelLoaded) {
        throw new Error('Model chưa được huấn luyện. Hãy chạy huấn luyện trước.');
      }
    }

    const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
    if (!predictionsToLearn.length) {
      return { message: 'Không có dự đoán mới nào để học.' };
    }

    const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
    const grouped = {};
    allResults.forEach(r => {
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
        epochs: 10,
        batchSize: Math.min(8, trainingData.length),
        validationSplit: 0.2,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            console.log(`Fine-tuning Epoch ${epoch + 1}: Loss = ${logs.loss?.toFixed(4) || 'N/A'}`);
          }
        }
      });

      inputTensor.dispose();
      targetTensor.dispose();
      
      await this.saveModel();
    }
    
    return { 
      message: `TensorFlow LSTM đã học từ ${learnedCount} kết quả mới.`,
      learnedCount 
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
