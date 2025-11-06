const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState'); // <-- IMPORT MỚI
const Result = require('../models/Result');

class TripleGroupAnalysisService {
    constructor() {
        this.learningState = null; // Biến để lưu "bộ nhớ" học tập, được tải khi cần.
    }

    // =================================================================
    // CÁC HÀM "HỌC" VÀ QUẢN LÝ "BỘ NHỚ" (CÁC CHỨC NĂNG MỚI)
    // =================================================================

    /**
     * Tải "kiến thức" (trạng thái học tập) từ CSDL vào bộ nhớ của service.
     * Nếu chưa có, sẽ tạo một bản ghi mới.
     */
    async loadLearningState() {
        // Chỉ tải một lần để tối ưu hiệu suất.
        if (this.learningState) {
            return;
        }
        
        console.log("🧠 [Service] Đang tải 'bộ nhớ' học tập...");
        let state = await TripleGroupLearningState.findOne({ modelName: 'TripleGroupV1' });
        
        if (!state) {
            console.log("...[Service] Chưa có 'bộ nhớ', tạo mới.");
            state = new TripleGroupLearningState();
            // Khởi tạo các mảng cho từng vị trí
            for (let i = 0; i < 10; i++) {
                const digit = i.toString();
                state.tram.push({ digit });
                state.chuc.push({ digit });
                state.donvi.push({ digit });
            }
            await state.save();
        }
        
        this.learningState = state;
        console.log(`✅ [Service] 'Bộ nhớ' đã sẵn sàng. Đã phân tích ${state.totalPredictionsAnalyzed} dự đoán.`);
    }

    /**
     * NÂNG CẤP: Quy trình "Học" thực sự.
     * Phân tích hiệu suất của tất cả các dự đoán trong quá khứ và LƯU LẠI "kiến thức" vào CSDL.
     * @returns {Promise<object>} - Thống kê về quá trình học.
     */
    async learnFromHistory() {
        console.log('🧠 [Service] Bắt đầu quy trình HỌC từ lịch sử dự đoán...');
        await this.loadLearningState();

        const { performance, totalAnalyzed } = await this.analyzeHistoricalPerformance();

        if (totalAnalyzed === 0) {
            console.log("...[Service] Không có dự đoán nào có kết quả để học.");
            return { updated: 0, total: 0 };
        }

        // Cập nhật "bộ nhớ" với kiến thức mới từ kết quả phân tích
        this.learningState.tram = this.formatPerformanceData(performance.tram);
        this.learningState.chuc = this.formatPerformanceData(performance.chuc);
        this.learningState.donvi = this.formatPerformanceData(performance.donvi);
        this.learningState.totalPredictionsAnalyzed = totalAnalyzed;
        this.learningState.lastLearnedAt = new Date();

        await this.learningState.save();
        console.log(`✅ [Service] Đã học và cập nhật 'bộ nhớ' thành công. Total analyzed: ${totalAnalyzed}`);
        return { updated: totalAnalyzed, total: totalAnalyzed };
    }

    // =================================================================
    // CÁC HÀM TẠO DỰ ĐOÁN (ĐÃ NÂNG CẤP ĐỂ SỬ DỤNG "KIẾN THỨC")
    // =================================================================

    /**
     * Hàm chính để tạo dự đoán mới, sẽ gọi hàm có học hỏi.
     */
    async generateTripleGroupPrediction(targetDateStr = null) {
        // Mặc định, hàm này sẽ gọi phiên bản có học hỏi để có kết quả tốt nhất.
        return this.generatePredictionWithLearning(targetDateStr);
    }
    
    /**
     * Tạo dự đoán cho ngày tiếp theo, có áp dụng "kiến thức" đã học.
     * @param {string|null} targetDateStr - Ngày dự đoán cụ thể.
     */
    async generatePredictionWithLearning(targetDateStr = null) {
        console.log('🎯 [Service] Bắt đầu tạo dự đoán CÓ HỌC HỎI...');
        await this.loadLearningState(); // Tải "bộ nhớ" trước khi dự đoán
        
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        console.log(`📅 [Service] Ngày mục tiêu dự đoán: ${targetDate}`);

        try {
            const resultsForAnalysis = await this.getResultsBeforeDate(targetDate, 100);
            const analysisResult = this.analyzeRealData(resultsForAnalysis);
            
            // ** THAY ĐỔI QUAN TRỌNG: Gọi hàm tạo dự đoán với tùy chọn useLearning = true **
            const prediction = this.createPredictionFromAnalysis(analysisResult, targetDate, true); 
            
            await this.savePrediction(prediction);
            console.log(`✅ [Service] Đã tạo dự đoán CÓ HỌC HỎI cho ngày ${targetDate}`);
            return prediction;

        } catch (error) {
            console.error(`❌ [Service] Lỗi nghiêm trọng khi tạo dự đoán có học hỏi cho ngày ${targetDate}:`, error);
            return this.getFallbackPrediction(targetDate);
        }
    }

    /**
     * Tạo dự đoán từ kết quả phân tích, có tùy chọn sử dụng "kiến thức" đã học.
     */
    createPredictionFromAnalysis(analysis, targetDate, useLearning = false) {
        let topTram, topChuc, topDonVi;

        // Nếu tùy chọn học được bật và "bộ nhớ" đã có dữ liệu
        if (useLearning && this.learningState && this.learningState.totalPredictionsAnalyzed > 0) {
            console.log("...[Service] Áp dụng kiến thức đã học (Tỷ lệ trúng) để chọn số.");
            topTram = this.selectNumbersByWeightedScore(analysis.frequency.tram, this.learningState.tram, 5);
            topChuc = this.selectNumbersByWeightedScore(analysis.frequency.chuc, this.learningState.chuc, 5);
            topDonVi = this.selectNumbersByWeightedScore(analysis.frequency.donvi, this.learningState.donvi, 5);
        } else {
            console.log("...[Service] Chỉ dùng tần suất thống kê thuần túy để chọn số.");
            topTram = this.selectNumbersByFrequency(analysis.frequency.tram, 5);
            topChuc = this.selectNumbersByFrequency(analysis.frequency.chuc, 5);
            topDonVi = this.selectNumbersByFrequency(analysis.frequency.donvi, 5);
        }

        return {
            ngayDuDoan: targetDate,
            ngayPhanTich: new Date().toISOString().split('T')[0],
            topTram,
            topChuc,
            topDonVi,
            analysisData: {
                totalDaysAnalyzed: analysis.totalDays,
                latestGDB: analysis.latestGDB,
                hotNumbers: analysis.trends.hotNumbers,
                coldNumbers: analysis.trends.coldNumbers
            },
            confidence: this.calculateConfidence(analysis, useLearning)
        };
    }
    
    // =================================================================
    // HÀM TẠO LỊCH SỬ DỰ ĐOÁN (Đã sửa lỗi)
    // =================================================================
    
    async generateHistoricalPredictions() {
        console.log('🕐 [Service] Bắt đầu quét và tạo lại TOÀN BỘ dự đoán lịch sử...');
        
        const allResults = await Result.find().sort({ ngay: 1 }).lean();
        if (allResults.length < 8) {
            throw new Error('Không đủ dữ liệu lịch sử (cần ít nhất 8 ngày).');
        }

        const groupedByDate = {};
        allResults.forEach(r => {
            if (!groupedByDate[r.ngay]) groupedByDate[r.ngay] = [];
            groupedByDate[r.ngay].push(r);
        });

        const sortedDates = Object.keys(groupedByDate).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        let createdCount = 0;
        const totalDaysToProcess = sortedDates.length - 7;
        console.log(`📝 [Service] Tổng số ngày có thể tạo dự đoán: ${totalDaysToProcess}`);

        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            
            try {
                const analysisDates = sortedDates.slice(i - 7, i);
                const analysisResults = analysisDates.flatMap(date => groupedByDate[date]);
                
                // Khi tạo lịch sử, chúng ta không dùng logic học, chỉ dùng thống kê thuần túy
                const analysis = this.analyzeRealData(analysisResults);
                const prediction = this.createPredictionFromAnalysis(analysis, targetDate, false);
                
                const actualGDB = (groupedByDate[targetDate] || []).find(r => r.giai === 'ĐB');
                if (actualGDB && actualGDB.so) {
                    const lastThree = String(actualGDB.so).padStart(5, '0').slice(-3);
                    if (lastThree.length === 3) {
                        prediction.actualResult = {
                            tram: lastThree[0],
                            chuc: lastThree[1],
                            donvi: lastThree[2],
                            isCorrect: this.checkCorrectness(prediction, lastThree),
                            updatedAt: new Date()
                        };
                    }
                }

                await this.savePrediction(prediction);
                createdCount++;
                if (createdCount % 20 === 0 || createdCount === totalDaysToProcess) { 
                    console.log(`...[Service] Đã tạo ${createdCount}/${totalDaysToProcess} dự đoán lịch sử (ngày gần nhất: ${targetDate})`);
                }
            } catch (error) {
                console.error(`❌ [Service] Lỗi khi tạo dự đoán lịch sử cho ngày ${targetDate}:`, error.message);
            }
        }

        console.log(`🎉 [Service] Hoàn thành! Đã tạo hoặc cập nhật ${createdCount} dự đoán lịch sử.`);
        return { created: createdCount, total: totalDaysToProcess };
    }

    // =================================================================
    // CÁC HÀM PHÂN TÍCH VÀ THỐNG KÊ
    // =================================================================
    
    analyzeRealData(results) {
        if (!results || results.length === 0) throw new Error('Không có dữ liệu kết quả để phân tích');
        const latestGDB = results.filter(r => r.giai === 'ĐB').sort((a, b) => this.dateKey(b.ngay).localeCompare(this.dateKey(a.ngay)))[0];
        
        return {
            totalDays: new Set(results.map(r => r.ngay)).size,
            latestGDB: latestGDB ? latestGDB.so : 'N/A',
            frequency: this.analyzeDigitFrequency(results),
            trends: this.analyzeTrends(results)
        };
    }

    analyzeDigitFrequency(results) {
        const frequency = { tram: Array(10).fill(0), chuc: Array(10).fill(0), donvi: Array(10).fill(0) };
        const gdbResults = results.filter(r => r.giai === 'ĐB' && r.so);
        
        gdbResults.forEach(result => {
            const lastThree = String(result.so).padStart(5, '0').slice(-3);
            if (lastThree.length === 3) {
                frequency.tram[parseInt(lastThree[0])]++;
                frequency.chuc[parseInt(lastThree[1])]++;
                frequency.donvi[parseInt(lastThree[2])]++;
            }
        });
        return frequency;
    }

    analyzeTrends(results) {
        const allGDB = results.filter(r => r.giai === 'ĐB').sort((a, b) => this.dateKey(b.ngay).localeCompare(this.dateKey(a.ngay))).slice(0, 30);
        if (allGDB.length === 0) return { hotNumbers: [], coldNumbers: [] };

        const digitCount = Array(10).fill(0);
        allGDB.forEach(result => {
            String(result.so).padStart(5, '0').split('').forEach(digit => {
                if (!isNaN(parseInt(digit))) {
                    digitCount[parseInt(digit)]++;
                }
            });
        });

        const sortedDigits = digitCount.map((count, digit) => ({ digit, count })).sort((a, b) => b.count - a.count);
        return {
            hotNumbers: sortedDigits.slice(0, 5).map(item => item.digit.toString()),
            coldNumbers: sortedDigits.slice(-5).reverse().map(item => item.digit.toString())
        };
    }
    
    async analyzeHistoricalPerformance() {
        console.log('📈 [Service] Phân tích hiệu suất lịch sử...');
        const predictionsWithResults = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } }).lean();
        
        if (predictionsWithResults.length < 10) {
            return {
                performance: {},
                totalAnalyzed: predictionsWithResults.length,
                message: `Không đủ dữ liệu để phân tích (hiện có ${predictionsWithResults.length}, cần ít nhất 10).`
            };
        }

        const performance = {
            tram: this.initializePositionStats(),
            chuc: this.initializePositionStats(),
            donvi: this.initializePositionStats()
        };
        for (const pred of predictionsWithResults) {
            const actual = pred.actualResult;
            this.updatePositionStats(performance.tram, pred.topTram || [], actual.tram);
            this.updatePositionStats(performance.chuc, pred.topChuc || [], actual.chuc);
            this.updatePositionStats(performance.donvi, pred.topDonVi || [], actual.donvi);
        }

        this.calculateFinalAccuracy(performance.tram);
        this.calculateFinalAccuracy(performance.chuc);
        this.calculateFinalAccuracy(performance.donvi);
        
        return {
            performance: performance,
            totalAnalyzed: predictionsWithResults.length
        };
    }

    // =================================================================
    // CÁC HÀM HELPER (HỖ TRỢ)
    // =================================================================
    
    selectNumbersByFrequency(frequencyArray, count) {
        return frequencyArray.map((freq, digit) => ({ digit: digit.toString(), freq })).sort((a, b) => b.freq - a.freq).slice(0, count).map(item => item.digit);
    }

    selectNumbersByWeightedScore(frequencyArray, learnedPerformance, count) {
        const WEIGHT_FREQUENCY = 0.4; // Trọng số cho tần suất
        const WEIGHT_ACCURACY = 0.6;  // Trọng số cho "thành tích" trong quá khứ

        const scores = [];
        for (let i = 0; i < 10; i++) {
            const digit = i.toString();
            const freqScore = frequencyArray[i] || 0;
            
            const learnedData = learnedPerformance.find(p => p.digit === digit);
            const accuracyScore = learnedData ? learnedData.accuracy : 0;
            
            const weightedScore = (freqScore * WEIGHT_FREQUENCY) + (accuracyScore * WEIGHT_ACCURACY);
            scores.push({ digit, score: weightedScore });
        }
        
        return scores.sort((a, b) => b.score - a.score).slice(0, count).map(item => item.digit);
    }

    calculateConfidence(analysis, useLearning = false) {
        let confidence = 50;
        if (analysis.totalDays >= 30) confidence += 10;
        if (analysis.totalDays >= 60) confidence += 5;
        if (analysis.trends.hotNumbers.length > 0) confidence += 5;
        // Tăng độ tin cậy nếu sử dụng chế độ học
        if (useLearning && this.learningState && this.learningState.totalPredictionsAnalyzed > 20) {
            confidence += 15;
        }
        return Math.min(confidence, 95);
    }

    async getNextPredictionDate() {
        console.log("...[Service] Đang xác định ngày dự đoán tiếp theo...");
        const allDates = await Result.distinct('ngay');
        if (allDates.length === 0) {
            throw new Error('Không có dữ liệu kết quả nào trong CSDL.');
        }

        const sortedDates = allDates
            .filter(d => d && d.split('/').length === 3)
            .sort((a, b) => {
                const dateA = new Date(a.split('/').reverse().join('-'));
                const dateB = new Date(b.split('/').reverse().join('-'));
                return dateB - dateA;
            });
        
        if (sortedDates.length === 0) {
            throw new Error('Không tìm thấy ngày hợp lệ nào để xác định ngày tiếp theo.');
        }

        const latestDateStr = sortedDates[0];
        console.log(`...[Service] Ngày kết quả gần nhất tìm thấy: ${latestDateStr}`);

        const [day, month, year] = latestDateStr.split('/').map(Number);
        const nextDate = new Date(year, month - 1, day + 1);
        
        return `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}/${nextDate.getFullYear()}`;
    }

    async getResultsBeforeDate(targetDate, limit) {
        const [day, month, year] = targetDate.split('/').map(Number);
        const targetDateObj = new Date(year, month - 1, day);
        const allDates = await Result.distinct('ngay');
        const sortedDates = allDates
            .map(d => ({ str: d, dateObj: new Date(d.split('/').reverse().join('-')) }))
            .filter(d => d.dateObj < targetDateObj)
            .sort((a, b) => b.dateObj - a.dateObj)
            .slice(0, limit)
            .map(d => d.str);
        if (sortedDates.length === 0) {
            throw new Error(`Không tìm thấy dữ liệu kết quả nào trước ngày ${targetDate}`);
        }
        return Result.find({ ngay: { $in: sortedDates } }).lean();
    }

    async savePrediction(predictionData) {
        if (!predictionData || !predictionData.ngayDuDoan) {
            throw new Error('Không thể lưu dự đoán vì thiếu dữ liệu hoặc thiếu ngày');
        }
        await TripleGroupPrediction.findOneAndUpdate(
            { ngayDuDoan: predictionData.ngayDuDoan },
            predictionData,
            { upsert: true, new: true }
        );
    }

    checkCorrectness(prediction, lastThree) {
        return Array.isArray(prediction.topTram) && prediction.topTram.includes(lastThree[0]) &&
               Array.isArray(prediction.topChuc) && prediction.topChuc.includes(lastThree[1]) &&
               Array.isArray(prediction.topDonVi) && prediction.topDonVi.includes(lastThree[2]);
    }
    
    getFallbackPrediction(targetDate) {
        console.warn(`⚠️ [Service] Sử dụng dự đoán dự phòng cho ngày ${targetDate}`);
        return {
            ngayDuDoan: targetDate,
            topTram: ['0','1','2','3','4'],
            topChuc: ['5','6','7','8','9'],
            topDonVi: ['0','2','4','6','8'],
            confidence: 20,
            analysisData: { message: "Fallback due to error" }
        };
    }

    dateKey(s) {
        if (!s || typeof s !== 'string') return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    initializePositionStats() {
        const stats = {};
        for (let i = 0; i < 10; i++) {
            stats[i.toString()] = { totalAppearances: 0, correctPicks: 0, accuracy: 0 };
        }
        return stats;
    }

    updatePositionStats(positionStats, predictedDigits, actualDigit) {
        if (!predictedDigits || !actualDigit) return;
        for (const digit of predictedDigits) {
            if (positionStats[digit]) {
                positionStats[digit].totalAppearances++;
                if (digit === actualDigit) {
                    positionStats[digit].correctPicks++;
                }
            }
        }
    }

    calculateFinalAccuracy(positionStats) {
        for (let i = 0; i < 10; i++) {
            const digit = i.toString();
            if (positionStats[digit].totalAppearances > 0) {
                positionStats[digit].accuracy = (positionStats[digit].correctPicks / positionStats[digit].totalAppearances) * 100;
            }
        }
    }
    
    formatPerformanceData(performanceObject) {
        return Object.keys(performanceObject).map(digit => ({
            digit: digit,
            totalAppearances: performanceObject[digit].totalAppearances,
            correctPicks: performanceObject[digit].correctPicks,
            accuracy: performanceObject[digit].accuracy
        }));
    }
}

module.exports = TripleGroupAnalysisService;
