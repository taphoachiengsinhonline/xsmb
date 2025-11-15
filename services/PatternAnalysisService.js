// File: services/PatternAnalysisService.js (Phiên bản V4 - Kiến trúc MLOps với GCS + MongoDB)

const { Storage } = require('@google-cloud/storage');
const Result = require('../models/Result');
const PatternPrediction = require('../models/PatternPrediction');
const NNState = require('../models/NNState'); // Sử dụng lại NNState để lưu metadata
const { GROUPS, PRIZE_ORDER } = require('./patternAnalysis/constants');
const { DateTime } = require('luxon');

// --- CẤU HÌNH GCS & AI V4 ---
const GCS_CREDENTIALS_JSON = process.env.GCS_CREDENTIALS;
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const MODEL_NAME = 'PatternAnalyzerV1'; // Tên định danh cho AI này

let storage;
let bucket;

if (GCS_CREDENTIALS_JSON && GCS_BUCKET_NAME) {
    try {
        const credentials = JSON.parse(GCS_CREDENTIALS_JSON);
        storage = new Storage({ credentials, projectId: credentials.project_id });
        bucket = storage.bucket(GCS_BUCKET_NAME);
        console.log(`✅ [PatternAI GCS] Đã khởi tạo Google Cloud Storage cho bucket: ${GCS_BUCKET_NAME}`);
    } catch (error) {
        console.error("❌ [PatternAI GCS] LỖI NGHIÊM TRỌNG: Không thể parse GCS_CREDENTIALS.", error);
        process.exit(1); // Dừng ứng dụng nếu cấu hình GCS lỗi
    }
} else {
    console.warn("⚠️ [PatternAI GCS] Cảnh báo: GCS_CREDENTIALS hoặc GCS_BUCKET_NAME chưa được thiết lập.");
}

const ANALYSIS_LOOKBACK_DAYS = 90;
const WEIGHT_INCREASE_FACTOR = 1.15;
const WEIGHT_DECREASE_FACTOR = 0.90;
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 5.0;
const CONVERGENCE_BONUS = 1.5;

class PatternAnalysisService {
    constructor() {
        this.resultsByDate = new Map();
        this.sortedDates = [];
        this.knowledge = new Map();
        this.prizeToGroupMap = this.createPrizeToGroupMap();
    }

    /**
     * =================================================================
     * CƠ CHẾ LƯU VÀ TẢI "TRÍ NHỚ" THEO KIẾN TRÚC MLOPS
     * =================================================================
     */

    async loadKnowledge() {
        if (!bucket) {
            console.warn('[PatternAI V4] Không thể tải "trí nhớ" vì GCS chưa được cấu hình.');
            this.knowledge = new Map();
            return false;
        }

        const modelState = await NNState.findOne({ modelName: MODEL_NAME }).lean();

        if (modelState && modelState.state && modelState.state.gcsPath) {
            const knowledgeGcsPath = modelState.state.gcsPath.replace(`gs://${GCS_BUCKET_NAME}/`, '');
            console.log(`[PatternAI V4] Tìm thấy metadata! Đang tải "trí nhớ" từ: ${modelState.state.gcsPath}`);
            try {
                const [file] = await bucket.file(knowledgeGcsPath).download();
                const knowledgeObject = JSON.parse(file.toString());
                this.knowledge = new Map(Object.entries(knowledgeObject));
                console.log(`✅ [PatternAI V4] ĐÃ TẢI THÀNH CÔNG ${this.knowledge.size} "mảnh tri thức".`);
                return true;
            } catch (error) {
                console.error(`❌ [PatternAI V4] Lỗi khi tải file từ GCS tại '${knowledgeGcsPath}':`, error.message);
                this.knowledge = new Map();
                return false;
            }
        } else {
            console.log(`[PatternAI V4] Không tìm thấy metadata. Đây có thể là lần huấn luyện đầu tiên.`);
            this.knowledge = new Map();
            return false;
        }
    }

    async saveKnowledge() {
        if (!bucket) {
            console.warn('[PatternAI V4] Không thể lưu "trí nhớ" vì GCS chưa được cấu hình.');
            return;
        }

        const knowledgeGcsPath = `pattern_knowledge/${MODEL_NAME}_${Date.now()}.json`;
        console.log(`[PatternAI V4] Đang lưu ${this.knowledge.size} "mảnh tri thức" lên GCS tại: ${knowledgeGcsPath}`);
        
        const knowledgeObject = Object.fromEntries(this.knowledge);
        const jsonString = JSON.stringify(knowledgeObject, null, 2);

        try {
            await bucket.file(knowledgeGcsPath).save(jsonString, { contentType: 'application/json' });
            console.log(`✅ [PatternAI V4] Upload "trí nhớ" lên GCS thành công.`);

            const modelInfo = {
                modelName: MODEL_NAME,
                knowledgeSize: this.knowledge.size,
                savedAt: new Date().toISOString(),
                gcsPath: `gs://${GCS_BUCKET_NAME}/${knowledgeGcsPath}`
            };

            await NNState.findOneAndUpdate(
                { modelName: MODEL_NAME },
                { state: modelInfo },
                { upsert: true, new: true }
            );
            console.log(`✅ [PatternAI V4] Đã cập nhật metadata vào MongoDB.`);

        } catch (error) {
            console.error('❌ [PatternAI V4] Lỗi nghiêm trọng khi lưu "trí nhớ":', error.message);
        }
    }
    
    async loadDataAndKnowledge(limitDays) {
        await this.loadKnowledge();
        
        console.log(`[PatternAI V4] Đang tải ${limitDays} ngày dữ liệu KQXS...`);
        const results = await Result.find().sort({ 'ngay': -1 }).limit(limitDays * 27).lean();
        this.resultsByDate.clear();
        results.forEach(r => {
            if (!this.resultsByDate.has(r.ngay)) this.resultsByDate.set(r.ngay, []);
            this.resultsByDate.get(r.ngay).push(r);
        });

        this.sortedDates = [...this.resultsByDate.keys()].sort((a, b) => 
            DateTime.fromFormat(b, 'dd/MM/yyyy') - DateTime.fromFormat(a, 'dd/MM/yyyy')
        );
    }

    /**
     * =================================================================
     * CÁC HÀM API CHÍNH (Được gọi từ Controller)
     * =================================================================
     */

    async resetAndRebuildAll() {
        console.log('💥 [PatternAI V4] BẮT ĐẦU QUÁ TRÌNH RESET VÀ HUẤN LUYỆN LẠI TOÀN BỘ!');
        
        await PatternPrediction.deleteMany({});
        await NNState.deleteOne({ modelName: MODEL_NAME });
        this.knowledge = new Map();
        if (bucket) {
            await bucket.file(`pattern_knowledge/${MODEL_NAME}_knowledge.json`).delete({ ignoreNotFound: true });
        }
        console.log('[PatternAI V4] Đã xóa dữ liệu cũ và reset "trí nhớ".');

        const backtestResult = await this.generateHistoricalPredictions();
        const nextDayPrediction = await this.generatePredictionForNextDay();
        await this.saveKnowledge();

        return {
            message: `Reset và huấn luyện lại hoàn tất! Đã xây dựng lại "trí nhớ", tạo ${backtestResult.created} dự đoán lịch sử và 1 dự đoán cho ngày tiếp theo.`,
            historicalCount: backtestResult.created,
            nextDay: nextDayPrediction.ngayDuDoan
        };
    }

    async learnAndPredictForward() {
        console.log('📚 [PatternAI V4] Bắt đầu quy trình: HỌC & DỰ ĐOÁN TIẾN TỚI...');
        
        await this.learnFromResults(); // Đã bao gồm load và save knowledge
        
        console.log('[PatternAI V4] Tìm và tạo dự đoán cho các ngày còn thiếu...');
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 10);

        const lastPrediction = await PatternPrediction.findOne().sort({ ngayDuDoan: -1 });
        const lastResultDateStr = this.sortedDates[0];
        
        if (!lastPrediction) {
            return [await this.generatePredictionForNextDay()];
        }

        let startDate = DateTime.fromFormat(lastPrediction.ngayDuDoan, 'dd/MM/yyyy');
        const endDate = DateTime.fromFormat(lastResultDateStr, 'dd/MM/yyyy');

        const predictionsMade = [];
        if (startDate < endDate) {
            while(startDate < endDate) {
                startDate = startDate.plus({ days: 1 });
                const targetDate = startDate.toFormat('dd/MM/yyyy');
                console.log(`[PatternAI V4] Lấp đầy ngày còn thiếu: ${targetDate}...`);
                predictionsMade.push(await this._generatePredictionForDate(targetDate));
            }
        }

        const finalPrediction = await this.generatePredictionForNextDay();
        predictionsMade.push(finalPrediction);

        console.log(`✅ [PatternAI V4] Quy trình hoàn tất. Đã tạo ${predictionsMade.length} dự đoán mới.`);
        return predictionsMade;
    }
    
    async generateHistoricalPredictions() {
        console.log('🏛️ [PatternAI V4] Bắt đầu quá trình Backtest Lịch sử...');
        await this.loadDataAndKnowledge(9999);
        const historicalDates = [...this.sortedDates].reverse();
        let createdCount = 0;
        const totalDaysToProcess = Math.max(0, historicalDates.length - ANALYSIS_LOOKBACK_DAYS);

        for (let i = ANALYSIS_LOOKBACK_DAYS; i < historicalDates.length; i++) {
            const targetDate = historicalDates[i];
            const actualGDBResult = (this.resultsByDate.get(targetDate) || []).find(r => r.giai === 'ĐB');
            if (!actualGDBResult || !actualGDBResult.so) continue;

            const timeMachineService = new PatternAnalysisService();
            const dataForThisRun = historicalDates.slice(0, i);
            timeMachineService.sortedDates = [...dataForThisRun].reverse();
            timeMachineService.resultsByDate = this.resultsByDate;
            timeMachineService.knowledge = this.knowledge; // Dùng chung trí nhớ để xây dựng dần

            const predictions = {};
            for (let j = 0; j < 5; j++) {
                predictions[['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'][j]] = await timeMachineService.runAnalysisPipelineForPosition(j);
            }

            await PatternPrediction.findOneAndUpdate({ ngayDuDoan: targetDate }, { ngayDuDoan: targetDate, ...predictions, hasActualResult: true }, { upsert: true });
            createdCount++;
        }
        console.log(`✅ [PatternAI V4] Hoàn tất Backtest! Đã tạo/cập nhật ${createdCount} bản ghi.`);
        return { created: createdCount, total: totalDaysToProcess };
    }

    async learnFromResults() {
        console.log('🧠 [PatternAI V4] Bắt đầu học hỏi...');
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 10);
        
        const predictionsToLearn = await PatternPrediction.find({ hasActualResult: false }).lean();
        if (predictionsToLearn.length === 0) return;

        let learnedCount = 0;
        for (const pred of predictionsToLearn) {
            const actualGDBResult = (this.resultsByDate.get(pred.ngayDuDoan) || []).find(r => r.giai === 'ĐB');
            if (!actualGDBResult || !actualGDBResult.so) {
                await PatternPrediction.updateOne({ _id: pred._id }, { hasActualResult: true });
                continue;
            }
            const actualGDB = String(actualGDBResult.so).padStart(5, '0');
            const dayBeforePrediction = this.sortedDates[this.sortedDates.indexOf(pred.ngayDuDoan) + 1];

            for (let i = 0; i < 5; i++) {
                const actualDigit = actualGDB[i];
                const timeMachineTraces = this.findHistoricalTraces(i, dayBeforePrediction);
                const patterns = this.detectPatterns(timeMachineTraces);
                for (const p of patterns) {
                    const nextStep = this.getNextStep(p);
                    if (!nextStep) continue;
                    const result = (this.resultsByDate.get(dayBeforePrediction) || []).find(r => r.giai === nextStep.prize);
                    const isHit = result && result.so && String(result.so).includes(actualDigit);
                    this.updateKnowledge(p.key, p.type, isHit, pred.ngayDuDoan);
                }
            }
            learnedCount++;
            await PatternPrediction.updateOne({ _id: pred._id }, { hasActualResult: true });
        }
        await this.saveKnowledge();
        console.log(`✅ [PatternAI V4] Học hỏi từ ${learnedCount} kết quả và lưu trí nhớ hoàn tất!`);
    }

    async _generatePredictionForDate(targetDate) {
        console.log(`[PatternAI V4] Generating for specific date: ${targetDate}...`);
        const serviceForDate = new PatternAnalysisService();
        await serviceForDate.loadDataAndKnowledge(9999);
        const dateIndex = serviceForDate.sortedDates.indexOf(targetDate);
        if (dateIndex > -1) {
            serviceForDate.sortedDates = serviceForDate.sortedDates.slice(dateIndex + 1);
        }

        const predictions = {};
        for (let j = 0; j < 5; j++) {
            predictions[['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'][j]] = await serviceForDate.runAnalysisPipelineForPosition(j);
        }

        return await PatternPrediction.findOneAndUpdate({ ngayDuDoan: targetDate }, { ngayDuDoan: targetDate, ...predictions, hasActualResult: false }, { upsert: true, new: true });
    }
    
    async generatePredictionForNextDay() {
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 5);
        if (this.sortedDates.length === 0) throw new Error("Không đủ dữ liệu.");
        const latestDate = this.sortedDates[0];
        const nextDay = DateTime.fromFormat(latestDate, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
        return this._generatePredictionForDate(nextDay);
    }
    
    // ... (Toàn bộ các hàm logic phân tích cốt lõi và tiện ích được giữ nguyên từ phiên bản trước)
    // Dưới đây là các hàm đó để đảm bảo file đầy đủ.

    async runAnalysisPipelineForPosition(gdbPositionIndex) {
        const historicalTraces = this.findHistoricalTraces(gdbPositionIndex);
        const detectedPatterns = this.detectPatterns(historicalTraces);
        const scoredPatterns = this.scorePatterns(detectedPatterns);
        const subgroupStrengths = this.evaluateSubgroupStrength(scoredPatterns);
        const { g1_digits, g2_digits, g3_digits } = this.filterByGroupLogic(subgroupStrengths);
        const primaryDigits = this.finalIntersectionAndFiltering({ g1_digits, g2_digits, g3_digits });
        const filteredPrimaryDigits = this.applyAdvancedExclusion(primaryDigits);
        let finalDigits = filteredPrimaryDigits;

        if (finalDigits.length < 5) {
            const initialPool = [...new Set([...g1_digits, ...g2_digits, ...g3_digits])];
            const scoredPool = initialPool.map(digit => {
                let score = 0;
                for (const [sgKey, strength] of Object.entries(subgroupStrengths)) {
                    if (this.getDigitsForSubgroup(sgKey).includes(digit)) score += strength;
                }
                return { digit, score };
            });
            const remainingCandidates = scoredPool.filter(item => !finalDigits.includes(item.digit)).sort((a, b) => b.score - a.score);
            const needed = 5 - finalDigits.length;
            finalDigits.push(...remainingCandidates.slice(0, needed).map(item => item.digit));
        }
        const hotDigit = this.findHotDigit(finalDigits.slice(0, 5), scoredPatterns);
        return {
            promisingDigits: finalDigits.slice(0, 5),
            hotDigit: hotDigit || (finalDigits.length > 0 ? finalDigits[0] : null),
            analysisDetails: { strongestPatterns: scoredPatterns.sort((a, b) => b.score - a.score).slice(0, 3) }
        };
    }

    findHistoricalTraces(gdbPositionIndex, fromDate = null) {
        const historicalTraces = new Map();
        const datesToScan = fromDate ? this.sortedDates.slice(this.sortedDates.indexOf(fromDate)) : this.sortedDates;
        for (let i = 0; i < Math.min(datesToScan.length - 1, ANALYSIS_LOOKBACK_DAYS); i++) {
            const currentDate = datesToScan[i];
            const previousDate = datesToScan[i + 1];
            const currentGDB = (this.resultsByDate.get(currentDate) || []).find(r => r.giai === 'ĐB');
            if (!currentGDB || !currentGDB.so) continue;
            const digitToTrace = String(currentGDB.so).padStart(5, '0')[gdbPositionIndex];
            const traces = [];
            for (const result of (this.resultsByDate.get(previousDate) || [])) {
                String(result.so).split('').forEach((d, pos) => {
                    if (d === digitToTrace) traces.push({ prize: result.giai, position: pos + 1 });
                });
            }
            if (traces.length > 0) historicalTraces.set(currentDate, { digit: digitToTrace, traces });
        }
        return historicalTraces;
    }

    detectPatterns(traces) {
        const patterns = [];
        const traceArray = [...traces.entries()];
        for (let i = 0; i < traceArray.length - 1; i++) {
            const [currentDate, currentData] = traceArray[i];
            for (const ct of currentData.traces) {
                for (let j = i + 1; j < traceArray.length; j++) {
                    const [prevDate, prevData] = traceArray[j];
                    for (const pt of prevData.traces) {
                        if (ct.prize === pt.prize && ct.position === pt.position) {
                            patterns.push({ type: 'streak', key: `${ct.prize}_p${ct.position}`, length: j - i + 1, lastDate: currentDate });
                        }
                        const prizeIndexDiff = PRIZE_ORDER.indexOf(ct.prize) - PRIZE_ORDER.indexOf(pt.prize);
                        if (prizeIndexDiff === 1 && ct.position === pt.position) {
                            patterns.push({ type: 'diagonal_prize', key: `${pt.prize}_to_${ct.prize}`, length: 2, lastDate: currentDate });
                        }
                    }
                }
            }
        }
        for (let i = 0; i < traceArray.length; i++) {
            const [date1, data1] = traceArray[i];
            for (let j = i + 2; j < traceArray.length; j++) {
                const [date2, data2] = traceArray[j];
                const dayDiff = Math.round(DateTime.fromFormat(date1, 'dd/MM/yyyy').diff(DateTime.fromFormat(date2, 'dd/MM/yyyy'), 'days').days);
                for (const t1 of data1.traces) {
                    for (const t2 of data2.traces) {
                        if (t1.prize === t2.prize && t1.position === t2.position) {
                            patterns.push({ type: 'cycle', key: `${t1.prize}_p${t1.position}_cycle${dayDiff}`, length: 2, lastDate: date1, cycleDays: dayDiff });
                        }
                    }
                }
            }
        }
        return this.consolidatePatterns(patterns);
    }

    scorePatterns(patterns) {
        return patterns.map(p => {
            const recency = (ANALYSIS_LOOKBACK_DAYS - this.sortedDates.indexOf(p.lastDate)) / ANALYSIS_LOOKBACK_DAYS;
            const baseScore = p.length * 10 * recency;
            const weight = (this.knowledge.get(p.key) || { weight: 1.0 }).weight;
            return { ...p, score: baseScore * weight };
        });
    }

    evaluateSubgroupStrength(scoredPatterns) {
        const strengths = {}, convergenceMap = {};
        Object.values(GROUPS).forEach(g => Object.keys(g.subgroups).forEach(sg => { strengths[sg] = 0; convergenceMap[sg] = 0; }));
        for (const p of scoredPatterns) {
            const nextStep = this.getNextStep(p);
            if (nextStep) {
                const subgroup = this.prizeToGroupMap.subgroup[nextStep.prize];
                if (subgroup && strengths[subgroup] !== undefined) {
                    strengths[subgroup] += p.score;
                    convergenceMap[subgroup]++;
                }
            }
        }
        for (const sgKey in strengths) {
            if (convergenceMap[sgKey] > 1) {
                strengths[sgKey] += strengths[sgKey] * CONVERGENCE_BONUS * (convergenceMap[sgKey] - 1);
            }
        }
        return strengths;
    }

    filterByGroupLogic(subgroupStrengths) {
        const findStrongestSubgroup = (groupKey) => Object.keys(GROUPS[groupKey].subgroups).reduce((s, c) => (subgroupStrengths[c] > subgroupStrengths[s]) ? c : s);
        const g1_digits = this.getDigitsForSubgroup(findStrongestSubgroup('G1'));
        const g2_digits = this.getDigitsForSubgroup(findStrongestSubgroup('G2'));
        const g3_digits_all = ['G3A', 'G3B', 'G3C'].map(sg => this.getDigitsForSubgroup(sg));
        const excludedDigits = g3_digits_all[0].filter(d => g3_digits_all[1].includes(d) && g3_digits_all[2].includes(d));
        const g3_digits = this.getDigitsForSubgroup(findStrongestSubgroup('G3')).filter(d => !excludedDigits.includes(d));
        return { g1_digits, g2_digits, g3_digits };
    }

    finalIntersectionAndFiltering({ g1_digits, g2_digits, g3_digits }) {
        const counts = [...g1_digits, ...g2_digits, ...g3_digits].reduce((acc, d) => ({ ...acc, [d]: (acc[d] || 0) + 1 }), {});
        return Object.keys(counts).filter(d => counts[d] >= 2);
    }

    applyAdvancedExclusion(digits) {
        const g7b = (this.resultsByDate.get(this.sortedDates[0]) || []).find(r => r.giai === 'G7b');
        const excluded = new Set(g7b && g7b.so ? String(g7b.so).split('') : []);
        return digits.filter(d => !excluded.has(d));
    }

    findHotDigit(digits, scoredPatterns) {
        if (!digits || digits.length === 0) return null;
        const digitScores = digits.reduce((acc, d) => ({ ...acc, [d]: 0 }), {});
        for (const p of scoredPatterns) {
            const nextStep = this.getNextStep(p);
            if (nextStep) {
                const result = (this.resultsByDate.get(this.sortedDates[0]) || []).find(r => r.giai === nextStep.prize);
                if (result && result.so) {
                    String(result.so).split('').forEach(d => {
                        if (digitScores[d] !== undefined) digitScores[d] += p.score;
                    });
                }
            }
        }
        return Object.keys(digitScores).reduce((a, b) => digitScores[a] > digitScores[b] ? a : b, digits[0]);
    }

    getDigitsForSubgroup(subgroupKey) {
        const groupKey = Object.keys(GROUPS).find(gk => GROUPS[gk].subgroups[subgroupKey]);
        if (!groupKey) return [];
        const digits = new Set();
        for (const p of GROUPS[groupKey].subgroups[subgroupKey].prizes) {
            const result = (this.resultsByDate.get(this.sortedDates[0]) || []).find(r => r.giai === p);
            if (result && result.so) String(result.so).split('').forEach(d => digits.add(d));
        }
        return [...digits];
    }

    consolidatePatterns(patterns) {
        const consolidated = new Map();
        patterns.forEach(p => {
            if (consolidated.has(p.key)) consolidated.get(p.key).length = Math.max(consolidated.get(p.key).length, p.length);
            else consolidated.set(p.key, { ...p });
        });
        return [...consolidated.values()];
    }

    getNextStep(pattern) {
        const parts = pattern.key.split('_');
        const prizeKey = parts[0];
        const lastPrizeIndex = PRIZE_ORDER.indexOf(prizeKey);
        if (lastPrizeIndex === -1 || lastPrizeIndex >= PRIZE_ORDER.length - 1) return null;
        if (pattern.type === 'streak') return { prize: PRIZE_ORDER[lastPrizeIndex] };
        if (pattern.type === 'diagonal_prize') return { prize: PRIZE_ORDER[lastPrizeIndex + 1] };
        if (pattern.type === 'cycle') return { prize: PRIZE_ORDER[lastPrizeIndex] };
        return null;
    }

    createPrizeToGroupMap() {
        const map = { subgroup: {}, group: {} };
        for (const [gk, gv] of Object.entries(GROUPS)) {
            for (const [sgk, sgv] of Object.entries(gv.subgroups)) {
                sgv.prizes.forEach(p => { map.subgroup[p] = sgk; map.group[p] = gk; });
            }
        }
        return map;
    }

    updateKnowledge(key, type, isHit, hitDate) {
        const current = this.knowledge.get(key) || { patternKey: key, type, weight: 1.0, hitCount: 0, missCount: 0 };
        current.weight = isHit ? Math.min(MAX_WEIGHT, current.weight * WEIGHT_INCREASE_FACTOR) : Math.max(MIN_WEIGHT, current.weight * WEIGHT_DECREASE_FACTOR);
        if(isHit) current.hitCount++; else current.missCount++;
        if(isHit) current.lastHit = hitDate;
        this.knowledge.set(key, current);
    }
}

module.exports = PatternAnalysisService;
