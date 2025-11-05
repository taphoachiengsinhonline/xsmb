// models/TripleGroupPrediction.js
const mongoose = require('mongoose');

const TripleGroupPredictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true },
  ngayPhanTich: { type: String, required: true }, // Ngày dùng để phân tích
  topTram: [String],
  topChuc: [String], 
  topDonVi: [String],
  filteredNumbers: [String],
  analysisData: {
    totalGroups: Number,
    winningGroups: Number,
    successRate: Number,
    highWinPatterns: [{
      pattern: String,
      winRate: Number,
      total: Number
    }],
    filteredGroupsCount: Number
  },
  confidence: Number,
  actualResult: { // Lưu kết quả thực tế khi có
    tram: String,
    chuc: String, 
    donvi: String,
    isCorrect: Boolean
  },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('TripleGroupPrediction', TripleGroupPredictionSchema);
