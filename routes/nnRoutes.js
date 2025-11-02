// file: routes/nnRoutes.js
const express = require('express');
const router = express.Router();
const nnController = require('../controllers/nnController');
const quantumController = require('../controllers/quantumController'); // THÊM

// Routes cho Neural Network cũ (giữ nguyên)
router.post('/train-historical', nnController.trainHistorical);
router.post('/learn', nnController.learn);
router.post('/predict-next-day', nnController.predictNextDay);
router.get('/predictions', nnController.getAllPredictions);

// Routes MỚI cho Quantum-LSTM
router.post('/quantum/train-historical', quantumController.trainHistorical);
router.post('/quantum/learn', quantumController.learn);
router.post('/quantum/predict-next-day', quantumController.predictNextDay);
router.get('/quantum/predictions', quantumController.getQuantumPredictions);

module.exports = router;
