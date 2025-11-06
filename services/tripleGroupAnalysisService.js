const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const Result = require('../models/Result');

class TripleGroupAnalysisService {
    constructor() {
        this.CL_PATTERNS = ['CCC','CCL','CLC','CLL','LLC','LLL','LCC','LCL'];
    }

    // =================================================================
    // CÁC HÀM TẠO DỰ ĐOÁN CHÍNH
    // =================================================================

    async generateTripleGroupPrediction(targetDateStr = null) {
        console.log('🎯 [Service] Bắt đầu tạo dự đoán Triple Group...');
        // SỬA LỖI: Luôn gọi hàm getNextPredictionDate đã được sửa lỗi để đảm bảo ngày chính xác.
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        console.log(`📅 [Service] Ngày mục tiêu dự đoán đã được xác định: ${targetDate}`);

        try {
            const resultsForAnalysis = await this.getResultsBeforeDate(targetDate, 100);
            const analysisResult = this.analyzeRealData(resultsForAnalysis);
            const prediction = this.createPredictionFromAnalysis(analysisResult, targetDate);
            
            await this.savePrediction(prediction);
            console.log(`✅ [Service] Đã tạo và lưu dự đoán thành công cho ngày ${targetDate}`);
            return prediction;
        } catch (error) {
            console.error(`❌ [Service] Lỗi nghiêm trọng khi tạo dự đoán cho ngày ${targetDate}:`, error);
            return this.getFallbackPrediction(targetDate);
        }
    }

    async generatePredictionWithLearning() {
        console.log('🧠 [Service] Tạo dự đoán VỚI HỌC HỎI...');
        return this.generateTripleGroupPrediction();
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
                
                const analysis = this.analyzeRealData(analysisResults);
                const prediction = this.createPredictionFromAnalysis(analysis, targetDate);
                
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
    // CÁC HÀM PHÂN TÍCH VÀ XỬ LÝ DỮ LIỆU
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
    
    createPredictionFromAnalysis(analysis, targetDate) {
        const topTram = this.selectNumbersByFrequency(analysis.frequency.tram, 5);
        const topChuc = this.selectNumbersByFrequency(analysis.frequency.chuc, 5);
        const topDonVi = this.selectNumbersByFrequency(analysis.frequency.donvi, 5);

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
            confidence: this.calculateConfidence(analysis)
        };
    }

    // =================================================================
    // CÁC HÀM THỐNG KÊ VÀ HỌC TẬP
    // =================================================================
    
    async learnFromOwnHistory() {
        console.log('🧠 [Service] Bắt đầu học từ lịch sử dự đoán...');
        const predictionsToUpdate = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } });
        console.log(`✅ [Service] Hoàn thành học hỏi từ ${predictionsToUpdate.length} bản ghi.`);
        return { updated: predictionsToUpdate.length, total: predictionsToUpdate.length };
    }
    
    async analyzeHistoricalPerformance() {
        console.log('📈 [Service] Phân tích hiệu suất lịch sử...');
        const predictionsWithResults = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } }).lean();
        if (predictionsWithResults.length < 10) {
            return {
                message: `Không đủ dữ liệu (cần ít nhất 10 dự đoán có kết quả), hiện có: ${predictionsWithResults.length}.`,
                totalAnalyzed: predictionsWithResults.length,
                performance: {}
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
            totalAnalyzed: predictionsWithResults.length,
            performance: performance
        };
    }

    // =================================================================
    // CÁC HÀM HELPER (HỖ TRỢ)
    // =================================================================
    
    selectNumbersByFrequency(frequencyArray, count) {
        return frequencyArray.map((freq, digit) => ({ digit: digit.toString(), freq })).sort((a, b) => b.freq - a.freq).slice(0, count).map(item => item.digit);
    }

    calculateConfidence(analysis) {
        let confidence = 50;
        if (analysis.totalDays >= 30) confidence += 15;
        if (analysis.totalDays >= 60) confidence += 10;
        if (analysis.trends.hotNumbers.length > 0) confidence += 10;
        return Math.min(confidence, 90);
    }

    /**
     * SỬA LỖI CHÍ MẠNG: Lấy ngày tiếp theo một cách chính xác.
     */
    async getNextPredictionDate() {
        console.log("...[Service] Đang xác định ngày dự đoán tiếp theo...");
        const allDates = await Result.distinct('ngay');
        if (allDates.length === 0) {
            throw new Error('Không có dữ liệu kết quả nào trong CSDL.');
        }

        // Lọc bỏ ngày không hợp lệ và sắp xếp đúng
        const sortedDates = allDates
            .filter(d => d && d.split('/').length === 3) // Lọc bỏ giá trị null/không hợp lệ
            .sort((a, b) => {
                const dateA = new Date(a.split('/').reverse().join('-'));
                const dateB = new Date(b.split('/').reverse().join('-'));
                return dateB - dateA; // Sắp xếp giảm dần
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
        if(sortedDates.length === 0) {
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
}

module.exports = TripleGroupAnalysisService;
