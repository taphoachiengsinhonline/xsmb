/**
 * @file advancedPatternAnalysisService.js
 * @description Service phân tích mẫu hình nâng cao dựa trên quy tắc 27 giải chia 9 nhóm.
 * Đây là service thay thế hoàn toàn cho TripleGroupAnalysisService.
 */
const Result = require('../models/Result');
const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState'); // Sẽ dùng để lưu "kiến thức" của AI
const { DateTime } = require('luxon');
const tf = require('@tensorflow/tfjs-node'); // Sử dụng TensorFlow.js cho các tác vụ học máy

// =================================================================
// CẤU TRÚC GIẢI VÀ NHÓM
// =================================================================
const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

const SMALL_GROUPS = {
    n1a: ['ĐB', 'G1', 'G2a'],
    n1b: ['G2b', 'G3a', 'G3b'],
    n1c: ['G3c', 'G3d', 'G3e'],
    n2a: ['G3f', 'G4a', 'G4b'],
    n2b: ['G4c', 'G4d', 'G5a'],
    n2c: ['G5b', 'G5c', 'G5d'],
    n3a: ['G5e', 'G5f', 'G6a'],
    n3b: ['G6b', 'G6c', 'G7a'],
    n3c: ['G7b', 'G7c', 'G7d']
};

const LARGE_GROUPS = {
    nhom1: ['n1a', 'n1b', 'n1c'],
    nhom2: ['n2a', 'n2b', 'n2c'],
    nhom3: ['n3a', 'n3b', 'n3c']
};

// =================================================================
// LỚP DỊCH VỤ CHÍNH
// =================================================================
class AdvancedPatternAnalysisService {
    constructor(lookbackDays = 100) {
        this.lookbackDays = lookbackDays; // AI sẽ nhìn lại 100 ngày
        this.historicalData = null; // Cache dữ liệu lịch sử
        this.learningModel = null;    // Mô hình AI để chấm điểm xu hướng
    }

    /**
     * Tải và chuẩn bị dữ liệu lịch sử
     */
    async prepareData(targetDateStr) {
        if (this.historicalData) return;
        console.log(`[AI Service] Đang chuẩn bị dữ liệu lịch sử ${this.lookbackDays} ngày...`);

        const allResults = await Result.find().lean();
        const grouped = {};
        allResults.forEach(r => {
            if (!grouped[r.ngay]) grouped[r.ngay] = [];
            grouped[r.ngay].push(r);
        });

        const sortedDays = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        const targetDateIndex = sortedDays.findIndex(d => d === targetDateStr);
        const effectiveLastDayIndex = targetDateIndex !== -1 ? targetDateIndex : sortedDays.length;
        
        const startIndex = Math.max(0, effectiveLastDayIndex - this.lookbackDays);
        const relevantDays = sortedDays.slice(startIndex, effectiveLastDayIndex);
        
        this.historicalData = {
            grouped,
            sortedDays: relevantDays
        };
        console.log(`[AI Service] Dữ liệu sẵn sàng với ${relevantDays.length} ngày.`);
    }

    /**
     * Hàm chính để tạo dự đoán cho một ngày
     */
    async generatePrediction(targetDateStr = null) {
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        await this.prepareData(targetDate);
        await this.buildOrLoadLearningModel();

        console.log(`[AI Service] Bắt đầu phân tích cho ngày ${targetDate}...`);
        
        // Phân tích song song cho cả 5 vị trí
        const positions = ['Hàng Vạn', 'Hàng Nghìn', 'Hàng Trăm', 'Hàng Chục', 'Hàng Đơn Vị'];
        const predictionPromises = positions.map((posName, posIndex) => 
            this.generatePredictionForPosition(posIndex, posName)
        );

        const [pos1, pos2, pos3, pos4, pos5] = await Promise.all(predictionPromises);

        const finalPrediction = {
            ngayDuDoan: targetDate,
            topVan: pos1.finalDigits,
            topNghin: pos2.finalDigits,
            topTram: pos3.finalDigits,
            topChuc: pos4.finalDigits,
            topDonVi: pos5.finalDigits,
            hotNumbers: {
                van: pos1.hotNumber,
                nghin: pos2.hotNumber,
                tram: pos3.hotNumber,
                chuc: pos4.hotNumber,
                donvi: pos5.hotNumber,
            },
            analysisData: { /* Thêm các chi tiết phân tích nếu cần */ },
            confidence: 75, // Có thể tính toán độ tin cậy sau
            createdAt: new Date()
        };

        // Lưu vào DB (sử dụng lại model TripleGroupPrediction)
        const saved = await TripleGroupPrediction.findOneAndUpdate(
            { ngayDuDoan: targetDate },
            { 
                ngayDuDoan: finalPrediction.ngayDuDoan,
                ngayPhanTich: DateTime.now().toFormat('dd/MM/yyyy'),
                // Ánh xạ lại tên trường cho phù hợp model
                topTram: finalPrediction.topTram,
                topChuc: finalPrediction.topChuc,
                topDonVi: finalPrediction.topDonVi,
                // Lưu thêm 2 vị trí mới vào analysisData
                analysisData: {
                    ...finalPrediction.analysisData,
                    topVan: finalPrediction.topVan,
                    topNghin: finalPrediction.topNghin,
                    hotNumbers: finalPrediction.hotNumbers
                },
                confidence: finalPrediction.confidence
            },
            { upsert: true, new: true }
        );

        return saved;
    }

    /**
     * Quy trình phân tích chi tiết cho một vị trí GĐB
     */
    async generatePredictionForPosition(posIndex, posName) {
        console.log(`\n--- [Vị trí: ${posName}] ---`);
        const rawHistory = this.getRawHistoryForPosition(posIndex);

        // 1. Phân tích và chọn số cho từng nhóm lớn
        const group1Digits = await this.analyzeLargeGroup('nhom1', rawHistory);
        const group2Digits = await this.analyzeLargeGroup('nhom2', rawHistory);
        const group3Digits = await this.analyzeLargeGroup('nhom3', rawHistory);

        // 2. Kết hợp kết quả từ 3 nhóm lớn
        const allDigits = [...group1Digits, ...group2Digits, ...group3Digits];
        const counts = allDigits.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {});
        let consolidatedDigits = Object.keys(counts).filter(d => counts[d] >= 2);
        console.log(`[${posName}] Kết hợp 3 nhóm (trùng >= 2 lần): [${consolidatedDigits.join(', ')}]`);

        // 3. Lọc bổ sung để còn 5 số
        let finalDigits = this.applyExclusionFilters(consolidatedDigits);
        console.log(`[${posName}] Sau khi lọc "gan": [${finalDigits.join(', ')}]`);

        // 4. Chọn số "hot" nhất
        let hotNumber = this.selectHotNumber(finalDigits);
        console.log(`[${posName}] Số "hot" nhất: ${hotNumber}`);
        
        return { finalDigits, hotNumber };
    }
    
    /**
     * Phân tích một nhóm lớn (bao gồm các nhóm nhỏ bên trong)
     */
    async analyzeLargeGroup(groupName, rawHistory) {
        const smallGroupNames = LARGE_GROUPS[groupName];
        let bestSmallGroups = [];

        // Dùng AI để chấm điểm và chọn nhóm nhỏ tốt nhất
        const smallGroupScores = await Promise.all(
            smallGroupNames.map(async (sgName) => {
                const trends = this.findTrendsForSmallGroup(sgName, rawHistory);
                const score = await this.scoreTrendsWithAI(trends);
                return { name: sgName, score, trends };
            })
        );
        
        smallGroupScores.sort((a, b) => b.score - a.score);
        console.log(`[${groupName}] Điểm các nhóm nhỏ: ${smallGroupScores.map(s => `${s.name}(${s.score.toFixed(2)})`).join(', ')}`);
        
        // Chọn ra các nhóm nhỏ có điểm cao nhất (ví dụ: điểm > 0.6)
        bestSmallGroups = smallGroupScores.filter(sg => sg.score > 0.6).map(sg => sg.name);
        if(bestSmallGroups.length === 0) {
            bestSmallGroups.push(smallGroupScores[0].name); // Luôn chọn ít nhất 1 nhóm
        }
        console.log(`[${groupName}] -> Chọn nhóm nhỏ: [${bestSmallGroups.join(', ')}]`);

        // Lấy và kết hợp các số từ các nhóm nhỏ được chọn
        const digitSets = bestSmallGroups.map(sgName => this.getDigitsInSmallGroup(sgName));
        let finalDigits = [...new Set(digitSets.flat())];

        // Áp dụng luật đặc biệt cho nhóm 3
        if (groupName === 'nhom3') {
            const allGroup3Digits = smallGroupNames.flatMap(sgName => this.getDigitsInSmallGroup(sgName));
            const counts = allGroup3Digits.reduce((acc, d) => { acc[d] = (acc[d] || 0) + 1; return acc; }, {});
            const excludedByCount = Object.keys(counts).filter(d => counts[d] >= 3);
            
            console.log(`[nhom3] Loại các số xuất hiện >= 3 lần: [${excludedByCount.join(', ')}]`);
            const keptByCount = Object.keys(counts).filter(d => counts[d] < 3);

            // Giao giữa 2 tập
            finalDigits = finalDigits.filter(d => keptByCount.includes(d));
        }
        
        console.log(`[${groupName}] Các số cuối cùng: [${finalDigits.join(', ')}]`);
        return finalDigits;
    }

    /**
     * Trích xuất lịch sử "ăn" của một vị trí GĐB
     */
    getRawHistoryForPosition(posIndex) {
        const history = [];
        const { grouped, sortedDays } = this.historicalData;

        for (let i = 1; i < sortedDays.length; i++) {
            const today = sortedDays[i];
            const yesterday = sortedDays[i - 1];
            const gdb = (grouped[today] || []).find(r => r.giai === 'ĐB');
            
            if (gdb?.so && String(gdb.so).length === 5) {
                const digitToFind = String(gdb.so)[posIndex];
                const hits = [];
                for (const result of (grouped[yesterday] || [])) {
                    const positions = [...String(result.so).matchAll(new RegExp(digitToFind, 'g'))].map(a => a.index + 1);
                    if (positions.length > 0) {
                        hits.push({ prize: result.giai, positions });
                    }
                }
                history.push({ date: today, digit: digitToFind, hits });
            }
        }
        return history.reverse(); // Gần nhất trước
    }

    /**
     * Tìm các chuỗi xu hướng cho một nhóm nhỏ
     */
    findTrendsForSmallGroup(smallGroupName, rawHistory) {
        // Đây là phần phức tạp, cần thuật toán để phát hiện "cầu"
        // Ví dụ đơn giản: đếm số lần nhóm này "ăn" trong 7 ngày gần nhất
        const trends = [];
        const prizesInGroup = SMALL_GROUPS[smallGroupName];
        let recentHits = 0;
        
        rawHistory.slice(0, 7).forEach(day => {
            if (day.hits.some(hit => prizesInGroup.includes(hit.prize))) {
                recentHits++;
            }
        });

        trends.push({ type: 'recency', value: recentHits / 7 }); // Feature 1: Tần suất gần đây
        
        // Thêm các logic phát hiện cầu chéo, cầu cách ngày... tại đây
        // Mỗi logic sẽ tạo ra một feature mới cho mô hình AI
        // Ví dụ:
        // trends.push({ type: 'diagonal_pattern_strength', value: 0.8 });
        // trends.push({ type: 'periodic_pattern_found', value: 1.0 });

        return trends;
    }

    /**
     * Dùng mô hình AI để chấm điểm các xu hướng
     */
    async scoreTrendsWithAI(trends) {
        if (!this.learningModel) return 0.5; // Chưa có model thì trả về điểm trung bình

        // 1. Chuyển đổi trends thành một vector feature
        // Đây là bước Kỹ thuật đặc trưng (Feature Engineering)
        const featureVector = [0, 0, 0, 0]; // Giả sử có 4 loại trend
        trends.forEach(trend => {
            if (trend.type === 'recency') featureVector[0] = trend.value;
            // map các loại trend khác vào vector
        });

        // 2. Dùng model để dự đoán
        const tensor = tf.tensor2d([featureVector]);
        const prediction = this.learningModel.predict(tensor);
        const score = (await prediction.data())[0];
        
        tensor.dispose();
        prediction.dispose();

        return score;
    }

    /**
     * Xây dựng hoặc tải mô hình AI. Đây là một mạng nơ-ron đơn giản.
     */
    async buildOrLoadLearningModel() {
        if (this.learningModel) return;

        // Trong thực tế, bạn sẽ lưu và tải model weights từ DB (ví dụ: trong TripleGroupLearningState)
        // Ở đây, chúng ta tạo một model mới mỗi lần chạy
        const model = tf.sequential();
        model.add(tf.layers.dense({ units: 8, inputShape: [4], activation: 'relu' })); // 4 features đầu vào
        model.add(tf.layers.dense({ units: 4, activation: 'relu' }));
        model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' })); // Output là điểm từ 0 đến 1

        model.compile({ optimizer: 'adam', loss: 'binaryCrossentropy' });
        
        this.learningModel = model;
        console.log("[AI Service] Mô hình học máy đã được tạo.");

        // TODO: Thêm logic huấn luyện model này với dữ liệu lịch sử
        // Dữ liệu huấn luyện sẽ là: (vector_feature_của_nhóm, target)
        // trong đó target = 1 nếu nhóm đó "ăn" vào ngày hôm sau, ngược lại target = 0
    }


    /**
     * Lấy các chữ số có trong một nhóm nhỏ
     */
    getDigitsInSmallGroup(smallGroupName) {
        const prizes = SMALL_GROUPS[smallGroupName];
        const { grouped, sortedDays } = this.historicalData;
        const lastDayResults = grouped[sortedDays[sortedDays.length - 1]] || [];
        
        const digits = new Set();
        prizes.forEach(prizeCode => {
            const result = lastDayResults.find(r => r.giai === prizeCode);
            if (result?.so) {
                String(result.so).split('').forEach(d => digits.add(d));
            }
        });
        return [...digits];
    }
    
    /**
     * Lọc loại trừ dựa trên các giải "gan"
     */
    applyExclusionFilters(digits) {
        // Logic này cần phân tích sâu hơn để tìm ra các giải "gan" một cách động
        // Tạm thời hardcode ví dụ
        const { grouped, sortedDays } = this.historicalData;
        const lastDayResults = grouped[sortedDays[sortedDays.length - 1]] || [];
        
        const g7b = lastDayResults.find(r => r.giai === 'G7b');
        let excluded = [];
        if (g7b?.so) {
            excluded = [...excluded, ...String(g7b.so).split('')];
        }

        let filtered = digits.filter(d => !excluded.includes(d));
        
        // Đảm bảo luôn trả về 5 số
        while(filtered.length < 5 && digits.length > filtered.length) {
            const digitToAdd = digits.find(d => !filtered.includes(d));
            if(digitToAdd) filtered.push(digitToAdd);
            else break;
        }

        return filtered.slice(0, 5);
    }
    
    /**
     * Chọn số hot nhất từ 5 số cuối cùng
     */
    selectHotNumber(finalDigits) {
        // Tương tự, logic này cần phân tích sâu hơn
        // Tạm thời chọn số đầu tiên
        return finalDigits[0] || null;
    }

    // --- Các hàm tiện ích ---
    dateKey(s) {
        if (!s || typeof s !== 'string') return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    async getNextPredictionDate() {
        const latestResult = await Result.findOne().sort({ ngay: -1 });
        if (!latestResult) return DateTime.now().plus({ days: 1 }).toFormat('dd/MM/yyyy');
        return DateTime.fromFormat(latestResult.ngay, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
    }
}

module.exports = AdvancedPatternAnalysisService;
