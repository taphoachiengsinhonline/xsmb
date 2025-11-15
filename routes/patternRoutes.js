const express = require('express');
const router = express.Router();
const patternController = require('../controllers/patternController');

// --- CÁC API CHÍNH CHO GIAO DIỆN NGƯỜI DÙNG ---

// [POST] Tác vụ hàng ngày: Học và tạo tất cả dự đoán còn thiếu
router.post('/learn-and-predict', patternController.learnAndPredict);

// [POST] Tác vụ quản trị: Reset và huấn luyện lại toàn bộ hệ thống
router.post('/reset-rebuild', patternController.resetAndRebuild);

// [GET] Lấy dữ liệu cho màn hình Lịch sử
router.get('/predictions', patternController.getAllPredictions);


// --- CÁC API PHỤ (DÙNG ĐỂ DEBUG HOẶC CÁC TÁC VỤ CỤ THỂ) ---

// [POST] Chỉ chạy backtest lịch sử mà không xóa
router.post('/generate-historical', patternController.generateHistorical);

// [POST] Chỉ chạy chức năng học
router.post('/learn', patternController.learn);

// [POST] Chỉ tạo 1 dự đoán cho ngày mai
router.post('/generate-next-day', patternController.generatePrediction);


module.exports = router;
