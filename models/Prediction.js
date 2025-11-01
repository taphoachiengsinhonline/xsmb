// file: models/Prediction.js

const mongoose = require('mongoose');

const chiTietGocSchema = new mongoose.Schema({ number: String, positionInPrize: Number, tram: String, chuc: String, donvi: String, weight: { type: Number, default: 1 } }, { _id: false });
const ketQuaPhuongPhapSchema = new mongoose.Schema({ topTram: [String], topChuc: [String], topDonVi: [String], chiTietGoc: [chiTietGocSchema] }, { _id: false });

// <<< SỬA LẠI SCHEMA NÀY CHO ĐÚNG VỚI HÀM CỦA BẠN >>>
const groupExclusionAnalysisSchema = new mongoose.Schema({
  potentialNumbers: [String],
  excludedPatternCount: Number,
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  ketQuaChiTiet: { type: Map, of: ketQuaPhuongPhapSchema },
  diemTinCay: { type: Map, of: Number },
  intersectionAnalysis: { tram: mongoose.Schema.Types.Mixed, chuc: mongoose.Schema.Types.Mixed, donvi: mongoose.Schema.Types.Mixed },
  groupExclusionAnalysis: groupExclusionAnalysisSchema, // Sử dụng schema đã sửa
  danhDauDaSo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

// Loại bỏ ModelState không còn cần thiết nữa
const PredictionModel = mongoose.model('Prediction', predictionSchema);

module.exports = { Prediction: PredictionModel }; // Chỉ export Prediction
