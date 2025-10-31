// file: models/Prediction.js
const mongoose = require('mongoose');

const chiTietSchema = new mongoose.Schema({
  number: String,
  nhomNho: Number,
  nhomTo: Number,
  positionInPrize: Number,
  tram: String,
  chuc: String,
  donvi: String,
  matchedDigit: String,
  weight: { type: Number, default: 1 }
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  chiTiet: [chiTietSchema],
  danhDauDaSo: { type: Boolean, default: false },

  // --- PHẦN BỊ THIẾU MÀ BẠN ĐÃ CHỈ RA ---
  // Định nghĩa cấu trúc cho trường analysis để MongoDB có thể lưu nó
  analysis: {
    predictedCL: String,
    cycle3DayDigits: [String],
  },
  // -----------------------------------------

  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('Prediction', predictionSchema);
