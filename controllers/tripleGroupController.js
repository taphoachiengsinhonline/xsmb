// controllers/tripleGroupController.js
const TripleGroupAnalysisService = require('../services/tripleGroupAnalysisService');
const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const Result = require('../models/Result');

const tripleGroupService = new TripleGroupAnalysisService();

exports.generatePrediction = async (req, res) => {
    try {
        console.log('🎯 Bắt đầu tạo dự đoán Triple Group...');
        
        const prediction = await tripleGroupService.generateTripleGroupPrediction();
        
        // Lưu dự đoán vào database
        await tripleGroupService.savePrediction(prediction);
        
        res.json({
            success: true,
            message: 'Dự đoán Triple Group đã được tạo và lưu',
            prediction: prediction
        });
    } catch (error) {
        console.error('❌ Lỗi generatePrediction:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo dự đoán: ' + error.message
        });
    }
};

exports.getPredictions = async (req, res) => {
    try {
        const { limit = 50, page = 1 } = req.query;
        const skip = (page - 1) * limit;

        const predictions = await TripleGroupPrediction.find()
            .sort({ ngayDuDoan: -1 })
            .limit(parseInt(limit))
            .skip(skip)
            .lean();

        const total = await TripleGroupPrediction.countDocuments();

        // Tính thống kê độ chính xác
        const stats = await this.calculateAccuracyStats();

        res.json({
            success: true,
            predictions: predictions,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                pages: Math.ceil(total / limit)
            },
            stats: stats
        });
    } catch (error) {
        console.error('❌ Lỗi getPredictions:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy dữ liệu dự đoán'
        });
    }
};

exports.getPredictionByDate = async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu tham số date'
            });
        }

        const prediction = await TripleGroupPrediction.findOne({ ngayDuDoan: date }).lean();
        
        if (!prediction) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy dự đoán cho ngày này'
            });
        }

        res.json({
            success: true,
            prediction: prediction
        });
    } catch (error) {
        console.error('❌ Lỗi getPredictionByDate:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy dự đoán'
        });
    }
};

exports.updateAllActualResults = async (req, res) => {
    try {
        console.log('🔄 Cập nhật kết quả thực tế cho tất cả dự đoán...');
        
        const allResults = await Result.find().lean();
        const predictions = await TripleGroupPrediction.find({ 
            'actualResult': { $exists: false } 
        }).lean();

        let updatedCount = 0;

        for (const prediction of predictions) {
            const result = allResults.find(r => r.ngay === prediction.ngayDuDoan && r.giai === 'ĐB');
            if (result?.so) {
                const gdbStr = String(result.so).padStart(5, '0');
                const lastThree = gdbStr.slice(-3);
                
                if (lastThree.length === 3) {
                    await tripleGroupService.updateActualResult(prediction.ngayDuDoan, lastThree);
                    updatedCount++;
                }
            }
        }

        res.json({
            success: true,
            message: `Đã cập nhật ${updatedCount} kết quả thực tế`
        });
    } catch (error) {
        console.error('❌ Lỗi updateAllActualResults:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật kết quả'
        });
    }
};

exports.calculateAccuracyStats = async () => {
    const predictionsWithResults = await TripleGroupPrediction.find({
        'actualResult': { $exists: true }
    }).lean();

    const total = predictionsWithResults.length;
    const correct = predictionsWithResults.filter(p => p.actualResult.isCorrect).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    // Thống kê theo tháng
    const monthlyStats = {};
    predictionsWithResults.forEach(pred => {
        const [day, month, year] = pred.ngayDuDoan.split('/');
        const monthYear = `${month}/${year}`;
        
        if (!monthlyStats[monthYear]) {
            monthlyStats[monthYear] = { total: 0, correct: 0 };
        }
        
        monthlyStats[monthYear].total++;
        if (pred.actualResult.isCorrect) {
            monthlyStats[monthYear].correct++;
        }
    });

    // Tính độ chính xác theo confidence level
    const confidenceStats = {};
    predictionsWithResults.forEach(pred => {
        const confidenceLevel = Math.floor(pred.confidence / 10) * 10; // Nhóm theo 10%
        
        if (!confidenceStats[confidenceLevel]) {
            confidenceStats[confidenceLevel] = { total: 0, correct: 0 };
        }
        
        confidenceStats[confidenceLevel].total++;
        if (pred.actualResult.isCorrect) {
            confidenceStats[confidenceLevel].correct++;
        }
    });

    return {
        overall: {
            total: total,
            correct: correct,
            accuracy: Math.round(accuracy * 100) / 100
        },
        monthly: monthlyStats,
        byConfidence: confidenceStats
    };
};

exports.generatePredictionWithLearning = async (req, res) => {
    try {
        console.log('🎯 Tạo dự đoán Triple Group với học hỏi...');
        
        const prediction = await tripleGroupService.generatePredictionWithLearning();
        
        res.json({
            success: true,
            message: 'Dự đoán Triple Group đã được tạo với học hỏi từ lịch sử',
            prediction: prediction,
            learning: {
                learnedFromHistory: true,
                historicalDataUsed: true
            }
        });
    } catch (error) {
        console.error('❌ Lỗi generatePredictionWithLearning:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo dự đoán với học hỏi: ' + error.message
        });
    }
};

exports.getLearningStats = async (req, res) => {
    try {
        const stats = await tripleGroupService.analyzeHistoricalPerformance();
        
        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('❌ Lỗi getLearningStats:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thống kê học tập'
        });
    }
};
// controllers/tripleGroupController.js
exports.generateHistoricalPredictions = async (req, res) => {
    try {
        console.log('🚀 Bắt đầu tạo dự đoán lịch sử...');
        
        const result = await tripleGroupService.generateHistoricalPredictions();
        
        res.json({
            success: true,
            message: `Đã tạo ${result.created} dự đoán lịch sử`,
            ...result
        });
    } catch (error) {
        console.error('❌ Lỗi generateHistoricalPredictions:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo dự đoán lịch sử: ' + error.message
        });
    }
};

exports.getPredictionsWithFilter = async (req, res) => {
    try {
        const { page = 1, limit = 20, date = null } = req.query;
        
        const result = await tripleGroupService.getAllPredictions(
            parseInt(page), 
            parseInt(limit), 
            date
        );

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('❌ Lỗi getPredictionsWithFilter:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy dữ liệu dự đoán'
        });
    }
};

exports.getAvailableDates = async (req, res) => {
    try {
        const dates = await tripleGroupService.getAvailableDates();
        
        res.json({
            success: true,
            dates: dates
        });
    } catch (error) {
        console.error('❌ Lỗi getAvailableDates:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách ngày'
        });
    }
};
