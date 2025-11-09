// file: services/tripleGroupAnalysisService.js
// PHIÊN BẢN HOÀN CHỈNH - ĐÃ SỬA LỖI VÀ NÂNG CẤP LOGIC

const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState');
const Result = require('../models/Result');
const { DateTime } = require('luxon');

// TIỆN ÍCH: Hàm tính Chẵn/Lẻ cho 3 số, được sử dụng ở nhiều nơi
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
    // LUỒNG DỰ ĐOÁN CHÍNH
    // =================================================================

    async generateTripleGroupPrediction(targetDateStr = null) {
        console.log("🎯 [Service] Bắt đầu tạo dự đoán Triple Group...");
        
        await this.loadOrCreateLearningState();
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        const cacheKey = `prediction_${targetDate}`;

        if (this.analysisCache.has(cacheKey)) {
            console.log(`🔄 [Service] Sử dụng cache cho ngày ${targetDate}`);
            return this.analysisCache.get(cacheKey);
        }

        try {
            const analysisData = await this.getDynamicAnalysisData(targetDate);
            if (!analysisData || analysisData.totalDays < 7) {
                console.warn("⚠️ [Service] Không đủ dữ liệu, sử dụng fallback");
                return this.getFallbackPrediction(targetDate);
            }

            const prediction = await this.createCombinedPrediction(analysisData, targetDate);
            const savedPrediction = await this.savePrediction(prediction);
            
            this.analysisCache.set(cacheKey, savedPrediction);
            console.log(`✅ [Service] Đã tạo dự đoán TỔNG HỢP cho ${targetDate}`);
            return savedPrediction;
            
        } catch (error) {
            console.error(`❌ [Service] Lỗi nghiêm trọng khi tạo dự đoán cho ${targetDate}:`, error);
            return this.getSmartFallbackPrediction(targetDate);
        }
    }

    async createCombinedPrediction(analysisData, targetDate) {
        console.log("🎲 [Service] Tạo dự đoán TỔNG HỢP (Combined)...");

        const finalPrediction = this.combineAndScorePredictions(analysisData);

        return {
            ngayDuDoan: targetDate,
            ngayPhanTich: DateTime.now().toFormat('dd/MM/yyyy'),
            topTram: finalPrediction.tram,
            topChuc: finalPrediction.chuc,
            topDonVi: finalPrediction.donvi,
            analysisData: {
                totalDaysAnalyzed: analysisData.totalDays,
                latestGDB: analysisData.latestGDB,
                analysisMethods: 3, // Tần suất, Học hỏi, Chẵn/Lẻ
                confidence: this.calculateDynamicConfidence(analysisData),
            },
            confidence: this.calculateDynamicConfidence(analysisData),
            predictionType: 'combined_analysis',
            createdAt: new Date()
        };
    }

    combineAndScorePredictions(analysisData) {
        const scores = {
            tram: Array(10).fill(0),
            chuc: Array(10).fill(0),
            donvi: Array(10).fill(0)
        };

        // --- Chiến lược 1: Phân tích tần suất (trọng số 1.5) ---
        const freqPred = this.selectByFrequency(analysisData.combined.frequency);
        if (freqPred) {
            if (Array.isArray(freqPred.tram)) freqPred.tram.forEach(d => { if(scores.tram[d] !== undefined) scores.tram[d] += 1.5; });
            if (Array.isArray(freqPred.chuc)) freqPred.chuc.forEach(d => { if(scores.chuc[d] !== undefined) scores.chuc[d] += 1.5; });
            if (Array.isArray(freqPred.donvi)) freqPred.donvi.forEach(d => { if(scores.donvi[d] !== undefined) scores.donvi[d] += 1.5; });
        }

        // --- Chiến lược 2: "Bộ não học hỏi" (trọng số 2.0) ---
        const learningPred = this.selectByLearning();
        if (learningPred) {
            if (Array.isArray(learningPred.tram)) learningPred.tram.forEach(d => { if(scores.tram[d] !== undefined) scores.tram[d] += 2.0; });
            if (Array.isArray(learningPred.chuc)) learningPred.chuc.forEach(d => { if(scores.chuc[d] !== undefined) scores.chuc[d] += 2.0; });
            if (Array.isArray(learningPred.donvi)) learningPred.donvi.forEach(d => { if(scores.donvi[d] !== undefined) scores.donvi[d] += 2.0; });
        }

        // --- Chiến lược 3: Phân tích mẫu hình Chẵn/Lẻ (trọng số 1.0) ---
        const lastGDBStr = String(analysisData.latestGDB);
        const lastDayPattern = (lastGDBStr.length >= 3) ? getChanLe(lastGDBStr.slice(-3)) : null;
        
        if (lastDayPattern && analysisData.combined.patterns?.evenOddTransitions?.[lastDayPattern]) {
            const nextPatterns = analysisData.combined.patterns.evenOddTransitions[lastDayPattern];
            const mostLikelyPattern = Object.entries(nextPatterns).sort((a, b) => b[1] - a[1])[0];
            
            if (mostLikelyPattern) {
                const [pattern, _] = mostLikelyPattern;
                if (pattern && pattern.length === 3) {
                    const [tramType, chucType, donviType] = pattern.split('');
                    for (let i = 0; i < 10; i++) {
                        if ((i % 2 === 1 && tramType === 'L') || (i % 2 === 0 && tramType === 'C')) scores.tram[i] += 1.0;
                        if ((i % 2 === 1 && chucType === 'L') || (i % 2 === 0 && chucType === 'C')) scores.chuc[i] += 1.0;
                        if ((i % 2 === 1 && donviType === 'L') || (i % 2 === 0 && donviType === 'C')) scores.donvi[i] += 1.0;
                    }
                }
            }
        }
        
        // --- Logic bổ sung: "Làm nguội" số vừa về ---
        if (lastGDBStr.length >= 3) {
            const lastThree = lastGDBStr.slice(-3);
            scores.tram[lastThree[0]] *= 0.5; // Giảm 50% điểm
            scores.chuc[lastThree[1]] *= 0.5;
            scores.donvi[lastThree[2]] *= 0.5;
        }
        
        const getTop5 = (scoreArray) => scoreArray
            .map((score, digit) => ({ digit: digit.toString(), score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, 5)
            .map(item => item.digit);

        return {
            tram: getTop5(scores.tram),
            chuc: getTop5(scores.chuc),
            donvi: getTop5(scores.donvi),
        };
    }
    
    // =================================================================
    // CÁC HÀM PHÂN TÍCH DỮ LIỆU
    // =================================================================

    async getDynamicAnalysisData(targetDate) {
        const results = await this.getResultsBeforeDate(targetDate, 90); // Lấy 90 ngày để phân tích sâu
        if (results.length === 0) throw new Error('Không có dữ liệu lịch sử để phân tích');

        return {
            combined: this.analyzeTrends(results),
            totalDays: new Set(results.map(r => r.ngay)).size,
            latestGDB: this.getLatestGDB(results)
        };
    }

    analyzeTrends(results) {
        if (!results || results.length === 0) return this.getDefaultTrends();
        
        const gdbResults = results.filter(r => r.giai === 'ĐB' && r.so)
                                .sort((a, b) => this.parseDateString(b.ngay) - this.parseDateString(a.ngay));

        if (gdbResults.length === 0) return this.getDefaultTrends();

        return {
            frequency: this.analyzeWeightedFrequency(gdbResults),
            patterns: {
                evenOddTransitions: this.analyzeEvenOddTransitions(gdbResults),
            },
            sampleSize: gdbResults.length
        };
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

    selectByLearning(count = 5) {
        if (!this.learningState || !this.learningState.totalPredictionsAnalyzed || this.learningState.totalPredictionsAnalyzed < 20) {
            return null;
        }
        const result = {};
        ['tram', 'chuc', 'donvi'].forEach(pos => {
            const stats = this.learningState[pos];
            if (!Array.isArray(stats)) {
                result[pos] = [];
                return;
            };
            const scoredNumbers = stats.map(stat => ({
                digit: stat.digit,
                score: (stat.accuracy || 0) * 1.5 + ((stat.correctPicks || 0) / (stat.totalAppearances || 1)) * 50
            })).sort((a, b) => b.score - a.score);
            result[pos] = scoredNumbers.slice(0, count).map(item => item.digit);
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

    async generatePredictionWithLearning(targetDateStr = null) {
        // Hàm này giờ đây là một bí danh cho hàm chính
        return this.generateTripleGroupPrediction(targetDateStr);
    }

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
            if (!finalResultCheck) continue; // Bỏ qua nếu ngày đó chưa có GĐB

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

    // =================================================================
    // CÁC HÀM HELPER VÀ SETUP
    // =================================================================
    
    async getResultsBeforeDate(targetDate, daysBack) {
        const targetDateObj = this.parseDateString(targetDate);
        if (!targetDateObj) throw new Error(`Định dạng ngày không hợp lệ: ${targetDate}`);

        const startDateObj = new Date(targetDateObj.getTime() - daysBack * 24 * 60 * 60 * 1000);
        
        // Tối ưu hóa: Query ngày tháng trong MongoDB hiệu quả hơn
        const allDates = await Result.distinct('ngay');
        const relevantDates = allDates.filter(d => {
            const dObj = this.parseDateString(d);
            return dObj && dObj < targetDateObj && dObj >= startDateObj;
        });

        if (relevantDates.length === 0) return [];
        return await Result.find({ ngay: { $in: relevantDates } }).lean();
    }

    parseDateString(dateStr) {
        if (!dateStr || typeof dateStr !== 'string') return null;
        try {
            const [day, month, year] = dateStr.split('/').map(Number);
            // Kiểm tra tính hợp lệ của ngày tháng năm
            if (isNaN(day) || isNaN(month) || isNaN(year) || year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) {
                return null;
            }
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
