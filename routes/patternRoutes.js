// routes/patternRoutes.js
const express = require('express');
const router = express.Router();
const patternController = require('../controllers/patternController');

// Tạo dự đoán cho ngày tiếp theo
router.post('/generate', patternController.generatePrediction);

// Dạy cho AI từ kết quả mới
router.post('/learn', patternController.learn);

module.exports = router;
