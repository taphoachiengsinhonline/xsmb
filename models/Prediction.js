const mongoose = require('mongoose');

const ChiTietSchema = new mongoose.Schema({
  matchedDigit: String,     // số trùng với giải ĐB hôm sau
  group: Number,            // nhóm 3 giải
  prizeIndex: Number,       // số thứ mấy trong nhóm
  positionInPrize: Number,  // vị trí trăm/chục/đơn vị
  prizeCode: String,        // tên giải (ĐB, G1,...)
  number: String,           // số quay của giải
  weight: { type: Number, default: 1 } // trọng số tự học
}, { _id: false });

const PredictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true }, // ngày dự đoán
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  chiTiet: [ChiTietSchema],
  danhDauDaSo: { type: Boolean, default: false } // đã so kết quả thực tế chưa
});

module.exports = mongoose.model('Prediction', PredictionSchema);
