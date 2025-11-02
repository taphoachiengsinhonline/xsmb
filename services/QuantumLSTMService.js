const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');
const FeatureEngineeringService = require('./featureEngineeringService');

class QuantumLSTMService {
    constructor() {
        this.model = null;
        this.quantumStates = new Map();
        this.entropyThreshold = 0.75;
        this.featureService = new FeatureEngineeringService();
        this.inputNodes = 0;
        this.SEQUENCE_LENGTH = 7;
        this.OUTPUT_NODES = 50;
    }

    async buildQuantumEnhancedModel(inputNodes) {
        console.log('🔮 Building Quantum-Inspired LSTM Model...');
        
        const model = tf.sequential({
            layers: [
                // Lớp 1: Bidirectional LSTM với quantum-inspired initialization
                tf.layers.bidirectional({
                    layer: tf.layers.lstm({
                        units: 256,
                        returnSequences: true,
                        inputShape: [this.SEQUENCE_LENGTH, inputNodes],
                        kernelInitializer: 'varianceScaling',
                        recurrentInitializer: 'orthogonal'
                    })
                }),
                
                // Lớp 2: Attention Mechanism
                // Lưu ý: TensorFlow.js không có layer Attention sẵn, nên chúng ta sẽ bỏ qua hoặc tự implement
                // Tạm thời thay bằng LSTM thông thường
                tf.layers.lstm({
                    units: 128,
                    returnSequences: false,
                    dropout: 0.3,
                    recurrentDropout: 0.2
                }),
                
                // Lớp 3: Quantum-inspired dense layer
                tf.layers.dense({
                    units: 64,
                    activation: 'swish', // Activation function mới hơn ReLU
                    kernelInitializer: 'varianceScaling'
                }),
                
                tf.layers.dropout({ rate: 0.4 }),
                
                // Lớp 5: Multi-head output (dự đoán cho từng vị trí độc lập)
                tf.layers.dense({
                    units: this.OUTPUT_NODES,
                    activation: 'sigmoid'
                })
            ]
        });

        model.compile({
            optimizer: tf.train.adam(0.0005),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy', this.precisionAt5, this.f1Score]
        });

        this.model = model;
        return model;
    }

    // Custom metric: Precision@5
    precisionAt5(yTrue, yPred) {
        return tf.tidy(() => {
            const topK = 5;
            const trueLabels = tf.argMax(yTrue, -1);
            const predTopK = tf.topk(yPred, topK).indices;
            
            const matches = tf.equal(tf.expandDims(trueLabels, -1), predTopK);
            const precision = tf.mean(tf.cast(tf.any(matches, -1), 'float32'));
            return precision;
        });
    }

    // F1-Score metric
    f1Score(yTrue, yPred) {
        return tf.tidy(() => {
            const threshold = 0.5;
            const yPredBin = tf.cast(tf.greater(yPred, threshold), 'float32');
            const yTrueBin = tf.cast(yTrue, 'float32');
            
            const truePos = tf.sum(tf.mul(yTrueBin, yPredBin));
            const falsePos = tf.sum(tf.mul(tf.sub(1, yTrueBin), yPredBin));
            const falseNeg = tf.sum(tf.mul(yTrueBin, tf.sub(1, yPredBin)));
            
            const precision = tf.div(truePos, tf.add(truePos, falsePos));
            const recall = tf.div(truePos, tf.add(truePos, falseNeg));
            const f1 = tf.div(tf.mul(2, tf.mul(precision, recall)), tf.add(precision, recall));
            
            return tf.where(tf.isNaN(f1), tf.scalar(0), f1);
        });
    }

    // Entropy-based uncertainty measurement
    calculatePredictionEntropy(predictions) {
        const entropy = predictions.map(p => {
            const probs = Array.from(p);
            return -probs.reduce((sum, prob) => {
                return sum + (prob > 0 ? prob * Math.log2(prob) : 0);
            }, 0);
        });
        return entropy;
    }

    // Adaptive learning based on prediction confidence
    async trainWithUncertainty(trainingData, validationData) {
        console.log('🎯 Training with Uncertainty-Aware Learning...');
        
        const classWeights = this.calculateAdaptiveClassWeights(trainingData);
        const callbacks = this.createAdvancedCallbacks();
        
        const history = await this.model.fit(
            tf.tensor3d(trainingData.inputs),
            tf.tensor2d(trainingData.targets),
            {
                epochs: 100,
                batchSize: 16,
                validationData: [
                    tf.tensor3d(validationData.inputs),
                    tf.tensor2d(validationData.targets)
                ],
                classWeight: classWeights,
                callbacks: callbacks
            }
        );
        
        return history;
    }

    calculateAdaptiveClassWeights(trainingData) {
        // Tính weights dựa trên frequency và prediction difficulty
        const targetTensor = tf.tensor2d(trainingData.targets);
        const classFreq = tf.sum(targetTensor, 0).dataSync();
        const total = trainingData.targets.length;
        
        const weights = {};
        classFreq.forEach((freq, idx) => {
            if (freq > 0) {
                // Inverse frequency + difficulty bonus
                weights[idx] = Math.sqrt(total / (freq * 10));
            }
        });
        
        targetTensor.dispose();
        return weights;
    }

    createAdvancedCallbacks() {
        return {
            onEpochEnd: async (epoch, logs) => {
                console.log(`Epoch ${epoch + 1}: Loss=${logs.loss?.toFixed(4)}, Val Loss=${logs.val_loss?.toFixed(4)}, Precision@5=${logs.precisionAt5?.toFixed(4)}`);
                
                // Adaptive learning rate
                if (epoch > 10 && logs.val_loss > logs.loss * 1.5) {
                    const currentLr = tf.backend().getScalar('learningRate');
                    const newLr = currentLr * 0.8;
                    tf.backend().setScalar('learningRate', newLr);
                    console.log(`🔄 Reducing learning rate to: ${newLr}`);
                }
                
                // Early stopping based on multiple metrics
                if (epoch > 20 && logs.precisionAt5 > 0.8) {
                    console.log('🎯 High precision achieved, considering early stopping');
                }
            },
            
            onTrainEnd: () => {
                console.log('✅ Quantum-LSTM Training Completed!');
            }
        };
    }

    // Ensemble prediction với multiple strategies
    async ensemblePredict(inputSequences) {
        const predictions = [];
        
        // 1. Standard prediction
        const standardPred = await this.predict(inputSequences);
        predictions.push(standardPred);
        
        // 2. Time-aware prediction (cho các khung giờ khác nhau)
        const timeAwarePred = await this.timeAwarePredict(inputSequences);
        predictions.push(timeAwarePred);
        
        // 3. Pattern-based prediction
        const patternPred = await this.patternBasedPredict(inputSequences);
        predictions.push(patternPred);
        
        // Weighted ensemble
        return this.weightedEnsemble(predictions, [0.5, 0.3, 0.2]);
    }

    async timeAwarePredict(inputSequences) {
        // Thêm features thời gian thực
        const now = new Date();
        const timeFeatures = [
            Math.sin(2 * Math.PI * now.getHours() / 24),
            Math.cos(2 * Math.PI * now.getHours() / 24),
            Math.sin(2 * Math.PI * now.getDay() / 7),
            Math.cos(2 * Math.PI * now.getDay() / 7)
        ];
        
        // Mở rộng input sequences với time features
        const extendedInputs = inputSequences.map(seq => 
            seq.concat(timeFeatures)
        );
        
        return await this.predict(extendedInputs);
    }

    async patternBasedPredict(inputSequences) {
        // Phân tích pattern và áp dụng rules-based corrections
        const rawPrediction = await this.predict(inputSequences);
        const patternAnalysis = this.analyzePatterns(rawPrediction);
        
        return this.applyPatternRules(rawPrediction, patternAnalysis);
    }

    analyzePatterns(prediction) {
        // Phát hiện các pattern đặc biệt trong dự đoán
        const analysis = {
            hasRepeatingDigits: this.checkRepeatingDigits(prediction),
            hasSequentialPattern: this.checkSequentialPattern(prediction),
            entropy: this.calculatePredictionEntropy([prediction])[0],
            confidence: Math.max(...prediction)
        };
        
        return analysis;
    }

    checkRepeatingDigits(prediction) {
        // Kiểm tra các digit lặp lại
        // Giả sử prediction là mảng 50 phần tử, chia thành 5 vị trí, mỗi vị trí 10 digit
        let hasRepeating = false;
        for (let i = 0; i < 5; i++) {
            const pos = prediction.slice(i * 10, (i + 1) * 10);
            const maxVal = Math.max(...pos);
            if (maxVal > 0.7) {
                // Nếu có digit nào đó có xác suất cao, kiểm tra xem có lặp lại ở vị trí khác không?
                // Code tạm thời, có thể cải thiện
                hasRepeating = true;
            }
        }
        return hasRepeating;
    }

    checkSequentialPattern(prediction) {
        // Kiểm tra các digit liên tiếp
        // Code tạm thời
        return false;
    }

    applyPatternRules(rawPrediction, patternAnalysis) {
        // Áp dụng các rules dựa trên pattern
        // Tạm thời trả về rawPrediction
        return rawPrediction;
    }

    weightedEnsemble(predictions, weights) {
        const weightedSum = Array(predictions[0].length).fill(0);
        
        predictions.forEach((pred, idx) => {
            pred.forEach((value, pos) => {
                weightedSum[pos] += value * weights[idx];
            });
        });
        
        return weightedSum;
    }

    // Explainable AI: Giải thích dự đoán
    explainPrediction(prediction, inputFeatures) {
        const explanation = {
            topFeatures: this.getTopContributingFeatures(inputFeatures, prediction),
            confidence: Math.max(...prediction),
            uncertainty: this.calculatePredictionEntropy([prediction])[0],
            patternInsights: this.extractPatternInsights(prediction),
            recommendedAction: this.getRecommendedAction(prediction)
        };
        
        return explanation;
    }

    getTopContributingFeatures(features, prediction) {
        // Feature importance analysis (simplified)
        const featureImpacts = features.map((feature, idx) => ({
            index: idx,
            impact: Math.abs(feature * prediction[idx % prediction.length])
        }));
        
        return featureImpacts
            .sort((a, b) => b.impact - a.impact)
            .slice(0, 10);
    }

    getRecommendedAction(prediction) {
        const confidence = Math.max(...prediction);
        const entropy = this.calculatePredictionEntropy([prediction])[0];
        
        if (confidence > 0.8 && entropy < 0.3) {
            return "HIGH_CONFIDENCE - Có thể sử dụng dự đoán này";
        } else if (confidence > 0.6 && entropy < 0.5) {
            return "MEDIUM_CONFIDENCE - Kết hợp với phương pháp khác";
        } else {
            return "LOW_CONFIDENCE - Nên xem xét lại hoặc chờ thêm dữ liệu";
        }
    }

    extractPatternInsights(prediction) {
        // Trích xuất các insights từ pattern
        const insights = [];
        if (this.checkRepeatingDigits(prediction)) {
            insights.push("Có khả năng xuất hiện các số lặp lại");
        }
        if (this.checkSequentialPattern(prediction)) {
            insights.push("Có khả năng xuất hiện các số liên tiếp");
        }
        return insights.length > 0 ? insights : ["Không có pattern đặc biệt"];
    }

    async predict(inputSequence) {
        const inputTensor = tf.tensor3d([inputSequence], [1, this.SEQUENCE_LENGTH, inputSequence.length]);
        const prediction = this.model.predict(inputTensor);
        const output = await prediction.data();
        
        inputTensor.dispose();
        prediction.dispose();
        
        return Array.from(output);
    }

    async saveModel() {
        const modelInfo = {
            modelName: 'QUANTUM_LSTM_V2',
            topology: this.model.toJSON(),
            weights: this.model.getWeights().map(w => w.dataSync()),
            quantumStates: Array.from(this.quantumStates.entries()),
            savedAt: new Date().toISOString()
        };

        await NNState.findOneAndUpdate(
            { modelName: 'QUANTUM_LSTM_V2' },
            { state: modelInfo },
            { upsert: true }
        );
        
        console.log('💾 Quantum-LSTM model saved!');
    }

    async loadModel() {
        const modelState = await NNState.findOne({ modelName: 'QUANTUM_LSTM_V2' });
        if (modelState?.state) {
            this.model = await tf.models.modelFromJSON(modelState.state.topology);
            const weightTensors = modelState.state.weights.map(w => tf.tensor(w));
            this.model.setWeights(weightTensors);
            
            this.quantumStates = new Map(modelState.state.quantumStates);
            console.log('✅ Quantum-LSTM model loaded!');
            return true;
        }
        return false;
    }

    // =================================================================
    // Các phương thức giao diện để tích hợp với nnController
    // =================================================================

    async runHistoricalTraining() {
        console.log('🔔 [QuantumLSTM Service] Starting Historical Training...');
        
        // Chuẩn bị dữ liệu
        const trainingSplit = await this.prepareTrainingData();
        if (trainingSplit.trainData.length === 0) {
            throw new Error('Không có dữ liệu training');
        }

        // Xây dựng model
        await this.buildQuantumEnhancedModel(this.inputNodes);

        // Huấn luyện
        const history = await this.trainWithUncertainty(
            {
                inputs: trainingSplit.trainData.map(d => d.inputSequence),
                targets: trainingSplit.trainData.map(d => d.targetArray)
            },
            {
                inputs: trainingSplit.valData.map(d => d.inputSequence),
                targets: trainingSplit.valData.map(d => d.targetArray)
            }
        );

        // Lưu model
        await this.saveModel();

        return {
            message: `Quantum-LSTM training completed. Số chuỗi: ${trainingSplit.trainData.length}`,
            sequences: trainingSplit.trainData.length,
            epochs: history.params.epochs,
            finalLoss: history.history.loss[history.history.loss.length - 1],
            finalValLoss: history.history.val_loss[history.history.val_loss.length - 1]
        };
    }

    async runNextDayPrediction() {
        console.log('🔔 [QuantumLSTM Service] Generating next day prediction...');
        
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
        let latestSequenceDays = days.slice(-this.SEQUENCE_LENGTH);

        // Nếu không đủ ngày, thêm padding
        const paddingDay = Array(this.inputNodes).fill(0);
        while (latestSequenceDays.length < this.SEQUENCE_LENGTH) {
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

        const output = await this.ensemblePredict(inputSequence);
        const prediction = this.decodeOutput(output);

        const latestDay = days[days.length - 1];
        const nextDayStr = DateTime.fromFormat(latestDay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');

        await NNPrediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { ngayDuDoan: nextDayStr, ...prediction, danhDauDaSo: false },
            { upsert: true, new: true }
        );

        return {
            message: `Quantum-LSTM đã tạo dự đoán cho ngày ${nextDayStr}.`,
            ngayDuDoan: nextDayStr
        };
    }

    async runLearning() {
        console.log('🔔 [QuantumLSTM Service] Learning from new results...');
        
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

            if (targetDayIndex >= this.SEQUENCE_LENGTH) {
                const actualResult = (grouped[targetDayStr] || []).find(r => r.giai === 'ĐB');
                
                if (actualResult?.so && String(actualResult.so).length >= 5) {
                    const sequenceDays = days.slice(targetDayIndex - this.SEQUENCE_LENGTH, targetDayIndex);
                    
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

            const inputTensor = tf.tensor3d(inputs, [inputs.length, this.SEQUENCE_LENGTH, this.inputNodes]);
            const targetTensor = tf.tensor2d(targets, [targets.length, this.OUTPUT_NODES]);

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
            message: `Quantum-LSTM đã học từ ${learnedCount} kết quả mới.`,
            learnedCount 
        };
    }

    // =================================================================
    // Các phương thức hỗ trợ
    // =================================================================

    async prepareTrainingData() {
        const results = await Result.find().sort({ 'ngay': 1 }).lean();
        if (results.length < this.SEQUENCE_LENGTH + 1) {
            throw new Error(`Không đủ dữ liệu. Cần ít nhất ${this.SEQUENCE_LENGTH + 1} ngày.`);
        }

        const grouped = {};
        results.forEach(r => {
            if (!grouped[r.ngay]) grouped[r.ngay] = [];
            grouped[r.ngay].push(r);
        });

        const days = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        const trainingData = [];

        for (let i = 0; i < days.length - this.SEQUENCE_LENGTH; i++) {
            const sequenceDays = days.slice(i, i + this.SEQUENCE_LENGTH);
            const targetDay = days[i + this.SEQUENCE_LENGTH];

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

    prepareTarget(gdbString) {
        const target = Array(this.OUTPUT_NODES).fill(0.01);
        gdbString.split('').forEach((digit, index) => {
            const d = parseInt(digit);
            if (!isNaN(d) && index < 5) {
                target[index * 10 + d] = 0.99;
            }
        });
        return target;
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

module.exports = QuantumLSTMService;
