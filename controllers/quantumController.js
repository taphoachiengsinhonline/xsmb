const QuantumLSTMService = require('../services/QuantumLSTMService');

const quantumService = new QuantumLSTMService();

exports.trainHistorical = async (req, res) => {
    try {
        const result = await quantumService.runHistoricalTraining();
        res.json(result);
    } catch (err) {
        console.error('Error in Quantum-LSTM trainHistorical:', err);
        res.status(500).json({ 
            message: err.message || 'Lỗi server trong Quantum-LSTM',
            error: err.toString()
        });
    }
};

exports.predictNextDay = async (req, res) => {
    try {
        const result = await quantumService.runNextDayPrediction();
        res.json(result);
    } catch (err) {
        console.error('Error in Quantum-LSTM predictNextDay:', err);
        res.status(500).json({ 
            message: err.message || 'Lỗi dự đoán Quantum-LSTM',
            error: err.toString()
        });
    }
};

exports.learn = async (req, res) => {
    try {
        const result = await quantumService.runLearning();
        res.json(result);
    } catch (err) {
        console.error('Error in Quantum-LSTM learn:', err);
        res.status(500).json({ 
            message: err.message || 'Lỗi học hỏi Quantum-LSTM',
            error: err.toString()
        });
    }
};

exports.getQuantumPredictions = async (req, res) => {
    try {
        const predictions = await require('../models/NNPrediction')
            .find({ modelType: 'QUANTUM_LSTM' })
            .sort({ 'ngayDuDoan': -1 })
            .lean();
        res.json(predictions);
    } catch (err) {
        console.error('Error getting Quantum predictions:', err);
        res.status(500).json({ message: 'Lỗi server' });
    }
};
