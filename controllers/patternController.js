// controllers/patternController.js
const PatternAnalysisService = require('../services/PatternAnalysisService');

exports.generatePrediction = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const prediction = await service.generatePredictionForNextDay();
        res.json({ success: true, message: 'Đã tạo dự đoán thành công!', prediction });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.learn = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        await service.learnFromResults();
        res.json({ success: true, message: 'AI đã học hỏi xong!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.learnAndPredict = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const predictions = await service.learnAndPredictForward();
        res.json({ success: true, message: `Đã học hỏi và tạo ${predictions.length} dự đoán mới.`, predictions });
    } catch (error) {
        console.error('Error in learnAndPredict:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// THÊM HÀM MỚI
exports.resetAndRebuild = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const result = await service.resetAndRebuildAll();
        res.json({ success: true, message: result.message, result });
    } catch (error) {
        console.error('Error in resetAndRebuild:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Thêm các hàm khác như getPredictions, ...
