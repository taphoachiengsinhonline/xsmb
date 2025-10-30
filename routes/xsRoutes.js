const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

router.get('/results', xsController.getAllResults);
router.post('/update', xsController.updateResults);
router.get('/train-advanced', xsController.trainAdvancedModel);
router.post('/update-weights', xsController.updatePredictionWeights);
router.get('/prediction', xsController.getLatestPrediction);       // mặc định latest
router.get('/prediction-by-date', xsController.getPrediction);    // dự đoán theo ngày

// ML / predictions
router.post('/train-historical', xsController.trainHistoricalPredictions); // tạo predictions cho lịch sử
router.post('/train-next-day', xsController.trainPredictionForNextDay);     // tạo prediction cho ngày tiếp theo
router.post('/update-weights', xsController.updatePredictionWeights);      // cập nhật weights khi có kết quả
router.get('/prediction', xsController.getPredictionByDate);               // GET ?date=dd/mm/yyyy

module.exports = router;

