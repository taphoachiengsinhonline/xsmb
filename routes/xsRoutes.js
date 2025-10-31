// file: routes/xsRoutes.js

const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

/*
 * =================================================================
 * CÁC ROUTE ĐƯỢC CẬP NHẬT GHI CHÚ CHO HỆ THỐNG ĐA PHƯƠNG PHÁP
 * =================================================================
 */

// --- 1. NHÓM QUẢN LÝ DỮ LIỆU KẾT QUẢ XỔ SỐ ---
// Lấy toàn bộ kết quả đã cào về
router.get('/results', xsController.getAllResults);

// Kích hoạt việc cào dữ liệu mới nhất từ trang web
router.post('/update', xsController.updateResults);


// --- 2. NHÓM VẬN HÀNH & HUẤN LUYỆN MODEL ---

// Chức năng #1: Chạy lại phân tích TOÀN BỘ lịch sử cho TẤT CẢ các phương pháp
router.post('/train-historical', xsController.trainHistoricalPredictions);

// Chức năng #2: Cập nhật trọng số (Học hỏi) - CHỈ ÁP DỤNG CHO "PHƯƠNG PHÁP GỐC"
router.post('/update-weights', xsController.updatePredictionWeights);

// Chức năng #3: Tạo dự đoán cho ngày tiếp theo bằng TẤT CẢ các phương pháp
router.post('/train-next-day', xsController.trainPredictionForNextDay);


// --- 3. NHÓM LẤY DỮ LIỆU DỰ ĐOÁN ---

// Lấy toàn bộ các bản ghi dự đoán (dùng cho thống kê đa phương pháp)
router.get('/predictions', xsController.getAllPredictions);

// Lấy ngày của bản ghi dự đoán mới nhất
router.get('/latest-prediction-date', xsController.getLatestPredictionDate);

// Lấy bản ghi dự đoán cho một ngày cụ thể
router.get('/prediction-by-date', xsController.getPredictionByDate);


module.exports = router;
