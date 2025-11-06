const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState');
const Result = require('../models/Result');

class TripleGroupAnalysisService {
    constructor() {
        this.learningState = null; // Biến để lưu "bộ nhớ" học tập
    }

    // =================================================================
    // CÁC HÀM QUẢN LÝ "BỘ NHỚ" (LEARNING STATE)
    // =================================================================

    /**
     * Tải hoặc tạo mới "bộ nhớ" học tập.
     */
    async loadOrCreateLearningState() {
        if (this.learningState) return;
        
        console.log("🧠 [Service] Đang tải hoặc tạo 'bộ nhớ' học tập...");
        let state = await TripleGroupLearningState.findOne({ modelName: 'TripleGroupV1' });
        
        if (!state) {
            console.log("...[Service] Chưa có 'bộ nhớ', tạo mới.");
            state = new TripleGroupLearningState();
            for (let i = 0; i < 10; i++) {
                const digit = i.toString();
                state.tram.push({ digit });
                state.chuc.push({ digit });
                state.donvi.push({ digit });
            }
            await state.save();
        }
        
        this.learningState = state;
    }

    /**
     * Cập nhật "bộ nhớ" với kết quả của MỘT dự đoán duy nhất.
     * @param {object} prediction - Đối tượng dự đoán (chứa topTram, topChuc, ...).
     * @param {object} actualResult - Đối tượng kết quả thực tế (chứa tram, chuc, ...).
     */
    updateLearningStateWithSingleResult(prediction, actualResult) {
        if (!this.learningState || !prediction || !actualResult) return;

        const updatePosition = (positionKey, topPredicted, actualDigit) => {
            if (!Array.isArray(topPredicted)) return;
            
            topPredicted.forEach(digit => {
                const stat = this.learningState[positionKey].find(s => s.digit === digit);
                if (stat) {
                    stat.totalAppearances++;
                    if (digit === actualDigit) {
                        stat.correctPicks++;
                    }
                    stat.accuracy = (stat.correctPicks / stat.totalAppearances) * 100;
                }
            });
        };

        updatePosition('tram', prediction.topTram, actualResult.tram);
        updatePosition('chuc', prediction.topChuc, actualResult.chuc);
        updatePosition('donvi', prediction.topDonVi, actualResult.donvi);
        
        this.learningState.totalPredictionsAnalyzed = (this.learningState.totalPredictionsAnalyzed || 0) + 1;
    }

    // =================================================================
    // HÀM TẠO LỊCH SỬ DỰ ĐOÁN (ĐÃ NÂNG CẤP VỚI HỌC TUẦN TỰ)
    // =================================================================
    
    async generateHistoricalPredictions() {
        console.log('🕐 [Service] Bắt đầu quét và tạo lịch sử VỚI HỌC TUẦN TỰ...');
        
        // 1. Chuẩn bị dữ liệu và "bộ nhớ"
        await this.loadOrCreateLearningState(); // Tải "bộ nhớ"
        await TripleGroupLearningState.updateOne({ modelName: 'TripleGroupV1' }, { $set: this.getInitialState() }); // Reset "bộ nhớ" về 0
        await this.loadOrCreateLearningState(); // Tải lại "bộ nhớ" đã reset
        
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

        // 2. Vòng lặp học tuần tự
        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            
            try {
                // a. Lấy dữ liệu phân tích
                const analysisDates = sortedDates.slice(i - 7, i);
                const analysisResults = analysisDates.flatMap(date => groupedByDate[date]);
                const analysis = this.analyzeRealData(analysisResults);
                
                // b. DỰ ĐOÁN: Áp dụng "kiến thức" hiện có tại thời điểm đó
                const prediction = this.createPredictionFromAnalysis(analysis, targetDate, true);
                
                // c. Lấy kết quả thực tế
                const actualGDB = (groupedByDate[targetDate] || []).find(r => r.giai === 'ĐB');
                let actualResultObject = null;
                if (actualGDB && actualGDB.so) {
                    const lastThree = String(actualGDB.so).padStart(5, '0').slice(-3);
                    if (lastThree.length === 3) {
                        actualResultObject = {
                            tram: lastThree[0], chuc: lastThree[1], donvi: lastThree[2]
                        };
                        prediction.actualResult = {
                            ...actualResultObject,
                            isCorrect: this.checkCorrectness(prediction, lastThree),
                            updatedAt: new Date()
                        };
                    }
                }

                // d. Lưu lại dự đoán và kết quả
                await this.savePrediction(prediction);
                createdCount++;

                // e. HỌC HỎI: Cập nhật "bộ nhớ" ngay lập tức với kết quả vừa có
                if (actualResultObject) {
                    this.updateLearningStateWithSingleResult(prediction, actualResultObject);
                }

                if (createdCount % 20 === 0 || createdCount === totalDaysToProcess) { 
                    console.log(`...[Service] Đã tạo & học ${createdCount}/${totalDaysToProcess} (ngày ${targetDate})`);
                }

            } catch (error) {
                console.error(`❌ [Service] Lỗi khi tạo/học cho ngày ${targetDate}:`, error.message);
            }
        }
        
        // 3. Lưu lại "bộ nhớ" cuối cùng sau khi đã học hết lịch sử
        this.learningState.lastLearnedAt = new Date();
        await this.learningState.save();

        console.log(`🎉 [Service] Hoàn thành! Đã tạo và học tuần tự ${createdCount} dự đoán lịch sử.`);
        return { created: createdCount, total: totalDaysToProcess };
    }

    // =================================================================
    // CÁC HÀM TẠO DỰ ĐOÁN VÀ HỌC KHÁC
    // =================================================================

    async generatePredictionWithLearning(targetDateStr = null) {
        console.log('🎯 [Service] Bắt đầu tạo dự đoán CÓ HỌC HỎI cho ngày tiếp theo...');
        await this.loadOrCreateLearningState();
        
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        console.log(`📅 [Service] Ngày mục tiêu dự đoán: ${targetDate}`);

        try {
            const resultsForAnalysis = await this.getResultsBeforeDate(targetDate, 100);
            const analysisResult = this.analyzeRealData(resultsForAnalysis);
            const prediction = this.createPredictionFromAnalysis(analysisResult, targetDate, true); 
            
            await this.savePrediction(prediction);
            console.log(`✅ [Service] Đã tạo dự đoán CÓ HỌC HỎI cho ngày ${targetDate}`);
            return prediction;
        } catch (error) {
            console.error(`❌ [Service] Lỗi nghiêm trọng khi tạo dự đoán có học hỏi:`, error);
            return this.getFallbackPrediction(targetDate);
        }
    }
    
    async learnFromHistory() {
        console.log('🧠 [Service] Bắt đầu quy trình HỌC tổng hợp từ lịch sử...');
        await this.loadOrCreateLearningState();
        const { performance, totalAnalyzed } = await this.analyzeHistoricalPerformance();
        if (totalAnalyzed === 0) {
            console.log("...[Service] Không có dự đoán nào để học.");
            return { updated: 0, total: 0 };
        }
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
    // PHẦN CÒN LẠI CỦA FILE (GIỮ NGUYÊN)
    // =================================================================
    
    createPredictionFromAnalysis(analysis, targetDate, useLearning = false) {
        let topTram, topChuc, topDonVi;
        if (useLearning && this.learningState && this.learningState.totalPredictionsAnalyzed > 0) {
            console.log("...[Service] Áp dụng kiến thức đã học để chọn số.");
            topTram = this.selectNumbersByWeightedScore(analysis.frequency.tram, this.learningState.tram, 5);
            topChuc = this.selectNumbersByWeightedScore(analysis.frequency.chuc, this.learningState.chuc, 5);
            topDonVi = this.selectNumbersByWeightedScore(analysis.frequency.donvi, this.learningState.donvi, 5);
        } else {
            console.log("...[Service] Chỉ dùng tần suất thống kê để chọn số.");
            topTram = this.selectNumbersByFrequency(analysis.frequency.tram, 5);
            topChuc = this.selectNumbersByFrequency(analysis.frequency.chuc, 5);
            topDonVi = this.selectNumbersByFrequency(analysis.frequency.donvi, 5);
        }
        return {
            ngayDuDoan: targetDate,
            ngayPhanTich: new Date().toISOString().split('T')[0],
            topTram, topChuc, topDonVi,
            analysisData: {
                totalDaysAnalyzed: analysis.totalDays,
                latestGDB: analysis.latestGDB,
                hotNumbers: analysis.trends.hotNumbers,
                coldNumbers: analysis.trends.coldNumbers
            },
            confidence: this.calculateConfidence(analysis, useLearning)
        };
    }
    
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
        const predictionsWithResults = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } }).lean();
        if (predictionsWithResults.length < 10) {
            return { performance: {}, totalAnalyzed: predictionsWithResults.length };
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
    
    selectNumbersByFrequency(frequencyArray, count) {
        return frequencyArray.map((freq, digit) => ({ digit: digit.toString(), freq })).sort((a, b) => b.freq - a.freq).slice(0, count).map(item => item.digit);
    }

    selectNumbersByWeightedScore(frequencyArray, learnedPerformance, count) {
        const WEIGHT_FREQUENCY = 0.4;
        const WEIGHT_ACCURACY = 0.6;
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
        if (useLearning && this.learningState && this.learningState.totalPredictionsAnalyzed > 20) {
            confidence += 20;
        }
        return Math.min(confidence, 95);
    }

    async getNextPredictionDate() {
        const allDates = await Result.distinct('ngay');
        if (allDates.length === 0) throw new Error('Không có dữ liệu kết quả nào trong CSDL.');
        const sortedDates = allDates.filter(d => d && d.split('/').length === 3).sort((a, b) => new Date(b.split('/').reverse().join('-')) - new Date(a.split('/').reverse().join('-')));
        if (sortedDates.length === 0) throw new Error('Không tìm thấy ngày hợp lệ nào.');
        const latestDateStr = sortedDates[0];
        const [day, month, year] = latestDateStr.split('/').map(Number);
        const nextDate = new Date(year, month - 1, day + 1);
        return `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}/${nextDate.getFullYear()}`;
    }

    async getResultsBeforeDate(targetDate, limit) {
        const [day, month, year] = targetDate.split('/').map(Number);
        const targetDateObj = new Date(year, month - 1, day);
        const allDates = await Result.distinct('ngay');
        const sortedDates = allDates.map(d => ({ str: d, dateObj: new Date(d.split('/').reverse().join('-')) })).filter(d => d.dateObj < targetDateObj).sort((a, b) => b.dateObj - a.dateObj).slice(0, limit).map(d => d.str);
        if (sortedDates.length === 0) throw new Error(`Không tìm thấy dữ liệu kết quả nào trước ngày ${targetDate}`);
        return Result.find({ ngay: { $in: sortedDates } }).lean();
    }

    async savePrediction(predictionData) {
        if (!predictionData || !predictionData.ngayDuDoan) throw new Error('Không thể lưu dự đoán vì thiếu dữ liệu hoặc thiếu ngày');
        await TripleGroupPrediction.findOneAndUpdate({ ngayDuDoan: predictionData.ngayDuDoan }, predictionData, { upsert: true, new: true });
    }

    checkCorrectness(prediction, lastThree) {
        return Array.isArray(prediction.topTram) && prediction.topTram.includes(lastThree[0]) && Array.isArray(prediction.topChuc) && prediction.topChuc.includes(lastThree[1]) && Array.isArray(prediction.topDonVi) && prediction.topDonVi.includes(lastThree[2]);
    }
    
    getFallbackPrediction(targetDate) {
        return { ngayDuDoan: targetDate, topTram: ['0','1','2','3','4'], topChuc: ['5','6','7','8','9'], topDonVi: ['0','2','4','6','8'], confidence: 20, analysisData: { message: "Fallback due to error" } };
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

    getInitialState() {
        const initialState = {
            tram: [], chuc: [], donvi: [],
            totalPredictionsAnalyzed: 0,
            lastLearnedAt: new Date()
        };
        for (let i = 0; i < 10; i++) {
            const digit = i.toString();
            const initialStat = { digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 };
            initialState.tram.push(initialStat);
            initialState.chuc.push(initialStat);
            initialState.donvi.push(initialStat);
        }
        return initialState;
    }

    updatePositionStats(positionStats, predictedDigits, actualDigit) {
        if (!predictedDigits || !actualDigit) return;
        for (const digit of predictedDigits) {
            const stat = positionStats[digit.toString()];
            if (stat) {
                stat.totalAppearances++;
                if (digit === actualDigit) {
                    stat.correctPicks++;
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
