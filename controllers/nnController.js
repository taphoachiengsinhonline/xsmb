const TensorFlowService = require('../services/tensorflowService');
//const ActorCriticService = require('../services/actorCriticService');
const NNPrediction = require('../models/NNPrediction');

const tfService = new TensorFlowService();
//const acService = new ActorCriticService(); // <-- KHỞI TẠO SERVICE MỚI

exports.trainHistorical = async (req, res) => {
    try {
        const result = await tfService.runHistoricalTraining();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow trainHistorical controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.predictNextDay = async (req, res) => {
    try {
        const result = await tfService.runNextDayPrediction();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow predictNextDay controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.learn = async (req, res) => {
    try {
        const result = await tfService.runLearning();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow learn controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

const getAllPredictions = async (req, res) => {
    try {
        const predictions = await NNPrediction.find()
            .sort({ ngayDuDoan: -1, createdAt: -1 })
            .lean();

        // Lấy kết quả thực tế để so sánh
        const results = await Result.find().lean();
        
        const enhancedPredictions = predictions.map(pred => {
            const actualResult = results.find(r => r.ngay === pred.ngayDuDoan && r.giai === 'ĐB');
            let accuracy = null;
            let resultDigits = null;

            if (actualResult?.so) {
                resultDigits = String(actualResult.so).padStart(5, '0').split('');
                
                // Tính độ chính xác
                let correctPositions = 0;
                for (let i = 0; i < 5; i++) {
                    const predictedDigits = pred[`pos${i+1}`] || [];
                    if (Array.isArray(predictedDigits) && predictedDigits.includes(resultDigits[i])) {
                        correctPositions++;
                    }
                }
                accuracy = correctPositions / 5;
            }

            return {
                ...pred,
                accuracy: accuracy,
                actualResult: resultDigits,
                hasActualResult: !!actualResult,
                // Đánh dấu loại dự đoán
                predictionType: pred.isHistorical ? 'historical' : 'future'
            };
        });

        res.json(enhancedPredictions);
    } catch (error) {
        console.error('Lỗi lấy lịch sử dự đoán:', error);
        res.status(500).json({ 
            error: 'Không thể lấy lịch sử dự đoán',
            details: error.message 
        });
    }
};

// API TẠO DỰ ĐOÁN HÀNG LOẠT
const generateBatchPredictions = async (req, res) => {
    try {
        const { days = 10 } = req.body;
        const tensorflowService = new TensorFlowService();
        
        // Load model trước
        const modelLoaded = await tensorflowService.loadModel();
        if (!modelLoaded) {
            return res.status(400).json({ error: 'Model chưa được huấn luyện' });
        }

        const generatedCount = await tensorflowService.autoGeneratePredictionsAfterTraining();
        
        res.json({
            message: `Đã tạo ${generatedCount} dự đoán mới`,
            generatedCount: generatedCount
        });
    } catch (error) {
        console.error('Lỗi tạo dự đoán hàng loạt:', error);
        res.status(500).json({ 
            error: 'Không thể tạo dự đoán',
            details: error.message 
        });
    }
};

// THÊM VÀO FILE routes/nnRoutes.js
exports.predictionHistory= async (req, res) => {
    try {
        const predictions = await NNPrediction.find()
            .sort({ ngayDuDoan: -1 })
            .limit(100)
            .lean();
            
        const results = await Result.find().lean();
        
        const enhancedPredictions = predictions.map(pred => {
            const actualResult = results.find(r => r.ngay === pred.ngayDuDoan && r.giai === 'ĐB');
            let accuracy = null;
            
            if (actualResult?.so) {
                const actualStr = String(actualResult.so).padStart(5, '0');
                let correctCount = 0;
                
                for (let i = 0; i < 5; i++) {
                    const predictedDigits = pred[`pos${i+1}`] || [];
                    if (predictedDigits.includes(actualStr[i])) {
                        correctCount++;
                    }
                }
                
                accuracy = correctCount / 5;
            }
            
            return {
                ...pred,
                accuracy: accuracy,
                hasActualResult: !!actualResult
            };
        });
        
        res.json(enhancedPredictions);
    } catch (error) {
        console.error('Lỗi lấy lịch sử dự đoán:', error);
        res.status(500).json({ 
            error: 'Không thể lấy lịch sử dự đoán',
            details: error.message 
        });
    }
};

module.exports = exports;
