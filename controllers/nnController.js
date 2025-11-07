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

exports.getAllPredictions = async (req, res) => {
    try {
        const predictions = await NNPrediction.find().sort({ 'ngayDuDoan': -1 }).lean();
        res.json(predictions);
    } catch (err) {
        console.error('Error in nn getAllPredictions controller:', err);
        res.status(500).json({ message: 'Lỗi server' });
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
});

module.exports = exports;
