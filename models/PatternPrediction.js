// models/PatternPrediction.js
const mongoose = require('mongoose');

// Schema để lưu chi tiết 1 vị trí (trăm, chục...)
const positionPredictionSchema = new mongoose.Schema({
    _id: false,
    promisingDigits: [String], // Dàn 5 số tiềm năng
    hotDigit: String, // Số nóng nhất
    analysisDetails: mongoose.Schema.Types.Mixed // Lưu lý do, vd: các pattern mạnh nhất
});

const patternPredictionSchema = new mongoose.Schema({
    ngayDuDoan: { type: String, required: true, unique: true },
    
    hangChucNgan: positionPredictionSchema,
    hangNgan: positionPredictionSchema,
    hangTram: positionPredictionSchema,
    hangChuc: positionPredictionSchema,
    hangDonVi: positionPredictionSchema,
    
    // Thông tin chung
    modelVersion: { type: String, default: 'PatternAnalyzerV1' },
    hasActualResult: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('PatternPrediction', patternPredictionSchema);
