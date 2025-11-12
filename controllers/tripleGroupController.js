//const TripleGroupAnalysisService = require('../services/tripleGroupAnalysisService');
const AdvancedPatternAnalysisService = require('../services/advancedPatternAnalysisService');
const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const Result = require('../models/Result');

//const tripleGroupService = new TripleGroupAnalysisService();
const advancedPatternService = new AdvancedPatternAnalysisService();
/**
 * Tạo dự đoán mới cho ngày tiếp theo
 */
exports.generatePrediction = async (req, res) => {
    try {
        console.log('🎯 [Controller] Bắt đầu tạo dự đoán bằng PHƯƠNG PHÁP NÂNG CAO...');
        
        // SỬA ĐỔI: Gọi service mới
        const prediction = await advancedPatternService.generatePrediction();
        
        res.json({
            success: true,
            message: 'Dự đoán theo phương pháp Nâng Cao đã được tạo thành công',
            prediction: prediction,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi generatePrediction (Nâng cao):', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo dự đoán: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};


/**
 * Tạo dự đoán với học hỏi từ lịch sử
 */
exports.generateHistoricalPredictions = async (req, res) => {
    try {
        console.log('🕐 [Controller] Bắt đầu tạo dự đoán lịch sử (PHƯƠNG PHÁP NÂNG CAO)...');

        // 1. Lấy tất cả các ngày duy nhất có kết quả trong DB
        const allResultDates = await Result.distinct('ngay');
        if (allResultDates.length < 8) { // Cần ít nhất vài ngày để có dữ liệu phân tích
            return res.status(400).json({ success: false, message: 'Không đủ dữ liệu lịch sử để tạo dự đoán.' });
        }
        
        // 2. Sắp xếp các ngày theo thứ tự từ cũ đến mới
        const sortedDates = allResultDates.sort((a, b) => {
            const dateA = new Date(a.split('/').reverse().join('-'));
            const dateB = new Date(b.split('/').reverse().join('-'));
            return dateA - dateB;
        });

        let createdCount = 0;
        let errorCount = 0;
        
        console.log(`[Controller] Sẽ xử lý ${sortedDates.length} ngày...`);

        // 3. Lặp qua từng ngày để tạo dự đoán
        // Bỏ qua vài ngày đầu tiên vì chúng không có đủ lịch sử phía trước
        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            try {
                // Gọi service mới để tạo dự đoán cho ngày cụ thể này
                console.log(`... Đang tạo cho ngày: ${targetDate}`);
                await advancedPatternService.generatePrediction(targetDate);
                createdCount++;
            } catch (innerError) {
                console.error(`❌ [Controller] Lỗi khi xử lý ngày ${targetDate}:`, innerError.message);
                errorCount++;
            }
        }

        const successMessage = `Đã tạo ${createdCount} dự đoán lịch sử thành công. Gặp lỗi ở ${errorCount} ngày.`;
        console.log(`✅ [Controller] Hoàn thành. ${successMessage}`);

        res.json({
            success: true,
            message: successMessage,
            created: createdCount,
            errors: errorCount,
            total: sortedDates.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi nghiêm trọng trong generateHistoricalPredictions:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi tạo dự đoán lịch sử: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};


/**
 * Lấy danh sách dự đoán với phân trang và lọc
 */
exports.getPredictions = async (req, res) => {
    try {
        const { page = 1, limit = 20, date = null } = req.query;
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        
        console.log(`📋 [Controller] Lấy dự đoán - trang ${pageNum}, limit ${limitNum}, date: ${date || 'all'}`);
        
        const skip = (pageNum - 1) * limitNum;
        
        let query = {};
        if (date) {
            query.ngayDuDoan = date;
        }

        // Sửa lỗi sắp xếp: Lấy dữ liệu trước rồi sắp xếp trong JS
        const predictionsFromDB = await TripleGroupPrediction.find(query)
            .sort({ _id: -1 }) // Sắp xếp theo thời gian tạo để ổn định
            .skip(skip)
            .limit(limitNum)
            .lean();

        const predictions = predictionsFromDB.sort((a, b) => {
            if (!a.ngayDuDoan || !b.ngayDuDoan) return 0;
            return new Date(b.ngayDuDoan.split('/').reverse().join('-')) - new Date(a.ngayDuDoan.split('/').reverse().join('-'));
        });

        const total = await TripleGroupPrediction.countDocuments(query);
        const totalPages = Math.ceil(total / limitNum);

        // Tính thống kê nhanh
        const predictionsWithResults = predictions.filter(p => p.actualResult);
        const correctPredictions = predictionsWithResults.filter(p => p.actualResult.isCorrect);
        const accuracy = predictionsWithResults.length > 0 
            ? (correctPredictions.length / predictionsWithResults.length * 100).toFixed(1)
            : 0;

        res.json({
            success: true,
            predictions: predictions,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total: total,
                pages: totalPages,
                hasNext: pageNum < totalPages,
                hasPrev: pageNum > 1
            },
            stats: {
                totalPredictions: total,
                withResults: predictionsWithResults.length,
                correct: correctPredictions.length,
                accuracy: parseFloat(accuracy)
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getPredictions:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy dữ liệu dự đoán: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Lấy dự đoán theo ngày cụ thể
 */
exports.getPredictionByDate = async (req, res) => {
    try {
        const { date } = req.query;
        
        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu tham số date (định dạng: dd/mm/yyyy)',
                timestamp: new Date().toISOString()
            });
        }

        console.log(`📅 [Controller] Lấy dự đoán cho ngày: ${date}`);
        
        const prediction = await TripleGroupPrediction.findOne({ ngayDuDoan: date }).lean();
        
        if (!prediction) {
            return res.status(404).json({
                success: false,
                message: `Không tìm thấy dự đoán cho ngày ${date}`,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            prediction: prediction,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getPredictionByDate:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy dự đoán theo ngày: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Cập nhật kết quả thực tế cho tất cả dự đoán - PHIÊN BẢN ĐÃ SỬA LỖI
 */
exports.updateActualResults = async (req, res) => {
    try {
        console.log('🔄 [Controller] Cập nhật kết quả thực tế cho tất cả dự đoán...');
        
        // Lấy tất cả kết quả và dự đoán
        const allResults = await Result.find().lean();
        const predictions = await TripleGroupPrediction.find({}).lean(); // Lấy tất cả dự đoán

        console.log(`📝 [Controller] Tìm thấy ${predictions.length} dự đoán cần kiểm tra`);

        let updatedCount = 0;
        let errorCount = 0;
        let noResultCount = 0;

        for (const prediction of predictions) {
            try {
                // 🔧 SỬA LỖI: Chuẩn hóa định dạng ngày để so sánh
                const predictionDate = prediction.ngayDuDoan;
                
                // Tìm kết quả thực tế - sử dụng so sánh trực tiếp
                const result = allResults.find(r => {
                    const resultDate = r.ngay;
                    // So sánh trực tiếp chuỗi ngày
                    return resultDate === predictionDate && r.giai === 'ĐB';
                });
                
                if (result?.so) {
                    const gdbStr = String(result.so).padStart(5, '0');
                    const lastThree = gdbStr.slice(-3);
                    
                    if (lastThree.length === 3) {
                        const isCorrect = 
                            Array.isArray(prediction.topTram) && prediction.topTram.includes(lastThree[0]) &&
                            Array.isArray(prediction.topChuc) && prediction.topChuc.includes(lastThree[1]) &&
                            Array.isArray(prediction.topDonVi) && prediction.topDonVi.includes(lastThree[2]);

                        // 🔧 SỬA LỖI: Cập nhật ngay cả khi actualResult đã tồn tại
                        await TripleGroupPrediction.updateOne(
                            { _id: prediction._id },
                            {
                                $set: {
                                    actualResult: {
                                        tram: lastThree[0],
                                        chuc: lastThree[1],
                                        donvi: lastThree[2],
                                        isCorrect: isCorrect,
                                        updatedAt: new Date()
                                    }
                                }
                            }
                        );
                        updatedCount++;
                        
                        if (updatedCount % 10 === 0) {
                            console.log(`📊 [Controller] Đã cập nhật ${updatedCount} dự đoán...`);
                        }
                    }
                } else {
                    noResultCount++;
                    console.log(`❌ Không tìm thấy kết quả cho ngày: ${predictionDate}`);
                }
            } catch (error) {
                console.error(`❌ [Controller] Lỗi cập nhật cho ${prediction.ngayDuDoan}:`, error.message);
                errorCount++;
            }
        }

        console.log(`✅ [Controller] Hoàn thành cập nhật: ${updatedCount} thành công, ${noResultCount} không có kết quả, ${errorCount} lỗi`);

        res.json({
            success: true,
            message: `Đã cập nhật ${updatedCount} kết quả thực tế`,
            stats: {
                updated: updatedCount,
                noResult: noResultCount,
                errors: errorCount,
                totalProcessed: predictions.length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi updateActualResults:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật kết quả thực tế: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Học từ lịch sử dự đoán
 */
exports.learnFromHistory = async (req, res) => {
    try {
        console.log('🧠 [Controller] Bắt đầu học từ lịch sử...');
        
        // =================================================================
        // SỬA LỖI DUY NHẤT TẠI ĐÂY:
        // Đổi tên hàm từ "learnFromOwnHistory" thành "learnFromHistory"
        // để khớp với file service mới nhất.
        // =================================================================
        const result = await tripleGroupService.learnFromHistory();
        
        res.json({
            success: true,
            message: `Đã học từ ${result.updated} dự đoán trong lịch sử`,
            learned: result.updated,
            total: result.total,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi learnFromHistory:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi học từ lịch sử: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Lấy thống kê độ chính xác
 */
exports.getAccuracyStats = async (req, res) => {
    try {
        console.log('📊 [Controller] Lấy thống kê độ chính xác...');
        
        const predictionsWithResults = await TripleGroupPrediction.find({
            'actualResult': { $exists: true }
        }).lean();

        const total = predictionsWithResults.length;
        const correct = predictionsWithResults.filter(p => p.actualResult.isCorrect).length;
        const accuracy = total > 0 ? (correct / total) * 100 : 0;

        // Thống kê theo tháng
        const monthlyStats = {};
        predictionsWithResults.forEach(pred => {
            if (!pred.ngayDuDoan) return; // Bỏ qua nếu ngày không hợp lệ
            const parts = pred.ngayDuDoan.split('/');
            if (parts.length !== 3) return;
            const [day, month, year] = parts;
            const monthYear = `${month}/${year}`;
            
            if (!monthlyStats[monthYear]) {
                monthlyStats[monthYear] = { total: 0, correct: 0 };
            }
            
            monthlyStats[monthYear].total++;
            if (pred.actualResult.isCorrect) {
                monthlyStats[monthYear].correct++;
            }
        });

        // Tính độ chính xác theo từng tháng
        Object.keys(monthlyStats).forEach(month => {
            const stats = monthlyStats[month];
            stats.accuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
        });

        // Thống kê theo độ tin cậy
        const confidenceStats = {};
        predictionsWithResults.forEach(pred => {
            const confidenceLevel = Math.floor((pred.confidence || 50) / 10) * 10;
            
            if (!confidenceStats[confidenceLevel]) {
                confidenceStats[confidenceLevel] = { total: 0, correct: 0 };
            }
            
            confidenceStats[confidenceLevel].total++;
            if (pred.actualResult.isCorrect) {
                confidenceStats[confidenceLevel].correct++;
            }
        });

        // Tính độ chính xác theo confidence
        Object.keys(confidenceStats).forEach(level => {
            const stats = confidenceStats[level];
            stats.accuracy = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
        });

        res.json({
            success: true,
            stats: {
                overall: {
                    total: total,
                    correct: correct,
                    accuracy: Math.round(accuracy * 100) / 100
                },
                monthly: monthlyStats,
                byConfidence: confidenceStats
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getAccuracyStats:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thống kê độ chính xác: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Lấy thống kê học tập
 */
exports.getLearningStats = async (req, res) => {
    try {
        console.log('📈 [Controller] Lấy thống kê học tập...');
        
        const stats = await tripleGroupService.analyzeHistoricalPerformance();
        
        res.json({
            success: true,
            stats: stats,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getLearningStats:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thống kê học tập: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Lấy danh sách các ngày có dự đoán
 */
exports.getAvailableDates = async (req, res) => {
    try {
        console.log('📅 [Controller] Lấy danh sách ngày có dự đoán...');
        
        const predictions = await TripleGroupPrediction.find({})
            .sort({ ngayDuDoan: -1 }) // Vẫn giữ sort sơ bộ
            .select('ngayDuDoan')
            .lean();

        // Lọc bỏ ngày null/undefined và sắp xếp đúng
        const dates = [...new Set(predictions.map(p => p.ngayDuDoan))]
            .filter(d => d) // Lọc bỏ giá trị falsy
            .sort((a, b) => {
                const dateA = new Date(a.split('/').reverse().join('-'));
                const dateB = new Date(b.split('/').reverse().join('-'));
                return dateB - dateA;
            });

        res.json({
            success: true,
            dates: dates,
            total: dates.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getAvailableDates:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách ngày: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Xóa dự đoán theo ngày (chức năng admin)
 */
exports.deletePrediction = async (req, res) => {
    try {
        const { date } = req.body;
        
        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu tham số date',
                timestamp: new Date().toISOString()
            });
        }

        console.log(`🗑️ [Controller] Xóa dự đoán cho ngày: ${date}`);
        
        const result = await TripleGroupPrediction.deleteOne({ ngayDuDoan: date });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                message: `Không tìm thấy dự đoán cho ngày ${date} để xóa`,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            success: true,
            message: `Đã xóa dự đoán cho ngày ${date}`,
            deletedCount: result.deletedCount,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi deletePrediction:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa dự đoán: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Xóa tất cả dự đoán (chức năng admin - reset)
 */
exports.deleteAllPredictions = async (req, res) => {
    try {
        console.log('⚠️ [Controller] XÓA TẤT CẢ dự đoán...');
        
        const result = await TripleGroupPrediction.deleteMany({});
        
        console.log(`✅ [Controller] Đã xóa ${result.deletedCount} dự đoán`);

        res.json({
            success: true,
            message: `Đã xóa toàn bộ ${result.deletedCount} dự đoán`,
            deletedCount: result.deletedCount,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi deleteAllPredictions:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa tất cả dự đoán: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Lấy thông tin hệ thống
 */
exports.getSystemInfo = async (req, res) => {
    try {
        console.log('ℹ️ [Controller] Lấy thông tin hệ thống...');
        
        const totalPredictions = await TripleGroupPrediction.countDocuments();
        const predictionsWithResults = await TripleGroupPrediction.countDocuments({ 
            'actualResult': { $exists: true } 
        });
        const correctPredictions = await TripleGroupPrediction.countDocuments({ 
            'actualResult.isCorrect': true 
        });
        
        const latestPrediction = await TripleGroupPrediction.findOne()
            .sort({ createdAt: -1 })
            .select('ngayDuDoan createdAt')
            .lean();

        const accuracy = predictionsWithResults > 0 
            ? (correctPredictions / predictionsWithResults * 100).toFixed(2)
            : 0;

        res.json({
            success: true,
            systemInfo: {
                totalPredictions: totalPredictions,
                predictionsWithResults: predictionsWithResults,
                correctPredictions: correctPredictions,
                overallAccuracy: parseFloat(accuracy),
                latestPrediction: latestPrediction,
                service: 'Triple Group Analysis',
                version: '2.0.0-learning', // Cập nhật phiên bản
                lastUpdated: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi getSystemInfo:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin hệ thống: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Health check endpoint
 */
exports.healthCheck = async (req, res) => {
    try {
        // Kiểm tra kết nối database
        const dbStatus = await TripleGroupPrediction.findOne().limit(1);
        
        res.json({
            success: true,
            status: 'healthy',
            service: 'Triple Group Controller',
            database: dbStatus ? 'connected' : 'no_data',
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi healthCheck:', error);
        res.status(500).json({
            success: false,
            status: 'unhealthy',
            message: 'Lỗi health check: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

/**
 * Reset và huấn luyện lại toàn bộ hệ thống
 */
exports.resetAndRetrain = async (req, res) => {
    try {
        console.log('🔄 [Controller] Reset và huấn luyện lại...');
        
        const result = await tripleGroupService.resetAndRetrain();
        
        res.json({
            success: result.success,
            message: result.message,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ [Controller] Lỗi resetAndRetrain:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi reset: ' + error.message,
            timestamp: new Date().toISOString()
        });
    }
};

module.exports = exports;
