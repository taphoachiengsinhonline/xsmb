const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const TripleGroupLearningState = require('../models/TripleGroupLearningState');
const Result = require('../models/Result');
const { DateTime } = require('luxon');

class TripleGroupAnalysisService {
    constructor() {
        this.learningState = null;
        this.analysisCache = new Map(); // Cache để tránh phân tích trùng lặp
    }

    // =================================================================
    // HÀM CHÍNH ĐÃ ĐƯỢC SỬA LỖI - TẠO DỰ ĐOÁN THÔNG MINH
    // =================================================================
    async generateTripleGroupPrediction(targetDateStr = null) {
        console.log("🎯 [Service] Bắt đầu tạo dự đoán Triple Group THÔNG MINH...");
        
        await this.loadOrCreateLearningState();
        const targetDate = targetDateStr || await this.getNextPredictionDate();
        console.log(`📅 [Service] Ngày mục tiêu: ${targetDate}`);

        // Kiểm tra cache để tránh phân tích trùng lặp
        const cacheKey = `prediction_${targetDate}`;
        if (this.analysisCache.has(cacheKey)) {
            console.log("🔄 [Service] Sử dụng kết quả từ cache");
            return this.analysisCache.get(cacheKey);
        }

        try {
            // Lấy dữ liệu 60 ngày gần nhất với các mốc thời gian khác nhau
            const analysisData = await this.getDynamicAnalysisData(targetDate);
            
            if (!analysisData || analysisData.totalDays < 7) {
                console.warn("⚠️ [Service] Không đủ dữ liệu, sử dụng fallback");
                return this.getFallbackPrediction(targetDate);
            }

            // Tạo dự đoán với độ đa dạng cao
            const prediction = await this.createDiversePrediction(analysisData, targetDate);
            
            // SỬA LỖI Ở ĐÂY: Lưu kết quả trả về từ savePrediction
            const savedPrediction = await this.savePrediction(prediction);
            
            this.analysisCache.set(cacheKey, savedPrediction);
            
            console.log(`✅ [Service] Đã tạo dự đoán ĐA DẠNG cho ${targetDate}`);
            
            // Trả về document đã được lưu vào DB (có _id)
            return savedPrediction;
            
        } catch (error) {
            console.error(`❌ [Service] Lỗi tạo dự đoán:`, error);
            return this.getSmartFallbackPrediction(targetDate);
        }
    }

    // =================================================================
    // PHÂN TÍCH DỮ LIỆU ĐỘNG - SỬA LỖI QUAN TRỌNG
    // =================================================================
    async getDynamicAnalysisData(targetDate) {
        console.log("📊 [Service] Phân tích dữ liệu ĐỘNG...");
        
        // Lấy dữ liệu từ nhiều khoảng thời gian khác nhau
        const [recentData, weeklyData, monthlyData] = await Promise.all([
            this.getResultsBeforeDate(targetDate, 7),   // 7 ngày gần nhất
            this.getResultsBeforeDate(targetDate, 30),  // 30 ngày gần nhất  
            this.getResultsBeforeDate(targetDate, 60)   // 60 ngày gần nhất
        ]);

        // Kết hợp và phân tích đa chiều
        const combinedData = [...recentData, ...weeklyData, ...monthlyData];
        const uniqueData = this.removeDuplicateResults(combinedData);

        if (uniqueData.length === 0) {
            throw new Error('Không có dữ liệu để phân tích');
        }

        return {
            recent: this.analyzeTrends(recentData, 'recent'),
            weekly: this.analyzeTrends(weeklyData, 'weekly'),
            monthly: this.analyzeTrends(monthlyData, 'monthly'),
            combined: this.analyzeTrends(uniqueData, 'combined'),
            totalDays: new Set(uniqueData.map(r => r.ngay)).size,
            latestGDB: this.getLatestGDB(uniqueData)
        };
    }

    // =================================================================
    // PHÂN TÍCH XU HƯỚNG THÔNG MINH - SỬA LỖI
    // =================================================================
    analyzeTrends(results, periodType = 'general') {
        if (!results || results.length === 0) {
            return this.getDefaultTrends();
        }

        const gdbResults = results.filter(r => r.giai === 'ĐB' && r.so);
        
        if (gdbResults.length === 0) {
            return this.getDefaultTrends();
        }

        // Phân tích tần suất với trọng số thời gian
        const frequency = this.analyzeWeightedFrequency(gdbResults, periodType);
        
        // Phân tích mẫu hình
        const patterns = this.analyzePatterns(gdbResults);
        
        // Phân tích chu kỳ
        const cycles = this.analyzeCycles(gdbResults);

        return {
            frequency,
            patterns,
            cycles,
            hotNumbers: this.findHotNumbers(frequency, periodType),
            coldNumbers: this.findColdNumbers(frequency, periodType),
            periodType,
            sampleSize: gdbResults.length
        };
    }

    // =================================================================
    // PHÂN TÍCH TẦN SUẤT CÓ TRỌNG SỐ THỜI GIAN - QUAN TRỌNG
    // =================================================================
    analyzeWeightedFrequency(gdbResults, periodType) {
        const frequency = {
            tram: Array(10).fill(0),
            chuc: Array(10).fill(0),
            donvi: Array(10).fill(0)
        };

        const now = new Date();
        let totalWeight = 0;

        gdbResults.forEach(result => {
            if (!result.ngay) return;

            // Tính trọng số dựa trên độ mới của dữ liệu
            const daysAgo = this.calculateDaysAgo(result.ngay, now);
            const weight = this.calculateTimeWeight(daysAgo, periodType);
            totalWeight += weight;

            const lastThree = String(result.so).padStart(5, '0').slice(-3);
            if (lastThree.length === 3) {
                frequency.tram[parseInt(lastThree[0])] += weight;
                frequency.chuc[parseInt(lastThree[1])] += weight;
                frequency.donvi[parseInt(lastThree[2])] += weight;
            }
        });

        // Chuẩn hóa về tỷ lệ
        if (totalWeight > 0) {
            for (let i = 0; i < 10; i++) {
                frequency.tram[i] = frequency.tram[i] / totalWeight;
                frequency.chuc[i] = frequency.chuc[i] / totalWeight;
                frequency.donvi[i] = frequency.donvi[i] / totalWeight;
            }
        }

        return frequency;
    }

    calculateTimeWeight(daysAgo, periodType) {
        // Dữ liệu càng mới càng có trọng số cao
        let baseWeight;
        
        switch (periodType) {
            case 'recent':
                baseWeight = Math.max(0, 7 - daysAgo); // Giảm dần theo ngày
                break;
            case 'weekly':
                baseWeight = Math.max(0, 30 - daysAgo) * 0.5;
                break;
            case 'monthly':
                baseWeight = Math.max(0, 60 - daysAgo) * 0.3;
                break;
            default:
                baseWeight = Math.max(0, 30 - daysAgo) * 0.7;
        }
        
        return Math.max(0.1, baseWeight); // Đảm bảo có trọng số tối thiểu
    }

    calculateDaysAgo(dateStr, now) {
        try {
            const [day, month, year] = dateStr.split('/').map(Number);
            const resultDate = new Date(year, month - 1, day);
            const diffTime = Math.abs(now - resultDate);
            return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        } catch (error) {
            return 30; // Mặc định nếu có lỗi
        }
    }

    // Thay thế toàn bộ hàm cũ bằng hàm này
// file: services/tripleGroupAnalysisService.js

    combineAndScorePredictions(analysisData) {
        const scores = {
            tram: Array(10).fill(0),
            chuc: Array(10).fill(0),
            donvi: Array(10).fill(0)
        };
    
        // --- Chiến lược 1: Phân tích tần suất (trọng số cao) ---
        const freqPred = this.selectByFrequency(analysisData.combined.frequency);
        if (freqPred) {
            // Kiểm tra an toàn: Đảm bảo freqPred.tram là một mảng trước khi gọi forEach
            if (Array.isArray(freqPred.tram)) {
                freqPred.tram.forEach(d => { if(scores.tram[d] !== undefined) scores.tram[d] += 1.5; });
            }
            if (Array.isArray(freqPred.chuc)) {
                freqPred.chuc.forEach(d => { if(scores.chuc[d] !== undefined) scores.chuc[d] += 1.5; });
            }
            if (Array.isArray(freqPred.donvi)) {
                freqPred.donvi.forEach(d => { if(scores.donvi[d] !== undefined) scores.donvi[d] += 1.5; });
            }
        }
    
        // --- Chiến lược 2: "Bộ não học hỏi" (trọng số rất cao) ---
        const learningPred = this.selectByLearning();
        
        // SỬA LỖI QUAN TRỌNG TẠI ĐÂY:
        // Kiểm tra an toàn: Đảm bảo learningPred không phải là null VÀ các thuộc tính bên trong nó là mảng
        if (learningPred) {
            if (Array.isArray(learningPred.tram)) {
                learningPred.tram.forEach(d => { if(scores.tram[d] !== undefined) scores.tram[d] += 2.0; });
            }
            if (Array.isArray(learningPred.chuc)) {
                learningPred.chuc.forEach(d => { if(scores.chuc[d] !== undefined) scores.chuc[d] += 2.0; });
            }
            if (Array.isArray(learningPred.donvi)) {
                learningPred.donvi.forEach(d => { if(scores.donvi[d] !== undefined) scores.donvi[d] += 2.0; });
            }
        }
    
        // --- Chiến lược 3: Phân tích mẫu hình Chẵn/Lẻ (Phần này đã an toàn) ---
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
        
        // --- Logic bổ sung: "Làm nguội" số vừa về (Phần này đã an toàn) ---
        if (lastGDBStr.length >= 3) {
            const lastThree = lastGDBStr.slice(-3);
            if (scores.tram[lastThree[0]] !== undefined) scores.tram[lastThree[0]] *= 0.5;
            if (scores.chuc[lastThree[1]] !== undefined) scores.chuc[lastThree[1]] *= 0.5;
            if (scores.donvi[lastThree[2]] !== undefined) scores.donvi[lastThree[2]] *= 0.5;
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
    // TẠO DỰ ĐOÁN ĐA DẠNG - SỬA LỖI QUAN TRỌNG
    // =================================================================
    async createDiversePrediction(analysisData, targetDate) {
    console.log("🎲 [Service] Tạo dự đoán TỔNG HỢP...");

    // THAY ĐỔI LỚN: Gọi hàm tổng hợp mới
    const finalPrediction = this.combineAndScorePredictions(analysisData);

    // Giữ nguyên phần còn lại của hàm
    return {
        ngayDuDoan: targetDate,
        ngayPhanTich: DateTime.now().toFormat('dd/MM/yyyy'),
        topTram: finalPrediction.tram,
        topChuc: finalPrediction.chuc,
        topDonVi: finalPrediction.donvi,
        analysisData: {
            totalDaysAnalyzed: analysisData.totalDays,
            latestGDB: analysisData.latestGDB,
            analysisMethods: 2, // Hiện tại có 2 phương pháp chính
            confidence: this.calculateDynamicConfidence(analysisData),
        },
        confidence: this.calculateDynamicConfidence(analysisData),
        predictionType: 'combined_analysis', // Đổi tên
        createdAt: new Date()
    };
}
    // =================================================================
    // CÁC PHƯƠNG PHÁP CHỌN SỐ ĐA DẠNG
    // =================================================================
    selectByFrequency(frequencyData) {
        if (!frequencyData) return null;

        return {
            tram: this.selectNumbersByWeightedFrequency(frequencyData.tram, 5),
            chuc: this.selectNumbersByWeightedFrequency(frequencyData.chuc, 5),
            donvi: this.selectNumbersByWeightedFrequency(frequencyData.donvi, 5)
        };
    }

    selectByPattern(patterns) {
        // Chọn số dựa trên mẫu hình phát hiện được
        const tram = this.generatePatternBasedNumbers(patterns, 'tram');
        const chuc = this.generatePatternBasedNumbers(patterns, 'chuc');
        const donvi = this.generatePatternBasedNumbers(patterns, 'donvi');

        return { tram, chuc, donvi };
    }

    async selectByLearning() {
        await this.loadOrCreateLearningState();
        
        if (!this.learningState || this.learningState.totalPredictionsAnalyzed < 10) {
            return null; // Chưa đủ dữ liệu học
        }

        // Sử dụng AI learning để chọn số
        return {
            tram: this.selectNumbersByLearning('tram', 5),
            chuc: this.selectNumbersByLearning('chuc', 5),
            donvi: this.selectNumbersByLearning('donvi', 5)
        };
    }

    selectRandomWithBias(frequencyData) {
        // Chọn số ngẫu nhiên nhưng có thiên vị theo tần suất
        return {
            tram: this.selectRandomNumbersWithBias(frequencyData?.tram, 5),
            chuc: this.selectRandomNumbersWithBias(frequencyData?.chuc, 5),
            donvi: this.selectRandomNumbersWithBias(frequencyData?.donvi, 5)
        };
    }

    // =================================================================
    // CẢI TIẾN HÀM CHỌN SỐ - THÊM TÍNH NGẪU NHIÊN
    // =================================================================
    selectNumbersByWeightedFrequency(frequencyArray, count) {
        if (!frequencyArray || frequencyArray.length !== 10) {
            return this.generateRandomNumbers(count);
        }

        // Tạo mảng số với xác suất dựa trên tần suất
        const numbers = [];
        for (let i = 0; i < 10; i++) {
            const probability = frequencyArray[i] * 100; // Chuyển thành phần trăm
            const countForNumber = Math.max(1, Math.round(probability / 20)); // Phân bổ theo xác suất
            
            for (let j = 0; j < countForNumber; j++) {
                numbers.push(i.toString());
            }
        }

        // Xáo trộn và chọn ngẫu nhiên
        const shuffled = this.shuffleArray([...numbers]);
        const selected = shuffled.slice(0, count);
        
        // Đảm bảo đủ số lượng
        while (selected.length < count) {
            const randomNum = Math.floor(Math.random() * 10).toString();
            if (!selected.includes(randomNum)) {
                selected.push(randomNum);
            }
        }

        return selected;
    }

    selectRandomNumbersWithBias(frequencyArray, count) {
        const numbers = [];
        const weights = frequencyArray || Array(10).fill(0.1); // Mặc định nếu không có tần suất
        
        // Chọn số với xác suất dựa trên weights
        for (let i = 0; i < count; i++) {
            const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
            let random = Math.random() * totalWeight;
            
            for (let j = 0; j < 10; j++) {
                random -= weights[j];
                if (random <= 0) {
                    const num = j.toString();
                    if (!numbers.includes(num)) {
                        numbers.push(num);
                    }
                    break;
                }
            }
        }

        // Đảm bảo đủ số lượng
        while (numbers.length < count) {
            const randomNum = Math.floor(Math.random() * 10).toString();
            if (!numbers.includes(randomNum)) {
                numbers.push(randomNum);
            }
        }

        return numbers.slice(0, count);
    }

    // =================================================================
    // HỖ TRỢ TÍNH ĐA DẠNG
    // =================================================================
    ensureDiversity(prediction) {
        // Đảm bảo các vị trí có sự đa dạng
        const allDigits = ['0','1','2','3','4','5','6','7','8','9'];
        
        ['tram', 'chuc', 'donvi'].forEach(position => {
            if (prediction[position].length < 3) {
                // Thêm số ngẫu nhiên nếu không đủ đa dạng
                const missing = allDigits.filter(d => !prediction[position].includes(d));
                const toAdd = this.shuffleArray(missing).slice(0, 5 - prediction[position].length);
                prediction[position] = [...prediction[position], ...toAdd].slice(0, 5);
            }
        });
    }

    combinePredictions(predictions) {
        const combined = { tram: [], chuc: [], donvi: [] };
        
        predictions.forEach(pred => {
            if (pred && pred.tram) combined.tram.push(...pred.tram);
            if (pred && pred.chuc) combined.chuc.push(...pred.chuc);
            if (pred && pred.donvi) combined.donvi.push(...pred.donvi);
        });

        // Loại bỏ trùng lặp và giới hạn số lượng
        return {
            tram: [...new Set(combined.tram)].slice(0, 5),
            chuc: [...new Set(combined.chuc)].slice(0, 5),
            donvi: [...new Set(combined.donvi)].slice(0, 5)
        };
    }

    // =================================================================
    // CÁC HÀM HỖ TRỢ KHÁC - GIỮ NGUYÊN CHỨC NĂNG
    // =================================================================
    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    generateRandomNumbers(count) {
        const numbers = [];
        while (numbers.length < count) {
            const num = Math.floor(Math.random() * 10).toString();
            if (!numbers.includes(num)) {
                numbers.push(num);
            }
        }
        return numbers;
    }

    calculateDynamicConfidence(analysisData) {
        let confidence = 50; // Cơ sở
        
        // Tăng độ tin cậy dựa trên số lượng dữ liệu
        if (analysisData.totalDays >= 30) confidence += 15;
        if (analysisData.totalDays >= 60) confidence += 10;
        
        // Tăng độ tin cậy nếu có sự đồng thuận giữa các phương pháp
        const methodAgreement = this.calculateMethodAgreement(analysisData);
        confidence += methodAgreement * 10;

        return Math.min(confidence, 95);
    }

    calculateMethodAgreement(analysisData) {
        // Tính toán mức độ đồng thuận giữa các phương pháp phân tích
        return 0.7; // Tạm thời cố định
    }

    // =================================================================
    // CÁC HÀM GỐC ĐƯỢC GIỮ LẠI NHƯNG TỐI ƯU
    // =================================================================
    async getResultsBeforeDate(targetDate, daysBack = 30) {
        try {
            const allResults = await Result.find().lean();
            const targetDateObj = this.parseDateString(targetDate);
            
            // Lọc kết quả trong khoảng thời gian
            const filteredResults = allResults.filter(result => {
                if (!result.ngay) return false;
                const resultDate = this.parseDateString(result.ngay);
                if (!resultDate) return false;
                
                const diffTime = targetDateObj - resultDate;
                const diffDays = diffTime / (1000 * 60 * 60 * 24);
                return diffDays > 0 && diffDays <= daysBack;
            });

            console.log(`📊 [Service] Lấy được ${filteredResults.length} kết quả trong ${daysBack} ngày`);
            return filteredResults;

        } catch (error) {
            console.error('❌ [Service] Lỗi lấy dữ liệu:', error);
            return [];
        }
    }

    parseDateString(dateStr) {
        try {
            const [day, month, year] = dateStr.split('/').map(Number);
            return new Date(year, month - 1, day);
        } catch (error) {
            console.error('❌ [Service] Lỗi parse date:', dateStr);
            return null;
        }
    }

    removeDuplicateResults(results) {
        const seen = new Set();
        return results.filter(result => {
            const key = `${result.ngay}_${result.giai}_${result.so}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    getLatestGDB(results) {
        const gdbResults = results.filter(r => r.giai === 'ĐB' && r.so);
        if (gdbResults.length === 0) return 'N/A';
        
        // Sắp xếp theo ngày giảm dần
        gdbResults.sort((a, b) => {
            const dateA = this.parseDateString(a.ngay);
            const dateB = this.parseDateString(b.ngay);
            return dateB - dateA;
        });
        
        return gdbResults[0].so;
    }

    // =================================================================
    // FALLBACK THÔNG MINH
    // =================================================================
    getSmartFallbackPrediction(targetDate) {
        console.log("🔄 [Service] Sử dụng fallback thông minh");
        
        // Tạo fallback dựa trên ngày và các yếu tố khác
        const dateBasedVariation = this.getDateBasedVariation(targetDate);
        
        return {
            ngayDuDoan: targetDate,
            topTram: this.generateDateBasedNumbers(targetDate, 'tram', dateBasedVariation),
            topChuc: this.generateDateBasedNumbers(targetDate, 'chuc', dateBasedVariation),
            topDonVi: this.generateDateBasedNumbers(targetDate, 'donvi', dateBasedVariation),
            confidence: 30,
            analysisData: { message: "Smart Fallback - Date Based" },
            isFallback: true
        };
    }

    getDateBasedVariation(dateStr) {
        // Tạo biến thể dựa trên ngày để đảm bảo sự đa dạng
        const date = this.parseDateString(dateStr);
        if (!date) return Math.random();
        
        const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
        return (dayOfYear % 10) / 10;
    }

    generateDateBasedNumbers(dateStr, position, variation) {
        const numbers = [];
        const baseNumbers = this.getBaseNumbersByPosition(position);
        
        // Áp dụng biến thể dựa trên ngày
        const offset = Math.floor(variation * 10) % 10;
        
        for (let i = 0; i < 5; i++) {
            const num = (parseInt(baseNumbers[i]) + offset) % 10;
            numbers.push(num.toString());
        }
        
        return [...new Set(numbers)].slice(0, 5);
    }

    getBaseNumbersByPosition(position) {
        // Số cơ sở khác nhau cho từng vị trí
        const bases = {
            tram: ['1','3','5','7','9','0','2','4','6','8'],
            chuc: ['0','2','4','6','8','1','3','5','7','9'],
            donvi: ['2','4','6','8','0','1','3','5','7','9']
        };
        return bases[position] || ['0','1','2','3','4'];
    }

    // =================================================================
    // CÁC HÀM GỐC ĐƯỢC GIỮ LẠI
    // =================================================================
    async loadOrCreateLearningState() {
        if (this.learningState) return;
        
        try {
            let state = await TripleGroupLearningState.findOne({ modelName: 'TripleGroupV1' });
            if (!state) {
                state = new TripleGroupLearningState();
                // Khởi tạo state mới
                for (let i = 0; i < 10; i++) {
                    const digit = i.toString();
                    state.tram.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                    state.chuc.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                    state.donvi.push({ digit, totalAppearances: 0, correctPicks: 0, accuracy: 0 });
                }
                await state.save();
            }
            this.learningState = state;
        } catch (error) {
            console.error('❌ [Service] Lỗi load learning state:', error);
        }
    }

    async getNextPredictionDate() {
        try {
            const allDates = await Result.distinct('ngay');
            if (allDates.length === 0) throw new Error('Không có dữ liệu');
            
            const sortedDates = allDates.filter(d => d && d.split('/').length === 3)
                .sort((a, b) => {
                    const dateA = this.parseDateString(a);
                    const dateB = this.parseDateString(b);
                    return dateB - dateA;
                });
            
            if (sortedDates.length === 0) throw new Error('Không có ngày hợp lệ');
            
            const latestDateStr = sortedDates[0];
            const latestDate = this.parseDateString(latestDateStr);
            const nextDate = new Date(latestDate.getTime() + 24 * 60 * 60 * 1000);
            
            return `${String(nextDate.getDate()).padStart(2, '0')}/${String(nextDate.getMonth() + 1).padStart(2, '0')}/${nextDate.getFullYear()}`;
        } catch (error) {
            console.error('❌ [Service] Lỗi tính ngày tiếp theo:', error);
            // Fallback: ngày mai
            const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
            return `${String(tomorrow.getDate()).padStart(2, '0')}/${String(tomorrow.getMonth() + 1).padStart(2, '0')}/${tomorrow.getFullYear()}`;
        }
    }

    async savePrediction(predictionData) {
        if (!predictionData?.ngayDuDoan) {
            throw new Error('Không thể lưu dự đoán: thiếu ngày');
        }
        
        try {
            // SỬA LỖI Ở ĐÂY: Thêm "return await"
            return await TripleGroupPrediction.findOneAndUpdate(
                { ngayDuDoan: predictionData.ngayDuDoan },
                predictionData,
                { upsert: true, new: true } // new: true là rất quan trọng, nó đảm bảo trả về document mới
            );
        } catch (error) {
            console.error('❌ [Service] Lỗi lưu dự đoán:', error);
            throw error;
        }
    }

    // =================================================================
    // CÁC PHƯƠNG THỨC KHÁC ĐƯỢC GIỮ LẠI
    // =================================================================
    async generatePredictionWithLearning(targetDateStr = null) {
        return this.generateTripleGroupPrediction(targetDateStr);
    }

    async generateHistoricalPredictions() {
        console.log('🕐 [Service] Tạo dự đoán lịch sử (PHIÊN BẢN CUỐI CÙNG - TỰ ĐỘNG CẬP NHẬT)...');
        
        const allResults = await Result.find().lean();
        if (allResults.length < 8) throw new Error('Không đủ dữ liệu lịch sử');

        const groupedByDate = {};
        allResults.forEach(r => {
            if (!groupedByDate[r.ngay]) groupedByDate[r.ngay] = [];
            groupedByDate[r.ngay].push(r);
        });
        
        const sortedDates = Object.keys(groupedByDate).sort((a, b) => this.parseDateString(a) - this.parseDateString(b));
        
        let createdCount = 0;
        let updatedCount = 0;
        const totalDaysToProcess = sortedDates.length - 7;

        // Bắt đầu từ ngày thứ 8 để có đủ 7 ngày lịch sử
        for (let i = 7; i < sortedDates.length; i++) {
            const targetDate = sortedDates[i];
            
            // Bỏ qua ngày cuối cùng nếu nó chưa có kết quả ĐB
            const finalResultCheck = allResults.find(r => r.ngay === targetDate && r.giai === 'ĐB');
            if (!finalResultCheck) {
                 console.log(`...[Service] Bỏ qua ngày ${targetDate} vì chưa có kết quả cuối cùng.`);
                 continue;
            }

            try {
                // Bước 1: Tạo và nhận về dự đoán đã được lưu
                const savedPrediction = await this.generateTripleGroupPrediction(targetDate);
                createdCount++;

                // Bước 2: Cập nhật kết quả thực tế vào bản ghi vừa tạo
                const gdbStr = String(finalResultCheck.so).padStart(5, '0');
                const lastThree = gdbStr.slice(-3);
                
                if (lastThree.length === 3) {
                    const isCorrect = 
                        Array.isArray(savedPrediction.topTram) && savedPrediction.topTram.includes(lastThree[0]) &&
                        Array.isArray(savedPrediction.topChuc) && savedPrediction.topChuc.includes(lastThree[1]) &&
                        Array.isArray(savedPrediction.topDonVi) && savedPrediction.topDonVi.includes(lastThree[2]);

                    // Cập nhật lại chính bản ghi đó
                    await TripleGroupPrediction.updateOne(
                        { _id: savedPrediction._id }, 
                        {
                            $set: {
                                actualResult: {
                                    tram: lastThree[0],
                                    chuc: lastThree[1],
                                    donvi: lastThree[2],
                                    isCorrect: isCorrect,
                                    updatedAt: new Date()
                                }
                            }
                        }
                    );
                    updatedCount++;
                }
                
                if (createdCount % 20 === 0) {
                    console.log(`...[Service] Đã xử lý ${createdCount}/${totalDaysToProcess} ngày...`);
                }
            } catch (error) {
                console.error(`❌ [Service] Lỗi xử lý ngày ${targetDate}:`, error.message);
            }
        }

        console.log(`🎉 [Service] Hoàn thành! Đã tạo ${createdCount} và cập nhật ${updatedCount} dự đoán lịch sử.`);
        return { created: createdCount, updated: updatedCount, total: totalDaysToProcess };
    }

    getDefaultTrends() {
        return {
            frequency: {
                tram: Array(10).fill(0.1),
                chuc: Array(10).fill(0.1),
                donvi: Array(10).fill(0.1)
            },
            patterns: {},
            cycles: {},
            hotNumbers: ['0','1','2','3','4'],
            coldNumbers: ['5','6','7','8','9'],
            periodType: 'default',
            sampleSize: 0
        };
    }

    getFallbackPrediction(targetDate) {
        return {
            ngayDuDoan: targetDate,
            topTram: ['0','1','2','3','4'],
            topChuc: ['5','6','7','8','9'],
            topDonVi: ['0','2','4','6','8'],
            confidence: 20,
            analysisData: { message: "Fallback due to insufficient data" },
            isFallback: true
        };
    }

    // Các hàm AI learning (giữ nguyên)
    selectNumbersByLearning(position, count = 5) { // Thêm count default
    if (!this.learningState || !this.learningState[position] || this.learningState.totalPredictionsAnalyzed < 20) {
        return null; // Chỉ sử dụng khi đã học đủ
    }

    const stats = this.learningState[position];
    const scoredNumbers = stats.map(stat => ({
        digit: stat.digit,
        // LOGIC MỚI: Tăng cường ảnh hưởng của độ chính xác
        // và thêm "phần thưởng" cho các số ít xuất hiện nhưng trúng (hiệu quả cao)
        score: (stat.accuracy || 0) * 1.5 + ((stat.correctPicks || 0) / (stat.totalAppearances || 1)) * 50
    })).sort((a, b) => b.score - a.score);

    return scoredNumbers.slice(0, count).map(item => item.digit);
}

    analyzePatterns(gdbResults) {
        // Phân tích mẫu hình cơ bản
        return {
            evenOddPattern: this.analyzeEvenOddPattern(gdbResults),
            sumPattern: this.analyzeSumPattern(gdbResults),
            sequencePattern: this.analyzeSequencePattern(gdbResults)
        };
    }

    analyzeCycles(gdbResults) {
        // Phân tích chu kỳ cơ bản
        return {
            dayOfWeek: this.analyzeDayOfWeekPattern(gdbResults),
            weeklyCycle: this.analyzeWeeklyCycle(gdbResults)
        };
    }

    findHotNumbers(frequency, periodType) {
        if (!frequency) return ['0','1','2','3','4'];
        
        const hotNumbers = frequency.tram
            .map((freq, digit) => ({ digit: digit.toString(), freq }))
            .sort((a, b) => b.freq - a.freq)
            .slice(0, 3)
            .map(item => item.digit);
            
        return hotNumbers.length > 0 ? hotNumbers : ['0','1','2'];
    }

    findColdNumbers(frequency, periodType) {
        if (!frequency) return ['5','6','7','8','9'];
        
        const coldNumbers = frequency.tram
            .map((freq, digit) => ({ digit: digit.toString(), freq }))
            .sort((a, b) => a.freq - b.freq)
            .slice(0, 3)
            .map(item => item.digit);
            
        return coldNumbers.length > 0 ? coldNumbers : ['7','8','9'];
    }

    // Các hàm phân tích mẫu hình (giữ nguyên)
    analyzeEvenOddPattern(gdbResults) { return {}; }
    analyzeSumPattern(gdbResults) { return {}; }
    analyzeSequencePattern(gdbResults) { return {}; }
    analyzeDayOfWeekPattern(gdbResults) { return {}; }
    analyzeWeeklyCycle(gdbResults) { return {}; }
    generatePatternBasedNumbers(patterns, position) { 
        return this.generateRandomNumbers(5); 
    }

    // Các hàm learning từ lịch sử (giữ nguyên)
    async learnFromHistory() {
        console.log('🧠 [Service] Học từ lịch sử...');
        await this.loadOrCreateLearningState();
        
        const { performance, totalAnalyzed } = await this.analyzeHistoricalPerformance();
        if (totalAnalyzed === 0) {
            return { updated: 0, total: 0 };
        }

        // Cập nhật learning state
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
        const predictionsWithResults = await TripleGroupPrediction.find({ 
            'actualResult': { $exists: true, $ne: null } 
        }).lean();
        
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
        
        return { performance, totalAnalyzed: predictionsWithResults.length };
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
            const stat = positionStats[digit];
            if (stat.totalAppearances > 0) {
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
}

module.exports = TripleGroupAnalysisService;
