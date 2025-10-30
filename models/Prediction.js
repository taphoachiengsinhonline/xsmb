// models/Prediction.js
// Schema cho predictions: mỗi document = 1 ngày dự đoán (ngayDuDoan)
const mongoose = require('mongoose');

const chiTietSchema = new mongoose.Schema({
  number: String,
  // group: Number, // Trường này có thể bỏ đi hoặc giữ lại nếu muốn
  nhomNho: Number,          // MỚI: Nhóm nhỏ (1-9)
  nhomTo: Number,           // MỚI: Nhóm to (1-3)
  positionInPrize: Number,
  tram: String,
  chuc: String,
  donvi: String,
  matchedDigit: String,
  weight: { type: Number, default: 1 }
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true }, // dd/mm/yyyy for predicted day
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  chiTiet: [chiTietSchema],
  danhDauDaSo: { type: Boolean, default: false }, // đã so sánh với kết quả thật?
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('Prediction', predictionSchema);
