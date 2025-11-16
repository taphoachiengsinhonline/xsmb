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
        // 1. Lấy tham số page và limit từ query string, với giá trị mặc định
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20; // Mặc định 20 item mỗi trang
        const skip = (page - 1) * limit;

        // 2. Lấy tổng số dự đoán để tính toán phân trang
        const totalDocuments = await PatternPrediction.countDocuments();
        const totalPages = Math.ceil(totalDocuments / limit);

        // 3. Lấy đúng "lát cắt" dữ liệu cho trang hiện tại
        const predictions = await PatternPrediction.find()
            .sort({ _id: -1 }) // Lấy theo thứ tự tạo mới nhất
            .skip(skip)
            .limit(limit)
            .lean();
        
        // Hàm helper để sắp xếp
        const parseDate = (dateStr) => {
            if (!dateStr) return null;
            const parts = dateStr.split('/');
            if (parts.length !== 3) return null;
            return new Date(parts[2], parts[1] - 1, parts[0]);
        };
        
        // Sắp xếp lại lát cắt dữ liệu này theo ngày giảm dần
        predictions.sort((a, b) => {
            const dateA = parseDate(a.ngayDuDoan);
            const dateB = parseDate(b.ngayDuDoan);
            return (dateB || 0) - (dateA || 0);
        });

        // 4. Các bước kết hợp dữ liệu còn lại giữ nguyên
        const dates = predictions.map(p => p.ngayDuDoan);
        const results = await Result.find({ ngay: { $in: dates }, giai: 'ĐB' }).lean();
        const resultsMap = new Map(results.map(r => [r.ngay, r.so]));
        const dataWithActuals = predictions.map(p => ({
            ...p,
            actualGDB: resultsMap.get(p.ngayDuDoan) || null
        }));

        // 5. Trả về dữ liệu cùng với thông tin phân trang
        res.json({
            success: true,
            predictions: dataWithActuals,
            pagination: {
                page: page,
                limit: limit,
                total: totalDocuments,
                pages: totalPages,
            }
        });
    } catch (error) {
        console.error('Error getting all predictions with pagination:', error);
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
