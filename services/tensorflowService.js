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
const MODEL_VERSION = 'v1.0'; // Thêm version control cho model state (tăng khi thay đổi features hoặc architecture)

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
      // Thêm Bidirectional LSTM cho layer đầu tiên
      tf.layers.bidirectional({
        layer: tf.layers.lstm({
          units: 128,
          returnSequences: true,
          inputShape: [SEQUENCE_LENGTH, inputNodes]
        }),
        mergeMode: 'concat' // Kết hợp output từ forward và backward
      }),
      tf.layers.dropout({ rate: 0.2 }),
      
      // Thêm Multi-Head Attention để focus vào các phần quan trọng của sequence
      tf.layers.multiHeadAttention({
        numHeads: 4,       // Số heads
        headSize: 32,      // Kích thước mỗi head
        outputSize: 128,   // Output size
        useBias: true
      }),
      
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

  console.log('✅ TensorFlow LSTM model built with Bidirectional and Attention mechanisms');
  return this.model;
}

  async trainModel(trainingSplit) {
  const { trainData, valData } = trainingSplit;

  const classWeights = this.calculateClassWeights(trainData.map(d => d.targetArray));

  const trainInputs = trainData.map(d => d.inputSequence);
  const trainTargets = trainData.map(d => d.targetArray);
  const valInputs = valData.map(d => d.inputSequence);
  const valTargets = valData.map(d => d.targetArray);

  const trainInputTensor = tf.tensor3d(trainInputs);
  const trainTargetTensor = tf.tensor2d(trainTargets);
  const valInputTensor = tf.tensor3d(valInputs);
  const valTargetTensor = tf.tensor2d(valTargets);

  const k = 5;
  const foldSize = Math.floor(trainInputs.length / k);
  let histories = [];

  for (let fold = 0; fold < k; fold++) {
    const foldStart = fold * foldSize;
    const foldEnd = (fold + 1) * foldSize;

    const foldValInputs = trainInputs.slice(foldStart, foldEnd);
    const foldValTargets = trainTargets.slice(foldStart, foldEnd);
    const foldTrainInputs = trainInputs.slice(0, foldStart).concat(trainInputs.slice(foldEnd));
    const foldTrainTargets = trainTargets.slice(0, foldStart).concat(trainTargets.slice(foldEnd));

    const foldTrainTensorX = tf.tensor3d(foldTrainInputs);
    const foldTrainTensorY = tf.tensor2d(foldTrainTargets);
    const foldValTensorX = tf.tensor3d(foldValInputs);
    const foldValTensorY = tf.tensor2d(foldValTargets);

    const history = await this.model.fit(foldTrainTensorX, foldTrainTensorY, {
      epochs: EPOCHS,
      batchSize: BATCH_SIZE,
      validationData: [foldValTensorX, foldValTensorY],
      classWeight: classWeights,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Fold ${fold + 1} - Epoch ${epoch + 1}: Loss = ${logs.loss.toFixed(4)}`);
        }
      }
    });

    histories.push(history);

    foldTrainTensorX.dispose();
    foldTrainTensorY.dispose();
    foldValTensorX.dispose();
    foldValTensorY.dispose();
  }

  trainInputTensor.dispose();
  trainTargetTensor.dispose();
  valInputTensor.dispose();
  valTargetTensor.dispose();

  return histories;
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

  async saveModel() {
  if (!this.model) {
    throw new Error('No model to save');
  }

  // Extract model topology (config) và weights
  const modelTopology = this.model.toJSON(); // Trả về object config của model
  const weightSpecs = this.model.weights.map(w => w.read().dataSync()); // Extract weights as arrays

  // Convert weights thành dạng lưu được (JSON stringifiable)
  const weightData = weightSpecs.map(ws => Array.from(ws)); // Chuyển DataSync() thành array

  const modelInfo = {
    modelName: NN_MODEL_NAME,
    inputNodes: this.inputNodes,
    topology: modelTopology, // Lưu config
    weights: weightData,     // Lưu weights arrays
    version: MODEL_VERSION,  // Thêm version để check khi load
    savedAt: new Date().toISOString()
  };

  // Lưu vào DB (NNState)
  await NNState.findOneAndUpdate(
    { modelName: NN_MODEL_NAME },
    { state: modelInfo }, // Lưu toàn bộ info vào state
    { upsert: true }
  );

  console.log(`💾 TensorFlow model saved to DB với ${this.inputNodes} input nodes`);
}

async loadModel() {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.state && modelState.state.topology && modelState.state.weights) {
      // Check version để tránh load model cũ với features mới
      if (modelState.state.version !== MODEL_VERSION) {
        console.warn(`❌ Model version mismatch: expected ${MODEL_VERSION}, got ${modelState.state.version}. Will rebuild.`);
        return false;
      }

      // Rebuild model từ topology
      this.model = tf.models.modelFromJSON(modelState.state.topology);

      // Set weights
      const weightTensors = modelState.state.weights.map(w => tf.tensor(w));
      this.model.setWeights(weightTensors);

      this.inputNodes = modelState.state.inputNodes;
      console.log(`✅ TensorFlow model loaded từ DB với ${this.inputNodes} input nodes`);
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
    if (results.length < 1) { // Không yêu cầu đủ SEQUENCE_LENGTH nữa, vì sẽ pad
      throw new Error('Không có dữ liệu.');
    }

    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.ngay]) grouped[r.ngay] = [];
      grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
    let latestSequenceDays = days.slice(-SEQUENCE_LENGTH);

    // Nếu không đủ sequence, pad với ngày giả (features zeros)
    const paddingDay = Array(this.inputNodes).fill(0); // Pad với zeros
    while (latestSequenceDays.length < SEQUENCE_LENGTH) {
      latestSequenceDays.unshift('padding'); // Thêm padding ở đầu
    }

    const previousDays = [];
    const inputSequence = latestSequenceDays.map((day, index) => {
      if (day === 'padding') {
        return paddingDay; // Sử dụng padding zeros cho ngày giả
      }
      const dayResults = grouped[day] || [];
      const prevDays = previousDays.slice();
      previousDays.push(dayResults);
      return this.featureService.extractAllFeatures(dayResults, prevDays, day);
    });

    const output = await this.predict(inputSequence);
    const prediction = this.decodeOutput(output);

    const latestDay = days[days.length - 1]; // Lấy ngày thật cuối cùng
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

  // THÊM HÀM runLearning ĐẦY ĐỦ
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
