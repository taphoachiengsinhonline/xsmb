// file: models/Prediction.js

const mongoose = require('mongoose');

const chiTietGocSchema = new mongoose.Schema({ number: String, positionInPrize: Number, tram: String, chuc: String, donvi: String, weight: { type: Number, default: 1 } }, { _id: false });
const ketQuaPhuongPhapSchema = new mongoose.Schema({ topTram: [String], topChuc: [String], topDonVi: [String], chiTietGoc: [chiTietGocSchema] }, { _id: false });
const consensusAnalysisSchema = new mongoose.Schema({ predictedWinCount: Number, potentialNumbers: [String] }, { _id: false });

// --- Schema MỚI cho phương pháp Loại trừ Nhóm ---
const groupExclusionAnalysisSchema = new mongoose.Schema({
  potentialNumbers: [String], // Các bộ số sống sót sau khi lọc
  excludedPatternCount: Number, // Đã loại bỏ bao nhiêu mẫu hình
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  ketQuaChiTiet: { type: Map, of: ketQuaPhuongPhapSchema },
  diemTinCay: { type: Map, of: Number },
  intersectionAnalysis: { tram: mongoose.Schema.Types.Mixed, chuc: mongoose.Schema.Types.Mixed, donvi: mongoose.Schema.Types.Mixed },
  consensusAnalysis: consensusAnalysisSchema,

  // --- TRƯỜNG MỚI ---
  groupExclusionAnalysis: groupExclusionAnalysisSchema,

  danhDauDaSo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('Prediction', predictionSchema);
