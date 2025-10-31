// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');
const { DateTime } = require('luxon'); // Dùng để xử lý ngày tháng dễ dàng hơn

/*
 * =================================================================
 * CÁC HẰNG SỐ CẤU HÌNH CHO THUẬT TOÁN HỌC HỎI VÀ PHÂN TÍCH
 * (Bạn có thể tinh chỉnh các giá trị này để thử nghiệm)
 * =================================================================
 */

// --- Cấu hình cho việc cập nhật trọng số (Học hỏi) ---
const REWARD_INCREMENT = 0.5;   // Điểm cộng cho mỗi lần khớp
const PENALTY_DECREMENT = 0.1;  // Điểm trừ nếu không khớp chút nào
const DECAY_FACTOR = 0.99;      // Hệ số suy giảm (ví dụ: 0.99 = giảm 1% mỗi lần)
const MIN_WEIGHT = 0.2;         // Trọng số tối thiểu, không bao giờ xuống dưới mức này
const MAX_WEIGHT = 10;          // Trọng số tối đa, tránh tăng vô hạn

// --- Cấu hình cho việc phân tích nâng cao ---
const CYCLE_PERIOD_DAYS = 3;    // Chu kỳ ngày để phân tích (3 ngày)
const CYCLE_BOOST_VALUE = 3;    // Điểm "boost" cho các số từ phân tích chu kỳ
const CL_HISTORY_DAYS = 60;     // Số ngày lịch sử để phân tích Chẵn/Lẻ

// --- Lấy tất cả kết quả XSMB ---
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ 'ngay': -1, 'giai': 1 });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// --- Cập nhật kết quả mới từ crawl ---
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

// --- GET Prediction theo ngày ---
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

// --- LẤY NGÀY DỰ ĐOÁN MỚI NHẤT ---
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
    // Lấy tất cả các bản ghi dự đoán, chỉ lấy các trường cần thiết để nhẹ hơn
    const predictions = await Prediction.find({}, 'ngayDuDoan topTram topChuc topDonVi').lean();
    res.json(predictions);
  } catch (err) {
    console.error('❌ [Backend] Lỗi trong getAllPredictions:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

/*
 * =================================================================
 * CẢI TIẾN #1: HÀM PHÂN TÍCH NÂNG CAO (CHU KỲ & CHẴN/LẺ)
 * =================================================================
 */
const performAdvancedAnalysis = async (previousDayStr, allGroupedResults) => {
  const days = Object.keys(allGroupedResults).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
  const previousDayIndex = days.indexOf(previousDayStr);

  let predictedCL = null;
  let cycle3DayDigits = [];

  // 1. Phân tích chu kỳ 3 ngày
  if (previousDayIndex >= CYCLE_PERIOD_DAYS - 1) {
    const cycleDayStr = days[previousDayIndex - (CYCLE_PERIOD_DAYS - 1)];
    const cycleDayResultDB = (allGroupedResults[cycleDayStr] || []).find(r => r.giai === 'ĐB');
    if (cycleDayResultDB && cycleDayResultDB.so) {
      cycle3DayDigits = String(cycleDayResultDB.so).slice(-3).split('');
      console.log(`[Analysis] Chu kỳ ${CYCLE_PERIOD_DAYS} ngày (${cycleDayStr}): Gợi ý các số ${cycle3DayDigits.join(', ')}`);
    }
  }

  // 2. Phân tích Chẵn/Lẻ
  const prevDayResultDB = (allGroupedResults[previousDayStr] || []).find(r => r.giai === 'ĐB');
  if (prevDayResultDB && prevDayResultDB.chanle) {
    const prevDayCL = prevDayResultDB.chanle;
    const clStats = {};
    const relevantDays = days.slice(Math.max(0, previousDayIndex - CL_HISTORY_DAYS), previousDayIndex);

    for (let i = 0; i < relevantDays.length - 1; i++) {
      const day = relevantDays[i];
      const nextDay = relevantDays[i + 1];
      const dayDB = (allGroupedResults[day] || []).find(r => r.giai === 'ĐB');
      if (dayDB && dayDB.chanle === prevDayCL) {
        const nextDayDB = (allGroupedResults[nextDay] || []).find(r => r.giai === 'ĐB');
        if (nextDayDB && nextDayDB.chanle) {
          clStats[nextDayDB.chanle] = (clStats[nextDayDB.chanle] || 0) + 1;
        }
      }
    }
    if (Object.keys(clStats).length > 0) {
      predictedCL = Object.entries(clStats).sort((a, b) => b[1] - a[1])[0][0];
      console.log(`[Analysis] GĐB hôm trước có C/L là ${prevDayCL}. Thống kê dự đoán C/L hôm nay là: ${predictedCL}`);
    }
  }

  return { predictedCL, cycle3DayDigits };
};


/*
 * =================================================================
 * CẢI TIẾN #2: NÂNG CẤP HÀM TẠO DÀN SỐ DỰ ĐOÁN
 * (Thêm logic "boost" điểm cho các số được gợi ý)
 * =================================================================
 */
const generateFinalPrediction = (initialCounts, options = {}) => {
  const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const counts = { ...initialCounts }; // Tạo bản sao để không ảnh hưởng bản gốc

  // >> LOGIC MỚI: Tăng điểm cho các số được gợi ý từ phân tích chu kỳ <<
  if (options.boostDigits && Array.isArray(options.boostDigits)) {
    options.boostDigits.forEach(digit => {
      counts[digit] = (counts[digit] || 0) + CYCLE_BOOST_VALUE;
    });
  }

  const allCounts = allDigits.map(digit => ({ k: digit, v: counts[digit] || 0 }));

  const top5Hot = [...allCounts].sort((a, b) => b.v - a.v).slice(0, 5).map(o => o.k);
  const top5Cold = [...allCounts].sort((a, b) => a.v - b.v).slice(0, 5).map(o => o.k);
  const keeperSet = allDigits.filter(d => !top5Cold.includes(d));
  const intersection = top5Hot.filter(d => keeperSet.includes(d));
  const remainingKeepers = keeperSet.filter(d => !intersection.includes(d));
  const finalPrediction = [...intersection, ...remainingKeepers];

  return finalPrediction.slice(0, 5);
};

/*
 * =================================================================
 * CẢI TIẾN #3: HÀM CẬP NHẬT WEIGHTS VỚI LOGIC THƯỞNG/PHẠT/SUY GIẢM
 * =================================================================
 */
exports.updatePredictionWeights = async (req, res) => {
  console.log('🔔 [updatePredictionWeights] Start (with advanced logic)');
  try {
    const predsToUpdate = await Prediction.find({ danhDauDaSo: false }).lean();
    if (!predsToUpdate.length) return res.json({ message: 'Không có dự đoán nào cần cập nhật.' });

    let updatedCount = 0;
    for (const p of predsToUpdate) {
      const actualResults = await Result.find({ ngay: p.ngayDuDoan }).lean();
      if (!actualResults.length) continue;
      const dbRec = actualResults.find(r => r.giai === 'ĐB');
      if (!dbRec || !dbRec.so) continue;

      const dbStr = String(dbRec.so).slice(-3);
      const actual = { tram: dbStr[0], chuc: dbStr[1], donVi: dbStr[2] };
      const predDoc = await Prediction.findById(p._id);
      if (!predDoc) continue;

      predDoc.chiTiet.forEach(ct => {
        let originalWeight = ct.weight || 1;
        let newWeight = originalWeight;
        
        let matches = 0;
        // So sánh chéo 9 lần
        if (ct.tram === actual.tram) matches++;
        if (ct.chuc === actual.tram) matches++;
        if (ct.donvi === actual.tram) matches++;
        if (ct.tram === actual.chuc) matches++;
        if (ct.chuc === actual.chuc) matches++;
        if (ct.donvi === actual.chuc) matches++;
        if (ct.tram === actual.donVi) matches++;
        if (ct.chuc === actual.donVi) matches++;
        if (ct.donvi === actual.donVi) matches++;

        if (matches > 0) {
          // Thưởng
          newWeight += matches * REWARD_INCREMENT;
        } else {
          // Phạt
          newWeight -= PENALTY_DECREMENT;
        }

        // Luôn áp dụng suy giảm
        newWeight *= DECAY_FACTOR;

        // Áp dụng sàn và trần
        ct.weight = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, newWeight));
      });

      predDoc.danhDauDaSo = true;
      await predDoc.save();
      updatedCount++;
    }
    console.log(`✅ [updatePredictionWeights] Done, processed ${updatedCount} records.`);
    return res.json({ message: `Cập nhật weights hoàn tất. Đã xử lý ${updatedCount} bản ghi.`, updatedCount });
  } catch (err) {
    console.error('❌ [updatePredictionWeights] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};


/*
 * =================================================================
 * CẢI TIẾN #4: TÍCH HỢP LOGIC MỚI VÀO CÁC HÀM TRAIN
 * =================================================================
 */

// ----------------- HÀM HUẤN LUYỆN LỊCH SỬ (ĐÃ NÂNG CẤP) -----------------
exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (with ADVANCED ANALYSIS)');
  try {
    const results = await Result.find().sort({ 'ngay': 1 }).lean();
    if (results.length < 2) return res.status(400).json({ message: 'Không đủ dữ liệu để train historical' });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
    
    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1];
      const targetDay = days[i];

      // >> GỌI HÀM PHÂN TÍCH NÂNG CAO <<
      const analysis = await performAdvancedAnalysis(prevDay, grouped);

      const previousPrediction = await Prediction.findOne({ ngayDuDoan: prevDay }).lean();
      const prevResults = grouped[prevDay] || [];
      const countTram = {}, countChuc = {}, countDonVi = {};
      const chiTiet = [];

      prevResults.forEach((r, idx) => {
        const num = String(r.so).padStart(3, '0').slice(-3); // Luôn lấy 3 số cuối
        const [tram, chuc, donvi] = num.split('');
        
        const memoryChiTiet = previousPrediction?.chiTiet?.find(ct => ct.positionInPrize === idx);
        const weight = memoryChiTiet?.weight || 1;

        countTram[tram] = (countTram[tram] || 0) + weight;
        countChuc[chuc] = (countChuc[chuc] || 0) + weight;
        countDonVi[donvi] = (countDonVi[donvi] || 0) + weight;
        
        const nhomNho = Math.floor(idx / 3) + 1;
        const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;
        chiTiet.push({ number: r.so, nhomNho, nhomTo, positionInPrize: idx, tram, chuc, donvi, weight: 1 });
      });

      // >> TRUYỀN GỢI Ý VÀO HÀM TẠO DỰ ĐOÁN <<
      const finalTopTram = generateFinalPrediction(countTram, { boostDigits: analysis.cycle3DayDigits });
      const finalTopChuc = generateFinalPrediction(countChuc, { boostDigits: analysis.cycle3DayDigits });
      const finalTopDonVi = generateFinalPrediction(countDonVi, { boostDigits: analysis.cycle3DayDigits });

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDay },
        { 
          ngayDuDoan: targetDay, 
          topTram: finalTopTram, 
          topChuc: finalTopChuc, 
          topDonVi: finalTopDonVi, 
          chiTiet, 
          danhDauDaSo: false,
          analysis // Lưu kết quả phân tích
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

// ----------------- HÀM TẠO DỰ ĐOÁN NGÀY TIẾP THEO (ĐÃ NÂNG CẤP) -----------------
exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (with ADVANCED ANALYSIS)');
    try {
        const allResults = await Result.find().sort({ 'ngay': 1 }).lean();
        if (allResults.length < 1) return res.status(400).json({ message: 'Không có dữ liệu results.' });

        const grouped = {};
        allResults.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
        const days = Object.keys(grouped).sort((a, b) => a.localeCompare(b, 'vi', { numeric: true }));
        const latestDay = days[days.length - 1];
        
        const latestDate = DateTime.fromFormat(latestDay, 'dd/MM/yyyy');
        const nextDayStr = latestDate.plus({ days: 1 }).toFormat('dd/MM/yyyy');
        
        // >> GỌI HÀM PHÂN TÍCH NÂNG CAO <<
        const analysis = await performAdvancedAnalysis(latestDay, grouped);

        const previousPrediction = await Prediction.findOne({ ngayDuDoan: latestDay }).lean();
        const prevResults = grouped[latestDay];

        const countTram = {}, countChuc = {}, countDonVi = {};
        const chiTiet = [];
        prevResults.forEach((r, idx) => {
            const num = String(r.so).padStart(3, '0').slice(-3);
            const [tram, chuc, donvi] = num.split('');

            const memoryChiTiet = previousPrediction?.chiTiet?.find(ct => ct.positionInPrize === idx);
            const weight = memoryChiTiet?.weight || 1;

            countTram[tram] = (countTram[tram] || 0) + weight;
            countChuc[chuc] = (countChuc[chuc] || 0) + weight;
            countDonVi[donvi] = (countDonVi[donvi] || 0) + weight;

            const nhomNho = Math.floor(idx / 3) + 1;
            const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;
            chiTiet.push({ number: r.so, nhomNho, nhomTo, positionInPrize: idx, tram, chuc, donvi, weight: 1 });
        });

        // >> TRUYỀN GỢI Ý VÀO HÀM TẠO DỰ ĐOÁN <<
        const finalTopTram = generateFinalPrediction(countTram, { boostDigits: analysis.cycle3DayDigits });
        const finalTopChuc = generateFinalPrediction(countChuc, { boostDigits: analysis.cycle3DayDigits });
        const finalTopDonVi = generateFinalPrediction(countDonVi, { boostDigits: analysis.cycle3DayDigits });
        
        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { 
              ngayDuDoan: nextDayStr, 
              topTram: finalTopTram, 
              topChuc: finalTopChuc, 
              topDonVi: finalTopDonVi, 
              chiTiet, 
              danhDauDaSo: false,
              analysis // Lưu kết quả phân tích
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




