// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const { DateTime } = require('luxon');

// --- Định danh cho các phương pháp ---
const METHOD_GOC = 'PHUONG_PHAP_GOC';
const METHOD_DEEP_30_DAY = 'DEEP_30_DAY';
const METHOD_GDB_14_DAY = 'GDB_14_DAY';

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
  
  return {
    topTram: generatePrediction(counts.tram),
    topChuc: generatePrediction(counts.chuc),
    topDonVi: generatePrediction(counts.donvi),
    chiTietGoc: chiTietGoc,
  };
};

const runMethodDeep30Day = (endDateIndex, days, groupedResults, prevDayGDB) => {
    const LOOKBACK_DAYS = 30;
    const TIME_DECAY_FACTOR = 0.98;
    const SCORE_WEIGHTS = { TIME_DECAY_FREQUENCY: 1.5, GAP: 1.0, PATTERN: 2.0 };
    const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

    const weightedFrequencies = { tram: {}, chuc: {}, donvi: {} };
    const lastSeenDay = { tram: {}, chuc: {}, donvi: {} };
    const transitionCounts = { tram: {}, chuc: {}, donvi: {} };
    allDigits.forEach(d => {
        weightedFrequencies.tram[d] = 0; weightedFrequencies.chuc[d] = 0; weightedFrequencies.donvi[d] = 0;
        lastSeenDay.tram[d] = LOOKBACK_DAYS; lastSeenDay.chuc[d] = LOOKBACK_DAYS; lastSeenDay.donvi[d] = LOOKBACK_DAYS;
        transitionCounts.tram[d] = {}; transitionCounts.chuc[d] = {}; transitionCounts.donvi[d] = {};
    });

    const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS);
    const analysisDays = days.slice(startIndex, endDateIndex);

    for (let i = 1; i < analysisDays.length; i++) {
        const todayResult = (groupedResults[analysisDays[i]] || []).find(r => r.giai === 'ĐB');
        const yesterdayResult = (groupedResults[analysisDays[i - 1]] || []).find(r => r.giai === 'ĐB');
        if (todayResult?.so && yesterdayResult?.so) {
            const todayNum = String(todayResult.so).slice(-3);
            const yesterdayNum = String(yesterdayResult.so).slice(-3);
            if (todayNum.length === 3 && yesterdayNum.length === 3) {
                const [tram, chuc, donvi] = todayNum.split('');
                const prevDonvi = yesterdayNum[2];
                const daysAgo = analysisDays.length - 1 - i;
                const weight = Math.pow(TIME_DECAY_FACTOR, daysAgo);
                weightedFrequencies.tram[tram] += weight;
                weightedFrequencies.chuc[chuc] += weight;
                weightedFrequencies.donvi[donvi] += weight;
                lastSeenDay.tram[tram] = daysAgo;
                lastSeenDay.chuc[chuc] = daysAgo;
                lastSeenDay.donvi[donvi] = daysAgo;
                transitionCounts.tram[prevDonvi][tram] = (transitionCounts.tram[prevDonvi][tram] || 0) + 1;
                transitionCounts.chuc[prevDonvi][chuc] = (transitionCounts.chuc[prevDonvi][chuc] || 0) + 1;
                transitionCounts.donvi[prevDonvi][donvi] = (transitionCounts.donvi[prevDonvi][donvi] || 0) + 1;
            }
        }
    }
    
    const finalScores = { tram: [], chuc: [], donvi: [] };
    const prevDonvi = prevDayGDB ? String(prevDayGDB.so).slice(-1) : null;
    ['tram', 'chuc', 'donvi'].forEach(position => {
        const scores = allDigits.map(digit => {
            let score = 0;
            score += (weightedFrequencies[position][digit] || 0) * SCORE_WEIGHTS.TIME_DECAY_FREQUENCY;
            score += (lastSeenDay[position][digit] || 0) * SCORE_WEIGHTS.GAP;
            if (prevDonvi && transitionCounts[position][prevDonvi]?.[digit]) {
                score += transitionCounts[position][prevDonvi][digit] * SCORE_WEIGHTS.PATTERN;
            }
            return { digit, score };
        });
        finalScores[position] = scores.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.digit);
    });

    return { topTram: finalScores.tram, topChuc: finalScores.chuc, topDonVi: finalScores.donvi };
};

const runMethodGDB14Day = (endDateIndex, days, groupedResults) => {
    const LOOKBACK_DAYS = 14;
    const frequencies = { tram: {}, chuc: {}, donvi: {} };
    const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS);
    const analysisDays = days.slice(startIndex, endDateIndex);
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

/* =================================================================
 * PHẦN 2: CÁC HÀM ĐIỀU PHỐI VÀ LẤY DỮ LIỆU
 * ================================================================= */

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (Multi-Method)');
  const MIN_DAYS_REQUIRED = 30;
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < MIN_DAYS_REQUIRED) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${MIN_DAYS_REQUIRED} ngày.` });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    
    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDayStr = days[i - 1];
      const targetDayStr = days[i];
      const prevDayResults = grouped[prevDayStr] || [];
      const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');

      const resultMethodGoc = runMethodGoc(prevDayResults);
      const resultMethodDeep30 = runMethodDeep30Day(i, days, grouped, prevDayGDB);
      const resultMethodGDB14 = runMethodGDB14Day(i, days, grouped);

      const ketQuaPhanTich = {
          [METHOD_GOC]: resultMethodGoc,
          [METHOD_DEEP_30_DAY]: resultMethodDeep30,
          [METHOD_GDB_14_DAY]: resultMethodGDB14,
      };

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDayStr },
        { ngayDuDoan: targetDayStr, ketQuaPhanTich, danhDauDaSo: false },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      created++;
    }
    return res.json({ message: `Huấn luyện lịch sử hoàn tất, đã tạo/cập nhật ${created} bản ghi.`, created });
  } catch (err) {
    console.error('❌ [trainHistoricalPredictions] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (Multi-Method)');
    const MIN_DAYS_REQUIRED = 30;
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < MIN_DAYS_REQUIRED) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${MIN_DAYS_REQUIRED} ngày.` });

        const grouped = {};
        allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        
        const latestDayStr = days[days.length - 1];
        const latestDate = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy');
        const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        const prevDayResults = grouped[latestDayStr] || [];
        const prevDayGDB = prevDayResults.find(r => r.giai === 'ĐB');

        const resultMethodGoc = runMethodGoc(prevDayResults);
        const resultMethodDeep30 = runMethodDeep30Day(days.length, days, grouped, prevDayGDB);
        const resultMethodGDB14 = runMethodGDB14Day(days.length, days, grouped);

        const ketQuaPhanTich = {
            [METHOD_GOC]: resultMethodGoc,
            [METHOD_DEEP_30_DAY]: resultMethodDeep30,
            [METHOD_GDB_14_DAY]: resultMethodGDB14,
        };

        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { ngayDuDoan: nextDayStr, ketQuaPhanTich, danhDauDaSo: false },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
    } catch (err) {
        console.error('❌ [trainPredictionForNextDay] Error:', err);
        return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
    }
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
            const actual = { tram: dbStr[0], chuc: dbStr[1], donVi: dbStr[2] };
            
            const methodGocData = predDoc.ketQuaPhanTich.get(METHOD_GOC);
            if (!methodGocData || !methodGocData.chiTietGoc) continue;

            let hasChanged = false;
            methodGocData.chiTietGoc.forEach(ct => {
                let originalWeight = ct.weight || 1;
                let newWeight = originalWeight;
                if (ct.tram === actual.tram) newWeight++; if (ct.chuc === actual.tram) newWeight++; if (ct.donvi === actual.tram) newWeight++;
                if (ct.tram === actual.chuc) newWeight++; if (ct.chuc === actual.chuc) newWeight++; if (ct.donvi === actual.chuc) newWeight++;
                if (ct.tram === actual.donVi) newWeight++; if (ct.chuc === actual.donVi) newWeight++; if (ct.donvi === actual.donVi) newWeight++;
                if (newWeight > originalWeight) {
                    ct.weight = newWeight;
                    hasChanged = true;
                }
            });

            if (hasChanged) {
                predDoc.ketQuaPhanTich.set(METHOD_GOC, methodGocData);
            }
            predDoc.danhDauDaSo = true;
            await predDoc.save();
            updatedCount++;
        }
        return res.json({ message: `Cập nhật weights cho PP Gốc hoàn tất. Đã xử lý ${updatedCount} bản ghi.`, updatedCount });
    } catch (err) {
        console.error('❌ [updatePredictionWeights] Error:', err);
        return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
    }
};

exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ 'ngay': -1, 'giai': 1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.getPredictionByDate = async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ message: 'Thiếu param date' });
    const pred = await Prediction.findOne({ ngayDuDoan: date }).lean();
    if (!pred) return res.status(404).json({ message: 'Không tìm thấy prediction cho ngày này' });
    return res.json(pred);
  } catch (err) {
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.getLatestPredictionDate = async (req, res) => {
  try {
    const latestPrediction = await Prediction.findOne().sort({ ngayDuDoan: -1 }).collation({ locale: 'vi', numericOrdering: true }).lean();
    if (!latestPrediction) return res.status(404).json({ message: 'Không tìm thấy bản ghi dự đoán nào.' });
    res.json({ latestDate: latestPrediction.ngayDuDoan });
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.getAllPredictions = async (req, res) => {
  try {
    const predictions = await Prediction.find({}).lean();
    res.json(predictions);
  } catch (err) {
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};
