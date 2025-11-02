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
}, { versionKey: false, timestamps: true });

module.exports = mongoose.model('NNPrediction', nnPredictionSchema);
