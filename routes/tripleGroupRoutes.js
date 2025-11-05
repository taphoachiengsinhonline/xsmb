// routes/tripleGroupRoutes.js
const express = require('express');
const router = express.Router();
const tripleGroupController = require('../controllers/tripleGroupController');

// Tạo dự đoán mới
router.post('/generate-prediction', tripleGroupController.generatePrediction);

// Lấy danh sách dự đoán
router.get('/predictions', tripleGroupController.getPredictions);

// Lấy dự đoán theo ngày
router.get('/prediction-by-date', tripleGroupController.getPredictionByDate);

// Cập nhật kết quả thực tế
router.post('/update-actual-results', tripleGroupController.updateAllActualResults);

// Lấy thống kê độ chính xác
router.get('/accuracy-stats', async (req, res) => {
    try {
        const stats = await tripleGroupController.calculateAccuracyStats();
        res.json({ success: true, stats: stats });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
