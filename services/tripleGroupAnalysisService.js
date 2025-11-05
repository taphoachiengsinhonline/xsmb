// services/tripleGroupAnalysisService.js
const Result = require('../models/Result');
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
}

module.exports = TripleGroupAnalysisService;
