// routes/tripleGroupRoutes.js
const express = require('express');
const router = express.Router();
const tripleGroupController = require('../controllers/tripleGroupController');

// Health check
router.get('/health', tripleGroupController.healthCheck);

// Tạo dự đoán
router.post('/generate-prediction', tripleGroupController.generatePrediction);
//router.post('/generate-with-learning', tripleGroupController.generatePredictionWithLearning);
router.post('/generate-historical', tripleGroupController.generateHistoricalPredictions);

// Lấy dự đoán
router.get('/predictions', tripleGroupController.getPredictions);
router.get('/prediction-by-date', tripleGroupController.getPredictionByDate);
router.get('/available-dates', tripleGroupController.getAvailableDates);

// Học hỏi và cập nhật
//router.post('/learn-from-history', tripleGroupController.learnFromHistory);
router.post('/update-actual-results', tripleGroupController.updateActualResults);

// Thống kê
router.get('/accuracy-stats', tripleGroupController.getAccuracyStats);
router.get('/learning-stats', tripleGroupController.getLearningStats);
router.get('/system-info', tripleGroupController.getSystemInfo);

// Quản lý (admin)
router.delete('/delete-prediction', tripleGroupController.deletePrediction);
router.delete('/delete-all', tripleGroupController.deleteAllPredictions);

module.exports = router;
