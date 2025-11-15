const PatternAnalysisService = require('../services/PatternAnalysisService');
const PatternPrediction = require('../models/PatternPrediction'); // Import model để lấy dữ liệu
const Result = require('../models/Result'); // Import model để lấy kết quả thực tế

/**
 * Tác vụ hàng ngày: Học hỏi từ kết quả mới, lấp đầy các ngày thiếu, và tạo dự đoán cho ngày mai.
 */
exports.learnAndPredict = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const predictions = await service.learnAndPredictForward();
        res.json({ success: true, message: `Đã học hỏi và tạo ${predictions.length} dự đoán mới.`, predictions });
    } catch (error) {
        console.error('Error in learnAndPredict:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Tác vụ quản trị: Xóa sạch dữ liệu, huấn luyện lại từ đầu và tạo dự đoán mới.
 */
exports.resetAndRebuild = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const result = await service.resetAndRebuildAll();
        res.json({ success: true, message: result.message, result });
    } catch (error) {
        console.error('Error in resetAndRebuild:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Tác vụ nền: Chạy lại backtest lịch sử (được gọi bởi resetAndRebuild).
 */
exports.generateHistorical = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const result = await service.generateHistoricalPredictions();
        res.json({ success: true, message: `Đã tạo ${result.created} dự đoán lịch sử.`, result });
    } catch (error) {
        console.error('Error generating historical predictions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Tác vụ lấy dữ liệu: Lấy lịch sử dự đoán để hiển thị trên màn hình Lịch sử.
 */
exports.getAllPredictions = async (req, res) => {
    try {
        // 1. Lấy 100 dự đoán gần nhất từ AI Mẫu Hình
        const predictions = await PatternPrediction.find()
            .sort({ ngayDuDoan: -1 }) // Sắp xếp mới nhất trước
            .limit(100) 
            .lean();
        
        // 2. Lấy danh sách các ngày có dự đoán để truy vấn kết quả thực tế
        const dates = predictions.map(p => p.ngayDuDoan);
        
        // 3. Lấy kết quả GĐB thực tế cho những ngày đó
        const results = await Result.find({ ngay: { $in: dates }, giai: 'ĐB' }).lean();
        
        // 4. Tạo một Map để tra cứu kết quả thực tế nhanh hơn
        const resultsMap = new Map(results.map(r => [r.ngay, r.so]));

        // 5. Kết hợp dữ liệu: Thêm kết quả thực tế vào mỗi bản ghi dự đoán
        const dataWithActuals = predictions.map(p => ({
            ...p,
            actualGDB: resultsMap.get(p.ngayDuDoan) || null
        }));

        res.json({ success: true, predictions: dataWithActuals });
    } catch (error) {
        console.error('Error getting all predictions:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Tác vụ đơn lẻ: Chỉ tạo dự đoán cho ngày tiếp theo (có thể dùng để test).
 */
exports.generatePrediction = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        const prediction = await service.generatePredictionForNextDay();
        res.json({ success: true, message: 'Đã tạo dự đoán thành công!', prediction });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Tác vụ đơn lẻ: Chỉ chạy chức năng học (có thể dùng để test).
 */
exports.learn = async (req, res) => {
    try {
        const service = new PatternAnalysisService();
        await service.learnFromResults();
        res.json({ success: true, message: 'AI đã học hỏi xong!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
