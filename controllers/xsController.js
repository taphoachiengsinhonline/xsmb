// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const { DateTime } = require('luxon');
const crawlService = require('../services/crawlService');

// --- Định danh cho các phương pháp ---
const METHOD_GOC = 'PHUONG_PHAP_GOC';
const METHOD_DEEP_30_DAY = 'DEEP_30_DAY';
const METHOD_GDB_14_DAY = 'GDB_14_DAY';
const METHOD_TONG_CHAM = 'TONG_CHAM_90_DAY';
const METHOD_BAC_NHO = 'BAC_NHO_VI_TRI_90_DAY';
const METHOD_CHAN_LE = 'MAU_HINH_CHAN_LE_90_DAY';

/* =================================================================
 * PHẦN 1: CÁC MODULE PHÂN TÍCH RIÊNG LẺ
 * ================================================================= */

const runMethodGoc = (prevDayResults) => {
  const counts = { tram: {}, chuc: {}, donvi: {} };
  const chiTietGoc = [];
  prevDayResults.forEach((r, idx) => {
    const num = String(r.so).padStart(3, '0').slice(-3);
    const [tram, chuc, donvi] = num.split('');
    if (tram) counts.tram[tram] = (counts.tram[tram] || 0) + 1;
    if (chuc) counts.chuc[chuc] = (counts.chuc[chuc] || 0) + 1;
    if (donvi) counts.donvi[donvi] = (counts.donvi[donvi] || 0) + 1;
    chiTietGoc.push({ number: r.so, positionInPrize: idx, tram, chuc, donvi, weight: 1 });
  });
  const generatePrediction = (initialCounts) => {
    const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const allCounts = allDigits.map(digit => ({ k: digit, v: initialCounts[digit] || 0 }));
    const top5Hot = [...allCounts].sort((a, b) => b.v - a.v).slice(0, 5).map(o => o.k);
    const top5Cold = [...allCounts].sort((a, b) => a.v - b.v).slice(0, 5).map(o => o.k);
    const keeperSet = allDigits.filter(d => !top5Cold.includes(d));
    const intersection = top5Hot.filter(d => keeperSet.includes(d));
    const remainingKeepers = keeperSet.filter(d => !intersection.includes(d));
    return [...intersection, ...remainingKeepers].slice(0, 5);
  };
  return { topTram: generatePrediction(counts.tram), topChuc: generatePrediction(counts.chuc), topDonVi: generatePrediction(counts.donvi), chiTietGoc: chiTietGoc };
};

const runMethodDeep30Day = (endDateIndex, days, groupedResults, prevDayGDB) => {
    const LOOKBACK_DAYS = 30; const TIME_DECAY_FACTOR = 0.98; const SCORE_WEIGHTS = { TIME_DECAY_FREQUENCY: 1.5, GAP: 1.0, PATTERN: 2.0 }; const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const weightedFrequencies = { tram: {}, chuc: {}, donvi: {} }; const lastSeenDay = { tram: {}, chuc: {}, donvi: {} }; const transitionCounts = { tram: {}, chuc: {}, donvi: {} };
    allDigits.forEach(d => { weightedFrequencies.tram[d] = 0; weightedFrequencies.chuc[d] = 0; weightedFrequencies.donvi[d] = 0; lastSeenDay.tram[d] = LOOKBACK_DAYS; lastSeenDay.chuc[d] = LOOKBACK_DAYS; lastSeenDay.donvi[d] = LOOKBACK_DAYS; transitionCounts.tram[d] = {}; transitionCounts.chuc[d] = {}; transitionCounts.donvi[d] = {}; });
    const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex);
    for (let i = 1; i < analysisDays.length; i++) {
        const todayResult = (groupedResults[analysisDays[i]] || []).find(r => r.giai === 'ĐB'); const yesterdayResult = (groupedResults[analysisDays[i - 1]] || []).find(r => r.giai === 'ĐB');
        if (todayResult?.so && yesterdayResult?.so) {
            const todayNum = String(todayResult.so).slice(-3); const yesterdayNum = String(yesterdayResult.so).slice(-3);
            if (todayNum.length === 3 && yesterdayNum.length === 3) {
                const [tram, chuc, donvi] = todayNum.split(''); const prevDonvi = yesterdayNum[2]; const daysAgo = analysisDays.length - 1 - i; const weight = Math.pow(TIME_DECAY_FACTOR, daysAgo);
                weightedFrequencies.tram[tram] += weight; weightedFrequencies.chuc[chuc] += weight; weightedFrequencies.donvi[donvi] += weight;
                lastSeenDay.tram[tram] = daysAgo; lastSeenDay.chuc[chuc] = daysAgo; lastSeenDay.donvi[donvi] = daysAgo;
                transitionCounts.tram[prevDonvi][tram] = (transitionCounts.tram[prevDonvi][tram] || 0) + 1; transitionCounts.chuc[prevDonvi][chuc] = (transitionCounts.chuc[prevDonvi][chuc] || 0) + 1; transitionCounts.donvi[prevDonvi][donvi] = (transitionCounts.donvi[prevDonvi][donvi] || 0) + 1;
            }
        }
    }
    const finalScores = { tram: [], chuc: [], donvi: [] }; const prevDonvi = prevDayGDB ? String(prevDayGDB.so).slice(-1) : null;
    ['tram', 'chuc', 'donvi'].forEach(position => {
        const scores = allDigits.map(digit => { let score = 0; score += (weightedFrequencies[position][digit] || 0) * SCORE_WEIGHTS.TIME_DECAY_FREQUENCY; score += (lastSeenDay[position][digit] || 0) * SCORE_WEIGHTS.GAP; if (prevDonvi && transitionCounts[position][prevDonvi]?.[digit]) { score += transitionCounts[position][prevDonvi][digit] * SCORE_WEIGHTS.PATTERN; } return { digit, score }; });
        finalScores[position] = scores.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.digit);
    });
    return { topTram: finalScores.tram, topChuc: finalScores.chuc, topDonVi: finalScores.donvi };
};

const runMethodGDB14Day = (endDateIndex, days, groupedResults) => {
    const LOOKBACK_DAYS = 14; const frequencies = { tram: {}, chuc: {}, donvi: {} }; const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex);
    analysisDays.forEach(day => {
        const dbResult = (groupedResults[day] || []).find(r => r.giai === 'ĐB');
        if (dbResult?.so) {
            const numStr = String(dbResult.so).slice(-3);
            if (numStr.length === 3) {
                const [tram, chuc, donvi] = numStr.split('');
                if (tram) frequencies.tram[tram] = (frequencies.tram[tram] || 0) + 1;
                if (chuc) frequencies.chuc[chuc] = (frequencies.chuc[chuc] || 0) + 1;
                if (donvi) frequencies.donvi[donvi] = (frequencies.donvi[donvi] || 0) + 1;
            }
        }
    });
    const getTop5 = (freqs) => Object.entries(freqs).sort((a,b) => b[1] - a[1]).slice(0,5).map(e => e[0]);
    return { topTram: getTop5(frequencies.tram), topChuc: getTop5(frequencies.chuc), topDonVi: getTop5(frequencies.donvi) };
};

const runMethodTongCham = (endDateIndex, days, groupedResults) => {
    const LOOKBACK_DAYS = 90; const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']; const sumFrequencies = {}; const touchGaps = {};
    allDigits.forEach(d => touchGaps[d] = LOOKBACK_DAYS);
    const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex);
    analysisDays.forEach((day, dayIndex) => {
        const dbResult = (groupedResults[day] || []).find(r => r.giai === 'ĐB');
        if (dbResult?.so) {
            const numStr = String(dbResult.so).slice(-3);
            if (numStr.length === 3) { const digits = numStr.split('').map(Number); const sum = digits.reduce((a, b) => a + b, 0); sumFrequencies[sum] = (sumFrequencies[sum] || 0) + 1; [...new Set(digits)].forEach(d => touchGaps[d] = analysisDays.length - 1 - dayIndex); }
        }
    });
    const top3Sums = Object.entries(sumFrequencies).sort((a,b) => b[1] - a[1]).slice(0, 3).map(e => parseInt(e[0]));
    const top3GanTouches = Object.entries(touchGaps).sort((a,b) => b[1] - a[1]).slice(0, 3).map(e => parseInt(e[0]));
    const potentialNumbers = [];
    for(let i = 0; i < 1000; i++) {
        const numStr = String(i).padStart(3, '0'); const digits = numStr.split('').map(Number); const sum = digits.reduce((a, b) => a + b, 0);
        if (top3Sums.includes(sum) || digits.some(d => top3GanTouches.includes(d))) { potentialNumbers.push(numStr); }
    }
    const finalCounts = { tram: {}, chuc: {}, donvi: {} };
    potentialNumbers.forEach(num => { finalCounts.tram[num[0]] = (finalCounts.tram[num[0]] || 0) + 1; finalCounts.chuc[num[1]] = (finalCounts.chuc[num[1]] || 0) + 1; finalCounts.donvi[num[2]] = (finalCounts.donvi[num[2]] || 0) + 1; });
    const getTop5 = (counts) => Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0,5).map(e=>e[0]);
    return { topTram: getTop5(finalCounts.tram), topChuc: getTop5(finalCounts.chuc), topDonVi: getTop5(finalCounts.donvi) };
};

const runMethodBacNho = (endDateIndex, days, groupedResults, prevDayResults) => {
    const LOOKBACK_DAYS = 90; const PRIZE_POSITIONS_TO_WATCH = ['G1', 'G2a', 'G3a', 'G7a']; const correlations = {};
    const startIndex = Math.max(0, endDateIndex - 1 - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex - 1);
    for (let i = 0; i < analysisDays.length; i++) {
        const yesterdayResults = groupedResults[analysisDays[i]] || []; const todayResultGDB = (groupedResults[analysisDays[i+1]] || []).find(r => r.giai === 'ĐB');
        if (todayResultGDB?.so) {
            const todayGDBNum = String(todayResultGDB.so).slice(-3); if (todayGDBNum.length < 3) continue; const [tram, chuc, donvi] = todayGDBNum.split('');
            PRIZE_POSITIONS_TO_WATCH.forEach(pos => {
                const prize = yesterdayResults.find(r => r.giai === pos);
                if (prize?.so) {
                    const key = `${pos}_${prize.so.slice(-1)}`; if (!correlations[key]) correlations[key] = { tram: {}, chuc: {}, donvi: {} };
                    correlations[key].tram[tram] = (correlations[key].tram[tram] || 0) + 1; correlations[key].chuc[chuc] = (correlations[key].chuc[chuc] || 0) + 1; correlations[key].donvi[donvi] = (correlations[key].donvi[donvi] || 0) + 1;
                }
            });
        }
    }
    const finalCounts = { tram: {}, chuc: {}, donvi: {} };
    PRIZE_POSITIONS_TO_WATCH.forEach(pos => {
        const prize = prevDayResults.find(r => r.giai === pos);
        if (prize?.so) {
            const key = `${pos}_${prize.so.slice(-1)}`;
            if (correlations[key]) {
                Object.entries(correlations[key].tram).forEach(([k,v]) => finalCounts.tram[k] = (finalCounts.tram[k] || 0) + v); Object.entries(correlations[key].chuc).forEach(([k,v]) => finalCounts.chuc[k] = (finalCounts.chuc[k] || 0) + v); Object.entries(correlations[key].donvi).forEach(([k,v]) => finalCounts.donvi[k] = (finalCounts.donvi[k] || 0) + v);
            }
        }
    });
    const getTop5 = (counts) => Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0,5).map(e=>e[0]);
    return { topTram: getTop5(finalCounts.tram), topChuc: getTop5(finalCounts.chuc), topDonVi: getTop5(finalCounts.donvi) };
};

const runMethodChanLe = (endDateIndex, days, groupedResults, prevDayGDB) => {
    const LOOKBACK_DAYS = 90; if (!prevDayGDB?.chanle) return { topTram: [], topChuc: [], topDonVi: [] }; const prevDayPattern = prevDayGDB.chanle; const nextDayPatternFrequencies = {};
    const startIndex = Math.max(0, endDateIndex - 1 - LOOKBACK_DAYS); const analysisDays = days.slice(startIndex, endDateIndex - 1);
    for (let i = 0; i < analysisDays.length; i++) {
        const yesterdayGDB = (groupedResults[analysisDays[i]] || []).find(r => r.giai === 'ĐB'); const todayGDB = (groupedResults[analysisDays[i+1]] || []).find(r => r.giai === 'ĐB');
        if (yesterdayGDB?.chanle === prevDayPattern && todayGDB?.chanle) { nextDayPatternFrequencies[todayGDB.chanle] = (nextDayPatternFrequencies[todayGDB.chanle] || 0) + 1; }
    }
    const predictedPattern = Object.entries(nextDayPatternFrequencies).sort((a,b) => b[1] - a[1])[0]?.[0];
    if (!predictedPattern) return { topTram: [], topChuc: [], topDonVi: [] };
    const [p1, p2, p3] = predictedPattern.split(''); const getDigits = (type) => type === 'C' ? ['0','2','4','6','8'] : ['1','3','5','7','9'];
    return { topTram: getDigits(p1), topChuc: getDigits(p2), topDonVi: getDigits(p3) };
};

/* =================================================================
 * PHẦN 2: CÁC HÀM ĐIỀU PHỐI VÀ LẤY DỮ LIỆU
 * ================================================================= */

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (Multi-Method)'); const MIN_DAYS_REQUIRED = 90;
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < MIN_DAYS_REQUIRED) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${MIN_DAYS_REQUIRED} ngày.` });
    const grouped = {}; results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); }); const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDayStr = days[i - 1]; const targetDayStr = days[i]; const prevDayResults = grouped[prevDayStr] || []; const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');
      if (i < 30) { // Bỏ qua những ngày đầu không đủ data cho các pp phức tạp
        continue;
      }
      const ketQuaPhanTich = {
          [METHOD_GOC]: runMethodGoc(prevDayResults),
          [METHOD_DEEP_30_DAY]: runMethodDeep30Day(i, days, grouped, prevDayGDB),
          [METHOD_GDB_14_DAY]: runMethodGDB14Day(i, days, grouped),
          [METHOD_TONG_CHAM]: runMethodTongCham(i, days, grouped),
          [METHOD_BAC_NHO]: runMethodBacNho(i, days, grouped, prevDayResults),
          [METHOD_CHAN_LE]: runMethodChanLe(i, days, grouped, prevDayGDB),
      };
      await Prediction.findOneAndUpdate( { ngayDuDoan: targetDayStr }, { ngayDuDoan: targetDayStr, ketQuaPhanTich, danhDauDaSo: false }, { upsert: true, new: true, setDefaultsOnInsert: true });
      created++;
    }
    return res.json({ message: `Huấn luyện lịch sử hoàn tất, đã tạo/cập nhật ${created} bản ghi.`, created });
  } catch (err) { console.error('❌ [trainHistoricalPredictions] Error:', err); return res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};

exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (Multi-Method)'); const MIN_DAYS_REQUIRED = 90;
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < MIN_DAYS_REQUIRED) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${MIN_DAYS_REQUIRED} ngày.` });
        const grouped = {}; allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); }); const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        const latestDayStr = days[days.length - 1]; const latestDate = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy'); const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        const prevDayResults = grouped[latestDayStr] || []; const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');
        const ketQuaPhanTich = {
            [METHOD_GOC]: runMethodGoc(prevDayResults),
            [METHOD_DEEP_30_DAY]: runMethodDeep30Day(days.length, days, grouped, prevDayGDB),
            [METHOD_GDB_14_DAY]: runMethodGDB14Day(days.length, days, grouped),
            [METHOD_TONG_CHAM]: runMethodTongCham(days.length, days, grouped),
            [METHOD_BAC_NHO]: runMethodBacNho(days.length, days, grouped, prevDayResults),
            [METHOD_CHAN_LE]: runMethodChanLe(days.length, days, grouped, prevDayGDB),
        };
        await Prediction.findOneAndUpdate( { ngayDuDoan: nextDayStr }, { ngayDuDoan: nextDayStr, ketQuaPhanTich, danhDauDaSo: false }, { upsert: true, new: true, setDefaultsOnInsert: true } );
        return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
    } catch (err) { console.error('❌ [trainPredictionForNextDay] Error:', err); return res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};

exports.updatePredictionWeights = async (req, res) => {
    console.log('🔔 [updatePredictionWeights] Applying to Original Method');
    try {
        const predsToUpdate = await Prediction.find({ danhDauDaSo: false });
        if (!predsToUpdate.length) return res.json({ message: 'Không có dự đoán nào cần cập nhật.' });
        let updatedCount = 0;
        for (const predDoc of predsToUpdate) {
            const actualResults = await Result.find({ ngay: predDoc.ngayDuDoan }).lean();
            const dbRec = actualResults.find(r => r.giai === 'ĐB');
            if (!dbRec?.so) continue;
            const dbStr = String(dbRec.so).slice(-3);
            if (dbStr.length < 3) continue; const actual = { tram: dbStr[0], chuc: dbStr[1], donVi: dbStr[2] };
            const methodGocData = predDoc.ketQuaPhanTich.get(METHOD_GOC);
            if (!methodGocData || !methodGocData.chiTietGoc) continue;
            let hasChanged = false;
            methodGocData.chiTietGoc.forEach(ct => {
                let originalWeight = ct.weight || 1; let newWeight = originalWeight;
                if (ct.tram === actual.tram) newWeight++; if (ct.chuc === actual.tram) newWeight++; if (ct.donvi === actual.tram) newWeight++;
                if (ct.tram === actual.chuc) newWeight++; if (ct.chuc === actual.chuc) newWeight++; if (ct.donvi === actual.chuc) newWeight++;
                if (ct.tram === actual.donVi) newWeight++; if (ct.chuc === actual.donVi) newWeight++; if (ct.donvi === actual.donVi) newWeight++;
                if (newWeight > originalWeight) { ct.weight = newWeight; hasChanged = true; }
            });
            if (hasChanged) { predDoc.ketQuaPhanTich.set(METHOD_GOC, methodGocData); }
            predDoc.danhDauDaSo = true; await predDoc.save(); updatedCount++;
        }
        return res.json({ message: `Cập nhật weights cho PP Gốc hoàn tất. Đã xử lý ${updatedCount} bản ghi.`, updatedCount });
    } catch (err) { console.error('❌ [updatePredictionWeights] Error:', err); return res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};

exports.getAllResults = async (req, res) => {
  try { const results = await Result.find().sort({ 'ngay': -1, 'giai': 1 }); res.json(results); } catch (err) { res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};
exports.getPredictionByDate = async (req, res) => {
  try { const { date } = req.query; if (!date) return res.status(400).json({ message: 'Thiếu param date' }); const pred = await Prediction.findOne({ ngayDuDoan: date }).lean(); if (!pred) return res.status(404).json({ message: 'Không tìm thấy prediction cho ngày này' }); return res.json(pred); } catch (err) { return res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};
exports.getLatestPredictionDate = async (req, res) => {
  try { const latestPrediction = await Prediction.findOne().sort({ ngayDuDoan: -1 }).collation({ locale: 'vi', numericOrdering: true }).lean(); if (!latestPrediction) return res.status(404).json({ message: 'Không tìm thấy bản ghi dự đoán nào.' }); res.json({ latestDate: latestPrediction.ngayDuDoan }); } catch (err) { res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};
exports.getAllPredictions = async (req, res) => {
  try { const predictions = await Prediction.find({}).lean(); res.json(predictions); } catch (err) { res.status(500).json({ message: 'Lỗi server', error: err.toString() }); }
};
exports.updateResults = async (req, res) => {
  console.log('🔹 [Backend] Request POST /api/xs/update');
  try {
    const data = await crawlService.extractXsData(); let insertedCount = 0;
    for (const item of data) { const exists = await Result.findOne({ ngay: item.ngay, giai: item.giai }); if (!exists) { await Result.create(item); insertedCount++; } }
    res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });
  } catch (err) { console.error(err); res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() }); }
};
