// file: routes/xsRoutes.js

const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

/*
 * =================================================================
 * CÁC ROUTE ĐƯỢC SẮP XẾP LẠI CHO RÕ RÀNG VÀ DỄ QUẢN LÝ
 * =================================================================
 */

// --- 1. NHÓM QUẢN LÝ DỮ LIỆU KẾT QUẢ XỔ SỐ ---
// Lấy toàn bộ kết quả đã cào về
router.get('/results', xsController.getAllResults);

// Kích hoạt việc cào dữ liệu mới nhất từ trang web
router.post('/update', xsController.updateResults);


// --- 2. NHÓM VẬN HÀNH & HUẤN LUYỆN MODEL ---
// (Tương ứng với các nút bấm trên màn hình TrainModelScreen)

// Chức năng #1: Huấn luyện lại model với TOÀN BỘ dữ liệu lịch sử
router.post('/train-historical', xsController.trainHistoricalPredictions);

// Chức năng #2: Cập nhật trọng số (Học hỏi từ kết quả mới nhất)
router.post('/update-weights', xsController.updatePredictionWeights);

// Chức năng #3: Tạo dự đoán cho ngày tiếp theo
router.post('/train-next-day', xsController.trainPredictionForNextDay);


// --- 3. NHÓM LẤY DỮ LIỆU DỰ ĐOÁN ---
// Lấy ngày của bản ghi dự đoán mới nhất (ví dụ: "01/10/2025")
router.get('/latest-prediction-date', xsController.getLatestPredictionDate);

// Lấy bản ghi dự đoán cho một ngày cụ thể (ví dụ: /api/xs/prediction-by-date?date=30/10/2025)
router.get('/prediction-by-date', xsController.getPredictionByDate);


module.exports = router;

