// const TensorFlowService = require('../services/tensorflowService');
const ActorCriticService = require('../services/actorCriticService');
const NNPrediction = require('../models/NNPrediction');

const tfService = new TensorFlowService();
const acService = new ActorCriticService(); // <-- KHỞI TẠO SERVICE MỚI

exports.trainHistorical = async (req, res) => {
    try {
        console.log('🤖 [AC Controller] Nhận lệnh Huấn luyện Lịch sử...');
        
        // Gọi hàm huấn luyện lịch sử của service mới
        const result = await acService.runHistoricalTraining();
        
        res.status(200).json({ 
            success: true, 
            message: "Huấn luyện lại từ đầu cho Actor-Critic hoàn tất.",
            details: result 
        });
    } catch (error) {
        console.error('❌ Error in Actor-Critic trainHistorical controller:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.predictNextDay = async (req, res) => {
    try {
        console.log('🚀 [AC Controller] Nhận lệnh Tạo Dự Đoán Ngày Mai...');
        
        // Gọi hàm dự đoán của service mới
        const result = await acService.runNextDayPrediction();

        res.status(200).json({ 
            success: true, 
            message: "Dự đoán bằng Actor-Critic đã được tạo.",
            details: result
        });
    } catch (error) {
        console.error('❌ Error in Actor-Critic predictNextDay controller:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.learn = async (req, res) => {
    try {
        console.log('🧠 [AC Controller] Nhận lệnh Học Tăng Cường...');
        
        // Gọi hàm học của service mới
        const result = await acService.runLearning();

        res.status(200).json({ 
            success: true, 
            message: "Vòng lặp học tăng cường hoàn tất.",
            details: result
        });
    } catch (error) {
        console.error('❌ Error in Actor-Critic learn controller:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};

exports.getAllPredictions = async (req, res) => {
    try {
        const NNPrediction = require('../models/NNPrediction'); // Import tại đây để tránh lỗi vòng lặp
        const predictions = await NNPrediction.find().sort({ ngayDuDoan: -1 }).limit(100);
        res.status(200).json(predictions);
    } catch (error) {
        console.error('❌ Error in getAllPredictions controller:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};
module.exports = exports;
