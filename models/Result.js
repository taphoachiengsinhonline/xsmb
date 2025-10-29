const mongoose = require('mongoose');

const resultSchema = new mongoose.Schema({
  ngay: { type: String, required: true }, // dd/mm/yyyy
  giai: { type: String, required: true }, // ĐB, G1, G2a...
  so: { type: String, required: true },
  basocuoi: String,
  haisocuoi: String,
  chanle: String
}, { timestamps: true });

resultSchema.index({ ngay: 1, giai: 1 }, { unique: true });

module.exports = mongoose.model('Result', resultSchema);
