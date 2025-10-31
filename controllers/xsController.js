// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');
const { DateTime } = require('luxon');

/* =================================================================
 * CÁC HẰNG SỐ CẤU HÌNH CHO MÔ HÌNH PHÂN TÍCH SÂU
 * ================================================================= */
const LOOKBACK_DAYS = 30; // <<<< ĐÃ THAY ĐỔI TỪ 90 XUỐNG 30 THEO YÊU CẦU
const TIME_DECAY_FACTOR = 0.98; // Có thể tăng nhẹ hệ số để các ngày gần hơn có trọng số cao hơn trong khoảng 30 ngày

// --- Trọng số cho Hệ thống tính điểm ---
const SCORE_WEIGHTS = {
  TIME_DECAY_FREQUENCY: 1.5, // Điểm cho tần suất có trọng số thời gian
  GAP: 1.0,                  // Điểm cho số lâu chưa về (gan)
  PATTERN: 2.0,              // Điểm "SIÊU BOOST" cho các số về theo mẫu hình lặp lại
};


/* =================================================================
 * PHẦN 1: CÁC HÀM LẤY DỮ LIỆU VÀ CẬP NHẬT CƠ BẢN
 * ================================================================= */
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ 'ngay': -1, 'giai': 1 });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.updateResults = async (req, res) => {
  console.log('🔹 [Backend] Request POST /api/xs/update');
  try {
    const data = await crawlService.extractXsData();
    let insertedCount = 0;
    for (const item of data) {
      const exists = await Result.findOne({ ngay: item.ngay, giai: item.giai });
      if (!exists) {
        await Result.create(item);
        insertedCount++;
      }
    }
    res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() });
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
    console.error(err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.getLatestPredictionDate = async (req, res) => {
  try {
    const latestPrediction = await Prediction.findOne()
      .sort({ ngayDuDoan: -1 })
      .collation({ locale: 'vi', numericOrdering: true })
      .lean();
    if (!latestPrediction) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi dự đoán nào.' });
    }
    res.json({ latestDate: latestPrediction.ngayDuDoan });
  } catch (err) {
    console.error('❌ [Backend] Lỗi trong getLatestPredictionDate:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.getAllPredictions = async (req, res) => {
  try {
    const predictions = await Prediction.find({}, 'ngayDuDoan topTram topChuc topDonVi').lean();
    res.json(predictions);
  } catch (err) {
    console.error('❌ [Backend] Lỗi trong getAllPredictions:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};


/* =================================================================
 * PHẦN 2: LOGIC PHÂN TÍCH SÂU 30 NGÀY
 * ================================================================= */

const analyzeDeepTrends = (endDateIndex, days, groupedResults) => {
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
  return { weightedFrequencies, gaps: lastSeenDay, patterns: transitionCounts };
};

const createAdvancedScoringModel = (trends, prevDayGDB) => {
    const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const finalScores = { tram: [], chuc: [], donvi: [] };
    const prevDonvi = prevDayGDB ? String(prevDayGDB.so).slice(-1) : null;

    ['tram', 'chuc', 'donvi'].forEach(position => {
        const scores = allDigits.map(digit => {
            let score = 0;
            score += (trends.weightedFrequencies[position][digit] || 0) * SCORE_WEIGHTS.TIME_DECAY_FREQUENCY;
            score += (trends.gaps[position][digit] || 0) * SCORE_WEIGHTS.GAP;
            if (prevDonvi && trends.patterns[position][prevDonvi]?.[digit]) {
                score += trends.patterns[position][prevDonvi][digit] * SCORE_WEIGHTS.PATTERN;
            }
            return { digit, score };
        });
        finalScores[position] = scores.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.digit);
    });
    return finalScores;
};

/* =================================================================
 * PHẦN 3: CÁC HÀM HUẤN LUYỆN DÙNG MÔ HÌNH MỚI
 * ================================================================= */
exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (with Deep 30-Day Model)');
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < LOOKBACK_DAYS) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${LOOKBACK_DAYS} ngày.` });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    
    let created = 0;
    for (let i = LOOKBACK_DAYS; i < days.length; i++) {
      const targetDayStr = days[i];
      const prevDayGDB = (grouped[days[i - 1]] || []).find(r => r.giai === 'ĐB');
      
      const trends = analyzeDeepTrends(i, days, grouped);
      const finalPrediction = createAdvancedScoringModel(trends, prevDayGDB);

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDayStr },
        { 
          ngayDuDoan: targetDayStr, 
          topTram: finalPrediction.tram, 
          topChuc: finalPrediction.chuc, 
          topDonVi: finalPrediction.donvi,
          danhDauDaSo: false,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      created++;
    }

    console.log(`✅ [trainHistoricalPredictions] Done, created/updated ${created} predictions.`);
    return res.json({ message: `Huấn luyện lịch sử hoàn tất, đã tạo/cập nhật ${created} bản ghi.`, created });
  } catch (err) {
    console.error('❌ [trainHistoricalPredictions] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (with Deep 30-Day Model)');
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < LOOKBACK_DAYS) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${LOOKBACK_DAYS} ngày.` });

        const grouped = {};
        allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        
        const latestDayStr = days[days.length - 1];
        const latestDate = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy');
        const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        const prevDayGDB = (grouped[latestDayStr] || []).find(r => r.giai === 'ĐB');
        
        const trends = analyzeDeepTrends(days.length, days, grouped);
        const finalPrediction = createAdvancedScoringModel(trends, prevDayGDB);
        
        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { 
              ngayDuDoan: nextDayStr, 
              topTram: finalPrediction.tram, 
              topChuc: finalPrediction.chuc, 
              topDonVi: finalPrediction.donvi, 
              danhDauDaSo: false,
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log(`✅ [trainPredictionForNextDay] Đã lưu dự đoán cho ngày ${nextDayStr}`);
        return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
    } catch (err) {
        console.error('❌ [trainPredictionForNextDay] Error:', err);
        return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
    }
};

exports.updatePredictionWeights = async (req, res) => {
    return res.json({ message: 'Chức năng này không còn được sử dụng trong mô hình mới.' });
};
