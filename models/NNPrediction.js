// file: models/NNPrediction.js
const mongoose = require('mongoose');

const nnPredictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },
  pos1: [String],
  pos2: [String],
  pos3: [String],
  pos4: [String],
  pos5: [String],
  danhDauDaSo: { type: Boolean, default: false },
  modelType: { type: String, default: 'LSTM' }, // THÊM: 'LSTM' hoặc 'QUANTUM_LSTM'
  explanation: { type: mongoose.Schema.Types.Mixed }, // THÊM: Giải thích dự đoán
  confidence: { type: Number }, // THÊM: Độ tin cậy
  uncertainty: { type: Number }, // THÊM: Độ không chắc chắn
}, { versionKey: false, timestamps: true });

module.exports = mongoose.model('NNPrediction', nnPredictionSchema);
