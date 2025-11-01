// file: models/NNState.js
const mongoose = require('mongoose');

const nnStateSchema = new mongoose.Schema({
    modelName: { type: String, required: true, unique: true }, // Ví dụ: "GDB_5_POS_PREDICTOR"
    state: { type: mongoose.Schema.Types.Mixed }, // Lưu trữ toàn bộ object weights của Neural Network
}, { timestamps: true });

module.exports = mongoose.model('NNState', nnStateSchema);
