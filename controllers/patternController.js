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

// Thêm các hàm khác như getPredictions, ...
