// services/tripleGroupAnalysisService.js
const Result = require('../models/Result');
const TripleGroupPrediction = require('../models/TripleGroupPrediction');
const { DateTime } = require('luxon');

class TripleGroupAnalysisService {
    constructor() {
        this.CL_PATTERNS = ['CCC','CCL','CLC','CLL','LLC','LLL','LCC','LCL'];
    }

    /**
     * PHƯƠNG PHÁP PHÂN TÍCH NHÓM 3 GIẢI
     * - Phân tích các nhóm 3 giải từ ngày trước có chứa số của giải ĐB ngày sau
     * - Tìm pattern chung của các nhóm "ăn" được
     * - Áp dụng pattern đó để lọc số cho ngày tiếp theo
     */
    async analyzeTripleGroupPatterns(targetDate = null) {
        console.log('🔍 Bắt đầu phân tích nhóm 3 giải...');
        
        const allResults = await Result.find().sort({ ngay: 1 }).lean();
        if (allResults.length < 2) {
            throw new Error('Không đủ dữ liệu để phân tích');
        }

        // Nhóm kết quả theo ngày
        const groupedByDate = {};
        allResults.forEach(r => {
            if (!groupedByDate[r.ngay]) groupedByDate[r.ngay] = [];
            groupedByDate[r.ngay].push(r);
        });

        const dates = Object.keys(groupedByDate).sort((a, b) => 
            this.dateKey(a).localeCompare(this.dateKey(b))
        );

        const analysisResults = [];
        let totalGroups = 0;
        let winningGroups = 0;

        // Phân tích từng cặp ngày liên tiếp
        for (let i = 1; i < dates.length; i++) {
            const prevDate = dates[i-1];
            const currentDate = dates[i];

            const prevDayResults = groupedByDate[prevDate] || [];
            const currentDayResults = groupedByDate[currentDate] || [];

            const currentGDB = currentDayResults.find(r => r.giai === 'ĐB');
            if (!currentGDB?.so) continue;

            const gdbDigits = String(currentGDB.so).padStart(5, '0').split('');
            
            // Tìm các giải ngày trước có chứa số của GDB ngày sau
            const relevantPrizes = prevDayResults.filter(prize => {
                if (!prize.so) return false;
                const prizeDigits = String(prize.so).split('');
                return prizeDigits.some(digit => gdbDigits.includes(digit));
            });

            // Tạo các nhóm 3 giải từ các giải liên quan
            const groups = this.generateTripleGroups(relevantPrizes);
            totalGroups += groups.length;

            // Phân tích pattern của các nhóm
            for (const group of groups) {
                const groupPattern = this.analyzeGroupPattern(group);
                const isWinning = this.checkGroupWinning(group, gdbDigits);
                
                if (isWinning) winningGroups++;

                analysisResults.push({
                    prevDate,
                    currentDate,
                    groupPattern,
                    isWinning,
                    groupPrizes: group.map(p => p.giai),
                    gdbDigits: gdbDigits.join('')
                });
            }
        }

        // Phân loại pattern theo tỷ lệ thắng
        const patternStats = this.calculatePatternStatistics(analysisResults);
        
        console.log(`📊 Phân tích hoàn tất: ${totalGroups} nhóm, ${winningGroups} nhóm thắng`);
        
        return {
            patternStats,
            analysisResults,
            totalGroups,
            winningGroups,
            successRate: totalGroups > 0 ? (winningGroups / totalGroups) * 100 : 0
        };
    }

    /**
     * Tạo tất cả các tổ hợp nhóm 3 giải từ danh sách giải
     */
    generateTripleGroups(prizes) {
        const groups = [];
        const n = prizes.length;
        
        if (n < 3) return groups;

        for (let i = 0; i < n - 2; i++) {
            for (let j = i + 1; j < n - 1; j++) {
                for (let k = j + 1; k < n; k++) {
                    groups.push([prizes[i], prizes[j], prizes[k]]);
                }
            }
        }

        return groups;
    }

    /**
     * Phân tích pattern của một nhóm 3 giải
     */
    analyzeGroupPattern(group) {
        const patterns = group.map(prize => {
            if (!prize.chanle || prize.chanle.length !== 3) {
                return 'UNK'; // Unknown pattern
            }
            return prize.chanle;
        });

        return {
            individualPatterns: patterns,
            combinedPattern: patterns.join('-'),
            patternType: this.classifyPatternType(patterns)
        };
    }

    /**
     * Phân loại pattern của nhóm
     */
    classifyPatternType(patterns) {
        const clCount = patterns.join('').split('').reduce((acc, char) => {
            acc[char] = (acc[char] || 0) + 1;
            return acc;
        }, {C: 0, L: 0});

        const total = clCount.C + clCount.L;
        if (total === 0) return 'UNKNOWN';

        const cRatio = clCount.C / total;
        const lRatio = clCount.L / total;

        if (cRatio >= 0.7) return 'C_BIASED';
        if (lRatio >= 0.7) return 'L_BIASED';
        if (Math.abs(cRatio - lRatio) <= 0.2) return 'BALANCED';
        
        return 'MIXED';
    }

    /**
     * Kiểm tra nhóm có "ăn" được không
     */
    checkGroupWinning(group, gdbDigits) {
        // Một nhóm được coi là "ăn" nếu có ít nhất 2 giải trong nhóm 
        // có chứa ít nhất 1 số trùng với GDB
        let matchCount = 0;
        
        for (const prize of group) {
            if (!prize.so) continue;
            const prizeDigits = String(prize.so).split('');
            const hasMatch = prizeDigits.some(digit => gdbDigits.includes(digit));
            if (hasMatch) matchCount++;
        }

        return matchCount >= 2;
    }

    /**
     * Tính toán thống kê pattern
     */
    calculatePatternStatistics(analysisResults) {
        const patternMap = new Map();

        analysisResults.forEach(result => {
            const key = result.groupPattern.combinedPattern;
            if (!patternMap.has(key)) {
                patternMap.set(key, {
                    pattern: key,
                    total: 0,
                    wins: 0,
                    type: result.groupPattern.patternType,
                    examples: []
                });
            }

            const stats = patternMap.get(key);
            stats.total++;
            if (result.isWinning) stats.wins++;
            
            // Lưu ví dụ (tối đa 5)
            if (stats.examples.length < 5) {
                stats.examples.push({
                    prevDate: result.prevDate,
                    currentDate: result.currentDate,
                    gdbDigits: result.gdbDigits
                });
            }
        });

        // Tính tỷ lệ thắng và sắp xếp
        const statsArray = Array.from(patternMap.values()).map(stat => ({
            ...stat,
            winRate: stat.total > 0 ? (stat.wins / stat.total) * 100 : 0
        })).sort((a, b) => b.winRate - a.winRate);

        return statsArray;
    }

    /**
     * Áp dụng phân tích để lọc số cho ngày tiếp theo
     */
    async applyTripleGroupFilter(targetDate) {
        console.log('🎯 Áp dụng bộ lọc nhóm 3 giải...');

        const historicalAnalysis = await this.analyzeTripleGroupPatterns();
        const allResults = await Result.find().sort({ ngay: -1 }).limit(100).lean();
        
        if (allResults.length === 0) {
            throw new Error('Không có dữ liệu gần đây');
        }

        // Lấy dữ liệu ngày gần nhất
        const latestDate = allResults[0].ngay;
        const latestResults = allResults.filter(r => r.ngay === latestDate);

        // Tìm các pattern có tỷ lệ thắng cao
        const highWinPatterns = historicalAnalysis.patternStats
            .filter(stat => stat.winRate >= 60 && stat.total >= 3)
            .slice(0, 10);

        console.log(`📈 Sử dụng ${highWinPatterns.length} pattern có tỷ lệ thắng cao`);

        // Tạo các nhóm 3 giải từ ngày gần nhất
        const currentGroups = this.generateTripleGroups(latestResults);
        
        // Lọc các nhóm có pattern khớp với pattern thắng cao
        const filteredGroups = currentGroups.filter(group => {
            const groupPattern = this.analyzeGroupPattern(group);
            return highWinPatterns.some(highPattern => 
                highPattern.pattern === groupPattern.combinedPattern
            );
        });

        // Trích xuất các số từ các nhóm được lọc
        const filteredNumbers = new Set();
        filteredGroups.forEach(group => {
            group.forEach(prize => {
                if (prize.so) {
                    const digits = String(prize.so).split('');
                    digits.forEach(digit => filteredNumbers.add(digit));
                }
            });
        });

        const result = {
            filteredNumbers: Array.from(filteredNumbers).sort(),
            filteredGroupsCount: filteredGroups.length,
            highWinPatterns: highWinPatterns.map(p => ({
                pattern: p.pattern,
                winRate: p.winRate,
                total: p.total
            })),
            analysisDate: latestDate,
            targetDate: targetDate || this.getNextDate(latestDate)
        };

        console.log(`✅ Lọc xong: ${result.filteredNumbers.length} số từ ${result.filteredGroupsCount} nhóm`);
        
        return result;
    }

    /**
     * Tạo dự đoán dựa trên phương pháp nhóm 3 giải
     */
    async generateTripleGroupPrediction() {
        try {
            const filterResult = await this.applyTripleGroupFilter();
            
            // Chuyển đổi kết quả lọc thành dự đoán vị trí
            const prediction = this.convertToPositionPrediction(filterResult.filteredNumbers);
            
            return {
                method: 'TRIPLE_GROUP_ANALYSIS',
                ...prediction,
                analysis: {
                    filteredNumbers: filterResult.filteredNumbers,
                    groupsAnalyzed: filterResult.filteredGroupsCount,
                    patternsUsed: filterResult.highWinPatterns.length,
                    confidence: this.calculateConfidence(filterResult)
                },
                generatedAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('❌ Lỗi trong generateTripleGroupPrediction:', error);
            return this.getFallbackPrediction();
        }
    }

    /**
     * Chuyển đổi số lọc được thành dự đoán vị trí
     */
    convertToPositionPrediction(filteredNumbers) {
        // Phân phối số vào các vị trí dựa trên tần suất và logic
        const positions = ['tram', 'chuc', 'donvi'];
        const prediction = {};
        
        positions.forEach(position => {
            // Ưu tiên các số có trong filteredNumbers
            const preferredNumbers = [...filteredNumbers];
            
            // Thêm các số khác để đủ 5 số mỗi vị trí
            while (preferredNumbers.length < 5) {
                const randomNum = Math.floor(Math.random() * 10).toString();
                if (!preferredNumbers.includes(randomNum)) {
                    preferredNumbers.push(randomNum);
                }
            }
            
            prediction[`top${position.charAt(0).toUpperCase() + position.slice(1)}`] = 
                preferredNumbers.slice(0, 5);
        });

        return prediction;
    }

    /**
     * Tính độ tin cậy của kết quả
     */
    calculateConfidence(filterResult) {
        let confidence = 50; // Mặc định
        
        // Tăng độ tin cậy dựa trên số lượng pattern và số lượng nhóm
        if (filterResult.highWinPatterns.length >= 5) confidence += 20;
        if (filterResult.filteredGroupsCount >= 10) confidence += 15;
        if (filterResult.filteredNumbers.length >= 6) confidence += 15;
        
        return Math.min(confidence, 95);
    }

    /**
     * Dự phòng nếu có lỗi
     */
    getFallbackPrediction() {
        return {
            method: 'TRIPLE_GROUP_ANALYSIS_FALLBACK',
            topTram: ['0','1','2','3','4'],
            topChuc: ['5','6','7','8','9'],
            topDonVi: ['0','2','4','6','8'],
            analysis: {
                filteredNumbers: ['0','1','2','3','4','5','6','7','8','9'],
                groupsAnalyzed: 0,
                patternsUsed: 0,
                confidence: 30
            },
            generatedAt: new Date().toISOString()
        };
    }

    dateKey(s) {
        if (!s || typeof s !== 'string') return '';
        const parts = s.split('/');
        return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
    }

    getNextDate(dateStr) {
        const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');
        return date.plus({ days: 1 }).toFormat('dd/MM/yyyy');
    }
    async savePrediction(predictionData) {
        try {
            const predictionRecord = {
                ngayDuDoan: predictionData.targetDate,
                ngayPhanTich: predictionData.analysisDate,
                topTram: predictionData.topTram || [],
                topChuc: predictionData.topChuc || [],
                topDonVi: predictionData.topDonVi || [],
                filteredNumbers: predictionData.filteredNumbers || [],
                analysisData: {
                    totalGroups: predictionData.totalGroups,
                    winningGroups: predictionData.winningGroups,
                    successRate: predictionData.successRate,
                    highWinPatterns: predictionData.highWinPatterns,
                    filteredGroupsCount: predictionData.filteredGroupsCount
                },
                confidence: predictionData.confidence
            };

            await TripleGroupPrediction.findOneAndUpdate(
                { ngayDuDoan: predictionData.targetDate },
                predictionRecord,
                { upsert: true, new: true }
            );

            console.log(`💾 Đã lưu dự đoán Triple Group cho ngày ${predictionData.targetDate}`);
        } catch (error) {
            console.error('❌ Lỗi khi lưu dự đoán:', error);
        }
    }

    async updateActualResult(targetDate, actualGDB) {
        try {
            if (!actualGDB || actualGDB.length !== 3) return;

            const prediction = await TripleGroupPrediction.findOne({ ngayDuDoan: targetDate });
            if (!prediction) return;

            const isCorrect = 
                prediction.topTram.includes(actualGDB[0]) &&
                prediction.topChuc.includes(actualGDB[1]) && 
                prediction.topDonVi.includes(actualGDB[2]);

            await TripleGroupPrediction.updateOne(
                { ngayDuDoan: targetDate },
                {
                    actualResult: {
                        tram: actualGDB[0],
                        chuc: actualGDB[1],
                        donvi: actualGDB[2],
                        isCorrect: isCorrect
                    }
                }
            );

            console.log(`✅ Đã cập nhật kết quả thực cho ${targetDate}: ${isCorrect ? 'ĐÚNG' : 'SAI'}`);
        } catch (error) {
            console.error('❌ Lỗi cập nhật kết quả thực:', error);
        }
     }
    async learnFromOwnHistory() {
        console.log('🧠 Triple Group đang học từ lịch sử của chính nó...');
        
        try {
            // Lấy tất cả dự đoán chưa có kết quả thực tế
            const predictionsWithoutResults = await TripleGroupPrediction.find({
                $or: [
                    { 'actualResult': { $exists: false } },
                    { 'actualResult': null }
                ]
            }).lean();

            console.log(`📝 Tìm thấy ${predictionsWithoutResults.length} dự đoán chưa có kết quả`);

            let updatedCount = 0;

            for (const prediction of predictionsWithoutResults) {
                const actualResult = await Result.findOne({
                    ngay: prediction.ngayDuDoan,
                    giai: 'ĐB'
                }).lean();

                if (actualResult?.so) {
                    const gdbStr = String(actualResult.so).padStart(5, '0');
                    const lastThree = gdbStr.slice(-3);
                    
                    if (lastThree.length === 3) {
                        const isCorrect = 
                            prediction.topTram.includes(lastThree[0]) &&
                            prediction.topChuc.includes(lastThree[1]) &&
                            prediction.topDonVi.includes(lastThree[2]);

                        await TripleGroupPrediction.updateOne(
                            { _id: prediction._id },
                            {
                                actualResult: {
                                    tram: lastThree[0],
                                    chuc: lastThree[1],
                                    donvi: lastThree[2],
                                    isCorrect: isCorrect
                                }
                            }
                        );
                        updatedCount++;
                    }
                }
            }

            console.log(`✅ Đã cập nhật ${updatedCount} kết quả thực tế`);
            return { updated: updatedCount, total: predictionsWithoutResults.length };
        } catch (error) {
            console.error('❌ Lỗi trong learnFromOwnHistory:', error);
            throw error;
        }
    }

    /**
     * PHƯƠNG PHÁP MỚI: Tạo dự đoán với học hỏi từ lịch sử
     */
    async generatePredictionWithLearning() {
        console.log('🚀 Tạo dự đoán Triple Group với học hỏi...');
        
        try {
            // Bước 1: Cập nhật kết quả thực tế cho các dự đoán cũ
            await this.learnFromOwnHistory();
            
            // Bước 2: Phân tích lịch sử để tìm pattern hiệu quả
            const historicalAnalysis = await this.analyzeHistoricalPerformance();
            
            // Bước 3: Tạo dự đoán mới với kiến thức đã học
            const prediction = await this.generateSmartPrediction(historicalAnalysis);
            
            // Bước 4: Lưu dự đoán
            await this.savePrediction(prediction);
            
            return prediction;
        } catch (error) {
            console.error('❌ Lỗi trong generatePredictionWithLearning:', error);
            throw error;
        }
    }

    /**
     * Phân tích hiệu suất lịch sử
     */
    async analyzeHistoricalPerformance() {
        const predictionsWithResults = await TripleGroupPrediction.find({
            'actualResult': { $exists: true }
        }).lean();

        const analysis = {
            total: predictionsWithResults.length,
            correct: predictionsWithResults.filter(p => p.actualResult.isCorrect).length,
            patternEffectiveness: {},
            confidenceAccuracy: {}
        };

        // Phân tích hiệu quả của các pattern
        predictionsWithResults.forEach(pred => {
            const patterns = pred.analysisData?.highWinPatterns || [];
            patterns.forEach(pattern => {
                const patternKey = pattern.pattern;
                if (!analysis.patternEffectiveness[patternKey]) {
                    analysis.patternEffectiveness[patternKey] = { total: 0, correct: 0 };
                }
                analysis.patternEffectiveness[patternKey].total++;
                if (pred.actualResult.isCorrect) {
                    analysis.patternEffectiveness[patternKey].correct++;
                }
            });

            // Phân tích độ chính xác theo confidence
            const confidenceLevel = Math.floor(pred.confidence / 10) * 10;
            if (!analysis.confidenceAccuracy[confidenceLevel]) {
                analysis.confidenceAccuracy[confidenceLevel] = { total: 0, correct: 0 };
            }
            analysis.confidenceAccuracy[confidenceLevel].total++;
            if (pred.actualResult.isCorrect) {
                analysis.confidenceAccuracy[confidenceLevel].correct++;
            }
        });

        // Tính tỷ lệ thành công
        analysis.successRate = analysis.total > 0 ? (analysis.correct / analysis.total) * 100 : 0;
        
        console.log(`📊 Phân tích hiệu suất: ${analysis.correct}/${analysis.total} (${analysis.successRate.toFixed(1)}%)`);
        
        return analysis;
    }

    /**
     * Tạo dự đoán thông minh dựa trên phân tích
     */
    async generateSmartPrediction(historicalAnalysis) {
        // Lấy dữ liệu cơ bản
        const basicPrediction = await this.generateTripleGroupPrediction();
        
        // Điều chỉnh dựa trên hiệu suất lịch sử
        const adjustedPrediction = this.adjustPredictionBasedOnHistory(basicPrediction, historicalAnalysis);
        
        return adjustedPrediction;
    }

    /**
     * Điều chỉnh dự đoán dựa trên lịch sử
     */
    adjustPredictionBasedOnHistory(prediction, historicalAnalysis) {
        // Nếu có dữ liệu lịch sử, điều chỉnh confidence
        if (historicalAnalysis.total > 0) {
            const successRate = historicalAnalysis.successRate;
            
            // Điều chỉnh confidence dựa trên hiệu suất thực tế
            let adjustedConfidence = prediction.confidence;
            
            if (successRate > 60) {
                adjustedConfidence = Math.min(95, prediction.confidence + 10);
            } else if (successRate < 40) {
                adjustedConfidence = Math.max(30, prediction.confidence - 10);
            }
            
            prediction.confidence = Math.round(adjustedConfidence);
        }

        return prediction;
    }
    async generateHistoricalPredictions() {
        console.log('🕐 Bắt đầu tạo dự đoán cho toàn bộ lịch sử...');
        
        const allResults = await Result.find().sort({ ngay: 1 }).lean();
        if (allResults.length === 0) {
            throw new Error('Không có dữ liệu kết quả');
        }

        // Nhóm kết quả theo ngày
        const grouped = {};
        allResults.forEach(r => {
            if (!grouped[r.ngay]) grouped[r.ngay] = [];
            grouped[r.ngay].push(r);
        });

        const dates = Object.keys(grouped).sort((a, b) => this.dateKey(a).localeCompare(this.dateKey(b)));
        
        // Chúng ta sẽ tạo dự đoán cho mỗi ngày, bắt đầu từ ngày thứ SEQUENCE_LENGTH + 1
        const startIndex = 7; // SEQUENCE_LENGTH = 7
        let createdCount = 0;

        for (let i = startIndex; i < dates.length; i++) {
            const currentDate = dates[i];
            
            // Kiểm tra xem đã có dự đoán cho ngày này chưa
            const existingPrediction = await TripleGroupPrediction.findOne({ ngayDuDoan: currentDate });
            if (existingPrediction) {
                console.log(`⚠️ Đã có dự đoán cho ngày ${currentDate}, bỏ qua`);
                continue;
            }

            // Lấy dữ liệu 7 ngày trước đó
            const sequenceStart = i - 7;
            const sequenceEnd = i;
            const sequenceDates = dates.slice(sequenceStart, sequenceEnd);

            // Kiểm tra xem có đủ 7 ngày không
            if (sequenceDates.length < 7) {
                console.log(`⚠️ Không đủ 7 ngày cho chuỗi ngày ${currentDate}, bỏ qua`);
                continue;
            }

            // Tạo dự đoán
            try {
                const prediction = await this.generatePredictionForDate(sequenceDates, currentDate);
                await this.savePrediction(prediction);
                createdCount++;
                console.log(`✅ Đã tạo dự đoán cho ${currentDate} (${createdCount}/${dates.length - startIndex})`);
            } catch (error) {
                console.error(`❌ Lỗi khi tạo dự đoán cho ${currentDate}:`, error.message);
            }
        }

        console.log(`🎉 Hoàn thành tạo dự đoán lịch sử! Đã tạo ${createdCount} dự đoán.`);
        return { created: createdCount, total: dates.length - startIndex };
    }

    /**
     * Tạo dự đoán cho một ngày cụ thể trong lịch sử
     */
    async generatePredictionForDate(sequenceDates, targetDate) {
        const allResults = await Result.find({ ngay: { $in: [...sequenceDates, targetDate] } }).lean();
        
        // Nhóm kết quả theo ngày
        const grouped = {};
        allResults.forEach(r => {
            if (!grouped[r.ngay]) grouped[r.ngay] = [];
            grouped[r.ngay].push(r);
        });

        // Chuẩn bị dữ liệu training từ các ngày trước đó
        const previousDays = [];
        const inputSequence = sequenceDates.map(day => {
            const dayResults = grouped[day] || [];
            const prevDays = previousDays.slice();
            previousDays.push(dayResults);
            
            // Sử dụng feature engineering (giống như trong TensorFlowService)
            const basicFeatures = this.featureService.extractAllFeatures(dayResults, prevDays, day);
            const advancedFeatures = this.advancedFeatureEngineer.extractPremiumFeatures(dayResults, previousDays);
            
            let finalFeatureVector = [...basicFeatures, ...Object.values(advancedFeatures).flat()];
            
            // Đảm bảo đúng 346 features
            const EXPECTED_SIZE = 346;
            if (finalFeatureVector.length !== EXPECTED_SIZE) {
                if (finalFeatureVector.length > EXPECTED_SIZE) {
                    finalFeatureVector = finalFeatureVector.slice(0, EXPECTED_SIZE);
                } else {
                    finalFeatureVector = [...finalFeatureVector, ...Array(EXPECTED_SIZE - finalFeatureVector.length).fill(0)];
                }
            }
            
            return finalFeatureVector;
        });

        // Áp dụng phương pháp Triple Group
        const filteredNumbers = await this.applyTripleGroupFilter(targetDate);
        const prediction = this.convertToPositionPrediction(filteredNumbers.filteredNumbers);

        // Lấy kết quả thực tế nếu có
        let actualResult = null;
        const actualGDB = (grouped[targetDate] || []).find(r => r.giai === 'ĐB');
        if (actualGDB?.so) {
            const gdbStr = String(actualGDB.so).padStart(5, '0');
            const lastThree = gdbStr.slice(-3);
            if (lastThree.length === 3) {
                const isCorrect = 
                    prediction.topTram.includes(lastThree[0]) &&
                    prediction.topChuc.includes(lastThree[1]) &&
                    prediction.topDonVi.includes(lastThree[2]);
                
                actualResult = {
                    tram: lastThree[0],
                    chuc: lastThree[1],
                    donvi: lastThree[2],
                    isCorrect: isCorrect
                };
            }
        }

        return {
            ...prediction,
            method: 'TRIPLE_GROUP_ANALYSIS',
            analysis: {
                filteredNumbers: filteredNumbers.filteredNumbers,
                groupsAnalyzed: filteredNumbers.filteredGroupsCount,
                patternsUsed: filteredNumbers.highWinPatterns.length,
                confidence: this.calculateConfidence(filteredNumbers)
            },
            ngayDuDoan: targetDate,
            ngayPhanTich: sequenceDates[sequenceDates.length - 1], // Ngày cuối cùng trong chuỗi
            actualResult: actualResult,
            createdAt: new Date()
        };
    }

    /**
     * Lấy tất cả dự đoán với phân trang và lọc
     */
    async getAllPredictions(page = 1, limit = 20, dateFilter = null) {
        const skip = (page - 1) * limit;
        
        let query = {};
        if (dateFilter) {
            query.ngayDuDoan = dateFilter;
        }

        const predictions = await TripleGroupPrediction.find(query)
            .sort({ ngayDuDoan: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await TripleGroupPrediction.countDocuments(query);

        return {
            predictions: predictions,
            pagination: {
                page: page,
                limit: limit,
                total: total,
                pages: Math.ceil(total / limit)
            }
        };
    }

    /**
     * Lấy danh sách các ngày có dự đoán
     */
    async getAvailableDates() {
        const predictions = await TripleGroupPrediction.find({})
            .sort({ ngayDuDoan: -1 })
            .select('ngayDuDoan')
            .lean();

        const dates = [...new Set(predictions.map(p => p.ngayDuDoan))].sort((a, b) => 
            new Date(b.split('/').reverse().join('-')) - new Date(a.split('/').reverse().join('-'))
        );

        return dates;
    }
}


module.exports = TripleGroupAnalysisService;
