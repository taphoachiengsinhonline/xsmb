// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');
const { DateTime } = require('luxon');

/* =================================================================
 * CÁC HẰNG SỐ CẤU HÌNH CHO MÔ HÌNH HYBRID
 * ================================================================= */
const LOOKBACK_DAYS_GDB = 14; // Số ngày phân tích GĐB dài hạn
const CYCLE_PERIOD_DAYS = 3;

/* =================================================================
 * PHẦN 1: CÁC HÀM LẤY DỮ LIỆU VÀ CẬP NHẬT CƠ BẢN (Giữ nguyên)
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
 * PHẦN 2: CÁC MODULE PHÂN TÍCH RIÊNG LẺ
 * ================================================================= */

// MODULE 1: Phân tích ngắn hạn (Logic gốc của bạn)
const analyzeShortTermFromAllPrizes = (prevDayResults) => {
  const counts = { tram: {}, chuc: {}, donvi: {} };
  prevDayResults.forEach(r => {
    const num = String(r.so).padStart(3, '0').slice(-3);
    const [tram, chuc, donvi] = num.split('');
    if (tram) counts.tram[tram] = (counts.tram[tram] || 0) + 1;
    if (chuc) counts.chuc[chuc] = (counts.chuc[chuc] || 0) + 1;
    if (donvi) counts.donvi[donvi] = (counts.donvi[donvi] || 0) + 1;
  });

  const generatePredictionFromCounts = (initialCounts) => {
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
    tram: generatePredictionFromCounts(counts.tram),
    chuc: generatePredictionFromCounts(counts.chuc),
    donvi: generatePredictionFromCounts(counts.donvi),
  };
};

// MODULE 2: Phân tích dài hạn (Logic GĐB)
const analyzeLongTermFromGDB = (endDateIndex, days, groupedResults) => {
  const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const frequencies = { tram: {}, chuc: {}, donvi: {} };
  const startIndex = Math.max(0, endDateIndex - LOOKBACK_DAYS_GDB);
  const analysisDays = days.slice(startIndex, endDateIndex);

  analysisDays.forEach(day => {
    const dbResult = (groupedResults[day] || []).find(r => r.giai === 'ĐB');
    if (dbResult && dbResult.so) {
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

  return {
      tram: getTop5(frequencies.tram),
      chuc: getTop5(frequencies.chuc),
      donvi: getTop5(frequencies.donvi),
  };
};


/* =================================================================
 * PHẦN 3: LOGIC HYBRID KẾT HỢP
 * ================================================================= */

const generateHybridPrediction = (shortTermPicks, longTermPicks) => {
    const finalPrediction = { tram: [], chuc: [], donvi: [] };

    ['tram', 'chuc', 'donvi'].forEach(position => {
        const shortTermSet = shortTermPicks[position];
        const longTermSet = longTermPicks[position];

        // 1. Tìm những số "vàng" (xuất hiện ở cả 2 phương pháp)
        const intersection = shortTermSet.filter(digit => longTermSet.includes(digit));
        
        // 2. Lấy những số còn lại từ mỗi phương pháp
        const onlyShortTerm = shortTermSet.filter(digit => !intersection.includes(digit));
        const onlyLongTerm = longTermSet.filter(digit => !intersection.includes(digit));

        // 3. Kết hợp lại theo thứ tự ưu tiên: Vàng -> Ngắn hạn -> Dài hạn
        const combined = [...intersection, ...onlyShortTerm, ...onlyLongTerm];
        
        // 4. Loại bỏ trùng lặp và lấy 5 số đầu tiên
        finalPrediction[position] = [...new Set(combined)].slice(0, 5);
    });

    return finalPrediction;
};


/* =================================================================
 * PHẦN 4: CÁC HÀM HUẤN LUYỆN DÙNG MÔ HÌNH HYBRID
 * ================================================================= */

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (with HYBRID MODEL)');
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < LOOKBACK_DAYS_GDB) return res.status(400).json({ message: `Không đủ dữ liệu, cần ít nhất ${LOOKBACK_DAYS_GDB} ngày.` });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    
    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDayStr = days[i - 1];
      const targetDayStr = days[i];

      // 1. Chạy phân tích ngắn hạn (logic gốc)
      const shortTermPicks = analyzeShortTermFromAllPrizes(grouped[prevDayStr] || []);

      // 2. Chạy phân tích dài hạn (logic GĐB)
      const longTermPicks = analyzeLongTermFromGDB(i, days, grouped);

      // 3. Kết hợp kết quả bằng mô hình Hybrid
      const finalPrediction = generateHybridPrediction(shortTermPicks, longTermPicks);

      // Lấy thêm thông tin analysis để hiển thị
      let cycle3DayDigits = [];
      const cycleDayIndex = i - CYCLE_PERIOD_DAYS;
      if (cycleDayIndex >= 0) {
        const cycleDayResultDB = (grouped[days[cycleDayIndex]] || []).find(r => r.giai === 'ĐB');
        if (cycleDayResultDB && cycleDayResultDB.so) {
          cycle3DayDigits = String(cycleDayResultDB.so).slice(-3).split('');
        }
      }

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDayStr },
        { 
          ngayDuDoan: targetDayStr, 
          topTram: finalPrediction.tram, 
          topChuc: finalPrediction.chuc, 
          topDonVi: finalPrediction.donvi,
          danhDauDaSo: false, 
          analysis: { cycle3DayDigits }
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
    console.log('🔔 [trainPredictionForNextDay] Start (with HYBRID MODEL)');
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < 1) return res.status(400).json({ message: 'Không có dữ liệu.' });

        const grouped = {};
        allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        
        const latestDayStr = days[days.length - 1];
        const latestDate = DateTime.fromFormat(latestDayStr, 'dd/MM/yyyy');
        const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        
        // 1. Chạy phân tích ngắn hạn (logic gốc)
        const shortTermPicks = analyzeShortTermFromAllPrizes(grouped[latestDayStr] || []);

        // 2. Chạy phân tích dài hạn (logic GĐB)
        const longTermPicks = analyzeLongTermFromGDB(days.length, days, grouped);
        
        // 3. Kết hợp kết quả
        const finalPrediction = generateHybridPrediction(shortTermPicks, longTermPicks);

        let cycle3DayDigits = [];
        const cycleDayIndex = days.length - CYCLE_PERIOD_DAYS;
        if (cycleDayIndex >= 0) {
            const cycleDayResultDB = (grouped[days[cycleDayIndex]] || []).find(r => r.giai === 'ĐB');
            if (cycleDayResultDB && cycleDayResultDB.so) {
                cycle3DayDigits = String(cycleDayResultDB.so).slice(-3).split('');
            }
        }
        
        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { 
              ngayDuDoan: nextDayStr, 
              topTram: finalPrediction.tram, 
              topChuc: finalPrediction.chuc, 
              topDonVi: finalPrediction.donvi, 
              danhDauDaSo: false,
              analysis: { cycle3DayDigits }
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
    return res.json({ message: 'Chức năng này không còn cần thiết trong mô hình Hybrid.' });
};
