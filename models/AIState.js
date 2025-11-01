// file: models/AIState.js

const mongoose = require('mongoose');

// Schema này chuyên dùng để lưu trạng thái học hỏi của các mô hình AI
const aiStateSchema = new mongoose.Schema({
    modelName: { type: String, required: true, unique: true }, // Tên của mô hình, vd: "GROUP_EXCLUSION_CONFIDENCE"
    confidenceScore: { type: Number, default: 1.0 }, // Điểm tin cậy hiện tại
    // Có thể thêm các trường khác trong tương lai, vd: history
}, { timestamps: true });

module.exports = mongoose.model('AIState', aiStateSchema);
