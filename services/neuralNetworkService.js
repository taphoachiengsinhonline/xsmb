// file: services/neuralNetworkService.js

const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');

class NeuralNetwork {
    constructor(i,h,o){this.inputNodes=i;this.hiddenNodes=h;this.outputNodes=o;this.weights_ih=this.createMatrix(h,i);this.weights_ho=this.createMatrix(o,h);this.bias_h=this.createMatrix(h,1);this.bias_o=this.createMatrix(o,1);this.randomize();this.learningRate=0.1;}createMatrix(r,c){return Array(r).fill(0).map(()=>Array(c).fill(0));}randomize(){this.weights_ih=this.weights_ih.map(r=>r.map(()=>Math.random()*2-1));this.weights_ho=this.weights_ho.map(r=>r.map(()=>Math.random()*2-1));this.bias_h=this.bias_h.map(r=>r.map(()=>Math.random()*2-1));this.bias_o=this.bias_o.map(r=>r.map(()=>Math.random()*2-1));}sigmoid(x){return 1/(1+Math.exp(-x));}dsigmoid(y){return y*(1-y);}static fromJson(d){const n=new NeuralNetwork(d.inputNodes,d.hiddenNodes,d.outputNodes);if(d.weights_ih)n.weights_ih=d.weights_ih;if(d.weights_ho)n.weights_ho=d.weights_ho;if(d.bias_h)n.bias_h=d.bias_h;if(d.bias_o)n.bias_o=d.bias_o;if(d.learningRate)n.learningRate=d.learningRate;return n;}predict(a){const i=this.arrayToMatrix(a);const h=this.multiply(this.weights_ih,i);h.forEach((r,i)=>r.forEach((_,j)=>h[i][j]+=this.bias_h[i][j]));h.forEach((r,i)=>r.forEach((v,j)=>h[i][j]=this.sigmoid(v)));const o=this.multiply(this.weights_ho,h);o.forEach((r,i)=>r.forEach((_,j)=>o[i][j]+=this.bias_o[i][j]));o.forEach((r,i)=>r.forEach((v,j)=>o[i][j]=this.sigmoid(v)));return this.matrixToArray(o);}train(a,t){const i=this.arrayToMatrix(a);const h=this.multiply(this.weights_ih,i);h.forEach((r,i)=>r.forEach((_,j)=>h[i][j]+=this.bias_h[i][j]));h.forEach((r,i)=>r.forEach((v,j)=>h[i][j]=this.sigmoid(v)));const s=this.multiply(this.weights_ho,h);s.forEach((r,i)=>r.forEach((_,j)=>s[i][j]+=this.bias_o[i][j]));s.forEach((r,i)=>r.forEach((v,j)=>s[i][j]=this.sigmoid(v)));const e=this.arrayToMatrix(t);const o=this.subtract(e,s);const g=s.map(r=>r.slice());g.forEach((r,i)=>r.forEach((v,j)=>g[i][j]=this.dsigmoid(v)));g.forEach((r,i)=>r.forEach((v,j)=>g[i][j]*=o[i][j]));g.forEach(r=>r.forEach((v,i)=>r[i]*=this.learningRate));const n=this.transpose(h);const d=this.multiply(g,n);this.weights_ho.forEach((r,i)=>r.forEach((_,j)=>this.weights_ho[i][j]+=d[i][j]));this.bias_o.forEach((r,i)=>r.forEach((_,j)=>this.bias_o[i][j]+=g[i][j]));const w=this.transpose(this.weights_ho);const _=this.multiply(w,o);const c=h.map(r=>r.slice());c.forEach((r,i)=>r.forEach((v,j)=>c[i][j]=this.dsigmoid(v)));c.forEach((r,i)=>r.forEach((v,j)=>c[i][j]*=_[i][j]));c.forEach(r=>r.forEach((v,i)=>r[i]*=this.learningRate));const p=this.transpose(i);const m=this.multiply(c,p);this.weights_ih.forEach((r,i)=>r.forEach((_,j)=>this.weights_ih[i][j]+=m[i][j]));this.bias_h.forEach((r,i)=>r.forEach((_,j)=>this.bias_h[i][j]+=c[i][j]));}arrayToMatrix(a){return a.map(e=>[e]);}matrixToArray(m){return m.flat();}transpose(m){return m[0].map((_,c)=>m.map(r=>r[c]));}multiply(a,b){return a.map((r,i)=>b[0].map((_,j)=>r.reduce((s,e,k)=>s+(e*b[k][j]),0)));}subtract(a,b){return a.map((r,i)=>r.map((v,j)=>v-b[i][j]));}}

const NN_MODEL_NAME = 'GDB_5_POS_PREDICTOR';
const INPUT_NODES = 135;
const HIDDEN_NODES = 64;
const OUTPUT_NODES = 50;

const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

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
        { upsert: true, new: true }
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
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));

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

// <<< HÀM ĐÃ ĐƯỢC SỬA LẠI HOÀN TOÀN >>>
const runNNNextDayPrediction = async () => {
    console.log('🔔 [NN Service] Generating next day prediction...');
    const nn = await getNN();

    // 1. Tìm ngày có KẾT QUẢ mới nhất trong DB
    const latestResult = await Result.findOne().sort({ 'ngay': -1 }).lean();
    if (!latestResult) {
        throw new Error("Không có dữ liệu kết quả để làm mồi dự đoán.");
    }
    const latestDayWithResult = latestResult.ngay;

    // 2. Tính toán ngày cần dự đoán (ngày tiếp theo của ngày có kết quả mới nhất)
    const nextDayToPredictStr = DateTime.fromFormat(latestDayWithResult, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

    // 3. Lấy toàn bộ 27 giải của ngày có kết quả mới nhất để làm input
    const latestDayResults = await Result.find({ ngay: latestDayWithResult }).lean();
    if (latestDayResults.length === 0) {
        throw new Error(`Không tìm thấy dữ liệu chi tiết cho ngày ${latestDayWithResult}.`);
    }

    // 4. Chạy dự đoán
    const inputArray = prepareInput(latestDayResults);
    const output = nn.predict(inputArray);
    const prediction = decodeOutput(output);
    
    // 5. Lưu kết quả
    await NNPrediction.findOneAndUpdate(
        { ngayDuDoan: nextDayToPredictStr },
        { ngayDuDoan: nextDayToPredictStr, ...prediction, danhDauDaSo: false },
        { upsert: true, new: true }
    );
    return { message: `AI đã tạo dự đoán cho ngày ${nextDayToPredictStr}.`, ngayDuDoan: nextDayToPredictStr };
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
