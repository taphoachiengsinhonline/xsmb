// file: models/Prediction.js
const mongoose = require('mongoose');

// Schema cho chi tiết của riêng "Phương pháp Gốc" để học hỏi
const chiTietGocSchema = new mongoose.Schema({
  number: String,
  positionInPrize: Number,
  tram: String,
  chuc: String,
  donvi: String,
  weight: { type: Number, default: 1 }
}, { _id: false });

// Schema cho kết quả dự đoán của một phương pháp
const ketQuaPhuongPhapSchema = new mongoose.Schema({
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  // Chỉ "Phương pháp Gốc" mới có trường này
  chiTietGoc: [chiTietGocSchema] 
}, { _id: false });

// Schema chính, mỗi document là một ngày
const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },

  // Object chứa kết quả của TẤT CẢ các phương pháp
  // Ví dụ: { "PHUONG_PHAP_GOC": { topTram: [...] }, "DEEP_30_DAY": { topTram: [...] } }
  ketQuaPhanTich: {
    type: Map,
    of: ketQuaPhuongPhapSchema
  },

  danhDauDaSo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('Prediction', predictionSchema);
