// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');
const { DateTime } = require('luxon');

/* =================================================================
 * CÁC HẰNG SỐ CẤU HÌNH CHO THUẬT TOÁN DỰ ĐOÁN GĐB
 * ================================================================= */
const LOOKBACK_DAYS = 14; // Số ngày nhìn lại lịch sử GĐB để phân tích
// --- Trọng số cho hệ thống tính điểm (chỉ dành cho dự đoán GĐB) ---
const SCORE_WEIGHTS = {
  FREQUENCY: 1.0, // Điểm cho những số xuất hiện nhiều trong GĐB gần đây
  GAP: 0.5,       // Điểm cho những số đã lâu không xuất hiện trong GĐB
  CYCLE: 1.5,     // Điểm "boost" nếu số đó xuất hiện trong GĐB của 3 ngày trước
};
const CYCLE_PERIOD_DAYS = 3;

/* =================================================================
 * PHẦN 1: CÁC HÀM LẤY DỮ LIỆU VÀ CẬP NHẬT CƠ BẢN
 * (Đây là những hàm gốc của bạn, được phục hồi đầy đủ)
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
 * PHẦN 2: LOGIC DỰ ĐOÁN GĐB NÂNG CAO
 * ================================================================= */

/**
 * Phân tích xu hướng của 3 số cuối GĐB trong N ngày gần nhất.
 */
const analyzeLongTermTrends = (endDateIndex, days, groupedResults) => {
  const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const frequencies = { tram: {}, chuc: {}, donvi: {} };
  const lastSeen = { tram: {}, chuc: {}, donvi: {} };

  allDigits.forEach(d => {
    frequencies.tram[d] = 0; frequencies.chuc[d] = 0; frequencies.donvi[d] = 0;
    lastSeen.tram[d] = LOOKBACK_DAYS; lastSeen.chuc[d] = LOOKBACK_DAYS; lastSeen.donvi[d] = LOOKBACK_DAYS;
  });

  const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS);
  const analysisDays = days.slice(startIndex, endDateIndex);

  analysisDays.forEach((day, dayIndex) => {
    const resultsForDay = groupedResults[day] || [];
    // CHỈ LẤY KẾT QUẢ GĐB ĐỂ PHÂN TÍCH
    const dbResult = resultsForDay.find(r => r.giai === 'ĐB');
    if (dbResult && dbResult.so) {
      const numStr = String(dbResult.so).slice(-3);
      if (numStr.length === 3) {
        const [tram, chuc, donvi] = numStr.split('');
        if(tram) { frequencies.tram[tram]++; lastSeen.tram[tram] = analysisDays.length - 1 - dayIndex; }
        if(chuc) { frequencies.chuc[chuc]++; lastSeen.chuc[chuc] = analysisDays.length - 1 - dayIndex; }
        if(donvi) { frequencies.donvi[donvi]++; lastSeen.donvi[donvi] = analysisDays.length - 1 - dayIndex; }
      }
    }
  });

  return { frequencies, gaps: lastSeen };
};


/**
 * Hệ thống tính điểm để chọn ra 5 số tiềm năng nhất cho mỗi vị trí của GĐB.
 */
const createScoringModel = (trends, cycleBoostDigits = []) => {
    const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const finalScores = { tram: [], chuc: [], donvi: [] };

    ['tram', 'chuc', 'donvi'].forEach(position => {
        const scores = allDigits.map(digit => {
            let score = 0;
            score += (trends.frequencies[position][digit] || 0) * SCORE_WEIGHTS.FREQUENCY;
            score += (trends.gaps[position][digit] || 0) * SCORE_WEIGHTS.GAP;
            if (cycleBoostDigits.includes(digit)) {
                score += SCORE_WEIGHTS.CYCLE;
            }
            return { digit, score };
        });
        
        finalScores[position] = scores.sort((a, b) => b.score - a.score).slice(0, 5).map(s => s.digit);
    });

    return finalScores;
};


/* =================================================================
 * PHẦN 3: CÁC HÀM HUẤN LUYỆN ĐƯỢC CẬP NHẬT ĐỂ DÙNG LOGIC MỚI
 * ================================================================= */

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (with ADVANCED GDB SCORING MODEL)');
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < LOOKBACK_DAYS) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${LOOKBACK_DAYS} ngày.` });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    
    let created = 0;
    for (let i = LOOKBACK_DAYS; i < days.length; i++) {
      const targetDayStr = days[i];

      const trends = analyzeLongTermTrends(i, days, grouped);

      let cycleBoostDigits = [];
      const cycleDayIndex = i - CYCLE_PERIOD_DAYS;
      if (cycleDayIndex >= 0) {
        const cycleDayResultDB = (grouped[days[cycleDayIndex]] || []).find(r => r.giai === 'ĐB');
        if (cycleDayResultDB && cycleDayResultDB.so) {
          cycleBoostDigits = String(cycleDayResultDB.so).slice(-3).split('');
        }
      }

      const finalPrediction = createScoringModel(trends, cycleBoostDigits);

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDayStr },
        { 
          ngayDuDoan: targetDayStr, 
          topTram: finalPrediction.tram, 
          topChuc: finalPrediction.chuc, 
          topDonVi: finalPrediction.donvi,
          danhDauDaSo: false, 
          analysis: { cycle3DayDigits: cycleBoostDigits }
        },
        { upsert: true, new: true }
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
    console.log('🔔 [trainPredictionForNextDay] Start (with ADVANCED GDB SCORING MODEL)');
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < LOOKBACK_DAYS) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${LOOKBACK_DAYS} ngày.` });

        const grouped = {};
        allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        
        const latestDayStr = days[days.length - 1];
        const latestDate = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy');
        const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        
        const trends = analyzeLongTermTrends(days.length, days, grouped);

        let cycleBoostDigits = [];
        const cycleDayIndex = days.length - CYCLE_PERIOD_DAYS;
        if (cycleDayIndex >= 0) {
            const cycleDayResultDB = (grouped[days[cycleDayIndex]] || []).find(r => r.giai === 'ĐB');
            if (cycleDayResultDB && cycleDayResultDB.so) {
                cycleBoostDigits = String(cycleDayResultDB.so).slice(-3).split('');
            }
        }

        const finalPrediction = createScoringModel(trends, cycleBoostDigits);
        
        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { 
              ngayDuDoan: nextDayStr, 
              topTram: finalPrediction.tram, 
              topChuc: finalPrediction.chuc, 
              topDonVi: finalPrediction.donvi, 
              danhDauDaSo: false,
              analysis: { cycle3DayDigits: cycleBoostDigits }
            },
            { upsert: true, new: true }
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
