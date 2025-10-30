// file: controllers/xsController.js

const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');

// --- Lấy tất cả kết quả XSMB ---
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ 'ngay': -1, 'giai': 1 }); // Sắp xếp hợp lý hơn
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


/*
 * =================================================================
 * HELPER FUNCTION: TẠO DÀN SỐ DỰ ĐOÁN CUỐI CÙNG (LOGIC MỚI)
 * =================================================================
 */
const generateFinalPrediction = (counts) => {
  const allDigits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

  // Chuyển object counts thành mảng. Nếu một số không xuất hiện, gán count = 0
  const allCounts = allDigits.map(digit => ({
    k: digit,
    v: counts[digit] || 0
  }));

  // Bước 1: Tìm 5 số "Nóng" (tần suất cao nhất)
  const top5Hot = [...allCounts].sort((a, b) => b.v - a.v).slice(0, 5).map(o => o.k);

  // Bước 2: Tìm 5 số "Lạnh" (tần suất thấp nhất)
  const top5Cold = [...allCounts].sort((a, b) => a.v - b.v).slice(0, 5).map(o => o.k);

  // Bước 3: Suy ra 5 số "Giữ Lại" (dàn số an toàn)
  const keeperSet = allDigits.filter(d => !top5Cold.includes(d));

  // Bước 4: Tìm Giao Điểm (những số "vàng", ưu tiên cao nhất)
  const intersection = top5Hot.filter(d => keeperSet.includes(d));

  // Bước 5 (LOGIC MỚI): Tạo dàn số cuối cùng
  // Lấy các số còn lại từ chính keeperSet để bù vào nếu thiếu
  const remainingKeepers = keeperSet.filter(d => !intersection.includes(d));
  
  // Ghép phần giao điểm và phần còn lại của keeperSet
  const finalPrediction = [...intersection, ...remainingKeepers];

  // Luôn đảm bảo trả về đúng 5 số
  return finalPrediction.slice(0, 5);
};





// ----------------- HÀM HUẤN LUYỆN LỊCH SỬ (VỚI "TRÍ NHỚ") -----------------
exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start (with MEMORY)');
  try {
    const results = await Result.find().sort({ ngay: 1 }).lean();
    if (results.length < 2) return res.status(400).json({ message: 'Không đủ ngày để train historical' });

    const grouped = {};
    results.forEach(r => { grouped[r.ngay] = grouped[r.ngay] || []; grouped[r.ngay].push(r); });
    const days = Object.keys(grouped).sort((a, b) => a.split('/').reverse().join('-').localeCompare(b.split('/').reverse().join('-')));
    
    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1]; // Ngày dùng để phân tích (N-1)
      const targetDay = days[i];  // Ngày cần dự đoán (N)

      // BƯỚC MỚI: Tải "trí nhớ" từ dự đoán của ngày hôm trước
      const previousPrediction = await Prediction.findOne({ ngayDuDoan: prevDay }).lean();

      const prevResults = grouped[prevDay] || [];
      const countTram = {}, countChuc = {}, countDonVi = {};
      const chiTiet = [];

      prevResults.forEach((r, idx) => {
        const num = String(r.so).padStart(3, '0');
        const [tram, chuc, donvi] = num.split('');
        
        // TÌM WEIGHT TƯƠNG ỨNG TỪ "TRÍ NHỚ"
        const memoryChiTiet = previousPrediction?.chiTiet?.find(ct => ct.positionInPrize === idx + 1);
        const weight = memoryChiTiet?.weight || 1; // Mặc định là 1 nếu không có "trí nhớ"

        // SỬ DỤNG WEIGHT ĐỂ TÍNH TẦN SUẤT
        countTram[tram] = (countTram[tram] || 0) + weight;
        countChuc[chuc] = (countChuc[chuc] || 0) + weight;
        countDonVi[donvi] = (countDonVi[donvi] || 0) + weight;
        
        const nhomNho = Math.floor(idx / 3) + 1;
        const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;
        chiTiet.push({ number: num, nhomNho, nhomTo, positionInPrize: idx + 1, tram, chuc, donvi, weight: 1 }); // weight khởi tạo luôn là 1
      });

      const finalTopTram = generateFinalPrediction(countTram);
      const finalTopChuc = generateFinalPrediction(countChuc);
      const finalTopDonVi = generateFinalPrediction(countDonVi);

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDay },
        { ngayDuDoan: targetDay, topTram: finalTopTram, topChuc: finalTopChuc, topDonVi: finalTopDonVi, chiTiet, danhDauDaSo: false },
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


// ----------------- HÀM TẠO DỰ ĐOÁN NGÀY TIẾP THEO (ÁP DỤNG LOGIC MỚI) -----------------
// ----------------- HÀM TẠO DỰ ĐOÁN NGÀY TIẾP THEO (VỚI "TRÍ NHỚ") -----------------
exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (with MEMORY)');
    try {
        const latestResultArr = await Result.aggregate([...]); // Giữ nguyên logic aggregate
        if (!latestResultArr || latestResultArr.length === 0) return res.status(400).json({ message: 'Không có dữ liệu results.' });
        const latestDay = latestResultArr[0].ngay;
        const nextDayStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        
        const previousPrediction = await Prediction.findOne({ ngayDuDoan: latestDay }).lean();
        
        const prevResults = await Result.find({ ngay: latestDay }).lean();
        if (!prevResults.length) return res.status(400).json({ message: 'Không có dữ liệu ngày trước để dự đoán.' });

        const countTram = {}, countChuc = {}, countDonVi = {};
        const chiTiet = [];
        prevResults.forEach((r, idx) => {
            const num = String(r.so).padStart(3, '0');
            const [tram, chuc, donvi] = num.split('');

            // TÌM WEIGHT TƯƠNG ỨNG TỪ "TRÍ NHỚ"
            const memoryChiTiet = previousPrediction?.chiTiet?.find(ct => ct.positionInPrize === idx + 1);
            const weight = memoryChiTiet?.weight || 1;

            // SỬ DỤNG WEIGHT ĐỂ TÍNH TẦN SUẤT
            countTram[tram] = (countTram[tram] || 0) + weight;
            countChuc[chuc] = (countChuc[chuc] || 0) + weight;
            countDonVi[donvi] = (countDonVi[donvi] || 0) + weight;

            const nhomNho = Math.floor(idx / 3) + 1;
            const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;
            chiTiet.push({ number: num, nhomNho, nhomTo, positionInPrize: idx + 1, tram, chuc, donvi, weight: 1 });
        });

        const finalTopTram = generateFinalPrediction(countTram);
        const finalTopChuc = generateFinalPrediction(countChuc);
        const finalTopDonVi = generateFinalPrediction(countDonVi);
        
        await Prediction.findOneAndUpdate(
            { ngayDuDoan: nextDayStr },
            { ngayDuDoan: nextDayStr, topTram: finalTopTram, topChuc: finalTopChuc, topDonVi: finalTopDonVi, chiTiet, danhDauDaSo: false },
            { upsert: true, new: true }
        );

        console.log(`✅ [trainPredictionForNextDay] Đã lưu dự đoán cho ngày ${nextDayStr}`);
        return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
    } catch (err) {
        console.error('❌ [trainPredictionForNextDay] Error:', err);
        return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
    }
};

// ----------------- HÀM CẬP NHẬT WEIGHTS (LOGIC SO SÁNH CHÉO) -----------------
exports.updatePredictionWeights = async (req, res) => {
  try {
    const predsToUpdate = await Prediction.find({ danhDauDaSo: false }).lean();
    if (!predsToUpdate.length) return res.json({ message: 'Không có dự đoán nào cần cập nhật.' });

    let updatedCount = 0;
    for (const p of predsToUpdate) {
      const actualResults = await Result.find({ ngay: p.ngayDuDoan }).lean();
      if (!actualResults.length) {
        continue;
      }
      const dbRec = actualResults.find(r => r.giai === 'ĐB');
      if (!dbRec || !dbRec.so) continue;
      
      const dbStr = String(dbRec.so).slice(-3); // Luôn lấy 3 số cuối
      const actual = { tram: dbStr[0], chuc: dbStr[1], donVi: dbStr[2] };

      const predDoc = await Prediction.findById(p._id);
      if (!predDoc) continue;

      let incrTotal = 0;
      predDoc.chiTiet.forEach(ct => {
        let originalWeight = ct.weight || 1;
        let newWeight = originalWeight;
        
        // So sánh chéo 3 chữ số của GĐB thật với 3 chữ số của từng giải hôm trước
        if (ct.tram === actual.tram) newWeight++;
        if (ct.chuc === actual.tram) newWeight++;
        if (ct.donvi === actual.tram) newWeight++;

        if (ct.tram === actual.chuc) newWeight++;
        if (ct.chuc === actual.chuc) newWeight++;
        if (ct.donvi === actual.chuc) newWeight++;

        if (ct.tram === actual.donVi) newWeight++;
        if (ct.chuc === actual.donVi) newWeight++;
        if (ct.donvi === actual.donVi) newWeight++;

        if (newWeight > originalWeight) {
          ct.weight = newWeight;
          incrTotal += (newWeight - originalWeight);
        }
      });

      predDoc.danhDauDaSo = true;
      await predDoc.save();
      updatedCount++;
    }

    return res.json({ message: `Cập nhật weights hoàn tất. Đã xử lý ${updatedCount} bản ghi.`, updatedCount });
  } catch (err) {
    console.error('❌ [updatePredictionWeights] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- GET Prediction theo ngày -----------------
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

// ----------------- LẤY NGÀY DỰ ĐOÁN MỚI NHẤT (VỚI LOG DEBUG) -----------------
exports.getLatestPredictionDate = async (req, res) => {
  try {
    // Sắp xếp theo `ngayDuDoan` giảm dần. Sử dụng collation để sắp xếp chuỗi dd/mm/yyyy đúng.
    const latestPrediction = await Prediction.findOne()
      .sort({ ngayDuDoan: -1 })
      .collation({ locale: 'vi', numericOrdering: true }) // Rất quan trọng để sort chuỗi ngày tháng
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





