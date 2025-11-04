// services/advancedTrainingService.js
const tf = require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNState = require('../models/NNState');
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedFeatureEngineer = require('./advancedFeatureService');

class AdvancedTraining {
    constructor() {
        this.featureService = new FeatureEngineeringService();
        this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
        this.models = [];
    }

    // =================================================================
    // 1. TRANSFER LEARNING - TẬN DỤNG PRE-TRAINED MODEL
    // =================================================================
    async transferLearning(baseModelPath, newData, freezeLayers = true) {
        console.log('🔄 Áp dụng Transfer Learning...');
        
        let baseModel;
        try {
            // Load pre-trained model
            baseModel = await tf.loadLayersModel(`file://${baseModelPath}/model.json`);
            console.log('✅ Đã load pre-trained model');
        } catch (error) {
            console.log('❌ Không tìm thấy pre-trained model, tạo model mới');
            return await this.buildNewModel(newData);
        }

        // Freeze các layer cũ nếu cần
        if (freezeLayers) {
            baseModel.layers.forEach(layer => {
                layer.trainable = false;
            });
            console.log('🔒 Đã freeze các layer của base model');
        }

        // Thêm layer mới cho task-specific
        const newModel = tf.sequential();
        newModel.add(baseModel);
        newModel.add(tf.layers.dense({
            units: 32,
            activation: 'relu',
            kernelRegularizer: tf.regularizers.l2({l2: 0.001})
        }));
        newModel.add(tf.layers.dense({
            units: 50, // OUTPUT_NODES
            activation: 'sigmoid'
        }));

        newModel.compile({
            optimizer: tf.train.adam(0.0001), // Learning rate nhỏ hơn
            loss: 'binaryCrossentropy',
            metrics: []
        });

        console.log('✅ Transfer Learning model đã được tạo');
        return newModel;
    }

    // =================================================================
    // 2. CURRICULUM LEARNING - HỌC TỪ DỄ ĐẾN KHÓ
    // =================================================================
    async curriculumLearning(trainingData, stages = 3) {
        console.log('📚 Áp dụng Curriculum Learning...');
        
        const sequencedData = this.sequenceDataByDifficulty(trainingData);
        const stageSize = Math.ceil(sequencedData.length / stages);
        
        let currentModel = await this.buildNewModel(sequencedData[0]);
        
        for (let stage = 0; stage < stages; stage++) {
            console.log(`🎯 Stage ${stage + 1}/${stages}: Training với ${stageSize * (stage + 1)} samples`);
            
            const stageData = sequencedData.slice(0, stageSize * (stage + 1));
            const { inputs, targets } = this.prepareBatch(stageData);
            
            await currentModel.fit(inputs, targets, {
                epochs: 20, // Ít epochs cho mỗi stage
                batchSize: 16,
                validationSplit: 0.1,
                callbacks: {
                    onEpochEnd: (epoch, logs) => {
                        if (epoch % 5 === 0) {
                            console.log(`   Stage ${stage + 1}, Epoch ${epoch + 1}: Loss = ${logs.loss?.toFixed(4) || 'N/A'}`);
                        }
                    }
                }
            });

            // Tăng độ khó cho stage tiếp theo
            if (stage < stages - 1) {
                currentModel = await this.increaseModelComplexity(currentModel);
            }
        }
        
        return currentModel;
    }

    sequenceDataByDifficulty(trainingData) {
        // Đánh giá độ khó dựa trên tính biến động của features
        return trainingData.map(data => {
            const features = data.inputSequence.flat();
            const mean = features.reduce((a, b) => a + b, 0) / features.length;
            const variance = features.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / features.length;
            return {
                ...data,
                difficulty: variance // Độ biến động càng cao càng khó
            };
        }).sort((a, b) => a.difficulty - b.difficulty); // Sắp xếp từ dễ đến khó
    }

    // =================================================================
    // 3. DATA AUGMENTATION - TẠO SYNTHETIC SEQUENCES
    // =================================================================
    augmentData(trainingData, augmentationFactor = 0.3) {
        console.log('🎨 Áp dụng Data Augmentation...');
        
        const augmentedData = [...trainingData];
        
        for (let i = 0; i < trainingData.length * augmentationFactor; i++) {
            const originalIndex = Math.floor(Math.random() * trainingData.length);
            const original = trainingData[originalIndex];
            
            // Tạo biến thể bằng cách thêm noise
            const augmentedSequence = original.inputSequence.map(dayFeatures => 
                dayFeatures.map(feature => {
                    // Thêm noise ngẫu nhiên nhỏ
                    const noise = (Math.random() - 0.5) * 0.05;
                    return Math.max(0, Math.min(1, feature + noise));
                })
            );
            
            augmentedData.push({
                inputSequence: augmentedSequence,
                targetArray: original.targetArray
            });
        }
        
        console.log(`✅ Đã tạo thêm ${Math.floor(trainingData.length * augmentationFactor)} synthetic sequences`);
        return augmentedData;
    }

    // =================================================================
    // 4. ENSEMBLE LEARNING - KẾT HỢP MULTIPLE MODELS
    // =================================================================
    async ensembleLearning(trainingData, numModels = 3) {
        console.log('👥 Áp dụng Ensemble Learning...');
        
        this.models = [];
        
        // Train nhiều model với các initialization khác nhau
        for (let i = 0; i < numModels; i++) {
            console.log(`🔄 Training model ${i + 1}/${numModels}...`);
            
            const model = await this.buildNewModel(trainingData[0]);
            
            // Huấn luyện với subset khác nhau của data
            const subsetSize = Math.floor(trainingData.length * 0.8);
            const shuffledData = [...trainingData].sort(() => Math.random() - 0.5);
            const subsetData = shuffledData.slice(0, subsetSize);
            
            const { inputs, targets } = this.prepareBatch(subsetData);
            
            await model.fit(inputs, targets, {
                epochs: 30,
                batchSize: 16,
                validationSplit: 0.1,
                verbose: 0
            });
            
            this.models.push(model);
        }
        
        console.log(`✅ Đã train ${numModels} models cho ensemble`);
        return this.models;
    }

    async ensemblePredict(inputSequence) {
        if (this.models.length === 0) {
            throw new Error('Chưa có ensemble models. Hãy train trước.');
        }
        
        const predictions = await Promise.all(
            this.models.map(model => this.singlePredict(model, inputSequence))
        );
        
        // Kết hợp predictions bằng averaging
        const averagedPrediction = predictions.reduce((acc, pred) => {
            return acc.map((val, idx) => val + pred[idx] / this.models.length);
        }, Array(predictions[0].length).fill(0));
        
        return averagedPrediction;
    }

    // =================================================================
    // 5. HYPERPARAMETER OPTIMIZATION VỚI BAYESIAN SEARCH
    // =================================================================
    async bayesianHyperparameterOptimization(trainingData, numTrials = 10) {
        console.log('🔍 Áp dụng Bayesian Hyperparameter Optimization...');
        
        let bestModel = null;
        let bestLoss = Infinity;
        const bestParams = {};
        
        for (let trial = 0; trial < numTrials; trial++) {
            console.log(`🧪 Trial ${trial + 1}/${numTrials}...`);
            
            // Sample hyperparameters từ distribution
            const params = this.sampleHyperparameters();
            
            try {
                const model = await this.trainWithParams(trainingData, params);
                const validationLoss = await this.evaluateModel(model, trainingData);
                
                console.log(`   Params: LR=${params.learningRate}, Units=${params.units}, Loss=${validationLoss.toFixed(4)}`);
                
                if (validationLoss < bestLoss) {
                    bestLoss = validationLoss;
                    bestModel = model;
                    Object.assign(bestParams, params);
                }
            } catch (error) {
                console.log(`   ❌ Trial ${trial + 1} failed: ${error.message}`);
            }
        }
        
        console.log(`✅ Best params: LR=${bestParams.learningRate}, Units=${bestParams.units}, Loss=${bestLoss.toFixed(4)}`);
        return { model: bestModel, params: bestParams, loss: bestLoss };
    }

    sampleHyperparameters() {
        // Bayesian-inspired sampling
        const learningRates = [0.001, 0.0005, 0.0001, 0.00005];
        const unitsList = [32, 64, 128, 256];
        const batchSizes = [16, 32, 64];
        
        return {
            learningRate: learningRates[Math.floor(Math.random() * learningRates.length)],
            units: unitsList[Math.floor(Math.random() * unitsList.length)],
            batchSize: batchSizes[Math.floor(Math.random() * batchSizes.length)]
        };
    }

    // =================================================================
    // MAIN TRAINING FUNCTION - KẾT HỢP TẤT CẢ STRATEGIES
    // =================================================================
    async trainWithAdvancedStrategies(trainingData, strategies = ['ensemble', 'augmentation']) {
        console.log('🚀 Bắt đầu Advanced Training với các strategies:', strategies);
        
        let processedData = trainingData;
        
        // Áp dụng Data Augmentation nếu được chọn
        if (strategies.includes('augmentation')) {
            processedData = this.augmentData(processedData, 0.3);
        }
        
        let finalModel;
        
        // Chọn strategy chính
        if (strategies.includes('transfer')) {
            finalModel = await this.transferLearning('./models/tfjs_model', processedData);
        } else if (strategies.includes('curriculum')) {
            finalModel = await this.curriculumLearning(processedData, 3);
        } else if (strategies.includes('ensemble')) {
            await this.ensembleLearning(processedData, 3);
            // Ensemble không trả về single model
            return { type: 'ensemble', models: this.models };
        } else if (strategies.includes('bayesian')) {
            const result = await this.bayesianHyperparameterOptimization(processedData, 8);
            finalModel = result.model;
        } else {
            // Default: train model thông thường với data đã augment
            finalModel = await this.buildNewModel(processedData[0]);
            const { inputs, targets } = this.prepareBatch(processedData);
            await finalModel.fit(inputs, targets, {
                epochs: 50,
                batchSize: 32,
                validationSplit: 0.1
            });
        }
        
        return { type: 'single', model: finalModel };
    }

    // =================================================================
    // HELPER FUNCTIONS
    // =================================================================
    async buildNewModel(sampleData, units = 64, learningRate = 0.001) {
        const inputNodes = sampleData.inputSequence[0].length;
        const SEQUENCE_LENGTH = 7;
        const OUTPUT_NODES = 50;

        const model = tf.sequential({
            layers: [
                tf.layers.lstm({
                    units: units,
                    returnSequences: false,
                    inputShape: [SEQUENCE_LENGTH, inputNodes],
                    kernelRegularizer: tf.regularizers.l2({l2: 0.001})
                }),
                tf.layers.dropout({rate: 0.3}),
                tf.layers.dense({
                    units: Math.floor(units / 2),
                    activation: 'relu',
                    kernelRegularizer: tf.regularizers.l2({l2: 0.001})
                }),
                tf.layers.dense({
                    units: OUTPUT_NODES,
                    activation: 'sigmoid'
                })
            ]
        });

        model.compile({
            optimizer: tf.train.adam(learningRate),
            loss: 'binaryCrossentropy',
            metrics: []
        });

        return model;
    }

    prepareBatch(trainingData) {
        const inputs = trainingData.map(d => d.inputSequence);
        const targets = trainingData.map(d => d.targetArray);
        
        const inputTensor = tf.tensor3d(inputs, [inputs.length, 7, inputs[0][0].length]);
        const targetTensor = tf.tensor2d(targets, [targets.length, 50]);
        
        return { inputs: inputTensor, targets: targetTensor };
    }

    async increaseModelComplexity(model) {
        // Tạo model mới phức tạp hơn dựa trên model hiện tại
        const config = model.getConfig();
        const newUnits = config.layers[0].config.units * 1.5;
        
        return await this.buildNewModel(
            { inputSequence: [[...Array(346).fill(0)]] }, // dummy data
            Math.min(256, newUnits), // Giới hạn max units
            0.0005 // Giảm learning rate
        );
    }

    async singlePredict(model, inputSequence) {
        const inputTensor = tf.tensor3d([inputSequence], [1, 7, inputSequence[0].length]);
        const prediction = model.predict(inputTensor);
        const output = await prediction.data();
        prediction.dispose();
        inputTensor.dispose();
        return Array.from(output);
    }

    async evaluateModel(model, trainingData) {
        const { inputs, targets } = this.prepareBatch(trainingData.slice(0, 10)); // Dùng subset để evaluation nhanh
        const evaluation = model.evaluate(inputs, targets);
        const loss = Array.isArray(evaluation) ? evaluation[0].dataSync()[0] : evaluation.dataSync()[0];
        inputs.dispose();
        targets.dispose();
        return loss;
    }

    async trainWithParams(trainingData, params) {
        const model = await this.buildNewModel(trainingData[0], params.units, params.learningRate);
        const { inputs, targets } = this.prepareBatch(trainingData.slice(0, 20)); // Dùng subset nhỏ cho nhanh
        
        await model.fit(inputs, targets, {
            epochs: 10,
            batchSize: params.batchSize,
            validationSplit: 0.2,
            verbose: 0
        });
        
        inputs.dispose();
        targets.dispose();
        return model;
    }
}

module.exports = AdvancedTraining;
