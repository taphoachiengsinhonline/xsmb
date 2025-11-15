// services/PatternAnalysisService.js
const Result = require('../models/Result');
const PatternPrediction = require('../models/PatternPrediction');
const PatternKnowledge = require('../models/PatternKnowledge');
const { GROUPS, PRIZE_ORDER } = require('./patternAnalysis/constants');
const { DateTime } = require('luxon');

// --- CÁC HẰNG SỐ CẤU HÌNH CHO AI ---
const ANALYSIS_LOOKBACK_DAYS = 60; // AI sẽ nhìn lại 60 ngày để tìm mẫu
const PATTERN_MIN_LENGTH = 2;       // Một mẫu phải có độ dài ít nhất 2 ngày
const WEIGHT_INCREASE_FACTOR = 1.15; // Mức độ "thưởng" khi mẫu đoán đúng
const WEIGHT_DECREASE_FACTOR = 0.90; // Mức độ "phạt" khi mẫu đoán sai
const MIN_WEIGHT = 0.2;             // Trọng số tối thiểu, tránh bị loại bỏ hoàn toàn

class PatternAnalysisService {
    constructor() {
        this.resultsByDate = new Map();
        this.sortedDates = [];
        this.knowledge = new Map(); // Knowledge base cho lần chạy này
        this.prizeToGroupMap = this.createPrizeToGroupMap();
    }

    /**
     * Hàm chính điều phối toàn bộ quá trình phân tích và dự đoán
     */
    async generatePredictionForNextDay() {
        console.log('🤖 [PatternAI] Bắt đầu phân tích cho ngày tiếp theo...');
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 5);

        const latestDate = this.sortedDates[0];
        const nextDay = DateTime.fromFormat(latestDate, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
        console.log(`🎯 Ngày dự đoán: ${nextDay}`);

        const predictions = {};
        const positions = ['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'];

        for (let i = 0; i < positions.length; i++) {
            const positionName = positions[i];
            const gdbPositionIndex = i;
            console.log(`--- Phân tích vị trí: ${positionName} ---`);
            predictions[positionName] = await this.runAnalysisPipelineForPosition(gdbPositionIndex);
        }

        const savedPrediction = await PatternPrediction.findOneAndUpdate(
            { ngayDuDoan: nextDay },
            { ngayDuDoan: nextDay, ...predictions },
            { upsert: true, new: true }
        );

        console.log('✅ [PatternAI] Đã tạo và lưu dự đoán thành công!');
        return savedPrediction;
    }

    /**
     * Pipeline các bước phân tích cho một vị trí GĐB cụ thể (0-4)
     */
    async runAnalysisPipelineForPosition(gdbPositionIndex) {
        const historicalTraces = this.findHistoricalTraces(gdbPositionIndex);
        const detectedPatterns = this.detectPatterns(historicalTraces);
        const scoredPatterns = this.scorePatterns(detectedPatterns);
        const subgroupStrengths = this.evaluateSubgroupStrength(scoredPatterns);
        const groupResults = this.filterByGroupLogic(subgroupStrengths);
        let finalDigits = this.finalIntersectionAndFiltering(groupResults);

        if (finalDigits.length > 5) {
            finalDigits = this.applyAdvancedExclusion(finalDigits);
        }
        
        // Đảm bảo luôn có 5 số, thêm số ngẫu nhiên nếu thiếu
        const allPossible = ['0','1','2','3','4','5','6','7','8','9'];
        while (finalDigits.length < 5 && finalDigits.length < allPossible.length) {
            const randomDigit = allPossible.filter(d => !finalDigits.includes(d))[0];
            if(randomDigit) finalDigits.push(randomDigit);
        }

        const hotDigit = this.findHotDigit(finalDigits, scoredPatterns);

        return {
            promisingDigits: finalDigits.slice(0, 5),
            hotDigit: hotDigit || finalDigits[0],
            analysisDetails: {
                strongestPatterns: scoredPatterns.sort((a,b) => b.score - a.score).slice(0, 3)
            }
        };
    }
    
    // --- CÁC HÀM LÕI ---

    async loadDataAndKnowledge(limitDays) {
        console.log(`[PatternAI] Đang tải ${limitDays} ngày dữ liệu...`);
        const results = await Result.find().sort({ 'ngay': -1 }).limit(limitDays * 27).lean();
        results.forEach(r => {
            if (!this.resultsByDate.has(r.ngay)) {
                this.resultsByDate.set(r.ngay, []);
            }
            this.resultsByDate.get(r.ngay).push(r);
        });

        this.sortedDates = [...this.resultsByDate.keys()].sort((a, b) => 
            DateTime.fromFormat(b, 'dd/MM/yyyy') - DateTime.fromFormat(a, 'dd/MM/yyyy')
        );

        const knowledgeDoc = await PatternKnowledge.findOne({ modelName: 'PatternAnalyzerV1' });
        if (knowledgeDoc && knowledgeDoc.knowledgeBase) {
            this.knowledge = knowledgeDoc.knowledgeBase;
            console.log(`[PatternAI] Đã tải ${this.knowledge.size} "mảnh tri thức" từ DB.`);
        } else {
            console.log('[PatternAI] Không tìm thấy "trí nhớ", sẽ bắt đầu với tri thức mới.');
        }
    }
    
    findHistoricalTraces(gdbPositionIndex) {
        const historicalTraces = new Map();
        for (let i = 0; i < Math.min(this.sortedDates.length - 1, ANALYSIS_LOOKBACK_DAYS); i++) {
            const currentDate = this.sortedDates[i];
            const previousDate = this.sortedDates[i + 1];

            const currentGDB = (this.resultsByDate.get(currentDate) || []).find(r => r.giai === 'ĐB');
            if (!currentGDB || !currentGDB.so) continue;

            const digitToTrace = String(currentGDB.so).padStart(5, '0')[gdbPositionIndex];
            const previousDayResults = this.resultsByDate.get(previousDate) || [];
            
            const traces = [];
            for (const result of previousDayResults) {
                const digits = String(result.so).split('');
                for (let pos = 0; pos < digits.length; pos++) {
                    if (digits[pos] === digitToTrace) {
                        traces.push({ prize: result.giai, position: pos + 1 });
                    }
                }
            }
            if (traces.length > 0) {
                historicalTraces.set(currentDate, { digit: digitToTrace, traces });
            }
        }
        return historicalTraces;
    }

    detectPatterns(traces) {
        // Hàm này sẽ tìm các đường đi của số. Đây là một phiên bản đơn giản hóa.
        // Một phiên bản hoàn thiện hơn sẽ cần các thuật toán nhận dạng mẫu phức tạp.
        const patterns = [];
        const traceArray = [...traces.entries()];

        for (let i = 0; i < traceArray.length - 1; i++) {
            const [currentDate, currentTraceData] = traceArray[i];
            const [prevDate, prevTraceData] = traceArray[i + 1];

            for (const ct of currentTraceData.traces) {
                for (const pt of prevTraceData.traces) {
                    // 1. Tìm đường ăn thẳng (Streak)
                    if (ct.prize === pt.prize && ct.position === pt.position) {
                        patterns.push({ type: 'streak', key: `${ct.prize}_p${ct.position}`, length: 2, lastDate: currentDate });
                    }
                    // 2. Tìm đường ăn chéo (Diagonal) - ví dụ đơn giản
                    const prizeIndexDiff = PRIZE_ORDER.indexOf(ct.prize) - PRIZE_ORDER.indexOf(pt.prize);
                    if (prizeIndexDiff === 1 && ct.position === pt.position) {
                        patterns.push({ type: 'diagonal_prize', key: `${pt.prize}_to_${ct.prize}`, length: 2, lastDate: currentDate });
                    }
                }
            }
        }
        // Logic tìm chu kỳ (Cycle) phức tạp hơn và sẽ được bổ sung sau
        return this.consolidatePatterns(patterns);
    }
    
    scorePatterns(patterns) {
        return patterns.map(p => {
            const recency = (ANALYSIS_LOOKBACK_DAYS - this.sortedDates.indexOf(p.lastDate)) / ANALYSIS_LOOKBACK_DAYS;
            const baseScore = p.length * 10 * recency;
            const knowledgeItem = this.knowledge.get(p.key);
            const weight = knowledgeItem ? knowledgeItem.weight : 1.0;
            return { ...p, score: baseScore * weight };
        });
    }

    evaluateSubgroupStrength(scoredPatterns) {
        const strengths = {};
        Object.values(GROUPS).forEach(g => Object.keys(g.subgroups).forEach(sg => strengths[sg] = 0));

        for (const p of scoredPatterns) {
            const nextStep = this.getNextStep(p);
            if (nextStep) {
                const subgroup = this.prizeToGroupMap.subgroup[nextStep.prize];
                if (subgroup && strengths[subgroup] !== undefined) {
                    strengths[subgroup] += p.score;
                }
            }
        }
        return strengths;
    }

    filterByGroupLogic(subgroupStrengths) {
        const getDigitsForSubgroup = (subgroupKey) => {
            const groupKey = Object.keys(GROUPS).find(gk => GROUPS[gk].subgroups[subgroupKey]);
            const prizes = GROUPS[groupKey].subgroups[subgroupKey].prizes;
            const digits = new Set();
            for (const p of prizes) {
                // Lấy KQXS của ngày gần nhất cho các giải này
                const lastDayResults = this.resultsByDate.get(this.sortedDates[0]) || [];
                const result = lastDayResults.find(r => r.giai === p);
                if (result && result.so) {
                    String(result.so).split('').forEach(d => digits.add(d));
                }
            }
            return [...digits];
        };

        const findStrongestSubgroup = (groupKey) => {
            const subgroupKeys = Object.keys(GROUPS[groupKey].subgroups);
            let strongestKey = subgroupKeys[0];
            let maxStrength = -1;
            subgroupKeys.forEach(key => {
                if (subgroupStrengths[key] > maxStrength) {
                    maxStrength = subgroupStrengths[key];
                    strongestKey = key;
                }
            });
            return strongestKey;
        };

        // Nhóm 1 & 2
        const strongestG1 = findStrongestSubgroup('G1');
        const strongestG2 = findStrongestSubgroup('G2');
        const g1_digits = getDigitsForSubgroup(strongestG1);
        const g2_digits = getDigitsForSubgroup(strongestG2);

        // Nhóm 3
        const g3a_digits = getDigitsForSubgroup('G3A');
        const g3b_digits = getDigitsForSubgroup('G3B');
        const g3c_digits = getDigitsForSubgroup('G3C');
        const excludedDigits = g3a_digits.filter(d => g3b_digits.includes(d) && g3c_digits.includes(d));
        
        const strongestG3 = findStrongestSubgroup('G3');
        const strongestG3_digits = getDigitsForSubgroup(strongestG3);
        const g3_digits = strongestG3_digits.filter(d => !excludedDigits.includes(d));
        
        return { g1_digits, g2_digits, g3_digits };
    }
    
    finalIntersectionAndFiltering({ g1_digits, g2_digits, g3_digits }) {
        const allDigits = [...g1_digits, ...g2_digits, ...g3_digits];
        const counts = allDigits.reduce((acc, digit) => {
            acc[digit] = (acc[digit] || 0) + 1;
            return acc;
        }, {});
        
        return Object.keys(counts).filter(digit => counts[digit] >= 2);
    }
    
    applyAdvancedExclusion(digits) {
        // Loại trừ dựa trên các giải "gan" G7
        const lastDayResults = this.resultsByDate.get(this.sortedDates[0]) || [];
        const g7b = lastDayResults.find(r => r.giai === 'G7b');
        const g7d = lastDayResults.find(r => r.giai === 'G7d');
        const excluded = new Set();
        if (g7b && g7b.so) String(g7b.so).split('').forEach(d => excluded.add(d));
        if (g7d && g7d.so) String(g7d.so).split('').forEach(d => excluded.add(d));

        return digits.filter(d => !excluded.has(d));
    }

    findHotDigit(digits, scoredPatterns) {
        if (!digits || digits.length === 0) return null;
        const digitScores = digits.reduce((acc, d) => ({ ...acc, [d]: 0 }), {});

        for (const p of scoredPatterns) {
            const nextStep = this.getNextStep(p);
            if (nextStep) {
                const lastDayResults = this.resultsByDate.get(this.sortedDates[0]) || [];
                const result = lastDayResults.find(r => r.giai === nextStep.prize);
                if (result && result.so) {
                    String(result.so).split('').forEach(d => {
                        if (digitScores[d] !== undefined) {
                            digitScores[d] += p.score;
                        }
                    });
                }
            }
        }
        return Object.keys(digitScores).reduce((a, b) => digitScores[a] > digitScores[b] ? a : b);
    }

    /**
     * Hàm cho AI học hỏi từ kết quả thực tế
     */
    async learnFromResults() {
        console.log('🧠 [PatternAI] Bắt đầu học hỏi từ kết quả mới...');
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 5);
        
        const predictionsToLearn = await PatternPrediction.find({ hasActualResult: false }).lean();
        if (predictionsToLearn.length === 0) {
            console.log('[PatternAI] Không có dự đoán mới để học.');
            return;
        }

        let learnedCount = 0;
        for (const pred of predictionsToLearn) {
            const actualGDBResult = (this.resultsByDate.get(pred.ngayDuDoan) || []).find(r => r.giai === 'ĐB');
            if (!actualGDBResult || !actualGDBResult.so) {
                await PatternPrediction.updateOne({ _id: pred._id }, { hasActualResult: true }); // Đánh dấu đã xử lý
                continue;
            }
            const actualGDB = String(actualGDBResult.so).padStart(5, '0');

            // Lặp lại quy trình phân tích cho từng vị trí để xác định pattern nào đã đúng
            for (let i = 0; i < 5; i++) {
                const actualDigit = actualGDB[i];
                const historicalTraces = this.findHistoricalTraces(i, pred.ngayDuDoan);
                const patterns = this.detectPatterns(historicalTraces);

                for (const p of patterns) {
                    const nextStep = this.getNextStep(p);
                    if (!nextStep) continue;
                    
                    const dayBeforePrediction = this.sortedDates[this.sortedDates.indexOf(pred.ngayDuDoan) + 1];
                    const resultsForNextStep = (this.resultsByDate.get(dayBeforePrediction) || []);
                    const result = resultsForNextStep.find(r => r.giai === nextStep.prize);

                    let isHit = false;
                    if (result && result.so && String(result.so).includes(actualDigit)) {
                        isHit = true;
                    }
                    this.updateKnowledge(p.key, p.type, isHit, pred.ngayDuDoan);
                }
            }
            learnedCount++;
            await PatternPrediction.updateOne({ _id: pred._id }, { hasActualResult: true });
        }
        
        await PatternKnowledge.findOneAndUpdate(
            { modelName: 'PatternAnalyzerV1' },
            { knowledgeBase: this.knowledge, lastLearnedAt: new Date() },
            { upsert: true }
        );
        console.log(`✅ [PatternAI] Học hỏi hoàn tất! Đã xử lý ${learnedCount} dự đoán.`);
    }

    // --- CÁC HÀM TIỆN ÍCH (HELPER) ---
    
    consolidatePatterns(patterns) {
        const consolidated = new Map();
        for (const p of patterns) {
            if (consolidated.has(p.key)) {
                consolidated.get(p.key).length++;
            } else {
                consolidated.set(p.key, { ...p, length: p.length });
            }
        }
        return [...consolidated.values()];
    }

    getNextStep(pattern) {
        const lastPrizeIndex = PRIZE_ORDER.indexOf(pattern.key.split('_')[0]);
        if (lastPrizeIndex === -1 || lastPrizeIndex >= PRIZE_ORDER.length - 1) return null;
        
        if (pattern.type === 'streak') {
            return { prize: PRIZE_ORDER[lastPrizeIndex], position: parseInt(pattern.key.split('p')[1]) };
        }
        if (pattern.type === 'diagonal_prize') {
            return { prize: PRIZE_ORDER[lastPrizeIndex + 1], position: parseInt(pattern.key.split('p')[1]) };
        }
        return null;
    }

    createPrizeToGroupMap() {
        const map = { subgroup: {}, group: {} };
        for (const [groupKey, groupData] of Object.entries(GROUPS)) {
            for (const [subgroupKey, subgroupData] of Object.entries(groupData.subgroups)) {
                for (const prize of subgroupData.prizes) {
                    map.subgroup[prize] = subgroupKey;
                    map.group[prize] = groupKey;
                }
            }
        }
        return map;
    }

    updateKnowledge(key, type, isHit, hitDate) {
        const current = this.knowledge.get(key) || { 
            patternKey: key, type, weight: 1.0, hitCount: 0, missCount: 0 
        };
        
        if (isHit) {
            current.weight = Math.min(5.0, current.weight * WEIGHT_INCREASE_FACTOR); // Giới hạn weight max
            current.hitCount++;
            current.lastHit = hitDate;
        } else {
            current.weight = Math.max(MIN_WEIGHT, current.weight * WEIGHT_DECREASE_FACTOR);
            current.missCount++;
        }
        this.knowledge.set(key, current);
    }
}

module.exports = PatternAnalysisService;
