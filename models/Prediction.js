// models/Prediction.js
// Schema cho predictions: mỗi document = 1 ngày dự đoán (ngayDuDoan)
const mongoose = require('mongoose');

const chiTietSchema = new mongoose.Schema({
  number: String,           // '123'
  group: Number,            // 1..3
  positionInPrize: Number,  // index of prize in today's list (1..27)
  tram: String,
  chuc: String,
  donvi: String,
  matchedDigit: String,     // digit matched (if any)
  weight: { type: Number, default: 1 } // score/weight, tăng lên khi đúng
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
