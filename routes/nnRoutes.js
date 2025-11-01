// file: routes/nnRoutes.js
const express = require('express');
const router = express.Router();
const nnController = require('../controllers/nnController');

// Huấn luyện AI Tự học với toàn bộ lịch sử
router.post('/train-historical', nnController.trainHistorical);

// Dạy cho AI Tự học từ kết quả mới nhất
router.post('/learn', nnController.learn);

// Tạo dự đoán cho ngày tiếp theo bằng AI Tự học
router.post('/predict-next-day', nnController.predictNextDay);

module.exports = router;
