// models/PatternKnowledge.js
const mongoose = require('mongoose');

// Lưu trọng số cho một mẫu hình cụ thể
const patternWeightSchema = new mongoose.Schema({
    patternKey: { type: String, required: true, unique: true }, // Vd: "DIAGONAL_G1_G2a_3_DAYS"
    type: { type: String, required: true, enum: ['streak', 'cycle', 'diagonal', 'convergence'] },
    weight: { type: Number, default: 1.0 }, // Trọng số tin cậy
    lastHit: { type: String }, // Ngày trúng gần nhất
    hitCount: { type: Number, default: 0 },
    missCount: { type: Number, default: 0 },
}, { _id: false });

const patternKnowledgeSchema = new mongoose.Schema({
    modelName: { type: String, default: 'PatternAnalyzerV1', unique: true },
    knowledgeBase: { type: Map, of: patternWeightSchema },
    lastLearnedAt: { type: Date },
});

module.exports = mongoose.model('PatternKnowledge', patternKnowledgeSchema);
