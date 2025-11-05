// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const { DateTime } = require('luxon');
const crawlService = require('../services/crawlService');
const groupExclusionService = require('../services/groupExclusionService');

async function getLatestTwoDaysResults() {
    // 1. Lấy tất cả các ngày duy nhất có trong CSDL
    const allDates = await Result.distinct('ngay');

    // 2. Chuyển đổi và sắp xếp ngày tháng một cách chính xác
    // Vì format "dd/MM/yyyy" không thể sắp xếp chuỗi đúng được
    const sortedDates = allDates.sort((a, b) => {
        const [dayA, monthA, yearA] = a.split('/').map(Number);
        const [dayB, monthB, yearB] = b.split('/').map(Number);
        const dateA = new Date(yearA, monthA - 1, dayA);
        const dateB = new Date(yearB, monthB - 1, dayB);
        return dateB - dateA; // Sắp xếp giảm dần (ngày mới nhất trước)
    });

    // 3. Kiểm tra xem có đủ dữ liệu không
    if (sortedDates.length < 2) {
        throw new Error('Không đủ dữ liệu để phân tích (yêu cầu ít nhất 2 ngày).');
    }

    // 4. Lấy ra 2 ngày gần nhất
    const latestDateStr = sortedDates[0];
    const prevDateStr = sortedDates[1];

    console.log(`Analyzing with latest date: ${latestDateStr} and previous date: ${prevDateStr}`);

    // 5. Lấy toàn bộ kết quả của 2 ngày đó
    const [latestResults, prevResults] = await Promise.all([
        Result.find({ ngay: latestDateStr }).lean(),
        Result.find({ ngay: prevDateStr }).lean()
    ]);

    // 6. Trả về kết quả
    return {
        latestResults,
        prevResults
    };
}


const METHOD_GOC = 'PHUONG_PHAP_GOC';
const METHOD_DEEP_30_DAY = 'DEEP_30_DAY';
const METHOD_GDB_14_DAY = 'GDB_14_DAY';
const METHOD_TONG_CHAM = 'TONG_CHAM_90_DAY';
const METHOD_BAC_NHO = 'BAC_NHO_VI_TRI_90_DAY';
const METHOD_CHAN_LE = 'MAU_HINH_CHAN_LE_90_DAY';
const ALL_METHODS = [METHOD_GOC, METHOD_DEEP_30_DAY, METHOD_GDB_14_DAY, METHOD_TONG_CHAM, METHOD_BAC_NHO, METHOD_CHAN_LE];

const INITIAL_TRUST_SCORE = 1.0;
const TRUST_SCORE_INCREMENT = 0.2;
const TRUST_SCORE_DECREMENT = 0.1;
const MIN_TRUST_SCORE = 0.1;
const MAX_TRUST_SCORE = 5.0;

/* =================================================================
 * PHẦN 1: CÁC MODULE PHÂN TÍCH RIÊNG LẺ
 * ================================================================= */

const runMethodGoc = (prevDayResults) => {
  const counts = { tram: {}, chuc: {}, donvi: {} }; const chiTietGoc = [];
  prevDayResults.forEach((r, idx) => { const num = String(r.so).padStart(3, '0').slice(-3); const [tram, chuc, donvi] = num.split(''); if (tram) counts.tram[tram] = (counts.tram[tram] || 0) + 1; if (chuc) counts.chuc[chuc] = (counts.chuc[chuc] || 0) + 1; if (donvi) counts.donvi[donvi] = (counts.donvi[donvi] || 0) + 1; chiTietGoc.push({ number: r.so, positionInPrize: idx, tram, chuc, donvi, weight: 1 }); });
  const generatePrediction = (initialCounts) => { const allDigits=['0','1','2','3','4','5','6','7','8','9']; const allCounts=allDigits.map(d=>({k:d,v:initialCounts[d]||0})); const top5Hot=[...allCounts].sort((a,b)=>b.v-a.v).slice(0,5).map(o=>o.k); const top5Cold=[...allCounts].sort((a,b)=>a.v-b.v).slice(0,5).map(o=>o.k); const keeperSet=allDigits.filter(d=>!top5Cold.includes(d)); const intersection=top5Hot.filter(d=>keeperSet.includes(d)); const remainingKeepers=keeperSet.filter(d=>!intersection.includes(d)); return [...intersection,...remainingKeepers].slice(0,5); };
  return { topTram: generatePrediction(counts.tram), topChuc: generatePrediction(counts.chuc), topDonVi: generatePrediction(counts.donvi), chiTietGoc };
};
const runMethodDeep30Day = (endDateIndex, days, groupedResults, prevDayGDB) => {
    const LOOKBACK_DAYS = 30; const TIME_DECAY_FACTOR = 0.98; const SCORE_WEIGHTS = { TIME_DECAY_FREQUENCY: 1.5, GAP: 1.0, PATTERN: 2.0 }; const allDigits=['0','1','2','3','4','5','6','7','8','9'];
    const weightedFrequencies = { tram: {}, chuc: {}, donvi: {} }; const lastSeenDay = { tram: {}, chuc: {}, donvi: {} }; const transitionCounts = { tram: {}, chuc: {}, donvi: {} };
    allDigits.forEach(d => { weightedFrequencies.tram[d] = 0; weightedFrequencies.chuc[d] = 0; weightedFrequencies.donvi[d] = 0; lastSeenDay.tram[d] = LOOKBACK_DAYS; lastSeenDay.chuc[d] = LOOKBACK_DAYS; lastSeenDay.donvi[d] = LOOKBACK_DAYS; transitionCounts.tram[d] = {}; transitionCounts.chuc[d] = {}; transitionCounts.donvi[d] = {}; });
    const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex);
    for (let i = 1; i < analysisDays.length; i++) {
        const todayResult = (groupedResults[analysisDays[i]] || []).find(r => r.giai === 'ĐB'); const yesterdayResult = (groupedResults[analysisDays[i-1]] || []).find(r => r.giai === 'ĐB');
        if (todayResult?.so && yesterdayResult?.so) {
            const todayNum = String(todayResult.so).slice(-3); const yesterdayNum = String(yesterdayResult.so).slice(-3);
            if (todayNum.length === 3 && yesterdayNum.length === 3) {
                const [tram, chuc, donvi] = todayNum.split(''); const prevDonvi = yesterdayNum[2]; const daysAgo = analysisDays.length-1-i; const weight = Math.pow(TIME_DECAY_FACTOR, daysAgo);
                weightedFrequencies.tram[tram]+=weight; weightedFrequencies.chuc[chuc]+=weight; weightedFrequencies.donvi[donvi]+=weight; lastSeenDay.tram[tram]=daysAgo; lastSeenDay.chuc[chuc]=daysAgo; lastSeenDay.donvi[donvi]=daysAgo;
                transitionCounts.tram[prevDonvi][tram] = (transitionCounts.tram[prevDonvi][tram] || 0) + 1; transitionCounts.chuc[prevDonvi][chuc] = (transitionCounts.chuc[prevDonvi][chuc] || 0) + 1; transitionCounts.donvi[prevDonvi][donvi] = (transitionCounts.donvi[prevDonvi][donvi] || 0) + 1;
            }
        }
    }
    const finalScores = { tram: [], chuc: [], donvi: [] }; const prevDonvi = prevDayGDB ? String(prevDayGDB.so).slice(-1) : null;
    ['tram','chuc','donvi'].forEach(pos => { const scores = allDigits.map(digit => { let score=0; score+=(weightedFrequencies[pos][digit]||0)*SCORE_WEIGHTS.TIME_DECAY_FREQUENCY; score+=(lastSeenDay[pos][digit]||0)*SCORE_WEIGHTS.GAP; if(prevDonvi && transitionCounts[pos][prevDonvi]?.[digit]){score+=transitionCounts[pos][prevDonvi][digit]*SCORE_WEIGHTS.PATTERN;} return {digit,score}; }); finalScores[pos] = scores.sort((a,b)=>b.score-a.score).slice(0,5).map(s=>s.digit); });
    return { topTram: finalScores.tram, topChuc: finalScores.chuc, topDonVi: finalScores.donvi };
};
const runMethodGDB14Day = (endDateIndex, days, groupedResults) => {
    const LOOKBACK_DAYS=14; const frequencies={tram:{},chuc:{},donvi:{}}; const startIndex=Math.max(0,endDateIndex-LOOKBACK_DAYS); const analysisDays=days.slice(startIndex,endDateIndex);
    analysisDays.forEach(day => { const dbResult = (groupedResults[day]||[]).find(r=>r.giai==='ĐB'); if(dbResult?.so){ const numStr=String(dbResult.so).slice(-3); if(numStr.length===3){const [tram,chuc,donvi]=numStr.split(''); if(tram)frequencies.tram[tram]=(frequencies.tram[tram]||0)+1; if(chuc)frequencies.chuc[chuc]=(frequencies.chuc[chuc]||0)+1; if(donvi)frequencies.donvi[donvi]=(frequencies.donvi[donvi]||0)+1;}} });
    const getTop5=(freqs)=>Object.entries(freqs).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    return {topTram:getTop5(frequencies.tram),topChuc:getTop5(frequencies.chuc),topDonVi:getTop5(frequencies.donvi)};
};
const runMethodTongCham = (endDateIndex, days, groupedResults) => {
    const LOOKBACK_DAYS=90; const allDigits=['0','1','2','3','4','5','6','7','8','9']; const sumFrequencies={}; const touchGaps={}; allDigits.forEach(d=>touchGaps[d]=LOOKBACK_DAYS);
    const startIndex=Math.max(0,endDateIndex-LOOKBACK_DAYS); const analysisDays=days.slice(startIndex,endDateIndex);
    analysisDays.forEach((day,dayIndex)=>{ const dbResult=(groupedResults[day]||[]).find(r=>r.giai==='ĐB'); if(dbResult?.so){const numStr=String(dbResult.so).slice(-3); if(numStr.length===3){const digits=numStr.split('').map(Number); const sum=digits.reduce((a,b)=>a+b,0); sumFrequencies[sum]=(sumFrequencies[sum]||0)+1; [...new Set(digits)].forEach(d=>touchGaps[String(d)]=analysisDays.length-1-dayIndex);}} });
    const top3Sums=Object.entries(sumFrequencies).sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>parseInt(e[0])); const top3GanTouches=Object.entries(touchGaps).sort((a,b)=>b[1]-a[1]).slice(0,3).map(e=>e[0]);
    const potentialNumbers=[]; for(let i=0;i<1000;i++){const numStr=String(i).padStart(3,'0'); const digits=numStr.split(''); const sum=digits.map(Number).reduce((a,b)=>a+b,0); if(top3Sums.includes(sum)||digits.some(d=>top3GanTouches.includes(d))){potentialNumbers.push(numStr);}}
    const finalCounts={tram:{},chuc:{},donvi:{}}; potentialNumbers.forEach(num=>{finalCounts.tram[num[0]]=(finalCounts.tram[num[0]]||0)+1; finalCounts.chuc[num[1]]=(finalCounts.chuc[num[1]]||0)+1; finalCounts.donvi[num[2]]=(finalCounts.donvi[num[2]]||0)+1;});
    const getTop5=(counts)=>Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    return {topTram:getTop5(finalCounts.tram),topChuc:getTop5(finalCounts.chuc),topDonVi:getTop5(finalCounts.donvi)};
};
const runMethodBacNho = (endDateIndex, days, groupedResults, prevDayResults) => {
    const LOOKBACK_DAYS=90; const PRIZE_POSITIONS_TO_WATCH=['G1','G2a','G3a','G7a']; const correlations={};
    const startIndex=Math.max(0,endDateIndex-1-LOOKBACK_DAYS); const analysisDays=days.slice(startIndex,endDateIndex-1);
    for(let i=0;i<analysisDays.length;i++){ const yesterdayResults=groupedResults[analysisDays[i]]||[]; const todayResultGDB=(groupedResults[analysisDays[i+1]]||[]).find(r=>r.giai==='ĐB'); if(todayResultGDB?.so){ const todayGDBNum=String(todayResultGDB.so).slice(-3); if(todayGDBNum.length<3)continue; const [tram,chuc,donvi]=todayGDBNum.split(''); PRIZE_POSITIONS_TO_WATCH.forEach(pos=>{ const prize=yesterdayResults.find(r=>r.giai===pos); if(prize?.so){const key=`${pos}_${prize.so.slice(-1)}`; if(!correlations[key])correlations[key]={tram:{},chuc:{},donvi:{}}; correlations[key].tram[tram]=(correlations[key].tram[tram]||0)+1; correlations[key].chuc[chuc]=(correlations[key].chuc[chuc]||0)+1; correlations[key].donvi[donvi]=(correlations[key].donvi[donvi]||0)+1;}});}}
    const finalCounts={tram:{},chuc:{},donvi:{}}; PRIZE_POSITIONS_TO_WATCH.forEach(pos=>{ const prize=prevDayResults.find(r=>r.giai===pos); if(prize?.so){const key=`${pos}_${prize.so.slice(-1)}`; if(correlations[key]){Object.entries(correlations[key].tram).forEach(([k,v])=>finalCounts.tram[k]=(finalCounts.tram[k]||0)+v); Object.entries(correlations[key].chuc).forEach(([k,v])=>finalCounts.chuc[k]=(finalCounts.chuc[k]||0)+v); Object.entries(correlations[key].donvi).forEach(([k,v])=>finalCounts.donvi[k]=(finalCounts.donvi[k]||0)+v);}}});
    const getTop5=(counts)=>Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    return {topTram:getTop5(finalCounts.tram),topChuc:getTop5(finalCounts.chuc),topDonVi:getTop5(finalCounts.donvi)};
};
const runMethodChanLe = (endDateIndex, days, groupedResults, prevDayGDB) => {
    const LOOKBACK_DAYS=90; if(!prevDayGDB?.chanle)return {topTram:[],topChuc:[],topDonVi:[]}; const prevDayPattern=prevDayGDB.chanle; const nextDayPatternFrequencies={};
    const startIndex=Math.max(0,endDateIndex-1-LOOKBACK_DAYS); const analysisDays=days.slice(startIndex,endDateIndex-1);
    for(let i=0;i<analysisDays.length;i++){ const yesterdayGDB=(groupedResults[analysisDays[i]]||[]).find(r=>r.giai==='ĐB'); const todayGDB=(groupedResults[analysisDays[i+1]]||[]).find(r=>r.giai==='ĐB'); if(yesterdayGDB?.chanle===prevDayPattern && todayGDB?.chanle){nextDayPatternFrequencies[todayGDB.chanle]=(nextDayPatternFrequencies[todayGDB.chanle]||0)+1;}}
    const predictedPattern=Object.entries(nextDayPatternFrequencies).sort((a,b)=>b[1]-a[1])[0]?.[0]; if(!predictedPattern || predictedPattern.length<3)return {topTram:[],topChuc:[],topDonVi:[]};
    const [p1,p2,p3]=predictedPattern.split(''); const getDigits=(type)=>type==='C'?['0','2','4','6','8']:['1','3','5','7','9'];
    return {topTram:getDigits(p1),topChuc:getDigits(p2),topDonVi:getDigits(p3)};
};

const dateKey = (s) => { if (!s || typeof s !== 'string') return ''; const parts = s.split('/'); return parts.length !== 3 ? s : `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`; };

/* =================================================================
 * PHẦN 2: CÁC MODULE PHÂN TÍCH TỔNG HỢP
 * ================================================================= */

const runIntersectionAnalysis = (allMethodResults) => {
  const analysis={tram:{},chuc:{},donvi:{}}; ['tram','chuc','donvi'].forEach(pos=>{ const counts={}; for(const methodKey in allMethodResults){ const result=allMethodResults[methodKey]; const pKey=`top${pos==='donvi'?'DonVi':pos.charAt(0).toUpperCase()+pos.slice(1)}`; result[pKey]?.forEach(digit=>{counts[digit]=(counts[digit]||0)+1;});} const posResults={}; for(const digit in counts){ const count=counts[digit]; if(count>=2&&count<=5){ if(!posResults[count])posResults[count]=[]; posResults[count].push(digit); posResults[count].sort();}} analysis[pos]=posResults; }); return analysis;
};

const runMetaLearner = (allMethodResults, trustScores) => {
    const finalScores = { tram: {}, chuc: {}, donvi: {} }; for(const methodKey in allMethodResults){ const result=allMethodResults[methodKey]; const score=trustScores[methodKey]||INITIAL_TRUST_SCORE; result.topTram?.forEach(d=>finalScores.tram[d]=(finalScores.tram[d]||0)+score); result.topChuc?.forEach(d=>finalScores.chuc[d]=(finalScores.chuc[d]||0)+score); result.topDonVi?.forEach(d=>finalScores.donvi[d]=(finalScores.donvi[d]||0)+score);}
    const getTop5=(scores)=>Object.entries(scores).sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
    return { topTram:getTop5(finalScores.tram), topChuc:getTop5(finalScores.chuc), topDonVi:getTop5(finalScores.donvi) };
};

const getCombinations = (arr, k) => { const result=[]; const combine=(start,combo)=>{if(combo.length===k){result.push([...combo]);return;} for(let i=start;i<arr.length;i++){combo.push(arr[i]);combine(i+1,combo);combo.pop();}}; combine(0,[]); return result; };

// <<< LOGIC MỚI, ĐÚNG THEO YÊU CẦU "TRÙNG 7 ĐẶC ĐIỂM" >>>
const runGroupExclusionAnalysis = (prevPrediction, prevResult, todayMethods) => {
    if (!prevPrediction || !prevResult?.so) return { potentialNumbers: [], excludedPatternCount: 0 };
    
    const methodGroups = getCombinations(ALL_METHODS, 3);
    const lastGDB = String(prevResult.so).slice(-3);
    if (lastGDB.length < 3) return { potentialNumbers: [], excludedPatternCount: 0 };

    const lastDayPatterns = new Map();
    methodGroups.forEach((group, index) => {
        const pattern = group.flatMap(methodKey => {
            const p = prevPrediction.ketQuaChiTiet?.[methodKey];
            if (!p || !p.topTram || !p.topChuc || !p.topDonVi) return [0, 0, 0];
            const tramMatch = p.topTram.includes(lastGDB[0]) ? 1 : 0;
            const chucMatch = p.topChuc.includes(lastGDB[1]) ? 1 : 0;
            const donviMatch = p.topDonVi.includes(lastGDB[2]) ? 1 : 0;
            return [tramMatch, chucMatch, donviMatch];
        });
        lastDayPatterns.set(index, pattern); // Lưu dưới dạng mảng [1,0,0,0,0,0,1,1,0]
    });
    
    let potentialNumbers = [];
    const SIMILARITY_THRESHOLD = 7; // Ngưỡng loại bỏ: trùng từ 7/9 đặc điểm trở lên

    for (let i = 0; i < 1000; i++) {
        const num = String(i).padStart(3, '0');
        let isExcluded = false;

        for (let j = 0; j < methodGroups.length; j++) {
            const group = methodGroups[j];
            const excludedPattern = lastDayPatterns.get(j); // Mảng 9-bit của ngày hôm qua
            if (excludedPattern === undefined) continue;

            const currentPattern = group.flatMap(methodKey => {
                const p = todayMethods[methodKey];
                const tramMatch = p.topTram.includes(num[0]) ? 1 : 0;
                const chucMatch = p.topChuc.includes(num[1]) ? 1 : 0;
                const donviMatch = p.topDonVi.includes(num[2]) ? 1 : 0;
                return [tramMatch, chucMatch, donviMatch];
            });

            // Tính độ tương đồng
            let similarity = 0;
            for (let k = 0; k < 9; k++) {
                if (currentPattern[k] === excludedPattern[k]) {
                    similarity++;
                }
            }
            
            // Nếu độ tương đồng cao -> loại bỏ
            if (similarity >= SIMILARITY_THRESHOLD) {
                isExcluded = true;
                break;
            }
        }

        if (!isExcluded) {
            potentialNumbers.push(num);
        }
    }

    return { potentialNumbers: potentialNumbers.sort(), excludedPatternCount: methodGroups.length };
};


/* =================================================================
 * PHẦN 3: CÁC HÀM ĐIỀU PHỐI, HUẤN LUYỆN VÀ HỌC HỎI
 * ================================================================= */

exports.trainHistoricalPredictions = async (req, res) => {
    console.log('🔔 [trainHistoricalPredictions] Start (Full Suite)');
    try {
        // THÊM: Kiểm tra dữ liệu
        const results = await Result.find().sort({ 'ngay': 1 }).lean(); 
        if (results.length < 2) {
            return res.status(400).json({ message: `Cần ít nhất 2 ngày dữ liệu để huấn luyện. Hiện có: ${results.length}` });
        }
        const grouped = {}; results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); }); 
        const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
        
        let created = 0;
        for (let i = 1; i < days.length; i++) {
            const prevDayStr = days[i-1]; const targetDayStr = days[i];
            const prevPrediction = await Prediction.findOne({ ngayDuDoan: prevDayStr }).lean();
            const trustScores = prevPrediction?.diemTinCay || {};
            ALL_METHODS.forEach(m => { if (trustScores[m] === undefined) trustScores[m] = INITIAL_TRUST_SCORE; });
            const prevDayResults = grouped[prevDayStr] || []; const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');
            const allMethodResults = { [METHOD_GOC]: runMethodGoc(prevDayResults), [METHOD_DEEP_30_DAY]: runMethodDeep30Day(i, days, grouped, prevDayGDB), [METHOD_GDB_14_DAY]: runMethodGDB14Day(i, days, grouped), [METHOD_TONG_CHAM]: runMethodTongCham(i, days, grouped), [METHOD_BAC_NHO]: runMethodBacNho(i, days, grouped, prevDayResults), [METHOD_CHAN_LE]: runMethodChanLe(i, days, grouped, prevDayGDB), };
            const finalPrediction = runMetaLearner(allMethodResults, trustScores);
            const intersectionAnalysis = runIntersectionAnalysis(allMethodResults);
            const groupExclusionAnalysis = runGroupExclusionAnalysis(prevPrediction, prevDayGDB, allMethodResults);
            await Prediction.findOneAndUpdate({ ngayDuDoan: targetDayStr }, { ngayDuDoan: targetDayStr, ...finalPrediction, ketQuaChiTiet: allMethodResults, diemTinCay: trustScores, intersectionAnalysis, groupExclusionAnalysis, danhDauDaSo: false }, { upsert: true, new: true, setDefaultsOnInsert: true });
            created++;
        }
        return res.json({ message: `Huấn luyện lịch sử hoàn tất, đã tạo/cập nhật ${created} bản ghi.`, created });
    } catch (err) { console.error('Error in trainHistorical:', err); res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};

exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (Full Suite)');
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean(); if (allResults.length < 1) return res.status(400).json({ message: `Không có dữ liệu.` });
        const grouped = {}; allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
        const latestDayStr = days[days.length - 1]; 
        const nextDayStr = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy').plus({ days: 1 }).toFormat('dd/MM/yyyy');
        const prevPrediction = await Prediction.findOne({ ngayDuDoan: latestDayStr }).lean();
        const trustScores = prevPrediction?.diemTinCay || {};
        ALL_METHODS.forEach(m => { if (trustScores[m] === undefined) trustScores[m] = INITIAL_TRUST_SCORE; });
        const prevDayResults = grouped[latestDayStr] || []; const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');
        const allMethodResults = { [METHOD_GOC]: runMethodGoc(prevDayResults), [METHOD_DEEP_30_DAY]: runMethodDeep30Day(days.length, days, grouped, prevDayGDB), [METHOD_GDB_14_DAY]: runMethodGDB14Day(days.length, days, grouped), [METHOD_TONG_CHAM]: runMethodTongCham(days.length, days, grouped), [METHOD_BAC_NHO]: runMethodBacNho(days.length, days, grouped, prevDayResults), [METHOD_CHAN_LE]: runMethodChanLe(days.length, days, grouped, prevDayGDB), };
        const finalPrediction = runMetaLearner(allMethodResults, trustScores);
        const intersectionAnalysis = runIntersectionAnalysis(allMethodResults);
        const groupExclusionAnalysis = runGroupExclusionAnalysis(prevPrediction, prevDayGDB, allMethodResults);
        await Prediction.findOneAndUpdate({ ngayDuDoan: nextDayStr }, { ngayDuDoan: nextDayStr, ...finalPrediction, ketQuaChiTiet: allMethodResults, diemTinCay: trustScores, intersectionAnalysis, groupExclusionAnalysis, danhDauDaSo: false }, { upsert: true, new: true, setDefaultsOnInsert: true });
        return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
    } catch (err) { console.error('Error in trainNextDay:', err); return res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};

exports.updateTrustScores=async(req,res)=>{ console.log('🔔 [updateTrustScores] Meta-Learner is learning...'); try{const predsToCompare=await Prediction.find({danhDauDaSo:false}).lean(); if(!predsToCompare.length)return res.json({message:'Không có dự đoán nào cần cập nhật.'}); let updatedCount=0; for(const pred of predsToCompare){const actualResults=await Result.find({ngay:pred.ngayDuDoan}).lean(); const dbRec=actualResults.find(r=>r.giai==='ĐB'); if(!dbRec?.so)continue; const dbStr=String(dbRec.so).slice(-3); if(dbStr.length<3)continue; const actual={tram:dbStr[0],chuc:dbStr[1],donVi:dbStr[2]}; const prevDate=DateTime.fromFormat(pred.ngayDuDoan,'dd/MM/yyyy').minus({days:1}).toFormat('dd/MM/yyyy'); const prevPredDoc=await Prediction.findOne({ngayDuDoan:prevDate}); if(!prevPredDoc){await Prediction.updateOne({_id:pred._id},{danhDauDaSo:true}); continue;} for(const methodKey of ALL_METHODS){const methodResult=pred.ketQuaChiTiet?.[methodKey]; let currentScore=prevPredDoc.diemTinCay?.get(methodKey)||INITIAL_TRUST_SCORE; if(methodResult){let correctCount=0; if(methodResult.topTram?.includes(actual.tram))correctCount++; if(methodResult.topChuc?.includes(actual.chuc))correctCount++; if(methodResult.topDonVi?.includes(actual.donVi))correctCount++; if(correctCount>0){currentScore+=correctCount*TRUST_SCORE_INCREMENT;}else{currentScore-=TRUST_SCORE_DECREMENT;} currentScore=Math.max(MIN_TRUST_SCORE,Math.min(MAX_TRUST_SCORE,currentScore)); if(!prevPredDoc.diemTinCay)prevPredDoc.diemTinCay=new Map(); prevPredDoc.diemTinCay.set(methodKey,currentScore);}} await prevPredDoc.save(); await Prediction.updateOne({_id:pred._id},{danhDauDaSo:true}); updatedCount++;} return res.json({message:`Siêu Mô Hình đã học hỏi xong. Đã cập nhật ${updatedCount} bản ghi.`,updatedCount});}catch(err){console.error('Error in updateTrustScores:',err);return res.status(500).json({message:'Lỗi server',error:err.toString()});}};
exports.getAllResults=async(req,res)=>{try{const results=await Result.find().sort({'ngay':-1,'giai':1}); res.json(results);}catch(err){res.status(500).json({message:'Lỗi server',error:err.toString()});}};
exports.updateResults=async(req,res)=>{console.log('🔹 [Backend] Request POST /api/xs/update'); try{const data=await crawlService.extractXsData(); let insertedCount=0; for(const item of data){const exists=await Result.findOne({ngay:item.ngay,giai:item.giai}); if(!exists){await Result.create(item); insertedCount++;}} res.json({message:`Cập nhật xong, thêm ${insertedCount} kết quả mới`});}catch(err){console.error(err);res.status(500).json({message:'Lỗi server khi cập nhật dữ liệu',error:err.toString()});}};
exports.getPredictionByDate=async(req,res)=>{try{const{date}=req.query; if(!date)return res.status(400).json({message:'Thiếu param date'}); const pred=await Prediction.findOne({ngayDuDoan:date}).lean(); if(!pred)return res.status(404).json({message:'Không tìm thấy prediction cho ngày này'}); return res.json(pred);}catch(err){return res.status(500).json({message:'Lỗi server',error:err.toString()});}};
exports.getLatestPredictionDate=async(req,res)=>{try{const latestPrediction=await Prediction.findOne().sort({ngayDuDoan:-1}).collation({locale:'vi',numericOrdering:true}).lean(); if(!latestPrediction)return res.status(404).json({message:'Không tìm thấy bản ghi dự đoán nào.'}); res.json({latestDate:latestPrediction.ngayDuDoan});}catch(err){res.status(500).json({message:'Lỗi server',error:err.toString()});}};
exports.getAllPredictions=async(req,res)=>{try{const predictions=await Prediction.find({}).lean(); res.json(predictions);}catch(err){res.status(500).json({message:'Lỗi server',error:err.toString()});}};
exports.updatePredictionWeights=(req,res)=>res.status(404).json({message:'API đã lỗi thời, sử dụng /update-trust-scores'});

exports.runGroupExclusionAnalysis = async (req, res) => {
    try {
        console.log('🔬 [API] Starting Group Exclusion Analysis...');
        
        // Bây giờ hàm này đã tồn tại và có thể gọi được
        const { latestResults, prevResults } = await getLatestTwoDaysResults();

        if (!latestResults.length || !prevResults.length) {
            // Trường hợp này thực tế đã được xử lý trong getLatestTwoDaysResults
            return res.status(404).json({ message: 'Không đủ dữ liệu để phân tích.' });
        }

        // Gọi service để thực hiện logic
        const analysisResult = groupExclusionService.analyzeAndFilter(latestResults, prevResults);

        // Trả về kết quả cho client
        res.status(200).json({
            message: 'Phân tích loại trừ nhóm hoàn tất.',
            data: {
                potentialNumbersCount: analysisResult.potentialNumbers.length,
                excludedNumbersCount: analysisResult.excludedNumbers.length,
                potentialNumbers: analysisResult.potentialNumbers,
                details: analysisResult.analysisDetails
            }
        });

    } catch (error) {
        console.error('Error during group exclusion analysis:', error);
        res.status(500).json({ message: 'Lỗi server khi đang phân tích', error: error.message });
    }
};




