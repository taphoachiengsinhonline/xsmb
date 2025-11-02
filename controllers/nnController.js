// file: controllers/nnController.js (updated getAllPredictions)

const TensorFlowService = require('../services/tensorflowService');
const NNPrediction = require('../models/NNPrediction');

// Helper function to sort dates correctly (copied from xsController for consistency)
function dateKey(s) { 
  if (!s || typeof s !== 'string') return ''; 
  const parts = s.split('/'); 
  return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`; 
}

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
        // Fetch all predictions without DB sort (to avoid string sort issues)
        const predictions = await NNPrediction.find().lean();
        
        // Custom sort in JS: descending by dateKey (newest first)
        predictions.sort((a, b) => dateKey(b.ngayDuDoan).localeCompare(dateKey(a.ngayDuDoan)));
        
        res.json(predictions);
    } catch (err) {
        console.error('Error in nn getAllPredictions controller:', err);
        res.status(500).json({ message: 'Lỗi server' });
    }
};
