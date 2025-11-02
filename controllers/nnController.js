const TensorFlowService = require('../services/tensorflowService');
const NNPrediction = require('../models/NNPrediction');

const tfService = new TensorFlowService();

exports.trainHistorical = async (req, res) => {
    try {
        const result = await tfService.runHistoricalTraining();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow trainHistorical controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.predictNextDay = async (req, res) => {
    try {
        const result = await tfService.runNextDayPrediction();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow predictNextDay controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.learn = async (req, res) => {
    try {
        const result = await tfService.runLearning();
        res.json(result);
    } catch (err) {
        console.error('Error in TensorFlow learn controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.getAllPredictions = async (req, res) => {
    try {
        const predictions = await NNPrediction.find().sort({ 'ngayDuDoan': -1 }).lean();
        res.json(predictions);
    } catch (err) {
        console.error('Error in nn getAllPredictions controller:', err);
        res.status(500).json({ message: 'Lỗi server' });
    }
};
