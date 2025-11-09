// file: services/tripleGroupAnalysisService.js
// PHIÊN BẢN ĐẠI TU - NĂNG ĐỘNG HƠN VÀ SỬA LỖI CACHE

const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState');
const Result = require('../models/Result');
const { DateTime } = require('luxon');

function getChanLe(numberStr) {
  if (!numberStr || String(numberStr).length !== 3) return '';
  return String(numberStr).split('').map(d => (parseInt(d, 10) % 2 === 0 ? 'C' : 'L')).join('');
}

class TripleGroupAnalysisService {
    constructor() {
        this.learningState = null;
        this.analysisCache = new Map();
    }

    // =================================================================
    // LUỒNG DỰ ĐOÁN CHÍNH - ĐÃ SỬA LỖI CACHE
    // =================================================================
    async generateTripleGroupPrediction(targetDateStr = null, forceRecalculate = false) {
        console.log(`🎯 [Service] Bắt đầu tạo dự đoán... Force recalculate: ${forceRecalculate}`);
        
        await this.loadOrCreateLearningState();
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        const cacheKey = `prediction_${targetDate}`;

        if (!forceRecalculate && this.analysisCache.has(cacheKey)) {
            console.log(`🔄 [Service] Sử dụng cache cho ngày ${targetDate}`);
            return this.analysisCache.get(cacheKey);
        }

        try {
            const analysisData = await this.getDynamicAnalysisData(targetDate);
            if (!analysisData || analysisData.totalDays < 15) { // Nâng yêu cầu dữ liệu lên 15 ngày
                console.warn("⚠️ [Service] Không đủ dữ liệu (cần >15 ngày), sử dụng fallback");
                return this.getFallbackPrediction(targetDate);
            }

            const prediction = await this.createCombinedPrediction(analysisData, targetDate);
            const savedPrediction = await this.savePrediction(prediction);
            
            this.analysisCache.set(cacheKey, savedPrediction);
            console.log(`✅ [Service] Đã tạo/cập nhật dự đoán TỔNG HỢP cho ${targetDate}`);
            return savedPrediction;
            
        } catch (error) {
            console.error(`❌ [Service] Lỗi nghiêm trọng khi tạo dự đoán cho ${targetDate}:`, error);
            return this.getSmartFallbackPrediction(targetDate);
        }
    }

    // =================================================================
    // NÂNG CẤP LỚN: "BỘ NÃO" MỚI VỚI HỆ THỐNG CHO ĐIỂM ĐA CHIỀU
    // =================================================================
    combineAndScorePredictions(analysisData) {
        const scores = { tram: Array(10).fill(0), chuc: Array(10).fill(0), donvi: Array(10).fill(0) };
        const WEIGHTS = { RECENT: 2.0, COMBINED: 1.0, LEARNING: 2.5, GAP: 1.8, EVEN_ODD: 1.2 };

        // --- 1. Phân tích Tần suất Ngắn hạn (7 ngày) - Rất quan trọng ---
        const recentFreq = analysisData.recent.frequency;
        for(let i=0; i<10; i++) {
            scores.tram[i] += (recentFreq.tram[i] || 0) * WEIGHTS.RECENT;
            scores.chuc[i] += (recentFreq.chuc[i] || 0) * WEIGHTS.RECENT;
            scores.donvi[i] += (recentFreq.donvi[i] || 0) * WEIGHTS.RECENT;
        }

        // --- 2. Phân tích Tần suất Dài hạn (90 ngày) ---
        const combinedFreq = analysisData.combined.frequency;
        for(let i=0; i<10; i++) {
            scores.tram[i] += (combinedFreq.tram[i] || 0) * WEIGHTS.COMBINED;
            scores.chuc[i] += (combinedFreq.chuc[i] || 0) * WEIGHTS.COMBINED;
            scores.donvi[i] += (combinedFreq.donvi[i] || 0) * WEIGHTS.COMBINED;
        }

        // --- 3. "Bộ não Học hỏi" - Quan trọng nhất ---
        const learningPred = this.selectByLearning(10); // Lấy tất cả các số đã được cho điểm
        if (learningPred) {
            learningPred.tram.forEach((item, index) => { if(scores.tram[item.digit] !== undefined) scores.tram[item.digit] += (10 - index) * 0.25 * WEIGHTS.LEARNING; });
            learningPred.chuc.forEach((item, index) => { if(scores.chuc[item.digit] !== undefined) scores.chuc[item.digit] += (10 - index) * 0.25 * WEIGHTS.LEARNING; });
            learningPred.donvi.forEach((item, index) => { if(scores.donvi[item.digit] !== undefined) scores.donvi[item.digit] += (10 - index) * 0.25 * WEIGHTS.LEARNING; });
        }

        // --- 4. NÂNG CẤP MỚI: Phân tích "Độ Gan" (Gap Analysis) ---
        const gapAnalysis = analysisData.gap;
        for(let i=0; i<10; i++) {
            // Điểm càng cao nếu số càng lâu chưa về
            scores.tram[i] += (gapAnalysis.tram[i] / analysisData.totalDays) * WEIGHTS.GAP;
            scores.chuc[i] += (gapAnalysis.chuc[i] / analysisData.totalDays) * WEIGHTS.GAP;
            scores.donvi[i] += (gapAnalysis.donvi[i] / analysisData.totalDays) * WEIGHTS.GAP;
        }

        // --- 5. Phân tích mẫu hình Chẵn/Lẻ ---
        // (Giữ nguyên logic cũ)
        
        // --- Logic bổ sung: "Làm nguội" số vừa về ---
        const lastGDBStr = String(analysisData.latestGDB);
        if (lastGDBStr.length >= 3) {
            const lastThree = lastGDBStr.slice(-3);
            scores.tram[lastThree[0]] *= 0.5;
            scores.chuc[lastThree[1]] *= 0.5;
            scores.donvi[lastThree[2]] *= 0.5;
        }
        
        const getTop5 = (scoreArray) => scoreArray
            .map((score, digit) => ({ digit: digit.toString(), score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(item => item.digit);

        return { tram: getTop5(scores.tram), chuc: getTop5(scores.chuc), donvi: getTop5(scores.donvi) };
    }

    // =================================================================
    // CÁC HÀM PHÂN TÍCH DỮ LIỆU - Bổ sung Gap Analysis
    // =================================================================

    async getDynamicAnalysisData(targetDate) {
        const results90Days = await this.getResultsBeforeDate(targetDate, 90);
        if (results90Days.length === 0) throw new Error('Không có dữ liệu lịch sử để phân tích');
        
        const results7Days = results90Days.filter(r => this.isWithinDays(r.ngay, targetDate, 7));
        const allGdb = results90Days.filter(r => r.giai === 'ĐB' && r.so)
                                    .sort((a, b) => this.parseDateString(b.ngay) - this.parseDateString(a.ngay));

        return {
            recent: this.analyzeTrends(results7Days, allGdb.slice(0, 7)),
            combined: this.analyzeTrends(results90Days, allGdb),
            gap: this.analyzeGap(allGdb), // NÂNG CẤP MỚI
            totalDays: new Set(results90Days.map(r => r.ngay)).size,
            latestGDB: this.getLatestGDB(results90Days)
        };
    }
    
    analyzeTrends(results, sortedGdbResults) {
        if (!results || results.length === 0) return this.getDefaultTrends();
        if (!sortedGdbResults || sortedGdbResults.length === 0) return this.getDefaultTrends();
        return {
            frequency: this.analyzeWeightedFrequency(sortedGdbResults),
            patterns: {
                evenOddTransitions: this.analyzeEvenOddTransitions(sortedGdbResults),
            },
            sampleSize: sortedGdbResults.length
        };
    }

    // NÂNG CẤP MỚI: Hàm phân tích độ gan
    analyzeGap(sortedGdbResults) {
        const gaps = { tram: Array(10).fill(sortedGdbResults.length), chuc: Array(10).fill(sortedGdbResults.length), donvi: Array(10).fill(sortedGdbResults.length) };
        const found = { tram: Array(10).fill(false), chuc: Array(10).fill(false), donvi: Array(10).fill(false) };

        sortedGdbResults.forEach((result, index) => {
            const lastThree = String(result.so).padStart(5, '0').slice(-3);
            if(lastThree.length === 3) {
                const [t, c, d] = lastThree.split('').map(Number);
                if (!found.tram[t]) { gaps.tram[t] = index; found.tram[t] = true; }
                if (!found.chuc[c]) { gaps.chuc[c] = index; found.chuc[c] = true; }
                if (!found.donvi[d]) { gaps.donvi[d] = index; found.donvi[d] = true; }
            }
        });
        return gaps;
    }


    analyzeWeightedFrequency(sortedGdbResults) {
        const frequency = { tram: Array(10).fill(0), chuc: Array(10).fill(0), donvi: Array(10).fill(0) };
        let totalWeight = 0;
        sortedGdbResults.forEach((result, index) => {
            const weight = Math.pow(0.97, index);
            totalWeight += weight;
            const lastThree = String(result.so).padStart(5, '0').slice(-3);
            if (lastThree.length === 3) {
                frequency.tram[parseInt(lastThree[0])] += weight;
                frequency.chuc[parseInt(lastThree[1])] += weight;
                frequency.donvi[parseInt(lastThree[2])] += weight;
            }
        });
        if (totalWeight > 0) {
            for (let i = 0; i < 10; i++) {
                frequency.tram[i] /= totalWeight;
                frequency.chuc[i] /= totalWeight;
                frequency.donvi[i] /= totalWeight;
            }
        }
        return frequency;
    }

    analyzeEvenOddTransitions(sortedGdbResults) {
        const transitions = {};
        for (let i = 0; i < sortedGdbResults.length - 1; i++) {
            const prevResult = sortedGdbResults[i + 1];
            const currentResult = sortedGdbResults[i];
            if (prevResult.chanle && currentResult.chanle) {
                if (!transitions[prevResult.chanle]) transitions[prevResult.chanle] = {};
                transitions[prevResult.chanle][currentResult.chanle] = (transitions[prevResult.chanle][currentResult.chanle] || 0) + 1;
            }
        }
        return transitions;
    }
    
    // =================================================================
    // CÁC HÀM CHỌN SỐ VÀ TIỆN ÍCH
    // =================================================================

    selectByFrequency(frequencyData) {
        if (!frequencyData) return null;
        const getTop = (arr, n) => arr.map((freq, digit) => ({ digit: digit.toString(), freq }))
                                     .sort((a, b) => b.freq - a.freq)
                                     .slice(0, n)
                                     .map(item => item.digit);
        return {
            tram: getTop(frequencyData.tram, 5),
            chuc: getTop(frequencyData.chuc, 5),
            donvi: getTop(frequencyData.donvi, 5)
        };
    }

    selectByLearning(count = 10) { // Lấy 10 để có thang điểm
        if (!this.learningState || !this.learningState.totalPredictionsAnalyzed || this.learningState.totalPredictionsAnalyzed < 20) {
            return null;
        }
        const result = {};
        ['tram', 'chuc', 'donvi'].forEach(pos => {
            const stats = this.learningState[pos];
            if (!Array.isArray(stats)) { result[pos] = []; return; };
            const scoredNumbers = stats.map(stat => ({
                digit: stat.digit,
                score: (stat.accuracy || 0) * 1.5 + ((stat.correctPicks || 0) / (stat.totalAppearances || 1)) * 50
            })).sort((a, b) => b.score - a.score);
            result[pos] = scoredNumbers.slice(0, count); // Trả về object có cả điểm
        });
        return result;
    }

    calculateDynamicConfidence(analysisData) {
        let confidence = 50.0;
        if (analysisData.totalDays >= 30) confidence += 15;
        if (analysisData.totalDays >= 60) confidence += 10;
        return Math.min(Math.round(confidence), 95);
    }
    
    // =================================================================
    // CHỨC NĂNG CHÍNH TỪ CONTROLLER
    // =================================================================

    async generateHistoricalPredictions() {
        console.log('🕐 [Service] Tạo dự đoán lịch sử (Tự động cập nhật)...');
        const allResults = await Result.find().lean();
        if (allResults.length < 8) throw new Error('Không đủ dữ liệu lịch sử (cần ít nhất 8 ngày)');

        const groupedByDate = {};
        allResults.forEach(r => {
            if (!groupedByDate[r.ngay]) groupedByDate[r.ngay] = [];
            groupedByDate[r.ngay].push(r);
        });
        const sortedDates = Object.keys(groupedByDate).sort((a, b) => this.parseDateString(a) - this.parseDateString(b));
        
        let createdCount = 0; let updatedCount = 0;
        const totalDaysToProcess = sortedDates.length - 7;

        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            const finalResultCheck = allResults.find(r => r.ngay === targetDate && r.giai === 'ĐB');
            if (!finalResultCheck) continue;

            try {
                const savedPrediction = await this.generateTripleGroupPrediction(targetDate);
                if (savedPrediction && !savedPrediction.isFallback) createdCount++;

                const gdbStr = String(finalResultCheck.so).padStart(5, '0');
                const lastThree = gdbStr.slice(-3);
                
                if (lastThree.length === 3 && savedPrediction?._id) {
                    const isCorrect = 
                        Array.isArray(savedPrediction.topTram) && savedPrediction.topTram.includes(lastThree[0]) &&
                        Array.isArray(savedPrediction.topChuc) && savedPrediction.topChuc.includes(lastThree[1]) &&
                        Array.isArray(savedPrediction.topDonVi) && savedPrediction.topDonVi.includes(lastThree[2]);

                    await TripleGroupPrediction.updateOne({ _id: savedPrediction._id }, {
                        $set: {
                            actualResult: {
                                tram: lastThree[0], chuc: lastThree[1], donvi: lastThree[2],
                                isCorrect: isCorrect, updatedAt: new Date()
                            }
                        }
                    });
                    updatedCount++;
                }
                if (createdCount > 0 && createdCount % 20 === 0) console.log(`...[Service] Đã xử lý ${createdCount}/${totalDaysToProcess} ngày...`);
            } catch (error) {
                console.error(`❌ [Service] Lỗi xử lý ngày ${targetDate}:`, error.message);
            }
        }
        console.log(`🎉 [Service] Hoàn thành! Đã tạo ${createdCount} và cập nhật ${updatedCount} dự đoán.`);
        return { created: createdCount, updated: updatedCount, total: totalDaysToProcess };
    }

    async learnFromHistory() {
        console.log('🧠 [Service] Học từ lịch sử...');
        await this.loadOrCreateLearningState();
        
        const { performance, totalAnalyzed } = await this.analyzeHistoricalPerformance();
        if (totalAnalyzed === 0) return { updated: 0, total: 0 };

        this.learningState.tram = this.formatPerformanceData(performance.tram);
        this.learningState.chuc = this.formatPerformanceData(performance.chuc);
        this.learningState.donvi = this.formatPerformanceData(performance.donvi);
        this.learningState.totalPredictionsAnalyzed = totalAnalyzed;
        this.learningState.lastLearnedAt = new Date();

        await this.learningState.save();
        console.log(`✅ [Service] Đã học từ ${totalAnalyzed} dự đoán`);
        return { updated: totalAnalyzed, total: totalAnalyzed };
    }

    async analyzeHistoricalPerformance() {
        const predictionsWithResults = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } }).lean();
        if (predictionsWithResults.length < 10) {
            console.warn(`[Service] Cần ít nhất 10 dự đoán có kết quả để học. Hiện có: ${predictionsWithResults.length}`);
            return { performance: {}, totalAnalyzed: predictionsWithResults.length };
        }

        const performance = {
            tram: this.initializePositionStats(),
            chuc: this.initializePositionStats(),
            donvi: this.initializePositionStats()
        };

        for (const pred of predictionsWithResults) {
            const actual = pred.actualResult;
            if(!actual) continue;
            this.updatePositionStats(performance.tram, pred.topTram, actual.tram);
            this.updatePositionStats(performance.chuc, pred.topChuc, actual.chuc);
            this.updatePositionStats(performance.donvi, pred.topDonVi, actual.donvi);
        }

        this.calculateFinalAccuracy(performance.tram);
        this.calculateFinalAccuracy(performance.chuc);
        this.calculateFinalAccuracy(performance.donvi);
        
        return { performance, totalAnalyzed: predictionsWithResults.length };
    }
    
    async getResultsBeforeDate(targetDate, daysBack) {
        const targetDateObj = this.parseDateString(targetDate);
        if (!targetDateObj) throw new Error(`Định dạng ngày không hợp lệ: ${targetDate}`);

        const startDateObj = new Date(targetDateObj.getTime() - (daysBack + 1) * 24 * 60 * 60 * 1000);
        
        const allDates = await Result.distinct('ngay');
        const relevantDates = allDates.filter(d => {
            const dObj = this.parseDateString(d);
            return dObj && dObj < targetDateObj && dObj >= startDateObj;
        });

        if (relevantDates.length === 0) return [];
        return await Result.find({ ngay: { $in: relevantDates } }).lean();
    }
    
    // =================================================================
    // CÁC HÀM HELPER, FALLBACK VÀ SETUP
    // =================================================================
    
    isWithinDays(dateStr, targetDateStr, days) {
        const dateObj = this.parseDateString(dateStr);
        const targetDateObj = this.parseDateString(targetDateStr);
        if(!dateObj || !targetDateObj) return false;
        const diffTime = targetDateObj - dateObj;
        const diffDays = diffTime / (1000 * 60 * 60 * 24);
        return diffDays > 0 && diffDays <= days;
    }
    
    parseDateString(dateStr) {
        if (!dateStr || typeof dateStr !== 'string') return null;
        try {
            const [day, month, year] = dateStr.split('/').map(Number);
            if (isNaN(day) || isNaN(month) || isNaN(year) || year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
            return new Date(year, month - 1, day);
        } catch (error) { return null; }
    }

    getLatestGDB(results) {
        const gdbResults = results.filter(r => r.giai === 'ĐB' && r.so);
        if (gdbResults.length === 0) return 'N/A';
        gdbResults.sort((a, b) => this.parseDateString(b.ngay) - this.parseDateString(a.ngay));
        return gdbResults[0].so;
    }

    async loadOrCreateLearningState() {
        if (this.learningState) return;
        try {
            let state = await TripleGroupLearningState.findOne({ modelName: 'TripleGroupV1' });
            if (!state) {
                console.log("🌱 [Service] Không tìm thấy learning state, đang tạo mới...");
                state = new TripleGroupLearningState();
                for (let i = 0; i < 10; i++) {
                    const digit = i.toString();
                    state.tram.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                    state.chuc.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                    state.donvi.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                }
                await state.save();
            }
            this.learningState = state;
        } catch (error) { console.error('❌ [Service] Lỗi nghiêm trọng khi load/create learning state:', error); }
    }

    async savePrediction(predictionData) {
        if (!predictionData?.ngayDuDoan) throw new Error('Thiếu ngày dự đoán');
        try {
            return await TripleGroupPrediction.findOneAndUpdate(
                { ngayDuDoan: predictionData.ngayDuDoan },
                predictionData,
                { upsert: true, new: true }
            );
        } catch (error) {
            console.error('❌ [Service] Lỗi lưu dự đoán:', error);
            throw error;
        }
    }

    async getNextPredictionDate() {
        try {
            const latestResult = await Result.findOne().sort({_id: -1}).limit(1).lean();
            const fallbackDate = DateTime.now().plus({ days: 1 }).toFormat('dd/MM/yyyy');
            if (!latestResult?.ngay) return fallbackDate;
            
            const latestDate = DateTime.fromFormat(latestResult.ngay, 'dd/MM/yyyy');
            if (!latestDate.isValid) return fallbackDate;

            return latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        } catch (error) {
            return DateTime.now().plus({ days: 1 }).toFormat('dd/MM/yyyy');
        }
    }

    initializePositionStats() {
        const stats = {};
        for (let i = 0; i < 10; i++) stats[i.toString()] = { totalAppearances: 0, correctPicks: 0, accuracy: 0 };
        return stats;
    }

    updatePositionStats(positionStats, predictedDigits, actualDigit) {
        if (!Array.isArray(predictedDigits) || !actualDigit) return;
        for (const digit of predictedDigits) {
            const stat = positionStats[digit.toString()];
            if (stat) {
                stat.totalAppearances++;
                if (digit === actualDigit) stat.correctPicks++;
            }
        }
    }

    calculateFinalAccuracy(positionStats) {
        for (let i = 0; i < 10; i++) {
            const stat = positionStats[i.toString()];
            if (stat && stat.totalAppearances > 0) {
                stat.accuracy = (stat.correctPicks / stat.totalAppearances) * 100;
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

    getDefaultTrends() {
        return {
            frequency: { tram: Array(10).fill(0.1), chuc: Array(10).fill(0.1), donvi: Array(10).fill(0.1) },
            patterns: { evenOddTransitions: {} },
            sampleSize: 0
        };
    }

    getFallbackPrediction(targetDate) {
        return {
            ngayDuDoan: targetDate,
            topTram: ['1','3','5','7','9'], topChuc: ['0','2','4','6','8'], topDonVi: ['2','4','6','8','0'],
            confidence: 20, analysisData: { message: "Fallback: Dữ liệu không đủ" }, isFallback: true
        };
    }
    
    getSmartFallbackPrediction(targetDate) {
        const day = parseInt(targetDate.split('/')[0]) || 1;
        const seed = day % 5;
        const sets = [
            [['1','3','5','7','9'], ['0','2','4','6','8'], ['2','4','6','8','0']],
            [['0','2','4','6','8'], ['1','3','5','7','9'], ['1','3','7','9','5']],
            [['2','3','4','5','6'], ['7','8','9','0','1'], ['0','1','8','9','2']],
            [['9','8','7','6','5'], ['4','3','2','1','0'], ['5','6','1','2','7']],
            [['1','2','7','8','9'], ['0','3','4','5','6'], ['0','5','6','7','8']]
        ];
        const selectedSet = sets[seed];
        return {
            ngayDuDoan: targetDate,
            topTram: selectedSet[0], topChuc: selectedSet[1], topDonVi: selectedSet[2],
            confidence: 30, analysisData: { message: "Smart Fallback: Lỗi hệ thống" }, isFallback: true
        };
    }
}

module.exports = TripleGroupAnalysisService;
