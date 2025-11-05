// services/tripleGroupAnalysisService.js
const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const Result = require('../models/Result');
const FeatureEngineeringService = require('./featureEngineeringService');
const AdvancedFeatureEngineer = require('./advancedFeatureService');

class TripleGroupAnalysisService {
    constructor() {
        this.CL_PATTERNS = ['CCC','CCL','CLC','CLL','LLC','LLL','LCC','LCL'];
        this.featureService = new FeatureEngineeringService();
        this.advancedFeatureEngineer = new AdvancedFeatureEngineer();
    }

    /**
     * SỬA LỖI: Tạo dự đoán với ngày xác định
     */
    async generateTripleGroupPrediction(targetDate = null) {
        console.log('🎯 Bắt đầu tạo dự đoán Triple Group...');
        
        try {
            // XÁC ĐỊNH NGÀY DỰ ĐOÁN - SỬA LỖI UNDEFINED
            if (!targetDate) {
                targetDate = await this.getNextPredictionDate();
                console.log(`📅 Đã xác định ngày dự đoán: ${targetDate}`);
            }

            // SỬA LỖI: Phân tích dữ liệu thực tế, không phải tạo số liệu ảo
            const analysisResult = await this.analyzeRealData();
            
            // Tạo dự đoán từ dữ liệu thực
            const prediction = this.createPredictionFromAnalysis(analysisResult, targetDate);
            
            // Lưu dự đoán
            await this.savePrediction(prediction);
            
            console.log(`✅ Đã tạo dự đoán cho ${targetDate}`);
            return prediction;
            
        } catch (error) {
            console.error('❌ Lỗi trong generateTripleGroupPrediction:', error);
            return this.getFallbackPrediction(targetDate);
        }
    }

    /**
     * SỬA LỖI: Phân tích dữ liệu THỰC TẾ từ database
     */
    async analyzeRealData() {
        console.log('🔍 Phân tích dữ liệu thực tế...');
        
        const results = await Result.find().sort({ ngay: -1 }).limit(100).lean();
        if (results.length === 0) {
            throw new Error('Không có dữ liệu kết quả');
        }

        // Phân tích GĐB gần nhất
        const latestGDB = results.find(r => r.giai === 'ĐB');
        if (!latestGDB) {
            throw new Error('Không tìm thấy giải ĐB');
        }

        // Phân tích pattern từ 7 ngày gần nhất
        const analysis = {
            totalDays: results.length,
            latestGDB: latestGDB.so,
            patterns: await this.analyzeRecentPatterns(results),
            frequency: this.analyzeDigitFrequency(results),
            trends: this.analyzeTrends(results)
        };

        console.log(`📊 Phân tích: ${analysis.totalDays} ngày, GĐB mới nhất: ${analysis.latestGDB}`);
        return analysis;
    }

    /**
     * Phân tích pattern từ 7 ngày gần nhất
     */
    async analyzeRecentPatterns(results) {
        const recentDays = results.slice(0, 7); // 7 ngày gần nhất
        const patterns = [];

        for (const day of recentDays) {
            const dayResults = results.filter(r => r.ngay === day.ngay);
            const pattern = this.analyzeDayPattern(dayResults);
            patterns.push(pattern);
        }

        return patterns;
    }

    /**
     * Phân tích pattern của 1 ngày
     */
    analyzeDayPattern(dayResults) {
        const pattern = {
            date: dayResults[0]?.ngay,
            prizes: [],
            chanLeCount: { C: 0, L: 0 }
        };

        dayResults.forEach(result => {
            if (result.chanle && result.chanle.length === 3) {
                const clPattern = result.chanle;
                pattern.prizes.push({
                    giai: result.giai,
                    so: result.so,
                    chanle: clPattern
                });

                // Đếm chẵn lẻ
                clPattern.split('').forEach(char => {
                    if (char === 'C') pattern.chanLeCount.C++;
                    if (char === 'L') pattern.chanLeCount.L++;
                });
            }
        });

        return pattern;
    }

    /**
     * Phân tích tần suất số
     */
    analyzeDigitFrequency(results) {
        const frequency = {
            tram: Array(10).fill(0),
            chuc: Array(10).fill(0),
            donvi: Array(10).fill(0)
        };

        results.forEach(result => {
            if (result.so && result.giai === 'ĐB') {
                const numStr = String(result.so).padStart(5, '0');
                const lastThree = numStr.slice(-3);
                
                if (lastThree.length === 3) {
                    frequency.tram[parseInt(lastThree[0])]++;
                    frequency.chuc[parseInt(lastThree[1])]++;
                    frequency.donvi[parseInt(lastThree[2])]++;
                }
            }
        });

        return frequency;
    }

    /**
     * Phân tích xu hướng
     */
    analyzeTrends(results) {
        const trends = {
            consecutiveDays: 0,
            hotNumbers: [],
            coldNumbers: []
        };

        // Phân tích số nóng/lạnh
        const allGDB = results.filter(r => r.giai === 'ĐB').slice(0, 30); // 30 ngày gần nhất
        
        if (allGDB.length > 0) {
            const digitCount = Array(10).fill(0);
            allGDB.forEach(result => {
                const numStr = String(result.so).padStart(5, '0');
                numStr.split('').forEach(digit => {
                    digitCount[parseInt(digit)]++;
                });
            });

            // Số nóng (xuất hiện nhiều)
            trends.hotNumbers = digitCount
                .map((count, digit) => ({ digit, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 5)
                .map(item => item.digit);

            // Số lạnh (xuất hiện ít)
            trends.coldNumbers = digitCount
                .map((count, digit) => ({ digit, count }))
                .sort((a, b) => a.count - b.count)
                .slice(0, 5)
                .map(item => item.digit);
        }

        return trends;
    }

    /**
     * Tạo dự đoán từ phân tích
     */
    createPredictionFromAnalysis(analysis, targetDate) {
        // Dựa trên phân tích thực tế để tạo dự đoán
        const frequency = analysis.frequency;
        
        // Chọn số dựa trên tần suất và xu hướng
        const topTram = this.selectNumbersByFrequency(frequency.tram, 5);
        const topChuc = this.selectNumbersByFrequency(frequency.chuc, 5);
        const topDonVi = this.selectNumbersByFrequency(frequency.donvi, 5);

        const prediction = {
            method: 'TRIPLE_GROUP_ANALYSIS',
            topTram: topTram,
            topChuc: topChuc,
            topDonVi: topDonVi,
            ngayDuDoan: targetDate,
            ngayPhanTich: new Date().toISOString().split('T')[0],
            analysis: {
                totalDaysAnalyzed: analysis.totalDays,
                latestGDB: analysis.latestGDB,
                hotNumbers: analysis.trends.hotNumbers,
                coldNumbers: analysis.trends.coldNumbers,
                confidence: this.calculateConfidence(analysis)
            },
            createdAt: new Date()
        };

        console.log(`🎯 Dự đoán: Trăm=${topTram}, Chục=${topChuc}, ĐV=${topDonVi}`);
        return prediction;
    }

    /**
     * Chọn số dựa trên tần suất
     */
    selectNumbersByFrequency(frequencyArray, count) {
        return frequencyArray
            .map((freq, digit) => ({ digit: digit.toString(), freq }))
            .sort((a, b) => b.freq - a.freq)
            .slice(0, count)
            .map(item => item.digit);
    }

    /**
     * Tính độ tin cậy
     */
    calculateConfidence(analysis) {
        let confidence = 50; // Mặc định
        
        // Tăng độ tin cậy nếu có nhiều dữ liệu
        if (analysis.totalDays > 50) confidence += 20;
        if (analysis.totalDays > 100) confidence += 10;
        
        // Tăng độ tin cậy nếu có xu hướng rõ ràng
        if (analysis.trends.hotNumbers.length > 0) confidence += 10;
        
        return Math.min(confidence, 85); // Max 85%
    }

    /**
     * Lấy ngày dự đoán tiếp theo - SỬA LỖI UNDEFINED
     */
    async getNextPredictionDate() {
        const latestResult = await Result.findOne().sort({ ngay: -1 }).lean();
        if (!latestResult) {
            throw new Error('Không có dữ liệu để xác định ngày dự đoán');
        }

        const latestDate = latestResult.ngay;
        const [day, month, year] = latestDate.split('/').map(Number);
        const nextDate = new Date(year, month - 1, day + 1);
        
        const nextDay = String(nextDate.getDate()).padStart(2, '0');
        const nextMonth = String(nextDate.getMonth() + 1).padStart(2, '0');
        const nextYear = nextDate.getFullYear();

        return `${nextDay}/${nextMonth}/${nextYear}`;
    }

    /**
     * SỬA LỖI: Lưu dự đoán với kiểm tra
     */
    async savePrediction(predictionData) {
        try {
            // KIỂM TRA DỮ LIỆU TRƯỚC KHI LƯU
            if (!predictionData.ngayDuDoan) {
                throw new Error('Thiếu ngày dự đoán');
            }

            const predictionRecord = {
                ngayDuDoan: predictionData.ngayDuDoan,
                ngayPhanTich: predictionData.ngayPhanTich || new Date().toISOString().split('T')[0],
                topTram: predictionData.topTram || [],
                topChuc: predictionData.topChuc || [],
                topDonVi: predictionData.topDonVi || [],
                analysisData: predictionData.analysis || {},
                confidence: predictionData.analysis?.confidence || 50
            };

            await TripleGroupPrediction.findOneAndUpdate(
                { ngayDuDoan: predictionData.ngayDuDoan },
                predictionRecord,
                { upsert: true, new: true }
            );

            console.log(`💾 Đã lưu dự đoán Triple Group cho ngày ${predictionData.ngayDuDoan}`);
        } catch (error) {
            console.error('❌ Lỗi khi save prediction:', error);
            throw error;
        }
    }

    /**
     * Dự phòng
     */
    getFallbackPrediction(targetDate) {
        console.warn('⚠️ Sử dụng dự đoán dự phòng');
        return {
            method: 'TRIPLE_GROUP_FALLBACK',
            topTram: ['0','1','2','3','4'],
            topChuc: ['5','6','7','8','9'],
            topDonVi: ['0','2','4','6','8'],
            ngayDuDoan: targetDate || new Date().toISOString().split('T')[0],
            ngayPhanTich: new Date().toISOString().split('T')[0],
            analysis: {
                totalDaysAnalyzed: 0,
                latestGDB: '00000',
                hotNumbers: [],
                coldNumbers: [],
                confidence: 30
            },
            createdAt: new Date()
        };
    }

    /**
     * SỬA LỖI: Tạo dự đoán lịch sử - ĐƠN GIẢN HÓA
     */
    async generateHistoricalPredictions() {
        console.log('🕐 Bắt đầu tạo dự đoán lịch sử...');
        
        const results = await Result.find().sort({ ngay: 1 }).lean();
        if (results.length < 8) { // Cần ít nhất 7 ngày để phân tích + 1 ngày để dự đoán
            throw new Error('Không đủ dữ liệu lịch sử');
        }

        const grouped = {};
        results.forEach(r => {
            if (!grouped[r.ngay]) grouped[r.ngay] = [];
            grouped[r.ngay].push(r);
        });

        const dates = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        let createdCount = 0;
        const batchSize = 50; // Giới hạn để tránh quá tải

        // Bắt đầu từ ngày thứ 8 (sau 7 ngày đầu)
        for (let i = 7; i < Math.min(dates.length, batchSize + 7); i++) {
            const targetDate = dates[i];
            
            // Kiểm tra xem đã có dự đoán chưa
            const existing = await TripleGroupPrediction.findOne({ ngayDuDoan: targetDate });
            if (existing) {
                console.log(`⏩ Đã có dự đoán cho ${targetDate}`);
                continue;
            }

            try {
                // Lấy 7 ngày trước đó để phân tích
                const analysisDates = dates.slice(i - 7, i);
                const analysisResults = analysisDates.map(date => grouped[date]).flat();
                
                // Phân tích đơn giản
                const analysis = await this.analyzeRealDataSpecific(analysisResults);
                const prediction = this.createPredictionFromAnalysis(analysis, targetDate);
                
                // CẬP NHẬT KẾT QUẢ THỰC TẾ NGAY LẬP TỨC
                const actualGDB = (grouped[targetDate] || []).find(r => r.giai === 'ĐB');
                if (actualGDB?.so) {
                    const gdbStr = String(actualGDB.so).padStart(5, '0');
                    const lastThree = gdbStr.slice(-3);
                    if (lastThree.length === 3) {
                        prediction.actualResult = {
                            tram: lastThree[0],
                            chuc: lastThree[1],
                            donvi: lastThree[2],
                            isCorrect: prediction.topTram.includes(lastThree[0]) && 
                                      prediction.topChuc.includes(lastThree[1]) && 
                                      prediction.topDonVi.includes(lastThree[2])
                        };
                    }
                }

                await this.savePrediction(prediction);
                createdCount++;
                console.log(`✅ Đã tạo dự đoán lịch sử ${createdCount}: ${targetDate}`);
                
            } catch (error) {
                console.error(`❌ Lỗi tạo dự đoán cho ${targetDate}:`, error.message);
            }
        }

        console.log(`🎉 Hoàn thành! Đã tạo ${createdCount} dự đoán lịch sử`);
        return { created: createdCount, total: Math.min(dates.length - 7, batchSize) };
    }

    /**
     * Phân tích dữ liệu cụ thể
     */
    async analyzeRealDataSpecific(results) {
        const analysis = {
            totalDays: results.length,
            latestGDB: '00000',
            patterns: [],
            frequency: this.analyzeDigitFrequency(results),
            trends: this.analyzeTrends(results)
        };

        // Tìm GĐB gần nhất
        const latestGDB = results.find(r => r.giai === 'ĐB');
        if (latestGDB) {
            analysis.latestGDB = String(latestGDB.so).padStart(5, '0');
        }

        return analysis;
    }

    dateKey(s) {
        if (!s || typeof s !== 'string') return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }
}

module.exports = TripleGroupAnalysisService;
