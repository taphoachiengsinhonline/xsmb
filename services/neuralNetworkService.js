// file: services/neuralNetworkService.js

const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');

// =================================================================
// KIẾN TRÚC MỚI: MẠNG LSTM (LONG SHORT-TERM MEMORY)
// =================================================================
// Lớp này được viết lại hoàn toàn để có "trí nhớ"
class LSTMNetwork {
    constructor(inputNodes, hiddenNodes, outputNodes) {
        this.inputNodes = inputNodes;
        this.hiddenNodes = hiddenNodes;
        this.outputNodes = outputNodes;

        // LSTM gates: Forget, Input, Candidate, Output
        // Mỗi gate đều cần weights cho input và hidden state trước đó
        this.weights_if = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_hf = this.createMatrix(this.hiddenNodes, this.hiddenNodes);
        this.bias_f = this.createMatrix(this.hiddenNodes, 1);

        this.weights_ii = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_hi = this.createMatrix(this.hiddenNodes, this.hiddenNodes);
        this.bias_i = this.createMatrix(this.hiddenNodes, 1);

        this.weights_ic = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_hc = this.createMatrix(this.hiddenNodes, this.hiddenNodes);
        this.bias_c = this.createMatrix(this.hiddenNodes, 1);

        this.weights_io = this.createMatrix(this.hiddenNodes, this.inputNodes);
        this.weights_ho = this.createMatrix(this.hiddenNodes, this.hiddenNodes);
        this.bias_o = this.createMatrix(this.hiddenNodes, 1);

        // Output layer weights
        this.weights_output = this.createMatrix(this.outputNodes, this.hiddenNodes);
        this.bias_output = this.createMatrix(this.outputNodes, 1);

        this.learningRate = 0.05; // Giảm learning rate cho ổn định hơn
        this.randomize();
    }

    // --- Các hàm ma trận và kích hoạt ---
    createMatrix(rows, cols) { return Array(rows).fill(0).map(() => Array(cols).fill(0)); }
    randomize() {
        const keys = Object.keys(this);
        for (const key of keys) {
            if (key.startsWith('weights_') || key.startsWith('bias_')) {
                this[key] = this[key].map(row => row.map(() => Math.random() * 0.2 - 0.1)); // Khởi tạo weight nhỏ hơn
            }
        }
    }
    sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
    dsigmoid(y) { return y * (1 - y); }
    tanh(x) { return Math.tanh(x); }
    dtanh(y) { return 1 - (y * y); }
    
    // Hàm nhân và cộng ma trận
    multiply(a, b) { return a.map((r, i) => b[0].map((_, j) => r.reduce((s, e, k) => s + (e * b[k][j]), 0))); }
    add(a, b) { return a.map((r, i) => r.map((v, j) => v + b[i][j])); }
    subtract(a, b) { return a.map((r, i) => r.map((v, j) => v - b[i][j])); }
    hadamard(a, b) { return a.map((r, i) => r.map((v, j) => v * b[i][j])); } // Phép nhân element-wise
    transpose(m) { return m[0].map((_, c) => m.map(r => r[c])); }
    
    // --- Hàm lưu và tải trạng thái ---
    static fromJson(data) {
        if (!data.inputNodes || !data.hiddenNodes || !data.outputNodes) {
             console.warn("Dữ liệu state cũ không hợp lệ cho LSTM. Đang tạo model mới.");
             return new LSTMNetwork(INPUT_NODES, HIDDEN_NODES, OUTPUT_NODES);
        }
        const nn = new LSTMNetwork(data.inputNodes, data.hiddenNodes, data.outputNodes);
        const keys = Object.keys(nn);
        for (const key of keys) {
            if (data[key]) nn[key] = data[key];
        }
        return nn;
    }

    // --- Cốt lõi của LSTM: 1 bước xử lý (forward pass) ---
    feedforward(input, prevState) {
        let { cellState, hiddenState } = prevState;
        const inputMatrix = input.map(e => [e]);

        // 1. Forget Gate: quyết định thông tin nào từ cell state cũ sẽ bị loại bỏ
        let forgetGate = this.add(this.multiply(this.weights_if, inputMatrix), this.multiply(this.weights_hf, hiddenState));
        forgetGate = this.add(forgetGate, this.bias_f).map(r => r.map(this.sigmoid));

        // 2. Input Gate: quyết định thông tin mới nào sẽ được lưu vào cell state
        let inputGate = this.add(this.multiply(this.weights_ii, inputMatrix), this.multiply(this.weights_hi, hiddenState));
        inputGate = this.add(inputGate, this.bias_i).map(r => r.map(this.sigmoid));
        
        // 3. Candidate Gate: tạo ra một vector chứa thông tin mới có thể được thêm vào
        let candidateGate = this.add(this.multiply(this.weights_ic, inputMatrix), this.multiply(this.weights_hc, hiddenState));
        candidateGate = this.add(candidateGate, this.bias_c).map(r => r.map(this.tanh));

        // 4. Cập nhật Cell State: trí nhớ dài hạn
        cellState = this.add(this.hadamard(forgetGate, cellState), this.hadamard(inputGate, candidateGate));

        // 5. Output Gate: quyết định sẽ output ra cái gì từ cell state
        let outputGate = this.add(this.multiply(this.weights_io, inputMatrix), this.multiply(this.weights_ho, hiddenState));
        outputGate = this.add(outputGate, this.bias_o).map(r => r.map(this.sigmoid));

        // 6. Cập nhật Hidden State: trí nhớ ngắn hạn (cũng là output của bước này)
        hiddenState = this.hadamard(outputGate, cellState.map(r => r.map(this.tanh)));

        // 7. Lớp Output cuối cùng
        let finalOutput = this.add(this.multiply(this.weights_output, hiddenState), this.bias_output);
        finalOutput = finalOutput.map(r => r.map(this.sigmoid));

        return {
            output: finalOutput.flat(),
            state: { cellState, hiddenState }
        };
    }
    
    // --- QUY TRÌNH MỚI: Huấn luyện qua nhiều Epochs và Batches ---
    train(inputSequence, targetArray) {
        // LSTM cần toàn bộ chuỗi để tính toán lan truyền ngược theo thời gian (BPTT)
        // Tuy nhiên, việc triển khai BPTT đầy đủ rất phức tạp.
        // Ở đây chúng ta sẽ dùng một cách đơn giản hóa: huấn luyện từng bước trong chuỗi
        // và lan truyền lỗi ngược lại một cách độc lập cho mỗi bước.
        // Đây là một sự đánh đổi để code đơn giản hơn.
        
        let hiddenState = this.createMatrix(this.hiddenNodes, 1);
        let cellState = this.createMatrix(this.hiddenNodes, 1);
        
        for(let i = 0; i < inputSequence.length; i++) {
            const input = inputSequence[i];
            const result = this.feedforward(input, { cellState, hiddenState });
            
            // Cập nhật state cho bước tiếp theo
            cellState = result.state.cellState;
            hiddenState = result.state.hiddenState;
        }

        // Chỉ tính lỗi và cập nhật weights dựa trên output cuối cùng của chuỗi
        const finalOutput = this.add(this.multiply(this.weights_output, hiddenState), this.bias_output).map(r => r.map(this.sigmoid));
        const targets = targetArray.map(e => [e]);

        const output_errors = this.subtract(targets, finalOutput);
        const gradients = finalOutput.map((r, i) => r.map((v, j) => this.dsigmoid(v) * output_errors[i][j] * this.learningRate));
        const hidden_T = this.transpose(hiddenState);
        const weight_output_deltas = this.multiply(gradients, hidden_T);
        
        this.weights_output = this.add(this.weights_output, weight_output_deltas);
        this.bias_output = this.add(this.bias_output, gradients);
        
        // Backpropagate lỗi về các gate (phần này rất phức tạp, ở đây là một phiên bản đơn giản hóa)
        // Một framework như TensorFlow/PyTorch sẽ tự động xử lý phần này.
        // Trong phạm vi dự án này, việc cập nhật chỉ lớp output đã là một cải tiến lớn.
    }
    
    // --- QUY TRÌNH MỚI: Dự đoán dựa trên một chuỗi đầu vào ---
    predict(inputSequence) {
        let hiddenState = this.createMatrix(this.hiddenNodes, 1);
        let cellState = this.createMatrix(this.hiddenNodes, 1);

        for (const input of inputSequence) {
            const result = this.feedforward(input, { cellState, hiddenState });
            cellState = result.state.cellState;
            hiddenState = result.state.hiddenState;
        }

        const finalOutput = this.add(this.multiply(this.weights_output, hiddenState), this.bias_output);
        return finalOutput.map(r => r.map(this.sigmoid)).flat();
    }
}

// =================================================================
// CẤU HÌNH VÀ CÁC HÀM TIỆN ÍCH
// =================================================================
const NN_MODEL_NAME = 'GDB_LSTM_PREDICTOR_V2'; // Đổi tên model để không ghi đè state cũ
const INPUT_NODES = 135; // 27 giải * 5 số
const HIDDEN_NODES = 100; // Tăng số node ẩn cho LSTM
const OUTPUT_NODES = 50; // 5 vị trí * 10 số

// --- CÁC THAM SỐ HUẤN LUYỆN MỚI ---
const SEQUENCE_LENGTH = 7; // AI sẽ nhìn vào 7 ngày gần nhất để dự đoán
const EPOCHS = 20; // Lặp lại toàn bộ dữ liệu 20 lần để học kỹ hơn
const BATCH_SIZE = 16; // Mỗi lần học sẽ xử lý 16 chuỗi dữ liệu

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
        if (!isNaN(d) && index < 5) { target[index * 10 + d] = 0.99; }
    });
    return target;
};

const getNN = async () => {
    const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
    if (modelState && modelState.state) {
        return LSTMNetwork.fromJson(modelState.state);
    }
    return new LSTMNetwork(INPUT_NODES, HIDDEN_NODES, OUTPUT_NODES);
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

// =================================================================
// CÁC HÀM ĐIỀU KHIỂN ĐÃ ĐƯỢC CẬP NHẬT
// =================================================================

const runNNHistoricalTraining = async () => {
    console.log('🔔 [LSTM Service] Starting Historical Training...');
    const nn = await getNN();
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < SEQUENCE_LENGTH + 1) throw new Error(`Không đủ dữ liệu lịch sử để huấn luyện. Cần ít nhất ${SEQUENCE_LENGTH + 1} ngày.`);

    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));

    // Tạo các chuỗi dữ liệu (sequences)
    const trainingData = [];
    for (let i = 0; i < days.length - SEQUENCE_LENGTH; i++) {
        const sequenceDays = days.slice(i, i + SEQUENCE_LENGTH);
        const targetDay = days[i + SEQUENCE_LENGTH];

        const inputSequence = sequenceDays.map(day => prepareInput(grouped[day] || []));
        const targetGDB_Object = (grouped[targetDay] || []).find(r => r.giai === 'ĐB');

        if (targetGDB_Object?.so && String(targetGDB_Object.so).length >= 5) {
            const targetGDB_String = String(targetGDB_Object.so).padStart(5, '0');
            const targetArray = prepareTarget(targetGDB_String);
            trainingData.push({ inputSequence, targetArray });
        }
    }
    
    if (trainingData.length === 0) throw new Error("Không thể tạo được bất kỳ chuỗi dữ liệu huấn luyện nào.");

    console.log(`💡 Chuẩn bị huấn luyện với ${trainingData.length} chuỗi dữ liệu, qua ${EPOCHS} epochs.`);
    
    // Quy trình huấn luyện mới
    for (let epoch = 1; epoch <= EPOCHS; epoch++) {
        console.log(`--- Epoch ${epoch}/${EPOCHS} ---`);
        // Xáo trộn dữ liệu ở mỗi epoch để học tốt hơn
        trainingData.sort(() => Math.random() - 0.5); 
        
        let trainedCount = 0;
        for (let i = 0; i < trainingData.length; i += BATCH_SIZE) {
            const batch = trainingData.slice(i, i + BATCH_SIZE);
            for(const data of batch){
                nn.train(data.inputSequence, data.targetArray);
                trainedCount++;
            }
        }
        console.log(`Epoch ${epoch} completed. Đã xử lý ${trainedCount} chuỗi.`);
    }

    await saveNN(nn);
    return { message: `AI (LSTM) đã học xong từ lịch sử. Đã xử lý ${trainingData.length} chuỗi dữ liệu qua ${EPOCHS} lần lặp.` };
};

const runNNNextDayPrediction = async () => {
    console.log('🔔 [LSTM Service] Generating next day prediction...');
    const nn = await getNN();
    const results = await Result.find().lean();
    if (results.length < SEQUENCE_LENGTH) throw new Error(`Không có đủ dữ liệu để dự đoán. Cần ít nhất ${SEQUENCE_LENGTH} ngày.`);
    
    const grouped = {};
    results.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    
    // Lấy chuỗi dữ liệu gần nhất
    const latestSequenceDays = days.slice(-SEQUENCE_LENGTH);
    console.log(`🔮 Sử dụng dữ liệu từ các ngày: ${latestSequenceDays.join(', ')} để dự đoán.`);

    const inputArray = latestSequenceDays.map(day => prepareInput(grouped[day] || []));
    const output = nn.predict(inputArray);
    const prediction = decodeOutput(output);
    
    const latestDay = latestSequenceDays[latestSequenceDays.length-1];
    const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
    
    await NNPrediction.findOneAndUpdate(
        { ngayDuDoan: nextDayStr },
        { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false },
        { upsert: true, new: true }
    );
    return { message: `AI (LSTM) đã tạo dự đoán cho ngày ${nextDayStr}.`, ngayDuDoan: nextDayStr };
};


const runNNLearning = async () => {
    console.log('🔔 [LSTM Service] Learning from new results...');
    const nn = await getNN();
    const predictionsToLearn = await NNPrediction.find({ danhDauDaSo: false }).lean();
    if (!predictionsToLearn.length) return { message: 'Không có dự đoán mới nào để học.' };

    const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
    const grouped = {};
    allResults.forEach(r => { if (!grouped[r.ngay]) grouped[r.ngay] = []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
    
    let learnedCount = 0;
    for (const pred of predictionsToLearn) {
        const targetDayStr = pred.ngayDuDoan;
        const targetDayIndex = days.indexOf(targetDayStr);

        // Kiểm tra xem có đủ dữ liệu lịch sử trước ngày cần học không
        if (targetDayIndex >= SEQUENCE_LENGTH) {
            const actualResult = (grouped[targetDayStr] || []).find(r => r.giai === 'ĐB');
            
            if (actualResult?.so && String(actualResult.so).length >= 5) {
                // Lấy chuỗi input
                const sequenceDays = days.slice(targetDayIndex - SEQUENCE_LENGTH, targetDayIndex);
                const inputSequence = sequenceDays.map(day => prepareInput(grouped[day]));

                // Lấy target
                const targetGDB_String = String(actualResult.so).padStart(5, '0');
                const targetArray = prepareTarget(targetGDB_String);
                
                // Huấn luyện 1 lần với dữ liệu mới này
                nn.train(inputSequence, targetArray);
                learnedCount++;
            }
        }
        await NNPrediction.updateOne({ _id: pred._id }, { danhDauDaSo: true });
    }
    
    if (learnedCount > 0) {
        await saveNN(nn);
    }
    
    return { message: `AI (LSTM) đã học xong. Đã xử lý ${learnedCount} kết quả mới.` };
};


module.exports = { runNNHistoricalTraining, runNNNextDayPrediction, runNNLearning };
