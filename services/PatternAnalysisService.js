// services/PatternAnalysisService.js
const Result = require('../models/Result');
const PatternPrediction = require('../models/PatternPrediction');
const PatternKnowledge = require('../models/PatternKnowledge');
const { GROUPS, PRIZE_ORDER } = require('./patternAnalysis/constants');
const { DateTime } = require('luxon');

class PatternAnalysisService {
    constructor() {
        this.resultsByDate = null;
        this.sortedDates = [];
        this.knowledge = new Map(); // Knowledge base for this run
    }

    /**
     * Hàm chính điều phối toàn bộ quá trình phân tích và dự đoán
     */
    async generatePredictionForNextDay() {
        console.log('🤖 [PatternAI] Bắt đầu phân tích cho ngày tiếp theo...');
        await this.loadDataAndKnowledge();

        const latestDate = this.sortedDates[0];
        const nextDay = DateTime.fromFormat(latestDate, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
        console.log(`🎯 Ngày dự đoán: ${nextDay}`);

        const predictions = {};
        const positions = ['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'];
        const gdbPositionNames = [0, 1, 2, 3, 4];

        for (let i = 0; i < positions.length; i++) {
            console.log(`--- Phân tích vị trí: ${positions[i]} ---`);
            // Chạy pipeline phân tích cho từng vị trí
            predictions[positions[i]] = await this.runAnalysisPipelineForPosition(gdbPositionNames[i]);
        }

        // Lưu kết quả vào DB
        const savedPrediction = await PatternPrediction.findOneAndUpdate(
            { ngayDuDoan: nextDay },
            { ngayDuDoan: nextDay, ...predictions },
            { upsert: true, new: true }
        );

        console.log('✅ [PatternAI] Đã tạo và lưu dự đoán thành công!');
        return savedPrediction;
    }

    /**
     * Pipeline các bước phân tích cho một vị trí GĐB cụ thể (0-4)
     */
    async runAnalysisPipelineForPosition(gdbPositionIndex) {
        // 1. Tìm các "dấu vết" lịch sử
        const historicalTraces = this.findHistoricalTraces(gdbPositionIndex);

        // 2. Phát hiện các mẫu hình từ dấu vết
        const detectedPatterns = this.detectPatterns(historicalTraces);

        // 3. Chấm điểm các mẫu hình dựa trên "trí nhớ" (knowledge base)
        const scoredPatterns = this.scorePatterns(detectedPatterns);

        // 4. Đánh giá "sức mạnh" của từng nhóm nhỏ dựa trên các mẫu hình trỏ về
        const subgroupStrengths = this.evaluateSubgroupStrength(scoredPatterns);

        // 5. Lọc số dựa trên logic các nhóm lớn
        const groupResults = this.filterByGroupLogic(subgroupStrengths);

        // 6. Giao (intersect) kết quả và áp dụng bộ lọc loại trừ cuối cùng
        let finalDigits = this.finalIntersectionAndFiltering(groupResults);
        
        // 7. Nếu vẫn còn nhiều hơn 5 số, áp dụng thêm bộ lọc
        if (finalDigits.length > 5) {
            finalDigits = this.applyAdvancedExclusion(finalDigits, 5);
        }
        
        // 8. Tìm số "hot" nhất
        const hotDigit = this.findHotDigit(finalDigits, scoredPatterns);

        return {
            promisingDigits: finalDigits.slice(0, 5),
            hotDigit: hotDigit,
            analysisDetails: { /* có thể lưu các pattern mạnh nhất ở đây */ }
        };
    }
    
    // --- CÁC HÀM LÕI (sẽ được implement chi tiết) ---

    async loadDataAndKnowledge() { /* Tải tất cả KQXS và knowledge base từ DB */ }
    
    findHistoricalTraces(gdbPositionIndex) { 
        /* 
         - Logic: Lặp qua các ngày, lấy chữ số ở vị trí `gdbPositionIndex` của GĐB.
         - Sau đó, quét tất cả giải của ngày hôm TRƯỚC để xem chữ số đó xuất hiện ở đâu.
         - Trả về một cấu trúc dữ liệu ghi lại các "dấu vết" này.
         - Ví dụ: { '05/11/2025': { digit: '8', traces: [{ prize: 'G1', position: 1 }, ...] } }
        */
        return {}; // Placeholder
    }

    detectPatterns(traces) {
        /*
         - Đây là phần "AI" nhận dạng.
         - Hàm này sẽ nhận vào các dấu vết và tìm kiếm:
           1. Đường ăn thẳng (Streak): Cùng 1 vị trí (vd: G1-pos1) xuất hiện trong trace nhiều ngày liên tiếp.
           2. Đường ăn chéo (Diagonal): Vị trí ăn di chuyển theo quy luật (vd: G1-pos1 -> G2a-pos2 -> G3b-pos3).
           3. Chu kỳ (Cycle): Một vị trí ăn lặp lại sau N ngày (vd: cách 2 ngày).
         - Trả về một danh sách các pattern đã phát hiện, vd: [{ type: 'streak', key: 'G1_pos1', length: 3, lastDay: '11/11/2025' }]
        */
        return []; // Placeholder
    }
    
    scorePatterns(patterns) { 
        /*
         - Lấy trọng số từ `this.knowledge` đã load.
         - Nhân điểm cơ bản của pattern (dựa trên độ dài, độ mới) với trọng số.
         - Trả về các pattern đã được chấm điểm.
        */
        return []; // Placeholder
    }

    evaluateSubgroupStrength(scoredPatterns) {
        /*
         - Với mỗi nhóm nhỏ (G1A, G1B, ...), đếm tổng điểm của các pattern "trỏ về" nó.
         - "Trỏ về" nghĩa là bước tiếp theo của pattern sẽ rơi vào một giải trong nhóm đó.
         - Trả về điểm sức mạnh cho mỗi nhóm nhỏ, vd: { G1A: 150, G1B: 450, G1C: 80, ... }
        */
        return {}; // Placeholder
    }

    filterByGroupLogic(subgroupStrengths) {
        /*
         - Implement logic bạn đã mô tả:
           - Nhóm 1 & 2: Tìm nhóm nhỏ mạnh nhất, lấy các chữ số có trong các giải của nhóm đó.
           - Nhóm 3: Áp dụng logic loại trừ số xuất hiện trong cả 3 nhóm nhỏ, sau đó tìm nhóm nhỏ mạnh nhất và giao với tập số còn lại.
         - Trả về 3 bộ số cho 3 nhóm lớn.
        */
        return { g1_digits: [], g2_digits: [], g3_digits: [] }; // Placeholder
    }
    
    finalIntersectionAndFiltering(groupResults) {
        /*
         - Lấy các số xuất hiện ít nhất 2 trong 3 bộ số từ `groupResults`.
         - Áp dụng bộ lọc loại trừ từ các giải "gan" (ví dụ G7b).
         - Trả về danh sách các số cuối cùng.
        */
        return []; // Placeholder
    }
    
    applyAdvancedExclusion(digits, targetCount) { /* Lọc thêm nếu cần */ return digits.slice(0, targetCount); }
    findHotDigit(digits, scoredPatterns) { /* Tìm số được nhiều pattern điểm cao nhất trỏ về */ return digits[0]; }

    /**
     * Hàm cho AI học hỏi từ kết quả thực tế
     */
    async learnFromResults() {
        console.log('🧠 [PatternAI] Bắt đầu học hỏi từ kết quả mới...');
        await this.loadDataAndKnowledge();
        
        const predictionsToLearn = await PatternPrediction.find({ hasActualResult: false });
        // ... Logic so sánh dự đoán với kết quả thật, tìm ra pattern nào đúng/sai ...
        // ... Cập nhật trọng số trong `this.knowledge` (tăng cho pattern đúng, giảm cho pattern sai) ...
        
        // Lưu lại knowledge base đã được cập nhật
        await PatternKnowledge.findOneAndUpdate(
            { modelName: 'PatternAnalyzerV1' },
            { knowledgeBase: this.knowledge, lastLearnedAt: new Date() },
            { upsert: true }
        );
        console.log('✅ [PatternAI] Học hỏi hoàn tất!');
    }
}

module.exports = PatternAnalysisService;
