// File: services/PatternAnalysisService.js
// File: services/PatternAnalysisService.js
const axios = require('axios'); // THÊM MỚI: Thư viện để gọi API
const Result = require('../models/Result');
const PatternPrediction = require('../models/PatternPrediction');
const PatternKnowledge = require('../models/PatternKnowledge');
const { GROUPS, PRIZE_ORDER } = require('./patternAnalysis/constants');
const { DateTime } = require('luxon');

// --- CÁC HẰNG SỐ CẤU HÌNH CHO AI ---
const ANALYSIS_LOOKBACK_DAYS = 90;
const WEIGHT_INCREASE_FACTOR = 1.15;
const WEIGHT_DECREASE_FACTOR = 0.90;
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 5.0;

// THÊM MỚI: URL của AI Service Transformer bạn vừa deploy
const TRANSFORMER_AI_SERVICE_URL = 'https://my-transformer-service-production.up.railway.app/predict';

class PatternAnalysisService {
    constructor() {
        this.resultsByDate = new Map();
        this.sortedDates = [];
        this.knowledge = new Map();
        this.prizeToGroupMap = this.createPrizeToGroupMap();
    }
    
    // =================================================================
    // HÀM MỚI: GỌI AI SERVICE TRANSFORMER
    // =================================================================
    /**
     * Gửi yêu cầu đến AI Service Python để lấy dự đoán từ mô hình Transformer.
     * @returns {Promise<object|null>} - Một object chứa dự đoán cho 5 vị trí hoặc null nếu có lỗi.
     */
    async getTransformerPrediction() {
    try {
        // --- THAY ĐỔI LỚN Ở ĐÂY ---
        // 1. Lấy dữ liệu 90 ngày
        const historyDays = this.sortedDates.slice(0, 90);
        
        // 2. Tự tiền xử lý dữ liệu ngay tại Node.js
        console.log(`[Node.js Preprocessing] Chuẩn bị chuỗi text từ ${historyDays.length} ngày...`);
        let inputText = '';
        for (const date of historyDays.reverse()) { // Xử lý từ cũ -> mới
            const dayResults = this.resultsByDate.get(date) || [];
            // Nối tất cả các số của ngày đó thành một chuỗi
            inputText += dayResults.map(r => String(r.so || '')).join('');
        }
        
        if (inputText.length < 100) { // Kiểm tra đơn giản
             console.warn('⚠️ [Transformer AI] Dữ liệu sau tiền xử lý quá ngắn, bỏ qua.');
             return null;
        }

        console.log(`🤖 [Transformer AI] Đang gửi chuỗi text (dài ${inputText.length} ký tự) đến service...`);

        // 3. Gửi đi chuỗi text đã được xử lý
        const response = await axios.post(TRANSFORMER_AI_SERVICE_URL, {
            // Thay vì `history: historyData`, gửi `input_text`
            input_text: inputText 
        }, { timeout: 30000 }); // Tăng timeout lên 30 giây

        // ... phần còn lại giữ nguyên
        if (response.data && response.data.success) {
            console.log('✅ [Transformer AI] Nhận dự đoán thành công!');
            return response.data.prediction;
        } else {
            console.error('❌ [Transformer AI] Service trả về lỗi:', response.data.message);
            return null;
        }
    } catch (error) {
            console.error('❌ [Transformer AI] Lỗi nghiêm trọng khi gọi Python service:', error.message);
            return null;
        }
    }

    // =================================================================
    // HÀM LÕI ĐƯỢC NÂNG CẤP ĐỂ TÍCH HỢP TRANSFORMER
    // =================================================================
    /**
     * Hàm lõi để tạo dự đoán cho một ngày CỤ THỂ, đã được nâng cấp để kết hợp 2 AI.
     * @private
     */
    async _generatePredictionForDate(targetDate) {
        console.log(`[PatternAI] Generating HYBRID prediction for: ${targetDate}...`);
        
        // Tải dữ liệu và kiến thức cho lần chạy này
        const serviceForDate = new PatternAnalysisService();
        await serviceForDate.loadDataAndKnowledge(9999);
        const dateIndex = serviceForDate.sortedDates.indexOf(targetDate);
        if (dateIndex > -1) {
            serviceForDate.sortedDates = serviceForDate.sortedDates.slice(dateIndex + 1);
        }

        // BƯỚC 1: Lấy dự đoán từ AI Transformer (chỉ gọi 1 lần)
        const transformerPrediction = await serviceForDate.getTransformerPrediction();

        const predictions = {};
        const positions = ['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'];

        for (let i = 0; i < positions.length; i++) {
            const positionKey = positions[i];
            
            // BƯỚC 2: Lấy dự đoán từ AI Phân tích Mẫu hình (như cũ)
            const patternPrediction = await serviceForDate.runAnalysisPipelineForPosition(i);
            
            // BƯỚC 3: KẾT HỢP KẾT QUẢ (Ensemble Method)
            if (transformerPrediction && transformerPrediction[positionKey] !== undefined) {
                const transformerDigit = String(transformerPrediction[positionKey]);
                
                // Logic kết hợp: Ưu tiên đưa số của Transformer lên đầu danh sách
                // và đảm bảo không bị trùng lặp.
                const combinedDigits = [
                    transformerDigit,
                    ...patternPrediction.promisingDigits.filter(d => d !== transformerDigit)
                ];
                
                patternPrediction.promisingDigits = combinedDigits.slice(0, 5);
                // Đặt số của Transformer làm "hot digit" để nhấn mạnh
                patternPrediction.hotDigit = transformerDigit;
                
                // Thêm ghi chú vào analysisDetails
                patternPrediction.analysisDetails.transformerSuggestion = transformerDigit;
            }

            predictions[positionKey] = patternPrediction;
        }

        return await PatternPrediction.findOneAndUpdate(
            { ngayDuDoan: targetDate },
            { ngayDuDoan: targetDate, ...predictions, hasActualResult: false },
            { upsert: true, new: true }
        );
    }
        
    // =================================================================
    // CÁC HÀM CŨ - Giữ nguyên không thay đổi
    // (Bao gồm resetAndRebuildAll, learnAndPredictForward, generateHistoricalPredictions, learnFromResults, etc.)
    // =================================================================
    
    /**
     * +++ HÀM MỚI: Reset, Huấn luyện lại từ đầu và Tạo dự đoán mới +++
     */
    async resetAndRebuildAll() {
        console.log('💥 [PatternAI] BẮT ĐẦU QUÁ TRÌNH RESET VÀ HUẤN LUYỆN LẠI TOÀN BỘ!');
        
        console.log('[PatternAI] Bước 1/3: Đang xóa dữ liệu dự đoán cũ...');
        await PatternPrediction.deleteMany({});
        console.log('[PatternAI] Xóa thành công!');

        console.log('[PatternAI] Bước 2/3: Bắt đầu quá trình Backtest lịch sử...');
        const backtestResult = await this.generateHistoricalPredictions();
        console.log(`[PatternAI] Backtest hoàn tất, đã tạo ${backtestResult.created} bản ghi.`);

        console.log('[PatternAI] Bước 3/3: Bắt đầu tạo dự đoán cho ngày tiếp theo...');
        const nextDayPrediction = await this.generatePredictionForNextDay();
        console.log(`[PatternAI] Đã tạo dự đoán cho ngày ${nextDayPrediction.ngayDuDoan}.`);

        return {
            message: `Reset và huấn luyện lại hoàn tất! Đã tạo ${backtestResult.created} dự đoán lịch sử và 1 dự đoán cho ngày tiếp theo.`,
            historicalCount: backtestResult.created,
            nextDay: nextDayPrediction.ngayDuDoan
        };
    }

    /**
     * +++ HÀM NÂNG CẤP: Học hỏi và lấp đầy các ngày còn thiếu +++
     */
    async learnAndPredictForward() {
        console.log('📚 [PatternAI] Bắt đầu quy trình: HỌC & DỰ ĐOÁN TIẾN TỚI...');
        
        console.log('[PatternAI] Bước 1/2: Đang học hỏi từ kết quả mới...');
        await this.learnFromResults();
        
        console.log('[PatternAI] Bước 2/2: Tìm và tạo dự đoán cho các ngày còn thiếu...');
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 10);

        const lastPrediction = await PatternPrediction.findOne().sort({ ngayDuDoan: -1 });
        const lastResultDateStr = this.sortedDates[0];
        
        if (!lastPrediction) {
            console.log('[PatternAI] Không có dự đoán nào, sẽ chỉ tạo cho ngày mai.');
            return [await this.generatePredictionForNextDay()];
        }

        let startDate = DateTime.fromFormat(lastPrediction.ngayDuDoan, 'dd/MM/yyyy');
        const endDate = DateTime.fromFormat(lastResultDateStr, 'dd/MM/yyyy');

        const predictionsMade = [];
        if (startDate >= endDate) {
            console.log('[PatternAI] Dữ liệu dự đoán đã được cập nhật. Chỉ tạo cho ngày mai.');
        } else {
            while(startDate < endDate) {
                startDate = startDate.plus({ days: 1 });
                const targetDate = startDate.toFormat('dd/MM/yyyy');
                console.log(`[PatternAI] Phát hiện ngày còn thiếu: ${targetDate}. Đang tạo dự đoán...`);
                const prediction = await this._generatePredictionForDate(targetDate);
                predictionsMade.push(prediction);
            }
        }

        const finalPrediction = await this.generatePredictionForNextDay();
        predictionsMade.push(finalPrediction);

        console.log(`✅ [PatternAI] Quy trình hoàn tất. Đã tạo ${predictionsMade.length} dự đoán mới.`);
        return predictionsMade;
    }
        
    /**
     * TẠO DỰ ĐOÁN CHO TOÀN BỘ LỊCH SỬ (BACKTEST)
     */
    async generateHistoricalPredictions() {
        console.log('🏛️ [PatternAI] Bắt đầu quá trình Backtest Lịch sử (Phiên bản cuối cùng)...');
        
        // BƯỚC 1: Tải toàn bộ dữ liệu MỘT LẦN DUY NHẤT
        await this.loadDataAndKnowledge(9999); 
        
        // BƯỚC 2: Sắp xếp ngày tháng một cách chính xác, từ CŨ -> MỚI
        const historicalDates = [...this.sortedDates].reverse(); 
        
        let createdCount = 0;
        const totalDaysToProcess = Math.max(0, historicalDates.length - ANALYSIS_LOOKBACK_DAYS);
        console.log(`[PatternAI] Sẽ xử lý khoảng ${totalDaysToProcess} ngày có đủ dữ liệu.`);

        // BƯỚC 3: Lặp qua từng ngày lịch sử theo đúng thứ tự thời gian
        for (let i = ANALYSIS_LOOKBACK_DAYS; i < historicalDates.length; i++) {
            const targetDate = historicalDates[i];
            
            const actualGDBResult = (this.resultsByDate.get(targetDate) || []).find(r => r.giai === 'ĐB');
            if (!actualGDBResult || !actualGDBResult.so) continue;

            console.log(`\n⏳ Backtesting for date: ${targetDate}...`);

            // BƯỚC 4: Tạo "cỗ máy thời gian" service
            const timeMachineService = new PatternAnalysisService();
            
            // Cắt ra chính xác những ngày xảy ra TRƯỚC targetDate
            const dataForThisRun = historicalDates.slice(0, i); 
            
            // Truyền dữ liệu và kiến thức, KHÔNG ĐỌC LẠI TỪ DB
            // Sửa logic: Chỉ truyền những ngày liên quan vào sortedDates
            timeMachineService.sortedDates = [...dataForThisRun].reverse(); // Sắp xếp lại từ mới -> cũ cho service
            timeMachineService.resultsByDate = this.resultsByDate;
            timeMachineService.knowledge = this.knowledge; // Dùng chung "trí nhớ" để tích lũy

            // BƯỚC 5: Lấy dự đoán từ cả 2 hệ thống AI
            const transformerPrediction = await timeMachineService.getTransformerPrediction();

            const predictions = {};
            const positions = ['hangChucNgan', 'hangNgan', 'hangTram', 'hangChuc', 'hangDonVi'];
            for (let j = 0; j < positions.length; j++) {
                const positionKey = positions[j];
                const patternPrediction = await timeMachineService.runAnalysisPipelineForPosition(j);

                if (transformerPrediction && transformerPrediction[positionKey] !== undefined) {
                    const transformerDigit = String(transformerPrediction[positionKey]);
                    const combinedDigits = [
                        transformerDigit,
                        ...patternPrediction.promisingDigits.filter(d => d !== transformerDigit)
                    ];
                    patternPrediction.promisingDigits = combinedDigits.slice(0, 5);
                    patternPrediction.hotDigit = transformerDigit;
                    patternPrediction.analysisDetails.transformerSuggestion = transformerDigit;
                }
                predictions[positionKey] = patternPrediction;
            }

            // BƯỚC 6: Lưu kết quả vào DB
            await PatternPrediction.findOneAndUpdate(
                { ngayDuDoan: targetDate },
                { 
                    ngayDuDoan: targetDate, 
                    ...predictions,
                    hasActualResult: true 
                },
                { upsert: true, new: true }
            );
            createdCount++;
            
            if (createdCount % 20 === 0) {
                console.log(`... Đã xử lý ${createdCount} / ${totalDaysToProcess} ngày ...`);
            }
        }

        console.log(`✅ [PatternAI] Hoàn tất Backtest! Đã tạo/cập nhật ${createdCount} bản ghi lịch sử.`);
        return { created: createdCount, total: totalDaysToProcess };
    }

    /**
     * DẠY CHO AI HỌC TỪ KẾT QUẢ MỚI
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

    // Phần còn lại của file giữ nguyên
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
                    const digitsOfSubgroup = this.getDigitsForSubgroup(sgKey);
                    if (digitsOfSubgroup.includes(digit)) {
                        score += strength;
                    }
                }
                return { digit, score };
            });

            const remainingCandidates = scoredPool
                .filter(item => !finalDigits.includes(item.digit))
                .sort((a, b) => b.score - a.score);
                
            const needed = 5 - finalDigits.length;
            const fallbackDigits = remainingCandidates.slice(0, needed).map(item => item.digit);
            finalDigits = [...finalDigits, ...fallbackDigits];
        }

        const hotDigit = this.findHotDigit(finalDigits.slice(0, 5), scoredPatterns);

        return {
            promisingDigits: finalDigits.slice(0, 5),
            hotDigit: hotDigit || (finalDigits.length > 0 ? finalDigits[0] : null),
            analysisDetails: {
                strongestPatterns: scoredPatterns.sort((a,b) => b.score - a.score).slice(0, 3)
            }
        };
    }

    async loadDataAndKnowledge(limitDays) {
        console.log(`[PatternAI] Đang tải ${limitDays} ngày dữ liệu...`);
        const results = await Result.find().sort({ 'ngay': -1 }).limit(limitDays * 27).lean();
        this.resultsByDate.clear();
        results.forEach(r => {
            if (!this.resultsByDate.has(r.ngay)) this.resultsByDate.set(r.ngay, []);
            this.resultsByDate.get(r.ngay).push(r);
        });

        this.sortedDates = [...this.resultsByDate.keys()].sort((a, b) => 
            DateTime.fromFormat(b, 'dd/MM/yyyy') - DateTime.fromFormat(a, 'dd/MM/yyyy')
        );

        const knowledgeDoc = await PatternKnowledge.findOne({ modelName: 'PatternAnalyzerV1' });
        if (knowledgeDoc && knowledgeDoc.knowledgeBase) {
            this.knowledge = knowledgeDoc.knowledgeBase;
            console.log(`[PatternAI] Đã tải ${this.knowledge.size} "mảnh tri thức".`);
        }
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
                        const currentPrizeIndex = PRIZE_ORDER.indexOf(ct.prize);
                        const symmetricPrizeIndex = PRIZE_ORDER.length - 1 - currentPrizeIndex;
                        const symmetricPrize = PRIZE_ORDER[symmetricPrizeIndex];
                        if (pt.prize === symmetricPrize && ct.position === pt.position) {
                            patterns.push({ type: 'symmetry', key: `${ct.prize}_sym_${pt.prize}_p${ct.position}`, length: 2, lastDate: currentDate });
                        }
                        if (ct.prize === pt.prize && ct.position !== pt.position) {
                           patterns.push({ type: 'intra_prize_move', key: `${ct.prize}_p${pt.position}_to_p${ct.position}`, length: 2, lastDate: currentDate });
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
        const digitFrequency = new Map();
        traceArray.forEach(([date, data]) => {
            digitFrequency.set(data.digit, (digitFrequency.get(data.digit) || 0) + 1);
        });
        const sortedFrequency = [...digitFrequency.entries()].sort((a, b) => b[1] - a[1]);
        if (sortedFrequency.length > 0) {
            for (let i = 0; i < Math.min(2, sortedFrequency.length); i++) {
                const [digit, count] = sortedFrequency[i];
                patterns.push({ type: 'frequency_hot', key: `digit_${digit}_hot`, digit: digit, length: count, lastDate: traceArray[0][0] });
            }
        }
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
        const findStrongestSubgroup = (groupKey) => {
            const subgroupKeys = Object.keys(GROUPS[groupKey].subgroups);
            return subgroupKeys.reduce((strongest, current) => 
                (subgroupStrengths[current] > subgroupStrengths[strongest]) ? current : strongest
            );
        };
        const strongestG1 = findStrongestSubgroup('G1');
        const strongestG2 = findStrongestSubgroup('G2');
        const g1_digits = this.getDigitsForSubgroup(strongestG1);
        const g2_digits = this.getDigitsForSubgroup(strongestG2);
        const g3a_digits = this.getDigitsForSubgroup('G3A');
        const g3b_digits = this.getDigitsForSubgroup('G3B');
        const g3c_digits = this.getDigitsForSubgroup('G3C');
        const excludedDigits = g3a_digits.filter(d => g3b_digits.includes(d) && g3c_digits.includes(d));
        const strongestG3 = findStrongestSubgroup('G3');
        const strongestG3_digits = this.getDigitsForSubgroup(strongestG3);
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
        if (this.sortedDates.length === 0) return digits;
        const lastDayResults = this.resultsByDate.get(this.sortedDates[0]) || [];
        const g7b = lastDayResults.find(r => r.giai === 'G7b');
        const excluded = new Set();
        if (g7b && g7b.so) String(g7b.so).split('').forEach(d => excluded.add(d));
        return digits.filter(d => !excluded.has(d));
    }

    findHotDigit(digits, scoredPatterns) {
        if (!digits || digits.length === 0) return null;
        const digitScores = digits.reduce((acc, d) => ({ ...acc, [d]: 0 }), {});
        for (const p of scoredPatterns) {
            const nextStep = this.getNextStep(p);
            if (nextStep) {
                if (this.sortedDates.length === 0) continue;
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
        return Object.keys(digitScores).reduce((a, b) => digitScores[a] > digitScores[b] ? a : b, digits[0]);
    }
    
    async generatePredictionForNextDay() {
        await this.loadDataAndKnowledge(ANALYSIS_LOOKBACK_DAYS + 5);
        if (this.sortedDates.length === 0) throw new Error("Không đủ dữ liệu.");
        const latestDate = this.sortedDates[0];
        const nextDay = DateTime.fromFormat(latestDate, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
        return this._generatePredictionForDate(nextDay);
    }

    getDigitsForSubgroup(subgroupKey) {
        const groupKey = Object.keys(GROUPS).find(gk => GROUPS[gk].subgroups[subgroupKey]);
        if (!groupKey) return [];
        const prizes = GROUPS[groupKey].subgroups[subgroupKey].prizes;
        const digits = new Set();
        if (this.sortedDates.length === 0) return [];
        const lastDayResults = this.resultsByDate.get(this.sortedDates[0]) || [];
        for (const p of prizes) {
            const result = lastDayResults.find(r => r.giai === p);
            if (result && result.so) {
                String(result.so).split('').forEach(d => digits.add(d));
            }
        }
        return [...digits];
    }
    
    consolidatePatterns(patterns) {
        const consolidated = new Map();
        for (const p of patterns) {
            if (consolidated.has(p.key)) {
                consolidated.get(p.key).length++;
            } else {
                consolidated.set(p.key, { ...p });
            }
        }
        return [...consolidated.values()];
    }

    getNextStep(pattern) {
        const parts = pattern.key.split('_');
        const prizeKey = parts[0];
        const lastPrizeIndex = PRIZE_ORDER.indexOf(prizeKey);
        if (lastPrizeIndex === -1) {
            if (pattern.type === 'frequency_hot') return null;
            return null;
        }
        if (lastPrizeIndex >= PRIZE_ORDER.length - 1) return null;
        switch (pattern.type) {
            case 'streak':
            case 'cycle':
            case 'intra_prize_move':
                return { prize: PRIZE_ORDER[lastPrizeIndex] };
            case 'diagonal_prize':
                return { prize: PRIZE_ORDER[lastPrizeIndex + 1] };
            case 'symmetry':
                const symmetricIndex = PRIZE_ORDER.length - 1 - lastPrizeIndex;
                return { prize: PRIZE_ORDER[symmetricIndex] };
            default:
                return null;
        }
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
            current.weight = Math.min(MAX_WEIGHT, current.weight * WEIGHT_INCREASE_FACTOR);
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
