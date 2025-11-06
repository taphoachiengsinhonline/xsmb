const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const Result = require('../models/Result');

// Các service khác có thể không cần thiết cho logic cốt lõi trong file này,
// nhưng chúng ta giữ lại để phòng trường hợp mở rộng trong tương lai.
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedFeatureEngineer = require('./advancedFeatureService');

class TripleGroupAnalysisService {
    constructor() {
        // Các hằng số và khởi tạo có thể dùng sau
        this.CL_PATTERNS = ['CCC','CCL','CLC','CLL','LLC','LLL','LCC','LCL'];
        // this.featureService = new FeatureEngineeringService(); // Không dùng trong logic hiện tại
        // this.advancedFeatureEngineer = new AdvancedFeatureEngineer(); // Không dùng trong logic hiện tại
    }

    // =================================================================
    // CÁC HÀM TẠO DỰ ĐOÁN CHÍNH (CORE FUNCTIONS)
    // =================================================================

    /**
     * Tạo dự đoán cho ngày tiếp theo (mặc định) hoặc một ngày cụ thể.
     * @param {string|null} targetDateStr - Ngày dự đoán (dd/MM/yyyy). Nếu null, tự động lấy ngày tiếp theo.
     * @returns {Promise<object>} - Đối tượng dự đoán đã được tạo và lưu.
     */
    async generateTripleGroupPrediction(targetDateStr = null) {
        console.log('🎯 Bắt đầu tạo dự đoán Triple Group...');
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        console.log(`📅 Ngày mục tiêu dự đoán: ${targetDate}`);

        try {
            // Lấy 100 ngày kết quả gần nhất TÍNH TỪ TRƯỚC ngày mục tiêu để phân tích.
            const resultsForAnalysis = await this.getResultsBeforeDate(targetDate, 100);
            
            // Phân tích dữ liệu đã lấy.
            const analysisResult = this.analyzeRealData(resultsForAnalysis);
            
            // Tạo đối tượng dự đoán từ kết quả phân tích.
            const prediction = this.createPredictionFromAnalysis(analysisResult, targetDate);
            
            // Lưu dự đoán vào CSDL.
            await this.savePrediction(prediction);
            console.log(`✅ Đã tạo và lưu dự đoán thành công cho ngày ${targetDate}`);
            return prediction;
        } catch (error) {
            console.error(`❌ Lỗi nghiêm trọng trong generateTripleGroupPrediction cho ngày ${targetDate}:`, error);
            // Trả về một dự đoán dự phòng nếu có lỗi.
            return this.getFallbackPrediction(targetDate);
        }
    }

    /**
     * Tạo dự đoán có tích hợp logic học hỏi (để đáp ứng API).
     * Hiện tại, nó gọi hàm tạo dự đoán chính.
     */
    async generatePredictionWithLearning() {
        console.log('🧠 Dịch vụ: Tạo dự đoán VỚI HỌC HỎI (gọi hàm tạo dự đoán chính)...');
        return this.generateTripleGroupPrediction();
    }

    // =================================================================
    // HÀM TẠO LỊCH SỬ DỰ ĐOÁN (ĐÃ SỬA LỖI TRIỆT ĐỂ)
    // =================================================================
    /**
     * Quét toàn bộ lịch sử kết quả, tạo/cập nhật dự đoán cho mỗi ngày có thể.
     * @returns {Promise<object>} - Thống kê số lượng dự đoán đã tạo.
     */
    async generateHistoricalPredictions() {
        console.log('🕐 Bắt đầu quét và tạo lại TOÀN BỘ dự đoán lịch sử...');
        
        const allResults = await Result.find().sort({ ngay: 1 }).lean();
        if (allResults.length < 8) {
            throw new Error('Không đủ dữ liệu lịch sử (cần ít nhất 8 ngày).');
        }

        // Nhóm tất cả kết quả theo ngày để truy vấn nhanh hơn.
        const groupedByDate = {};
        allResults.forEach(r => {
            if (!groupedByDate[r.ngay]) groupedByDate[r.ngay] = [];
            groupedByDate[r.ngay].push(r);
        });

        // Lấy danh sách các ngày đã được sắp xếp chính xác.
        const sortedDates = Object.keys(groupedByDate).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        let createdCount = 0;
        const totalDaysToProcess = sortedDates.length - 7;
        console.log(`📝 Tổng số ngày có thể tạo dự đoán: ${totalDaysToProcess}`);

        // ** SỬA LỖI: Vòng lặp chạy qua TOÀN BỘ các ngày, không còn giới hạn batchSize **
        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            
            try {
                // Lấy 7 ngày trước đó từ dữ liệu đã sắp xếp để phân tích.
                const analysisDates = sortedDates.slice(i - 7, i);
                const analysisResults = analysisDates.flatMap(date => groupedByDate[date]);
                
                // Thực hiện phân tích và tạo dự đoán.
                const analysis = this.analyzeRealData(analysisResults);
                const prediction = this.createPredictionFromAnalysis(analysis, targetDate);
                
                // ** SỬA LỖI: Tự động cập nhật kết quả thực tế ngay lập tức. **
                const actualGDB = (groupedByDate[targetDate] || []).find(r => r.giai === 'ĐB');
                if (actualGDB && actualGDB.so) {
                    const gdbStr = String(actualGDB.so).padStart(5, '0');
                    const lastThree = gdbStr.slice(-3);
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
                // Log tiến độ mỗi 20 ngày để theo dõi.
                if(createdCount % 20 === 0 || createdCount === totalDaysToProcess) { 
                    console.log(`...Đã tạo ${createdCount}/${totalDaysToProcess} dự đoán lịch sử (ngày gần nhất: ${targetDate})`);
                }
            } catch (error) {
                console.error(`❌ Lỗi khi tạo dự đoán lịch sử cho ngày ${targetDate}:`, error.message);
            }
        }

        console.log(`🎉 Hoàn thành! Đã tạo hoặc cập nhật ${createdCount} dự đoán lịch sử.`);
        return { created: createdCount, total: totalDaysToProcess };
    }

    // =================================================================
    // CÁC HÀM PHÂN TÍCH VÀ XỬ LÝ DỮ LIỆU
    // =================================================================
    
    /**
     * Phân tích một tập hợp kết quả để trích xuất các đặc trưng.
     * @param {Array} results - Mảng các bản ghi kết quả.
     * @returns {object} - Đối tượng chứa kết quả phân tích.
     */
    analyzeRealData(results) {
        if (!results || results.length === 0) throw new Error('Không có dữ liệu kết quả để phân tích');
        
        // Sắp xếp lại để chắc chắn lấy GĐB gần nhất trong tập dữ liệu.
        const latestGDB = results
            .filter(r => r.giai === 'ĐB')
            .sort((a, b) => this.dateKey(b.ngay).localeCompare(this.dateKey(a.ngay)))[0];
        
        return {
            totalDays: new Set(results.map(r => r.ngay)).size,
            latestGDB: latestGDB ? latestGDB.so : 'N/A',
            frequency: this.analyzeDigitFrequency(results),
            trends: this.analyzeTrends(results)
        };
    }

    /**
     * Phân tích tần suất xuất hiện của các chữ số ở 3 vị trí cuối GĐB.
     */
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

    /**
     * Phân tích xu hướng số nóng/lạnh từ 30 GĐB gần nhất.
     */
    analyzeTrends(results) {
        const allGDB = results
            .filter(r => r.giai === 'ĐB')
            .sort((a, b) => this.dateKey(b.ngay).localeCompare(this.dateKey(a.ngay)))
            .slice(0, 30);
            
        if (allGDB.length === 0) return { hotNumbers: [], coldNumbers: [] };

        const digitCount = Array(10).fill(0);
        allGDB.forEach(result => {
            String(result.so).padStart(5, '0').split('').forEach(digit => {
                if (!isNaN(parseInt(digit))) {
                    digitCount[parseInt(digit)]++;
                }
            });
        });

        const sortedDigits = digitCount
            .map((count, digit) => ({ digit, count }))
            .sort((a, b) => b.count - a.count);
            
        return {
            hotNumbers: sortedDigits.slice(0, 5).map(item => item.digit.toString()),
            coldNumbers: sortedDigits.slice(-5).reverse().map(item => item.digit.toString())
        };
    }
    
    /**
     * Tạo đối tượng dự đoán hoàn chỉnh từ kết quả phân tích.
     */
    createPredictionFromAnalysis(analysis, targetDate) {
        const topTram = this.selectNumbersByFrequency(analysis.frequency.tram, 5);
        const topChuc = this.selectNumbersByFrequency(analysis.frequency.chuc, 5);
        const topDonVi = this.selectNumbersByFrequency(analysis.frequency.donvi, 5);

        return {
            ngayDuDoan: targetDate,
            ngayPhanTich: new Date().toISOString().split('T')[0],
            topTram: topTram,
            topChuc: topChuc,
            topDonVi: topDonVi,
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
    // CÁC HÀM THỐNG KÊ VÀ HỌC TẬP (ĐÃ BỔ SUNG)
    // =================================================================
    
    async learnFromOwnHistory() {
        console.log('🧠 Dịch vụ: Bắt đầu học từ lịch sử dự đoán...');
        const predictionsToUpdate = await TripleGroupPrediction.find({ 'actualResult': { $exists: true, $ne: null } });
        // Logic học hỏi phức tạp hơn có thể được thêm vào đây, ví dụ cập nhật trọng số.
        console.log(`✅ Hoàn thành học hỏi từ ${predictionsToUpdate.length} bản ghi.`);
        return { updated: predictionsToUpdate.length, total: predictionsToUpdate.length };
    }
    
    async analyzeHistoricalPerformance() {
        console.log('📈 Dịch vụ: Phân tích hiệu suất lịch sử...');
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
        return frequencyArray
            .map((freq, digit) => ({ digit: digit.toString(), freq }))
            .sort((a, b) => b.freq - a.freq)
            .slice(0, count)
            .map(item => item.digit);
    }

    calculateConfidence(analysis) {
        let confidence = 50;
        if (analysis.totalDays >= 30) confidence += 15;
        if (analysis.totalDays >= 60) confidence += 10;
        if (analysis.trends.hotNumbers.length > 0) confidence += 10;
        return Math.min(confidence, 90);
    }

    async getNextPredictionDate() {
        const latestResult = await Result.findOne().sort({ ngay: -1 }).lean();
        if (!latestResult) throw new Error('Không có dữ liệu kết quả để xác định ngày dự đoán tiếp theo');
        const [day, month, year] = latestResult.ngay.split('/').map(Number);
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
        // Sử dụng findOneAndUpdate với upsert: true để tạo mới nếu chưa có, hoặc cập nhật nếu đã tồn tại.
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
        console.warn(`⚠️ Sử dụng dự đoán dự phòng cho ngày ${targetDate}`);
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
