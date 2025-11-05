// file: routes/xsRoutes.js

const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

router.get('/results', xsController.getAllResults);
router.post('/update', xsController.updateResults);

// Chạy lại phân tích TOÀN BỘ lịch sử cho Siêu Mô Hình
router.post('/train-historical', xsController.trainHistoricalPredictions);

// --- THAY ĐỔI QUAN TRỌNG ---
// Chạy chức năng học hỏi của Siêu Mô Hình (cập nhật điểm tin cậy)
router.post('/update-trust-scores', xsController.updateTrustScores);

// Tạo dự đoán cho ngày tiếp theo bằng Siêu Mô Hình
router.post('/train-next-day', xsController.trainPredictionForNextDay);

router.get('/predictions', xsController.getAllPredictions);
router.get('/latest-prediction-date', xsController.getLatestPredictionDate);
router.get('/prediction-by-date', xsController.getPredictionByDate);

// Route cũ không còn dùng nữa
router.post('/update-weights', xsController.updatePredictionWeights);

router.post('/analyze-group-exclusion', xsController.runGroupExclusionAnalysis);

module.exports = router;

