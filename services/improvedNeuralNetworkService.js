const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-node');
const Result = require('../models/Result');
const NNPrediction = require('../models/NNPrediction');
const NNState = require('../models/NNState');
const { DateTime } = require('luxon');
const FeatureEngineeringService = require('./featureEngineeringService'); // THÊM DÒNG NÀY

class ImprovedLSTMService {
    constructor() {
        this.model = null;
        this.isTrained = false;
        this.inputNodes = 0;
        this.featureService = new FeatureEngineeringService(); // THÊM DÒNG NÀY
    }

    // =================================================================
    // THAY THẾ TOÀN BỘ HÀM prepareEnhancedInput CŨ
    // =================================================================
    prepareEnhancedInput(currentDayResults, previousDaysResults = [], dateStr = null) {
        // SỬA: Sử dụng featureService thay vì tự tính toán
        return this.featureService.extractAllFeatures(currentDayResults, previousDaysResults, dateStr);
    }

    // =================================================================
    // XÓA CÁC HÀM CŨ ĐI - CHÚNG TA DÙNG FEATURE SERVICE RỒI
    // =================================================================
    // XÓA: calculateStatisticalFeatures()
    // XÓA: calculateTemporalFeatures()  
    // XÓA: calculatePatternFeatures()
    // XÓA: calculateFrequency()
    // XÓA: calculateRecency()
    // XÓA: digitAppearedInDay()

    // =================================================================
    // CẬP NHẬT HÀM buildModel ĐỂ TỰ ĐỘNG TÍNH INPUT_NODES
    // =================================================================
    async buildModel(trainingData) {
        if (!trainingData || trainingData.length === 0) {
            throw new Error('Không có dữ liệu training để xác định kích thước model');
        }

        // TÍNH KÍCH THƯỚC FEATURE VECTOR TỪ DỮ LIỆU THỰC TẾ
        const sampleInput = trainingData[0].inputSequence[0];
        this.inputNodes = sampleInput.length;
        const outputNodes = trainingData[0].targetArray.length;

        console.log(`🏗️ Building LSTM model với ${this.inputNodes} input nodes, ${outputNodes} output nodes`);
        
        this.model = tf.sequential({
            layers: [
                tf.layers.lstm({
                    units: 128,
                    returnSequences: true,
                    inputShape: [SEQUENCE_LENGTH, this.inputNodes], // DÙNG this.inputNodes ĐỘNG
                    dropout: 0.2,
                    recurrentDropout: 0.2
                }),
                tf.layers.lstm({
                    units: 64,
                    dropout: 0.2,
                    recurrentDropout: 0.2
                }),
                tf.layers.dense({
                    units: 32,
                    activation: 'relu'
                }),
                tf.layers.dropout({ rate: 0.3 }),
                tf.layers.dense({
                    units: outputNodes, // DÙNG outputNodes ĐỘNG
                    activation: 'sigmoid'
                })
            ]
        });

        this.model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'binaryCrossentropy',
            metrics: ['accuracy', 'precision', 'recall']
        });

        console.log('✅ LSTM model built successfully');
        return this.model;
    }

    // =================================================================
    // CẬP NHẬT HÀM runHistoricalTraining
    // =================================================================
    async runHistoricalTraining() {
        console.log('🔔 [Improved LSTM] Starting Historical Training...');
        
        // Chuẩn bị dữ liệu training TRƯỚC
        const trainingData = await this.prepareTrainingData();
        if (!trainingData.length) {
            throw new Error('Không có dữ liệu để huấn luyện');
        }

        console.log(`📊 Feature vector size: ${trainingData[0].inputSequence[0].length} nodes`);
        
        // Tải hoặc tạo mới model - TRUYỀN trainingData VÀO buildModel
        const modelLoaded = await this.loadModel();
        if (!modelLoaded) {
            await this.buildModel(trainingData); // SỬA: truyền trainingData vào
        }

        await this.trainModel(trainingData);
        await this.saveModel();

        return { 
            message: `AI (TensorFlow LSTM) đã học xong. ${trainingData.length} sequences, ${EPOCHS} epochs, Feature size: ${this.inputNodes}`,
            sequences: trainingData.length,
            epochs: EPOCHS,
            featureSize: this.inputNodes
        };
    }

    // =================================================================
    // CẬP NHẬT HÀM prepareTrainingData
    // =================================================================
    async prepareTrainingData() {
        const results = await Result.find().sort({ 'ngay': 1 }).lean();
        if (results.length < SEQUENCE_LENGTH + 1) {
            return [];
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

            // Lấy dữ liệu các ngày trước để tính pattern features
            const previousDays = sequenceDays.map(day => grouped[day] || []);
            
            // SỬA: Sử dụng prepareEnhancedInput mới (đã tích hợp featureService)
            const inputSequence = sequenceDays.map((day, idx) => 
                this.prepareEnhancedInput(
                    grouped[day] || [], 
                    previousDays.slice(0, idx), 
                    day // THÊM dateStr
                )
            );

            const targetGDB = (grouped[targetDay] || []).find(r => r.giai === 'ĐB');
            if (targetGDB?.so && String(targetGDB.so).length >= 5) {
                const targetGDBString = String(targetGDB.so).padStart(5, '0');
                const targetArray = this.prepareTarget(targetGDBString);
                trainingData.push({ inputSequence, targetArray });
            }
        }

        console.log(`📈 Prepared ${trainingData.length} training sequences với feature size: ${trainingData[0]?.inputSequence[0]?.length || 0}`);
        return trainingData;
    }

    // =================================================================
    // CẬP NHẬT HÀM loadModel
    // =================================================================
    async loadModel() {
        const modelState = await NNState.findOne({ modelName: NN_MODEL_NAME });
        
        if (!modelState || !modelState.modelArtifacts) {
            console.log('🆕 No saved model found, will create new one after training data preparation');
            return false;
        }

        try {
            this.model = await tf.loadLayersModel('indexeddb://' + NN_MODEL_NAME);
            this.inputNodes = modelState.state.inputNodes || 0;
            this.isTrained = modelState.state.isTrained || false;
            
            console.log(`✅ Model loaded successfully với ${this.inputNodes} input nodes`);
            return true;
        } catch (error) {
            console.warn('❌ Failed to load saved model, will create new one:', error.message);
            return false;
        }
    }

    // =================================================================
    // CẬP NHẬT HÀM saveModel
    // =================================================================
    async saveModel() {
        if (!this.model) {
            throw new Error('No model to save');
        }

        const modelInfo = {
            modelName: NN_MODEL_NAME,
            inputNodes: this.inputNodes, // LƯU inputNodes thực tế
            isTrained: this.isTrained,
            savedAt: new Date().toISOString(),
            featureService: 'v1' // Đánh dấu phiên bản feature service
        };

        await NNState.findOneAndUpdate(
            { modelName: NN_MODEL_NAME },
            { 
                state: modelInfo,
                modelArtifacts: await this.model.save('indexeddb://' + NN_MODEL_NAME)
            },
            { upsert: true }
        );

        console.log(`💾 Model saved với ${this.inputNodes} input nodes`);
    }
}
