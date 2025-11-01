// file: services/neuralNetworkService.js

const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');

// Lớp Neural Network, không thay đổi
class NeuralNetwork {
    constructor(inputNodes, hiddenNodes, outputNodes) {
        this.inputNodes = inputNodes;
        this.hiddenNodes = hiddenNodes;
        this.outputNodes = outputNodes;
        this.weights_ih = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_ho = this.createMatrix(this.outputNodes, this.hiddenNodes);
        this.bias_h = this.createMatrix(this.hiddenNodes, 1);
        this.bias_o = this.createMatrix(this.outputNodes, 1);
        this.randomize();
        this.learningRate = 0.1;
    }
    createMatrix(rows, cols) { return Array(rows).fill(0).map(() => Array(cols).fill(0)); }
    randomize() {
        this.weights_ih = this.weights_ih.map(row => row.map(() => Math.random() * 2 - 1));
        this.weights_ho = this.weights_ho.map(row => row.map(() => Math.random() * 2 - 1));
        this.bias_h = this.bias_h.map(row => row.map(() => Math.random() * 2 - 1));
        this.bias_o = this.bias_o.map(row => row.map(() => Math.random() * 2 - 1));
    }
    sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
    dsigmoid(y) { return y * (1 - y); }
    static fromJson(data) {
        const nn = new NeuralNetwork(data.inputNodes, data.hiddenNodes, data.outputNodes);
        if (data.weights_ih) nn.weights_ih = data.weights_ih;
        if (data.weights_ho) nn.weights_ho = data.weights_ho;
        if (data.bias_h) nn.bias_h = data.bias_h;
        if (data.bias_o) nn.bias_o = data.bias_o;
        if (data.learningRate) nn.learningRate = data.learningRate;
        return nn;
    }
    predict(inputArray) {
        const inputs = this.arrayToMatrix(inputArray);
        const hidden = this.multiply(this.weights_ih, inputs);
        hidden.forEach((row, i) => row.forEach((_, j) => hidden[i][j] += this.bias_h[i][j]));
        hidden.forEach((row, i) => row.forEach((val, j) => hidden[i][j] = this.sigmoid(val)));
        const output = this.multiply(this.weights_ho, hidden);
        output.forEach((row, i) => row.forEach((_, j) => output[i][j] += this.bias_o[i][j]));
        output.forEach((row, i) => row.forEach((val, j) => output[i][j] = this.sigmoid(val)));
        return this.matrixToArray(output);
    }
    train(inputArray, targetArray) {
        const inputs = this.arrayToMatrix(inputArray);
        const hidden = this.multiply(this.weights_ih, inputs);
        hidden.forEach((r, i) => r.forEach((_, j) => hidden[i][j] += this.bias_h[i][j]));
        hidden.forEach((r, i) => r.forEach((v, j) => hidden[i][j] = this.sigmoid(v)));
        const outputs = this.multiply(this.weights_ho, hidden);
        outputs.forEach((r, i) => r.forEach((_, j) => outputs[i][j] += this.bias_o[i][j]));
        outputs.forEach((r, i) => r.forEach((v, j) => outputs[i][j] = this.sigmoid(v)));
        const targets = this.arrayToMatrix(targetArray);
        const output_errors = this.subtract(targets, outputs);
        const gradients = outputs.map(r => r.slice());
        gradients.forEach((r, i) => r.forEach((v, j) => g[i][j] = this.dsigmoid(v)));
        gradients.forEach((r, i) => r.forEach((v, j) => g[i][j] *= output_errors[i][j]));
        gradients.forEach(r => r.forEach((v, i) => r[i] *= this.learningRate));
        const hidden_T = this.transpose(hidden);
        const weight_ho_deltas = this.multiply(gradients, hidden_T);
        this.weights_ho.forEach((r, i) => r.forEach((_, j) => this.weights_ho[i][j] += weight_ho_deltas[i][j]));
        this.bias_o.forEach((r, i) => r.forEach((_, j) => this.bias_o[i][j] += gradients[i][j]));
        const who_t = this.transpose(this.weights_ho);
        const hidden_errors = this.multiply(who_t, output_errors);
        const hidden_gradient = hidden.map(r => r.slice());
        hidden_gradient.forEach((r, i) => r.forEach((v, j) => hidden_gradient[i][j] = this.dsigmoid(v)));
        hidden_gradient.forEach((r, i) => r.forEach((v, j) => hidden_gradient[i][j] *= hidden_errors[i][j]));
        hidden_gradient.forEach(r => r.forEach((v, i) => r[i] *= this.learningRate));
        const inputs_T = this.transpose(inputs);
        const weight_ih_deltas = this.multiply(hidden_gradient, inputs_T);
        this.weights_ih.forEach((r, i) => r.forEach((_, j) => this.weights_ih[i][j] += weight_ih_deltas[i][j]));
        this.bias_h.forEach((r, i) => r.forEach((_, j) => this.bias_h[i][j] += hidden_gradient[i][j]));
    }
    arrayToMatrix(a) { return a.map(e => [e]); }
    matrixToArray(m) { return m.flat(); }
    transpose(m) { return m[0].map((_, c) => m.map(r => r[c])); }
    multiply(a, b) { return a.map((r, i) => b[0].map((_, j) => r.reduce((s, e, k) => s + (e * b[k][j]), 0))); }
    subtract(a, b) { return a.map((r, i) => r.map((v, j) => v - b[i][j])); }
}

const NN_MODEL_NAME = 'GDB_5_POS_PREDICTOR';
const INPUT_NODES = 135;
const HIDDEN_NODES = 64;
const OUTPUT_NODES = 50;

const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

const dateKey = (s) => { if (!s || typeof s !== 'string') return ''; const parts = s.split('/'); return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`; };

const prepareInput = (resultsForDay) => {
    const input = [];
    PRIZE_ORDER.forEach(prize => {
        const result = resultsForDay.find(r => r.giai === prize);
        const numStr = String(result?.so || '0').padStart(5, '0');
        numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
    });
    return input;
};

const prepareTarget = (gdbString) => {
    const target = Array(OUTPUT_NODES).fill(0.01);
    gdbString.split('').forEach((digit, index) => {
        const d = parseInt(digit);
        if (!isNaN(d) && index < 5) {
            target[index * 10 + d] = 0.99;
        }
    });
    return target;
};

const getNN = async () => {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.state) {
        return NeuralNetwork.fromJson(modelState.state);
    }
    return new NeuralNetwork(INPUT_NODES, HIDDEN_NODES, OUTPUT_NODES);
};

const saveNN = async (nn) => {
    await NNState.findOneAndUpdate(
        { modelName: NN_MODEL_NAME },
        { state: JSON.parse(JSON.stringify(nn)) },
        { upsert: true }
    );
};

const decodeOutput = (output) => {
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
};

const runNNHistoricalTraining = async () => {
    console.log('🔔 [NN Service] Starting Historical Training...');
    const nn = await getNN();
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < 2) throw new Error("Không đủ dữ liệu lịch sử để huấn luyện.");

    const grouped = {};
    results.forEach(r => {
        if (!grouped[r.ngay]) grouped[r.ngay] = [];
        grouped[r.ngay].push(r);
    });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));

    let trainedCount = 0;
    for (let i = 1; i < days.length; i++) {
        const yesterdayDate = days[i - 1];
        const todayDate = days[i];
        
        const inputArray = prepareInput(grouped[yesterdayDate] || []);
        const targetGDB_Object = (grouped[todayDate] || []).find(r => r.giai === 'ĐB');

        if (targetGDB_Object?.so && String(targetGDB_Object.so).length >= 5) {
            const targetGDB_String = String(targetGDB_Object.so).padStart(5, '0');
            const targetArray = prepareTarget(targetGDB_String);
            nn.train(inputArray, targetArray);
            trainedCount++;
        }
    }
    await saveNN(nn);
    return { message: `AI đã học xong từ lịch sử. Đã xử lý ${trainedCount} cặp dữ liệu.` };
};

const runNNNextDayPrediction = async () => {
    console.log('🔔 [NN Service] Generating next day prediction...');
    const nn = await getNN();
    const results = await Result.find().lean();
    if (results.length < 1) throw new Error("Không có dữ liệu để dự đoán.");
    
    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    const latestDay = days[days.length - 1];
    
    const inputArray = prepareInput(grouped[latestDay] || []);
    const output = nn.predict(inputArray);
    const prediction = decodeOutput(output);
    
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
    
    await NNPrediction.findOneAndUpdate(
        { ngayDuDoan: nextDayStr },
        { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false },
        { upsert: true, new: true }
    );
    return { message: `AI đã tạo dự đoán cho ngày ${nextDayStr}.`, ngayDuDoan: nextDayStr };
};

const runNNLearning = async () => {
    console.log('🔔 [NN Service] Learning from new results...');
    const nn = await getNN();
    const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
    if (!predictionsToLearn.length) return { message: 'Không có dự đoán mới nào để học.' };

    let learnedCount = 0;
    for (const pred of predictionsToLearn) {
        const actualResult = await Result.findOne({ ngay: pred.ngayDuDoan, giai: 'ĐB' }).lean();
        if (actualResult?.so && String(actualResult.so).length >= 5) {
            const targetGDB_String = String(actualResult.so).padStart(5, '0');
            const targetArray = prepareTarget(targetGDB_String);
            
            const prevDateStr = DateTime.fromFormat(pred.ngayDuDoan, 'dd/MM/yyyy').minus({ days: 1 }).toFormat('dd/MM/yyyy');
            const prevDayResults = await Result.find({ ngay: prevDateStr }).lean();

            if (prevDayResults.length > 0) {
                const inputArray = prepareInput(prevDayResults);
                nn.train(inputArray, targetArray);
                learnedCount++;
            }
        }
        await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }
    
    if (learnedCount > 0) {
        await saveNN(nn);
    }
    
    return { message: `AI đã học xong. Đã xử lý ${learnedCount} kết quả mới.` };
};

module.exports = { runNNHistoricalTraining, runNNNextDayPrediction, runNNLearning };
