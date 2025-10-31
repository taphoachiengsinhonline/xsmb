// file: models/Prediction.js

const mongoose = require('mongoose');

// Schema cho chi tiết của riêng "Phương pháp Gốc" để học hỏi weight nội bộ
const chiTietGocSchema = new mongoose.Schema({
  number: String,
  positionInPrize: Number,
  tram: String,
  chuc: String,
  donvi: String,
  weight: { type: Number, default: 1 }
}, { _id: false });

// Schema cho kết quả dự đoán của một phương pháp "chuyên gia"
const ketQuaPhuongPhapSchema = new mongoose.Schema({
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  // Chỉ "Phương pháp Gốc" mới có trường này
  chiTietGoc: [chiTietGocSchema] 
}, { _id: false });

// Schema chính, mỗi document là một ngày dự đoán
const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },

  // --- NÂNG CẤP LỚN ---
  // 1. Kết quả dự đoán cuối cùng của Siêu Mô Hình
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  
  // 2. Kết quả chi tiết của từng phương pháp "chuyên gia" để tham khảo
  ketQuaChiTiet: {
    type: Map,
    of: ketQuaPhuongPhapSchema
  },
  
  // 3. Điểm tin cậy của các phương pháp TẠI THỜI ĐIỂM dự đoán
  // Đây là điểm số đã được học hỏi từ ngày hôm trước
  diemTinCay: {
    type: Map,
    of: Number
  },

  danhDauDaSo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('Prediction', predictionSchema);
