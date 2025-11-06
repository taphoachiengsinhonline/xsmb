const mongoose = require('mongoose');

// Schema để lưu trữ "kiến thức" của một vị trí (Trăm, Chục, hoặc Đơn vị)
const PositionStatsSchema = new mongoose.Schema({
    _id: false, // không cần _id cho sub-document này
    digit: { type: String, required: true },
    totalAppearances: { type: Number, default: 0 },
    correctPicks: { type: Number, default: 0 },
    accuracy: { type: Number, default: 0 } // Tỷ lệ trúng (%)
});

const LearningStateSchema = new mongoose.Schema({
    // Dùng một ID cố định để luôn cập nhật cùng một bản ghi
    modelName: { type: String, required: true, unique: true, default: 'TripleGroupV1' },
    
    // "Kiến thức" về từng vị trí
    tram: [PositionStatsSchema],
    chuc: [PositionStatsSchema],
    donvi: [PositionStatsSchema],
    
    totalPredictionsAnalyzed: { type: Number, default: 0 },
    lastLearnedAt: { type: Date }
});

module.exports = mongoose.model('TripleGroupLearningState', LearningStateSchema);
