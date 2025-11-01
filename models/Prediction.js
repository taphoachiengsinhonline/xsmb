// file: models/Prediction.js

const mongoose = require('mongoose');

const chiTietGocSchema = new mongoose.Schema({ number: String, positionInPrize: Number, tram: String, chuc: String, donvi: String, weight: { type: Number, default: 1 } }, { _id: false });
const ketQuaPhuongPhapSchema = new mongoose.Schema({ topTram: [String], topChuc: [String], topDonVi: [String], chiTietGoc: [chiTietGocSchema] }, { _id: false });
const groupExclusionAnalysisSchema = new mongoose.Schema({
  potentialNumbers: [String],
  excludedPatternCount: Number,
  appliedThreshold: Number,
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  ngayDuDoan: { type: String, required: true, unique: true },
  topTram: [String],
  topChuc: [String],
  topDonVi: [String],
  ketQuaChiTiet: { type: Map, of: ketQuaPhuongPhapSchema },
  diemTinCay: { type: Map, of: Number },
  intersectionAnalysis: { tram: mongoose.Schema.Types.Mixed, chuc: mongoose.Schema.Types.Mixed, donvi: mongoose.Schema.Types.Mixed },
  groupExclusionAnalysis: groupExclusionAnalysisSchema,
  danhDauDaSo: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const modelStateSchema = new mongoose.Schema({
    modelName: { type: String, required: true, unique: true },
    confidenceScore: { type: Number, default: 1.0 },
    history: [{
        date: String,
        isCorrect: Boolean
    }]
}, { timestamps: true });

const PredictionModel = mongoose.model('Prediction', predictionSchema);
const ModelStateModel = mongoose.model('ModelState', modelStateSchema);

module.exports = { Prediction: PredictionModel, ModelState: ModelStateModel };
