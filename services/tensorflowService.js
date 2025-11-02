// file: services/tensorflowService.js

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
const DEFAULT_INPUT_NODES = 234; // Full with external features

class TensorFlowService {
  constructor() {
    this.model = null;
    this.featureService = new FeatureEngineeringService();
    this.inputNodes = DEFAULT_INPUT_NODES; // Default to avoid 0
  }

  precisionAt5(yTrue, yPred) {
    const trueLabels = tf.argMax(yTrue, -1).dataSync();
    const predTop5 = tf.topk(yPred, 5).indices.dataSync();
    
    let correct = 0;
    for (let i = 0; i < trueLabels.length; i++) {
      if (predTop5.slice(i * 5, (i + 1) * 5).includes(trueLabels[i])) {
        correct++;
      }
    }
    
    return correct / trueLabels.length;
  }

  async computeConfusionMatrix(testData, model) {
    const predictions = [];
    const truths = [];

    for (const data of testData) {
      const inputTensor = tf.tensor3d([data.inputSequence], [1, SEQUENCE_LENGTH, this.inputNodes]);
      const pred = model.predict(inputTensor);
      const predData = await pred.data();
      predictions.push(predData);
      truths.push(data.targetArray);
      inputTensor.dispose();
      pred.dispose();
    }

    // Confusion matrix cho 50 classes (10 digits x 5 positions)
    const cm = Array(OUTPUT_NODES).fill(null).map(() => Array(OUTPUT_NODES).fill(0));
    
    for (let i = 0; i < truths.length; i++) {
      const truth = truths[i];
      const pred = predictions[i];
      const trueClass = tf.argMax(tf.tensor(truth)).dataSync()[0];
      const predClass = tf.argMax(tf.tensor(pred)).dataSync()[0];
      cm[trueClass][predClass]++;
    }

    console.log('Confusion Matrix (simplified log):', cm.slice(0, 10)); // Log top 10 để tránh spam
    return cm;
  }

  async buildModel(inputNodes = DEFAULT_INPUT_NODES) {
    this.inputNodes = inputNodes || DEFAULT_INPUT_NODES;
    if (this.inputNodes <= 0) {
      console.warn('Invalid inputNodes, using default:', DEFAULT_INPUT_NODES);
      this.inputNodes = DEFAULT_INPUT_NODES;
    }

    this.model = tf.sequential({
      layers: [
        tf.layers.bidirectional({
          layer: tf.layers.lstm({
            units: 128,
            returnSequences: true,
            inputShape: [SEQUENCE_LENGTH, this.inputNodes]  // Explicit here
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

    console.log('✅ TensorFlow LSTM model built with inputShape:', [SEQUENCE_LENGTH, this.inputNodes]);
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
    const { trainData, valData, testData } = trainingSplit; // Sử dụng testData cho eval

    const classWeights = this.calculateClassWeights(trainData.map(d => d.targetArray));

    await this.buildModel(this.inputNodes);  // Ensure model built with correct inputNodes

    const trainInputs = trainData.map(d => d.inputSequence);
    const trainTargets = trainData.map(d => d.targetArray);
    const valInputs = valData.map(d => d.inputSequence);
    const valTargets = valData.map(d => d.targetArray);

    const trainInputTensor = tf.tensor3d(trainInputs);
    const trainTargetTensor = tf.tensor2d(trainTargets);
    const valInputTensor = tf.tensor3d(valInputs);
    const valTargetTensor = tf.tensor2d(valTargets);

    // TensorBoard callback (chỉ Node.js, log vào folder ./logs)
    const tensorBoard = tf.node.tensorBoard('./logs');

    const history = await this.model.fit(trainInputTensor, trainTargetTensor, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationData: [valInputTensor, valTargetTensor],
      classWeight: classWeights,
      callbacks: [
        tensorBoard,
        {
          onEpochEnd: (epoch, logs) => {
            console.log(`Epoch ${epoch + 1}: Loss = ${logs.loss?.toFixed(4)}, Val Loss = ${logs.val_loss?.toFixed(4)}`);
          }
        }
      ],
      optimizer: tf.train.adam(params.lr)
    });

    // Post-training eval: Precision@5 và confusion matrix trên test set
    if (testData.length > 0) {
      const testInputs = testData.map(d => d.inputSequence);
      const testInputTensor = tf.tensor3d(testInputs);
      const testPreds = this.model.predict(testInputTensor);
      const testPredData = await testPreds.data();

      const testTrue = tf.tensor2d(testData.map(d => d.targetArray));
      const p5 = this.precisionAt5(testTrue, tf.tensor2d(testPredData));
      console.log(`Precision@5 on test set: ${p5.toFixed(4)}`);

      await this.computeConfusionMatrix(testData, this.model);

      testInputTensor.dispose();
      testPreds.dispose();
      testTrue.dispose();
    }

    trainInputTensor.dispose();
    trainTargetTensor.dispose();
    valInputTensor.dispose();
    valTargetTensor.dispose();

    return history;
  }

  async loadPretrainedModel(pretrainedPath = 'file://./models/pretrained_lottery_model/model.json') {
    try {
      // Graceful skip if path doesn't exist (as per user issue)
      console.log('Attempting to load pre-trained model from:', pretrainedPath);
      const pretrainedModel = await tf.loadLayersModel(pretrainedPath);
      // Freeze early layers if loaded
      for (let i = 0; i < Math.min(2, pretrainedModel.layers.length); i++) {
        pretrainedModel.layers[i].trainable = false;
      }
      console.log('✅ Pre-trained model loaded and partially frozen');
      return pretrainedModel;
    } catch (error) {
      console.warn('❌ Failed to load pre-trained model (path may not exist), building new one:', error.message);
      return null;
    }
  }

  async predict(inputSequence) {
    if (!this.model) {
      throw new Error('Model not built or loaded. Call buildModel first.');
    }
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

    // Use for loop to handle async extractAllFeatures
    for (let i = 0; i < days.length - SEQUENCE_LENGTH; i++) {
      const sequenceDays = days.slice(i, i + SEQUENCE_LENGTH);
      const targetDay = days[i + SEQUENCE_LENGTH];

      // Async map for inputSequence
      const inputPromises = sequenceDays.map(async (day) => {
        const dayResults = grouped[day] || [];
        const previousDaysResults = sequenceDays.slice(0, sequenceDays.indexOf(day)).map(d => grouped[d] || []);
        return await this.featureService.extractAllFeatures(dayResults, previousDaysResults, day);
      });
      const inputSequence = await Promise.all(inputPromises);

      const targetGDB = (grouped[targetDay] || []).find(r => r.giai === 'ĐB');
      if (targetGDB?.so && String(targetGDB.so).length >= 5) {
        const targetGDBString = String(targetGDB.so).padStart(5, '0');
        const targetArray = this.prepareTarget(targetGDBString);
        trainingData.push({ inputSequence, targetArray });
      }
    }

    if (trainingData.length > 0) {
      this.inputNodes = trainingData[0].inputSequence[0].length;
      console.log('Detected inputNodes from data:', this.inputNodes);
    } else {
      console.warn('No training data generated, using default inputNodes:', DEFAULT_INPUT_NODES);
      this.inputNodes = DEFAULT_INPUT_NODES;
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

    // Skip pre-trained if not exist, build new
    const pretrained = await this.loadPretrainedModel();
    if (pretrained) {
      this.model = pretrained;
    } else {
      await this.buildModel(this.inputNodes);  // Build with detected inputNodes
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

  async runNextDayPrediction() {
    console.log('🔔 [TensorFlow Service] Generating next day prediction...');
    
    if (!this.model) {
      const modelLoaded = await this.loadModel();
      if (!modelLoaded) {
        await this.buildModel();  // Build default if not loaded
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

    // Pad if needed
    const paddingDay = Array(this.inputNodes).fill(0);
    while (latestSequenceDays.length < SEQUENCE_LENGTH) {
      latestSequenceDays.unshift('padding');
    }

    // Async extract for sequence
    const inputPromises = latestSequenceDays.map(async (day, index) => {
      if (day === 'padding') return paddingDay;
      const dayResults = grouped[day] || [];
      const previousDaysResults = latestSequenceDays.slice(0, index).map(d => grouped[d] || []);
      return await this.featureService.extractAllFeatures(dayResults, previousDaysResults, day);
    });
    const inputSequence = await Promise.all(inputPromises);

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
        await this.buildModel();  // Build default
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
          
          // Async extract
          const previousDays = [];
          const inputPromises = sequenceDays.map(async (day) => {
            const dayResults = grouped[day] || [];
            const prevDays = previousDays.slice();
            previousDays.push(dayResults);
            return await this.featureService.extractAllFeatures(dayResults, prevDays, day);
          });
          const inputSequence = await Promise.all(inputPromises);

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
