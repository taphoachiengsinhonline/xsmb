const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

router.get('/results', xsController.getAllResults);
router.post('/update', xsController.updateResults);
router.get('/train-advanced', xsController.trainAdvancedModel);
router.post('/update-weights', xsController.updatePredictionWeights);
router.get('/prediction', xsController.getLatestPrediction);       // mặc định latest
router.get('/prediction-by-date', xsController.getPrediction);    // dự đoán theo ngày

module.exports = router;
