// file: controllers/nnController.js
const nnService = require('../services/neuralNetworkService');

exports.trainHistorical = async (req, res) => {
    try {
        const result = await nnService.runNNHistoricalTraining();
        res.json(result);
    } catch (err) {
        console.error('Error in nn trainHistorical controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.predictNextDay = async (req, res) => {
    try {
        const result = await nnService.runNNNextDayPrediction();
        res.json(result);
    } catch (err) {
        console.error('Error in nn predictNextDay controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};

exports.learn = async (req, res) => {
    try {
        const result = await nnService.runNNLearning();
        res.json(result);
    } catch (err) {
        console.error('Error in nn learn controller:', err);
        res.status(500).json({ message: err.message || 'Lỗi server' });
    }
};
