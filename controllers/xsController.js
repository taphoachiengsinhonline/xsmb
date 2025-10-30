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
    console.log(`✅ Thêm ${insertedCount} bản ghi mới`);
    res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() });
  }
};


// ----------------- HÀM HUẤN LUYỆN LỊCH SỬ (ĐÃ SỬA LỖI + CẬP NHẬT LOGIC) -----------------
exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start');
  try {
    const results = await Result.find().sort({ ngay: 1 }).lean();
    if (!results.length) return res.status(400).json({ message: 'Không có dữ liệu results' });

    const grouped = {};
    for (const r of results) {
      grouped[r.ngay] = grouped[r.ngay] || [];
      grouped[r.ngay].push(r);
    }
    const days = Object.keys(grouped).sort((a, b) => a.split('/').reverse().join('-').localeCompare(b.split('/').reverse().join('-')));
    if (days.length < 2) return res.status(400).json({ message: 'Không đủ ngày để train historical' });

    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i - 1];
      const targetDay = days[i];
      const prevResults = grouped[prevDay] || [];

      const countTram = {}, countChuc = {}, countDonVi = {};
      const chiTiet = [];

      // BƯỚC 1: Dùng forEach để thu thập dữ liệu
      prevResults.forEach((r, idx) => {
        const num = String(r.so).padStart(3, '0');
        const [tram, chuc, donvi] = num.split('');
        countTram[tram] = (countTram[tram] || 0) + 1;
        countChuc[chuc] = (countChuc[chuc] || 0) + 1;
        countDonVi[donvi] = (countDonVi[donvi] || 0) + 1;

        const nhomNho = Math.floor(idx / 3) + 1;
        const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;

        chiTiet.push({
          number: num,
          nhomNho: nhomNho,
          nhomTo: nhomTo,
          positionInPrize: idx + 1,
          tram,
          chuc,
          donvi,
          weight: 1
        });
      }); // <-- Đóng forEach ở đây

      // BƯỚC 2: Sau khi forEach xong, tính toán và gọi await
      const sortTop = (obj) => Object.entries(obj).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 5).map(o => o.k);

      const topTram = sortTop(countTram);
      const topChuc = sortTop(countChuc);
      const topDonVi = sortTop(countDonVi);

      await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDay },
        { ngayDuDoan: targetDay, topTram, topChuc, topDonVi, chiTiet, danhDauDaSo: false },
        { upsert: true, new: true }
      );
      created++;
    }

    console.log(`✅ [trainHistoricalPredictions] Done, created/updated ${created} predictions`);
    return res.json({ message: `Huấn luyện lịch sử hoàn tất, đã tạo/cập nhật ${created} bản ghi.`, created });
  } catch (err) {
    console.error('❌ [trainHistoricalPredictions] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- HÀM TẠO DỰ ĐOÁN NGÀY TIẾP THEO (ĐÃ CẬP NHẬT LOGIC) -----------------
exports.trainPredictionForNextDay = async (req, res) => {
  console.log('🔔 [trainPredictionForNextDay] Start');
  try {
    // SỬ DỤNG AGGREGATION ĐỂ TÌM NGÀY MỚI NHẤT CHÍNH XÁC
    const latestResultArr = await Result.aggregate([
      {
        $addFields: {
          convertedDate: {
            $dateFromString: {
              dateString: '$ngay',
              format: '%d/%m/%Y',
              timezone: 'Asia/Ho_Chi_Minh'
            }
          }
        }
      },
      { $sort: { convertedDate: -1 } },
      { $limit: 1 }
    ]);

    if (!latestResultArr || latestResultArr.length === 0) {
      return res.status(400).json({ message: 'Không có dữ liệu results để tạo dự đoán.' });
    }

    const latestDay = latestResultArr[0].ngay;
    console.log(`✅ [trainPredictionForNextDay] Tìm thấy ngày kết quả mới nhất là: ${latestDay}`);

    // Tính toán ngày tiếp theo
    const parts = latestDay.split('/');
    const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    d.setDate(d.getDate() + 1);
    const nextDayStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    console.log(`🔮 [trainPredictionForNextDay] Sẽ tạo dự đoán cho ngày: ${nextDayStr}`);

    // Lấy tất cả kết quả của ngày mới nhất để phân tích
    const prevResults = await Result.find({ ngay: latestDay }).lean();
    if (!prevResults.length) {
      return res.status(400).json({ message: 'Không có dữ liệu của ngày mới nhất để phân tích.' });
    }

    const countTram = {}, countChuc = {}, countDonVi = {};
    const chiTiet = [];
    prevResults.forEach((r, idx) => {
      const num = String(r.so).padStart(3, '0');
      const [tram, chuc, donvi] = num.split('');
      countTram[tram] = (countTram[tram] || 0) + 1;
      countChuc[chuc] = (countChuc[chuc] || 0) + 1;
      countDonVi[donvi] = (countDonVi[donvi] || 0) + 1;

      const nhomNho = Math.floor(idx / 3) + 1;
      const nhomTo = Math.floor((nhomNho - 1) / 3) + 1;

      chiTiet.push({
        number: num,
        nhomNho: nhomNho,
        nhomTo: nhomTo,
        positionInPrize: idx + 1,
        tram,
        chuc,
        donvi,
        weight: 1
      });
    });

    const sortTop = (obj) => Object.entries(obj).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 5).map(o => o.k);
    const topTram = sortTop(countTram);
    const topChuc = sortTop(countChuc);
    const topDonVi = sortTop(countDonVi);

    await Prediction.findOneAndUpdate(
      { ngayDuDoan: nextDayStr },
      { ngayDuDoan: nextDayStr, topTram, topChuc, topDonVi, chiTiet, danhDauDaSo: false },
      { upsert: true, new: true }
    );

    console.log(`✅ [trainPredictionForNextDay] Saved prediction for ${nextDayStr}`);
    return res.json({ message: 'Tạo dự đoán cho ngày tiếp theo thành công!', ngayDuDoan: nextDayStr });
  } catch (err) {
    console.error('❌ [trainPredictionForNextDay] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- HÀM CẬP NHẬT WEIGHTS (LOGIC SO SÁNH CHÉO) -----------------
exports.updatePredictionWeights = async (req, res) => {
  console.log('🔔 [updatePredictionWeights] Start');
  try {
    const predsToUpdate = await Prediction.find({ danhDauDaSo: false }).lean();
    if (!predsToUpdate.length) return res.json({ message: 'Không có dự đoán nào cần cập nhật.' });

    let updatedCount = 0;
    for (const p of predsToUpdate) {
      const actualResults = await Result.find({ ngay: p.ngayDuDoan }).lean();
      if (!actualResults.length) {
        console.log(`⚠️ Không tìm thấy kết quả cho ngày ${p.ngayDuDoan}, bỏ qua.`);
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
      console.log(`✅ Đã cập nhật prediction ngày ${p.ngayDuDoan}, tổng weight tăng: ${incrTotal}`);
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
    console.log('🔍 [Backend] API /latest-prediction-date được gọi.');
    // Sắp xếp theo `ngayDuDoan` giảm dần. Sử dụng collation để sắp xếp chuỗi dd/mm/yyyy đúng.
    const latestPrediction = await Prediction.findOne()
      .sort({ ngayDuDoan: -1 })
      .collation({ locale: 'vi', numericOrdering: true }) // Rất quan trọng để sort chuỗi ngày tháng
      .lean();
      
    console.log('📄 [Backend] Bản ghi dự đoán tìm thấy:', latestPrediction); // LOG QUAN TRỌNG

    if (!latestPrediction) {
      console.log('⚠️ [Backend] Không tìm thấy bản ghi dự đoán nào trong DB.');
      return res.status(404).json({ message: 'Không tìm thấy bản ghi dự đoán nào.' });
    }
    
    console.log('✅ [Backend] Trả về ngày:', latestPrediction.ngayDuDoan);
    res.json({ latestDate: latestPrediction.ngayDuDoan });

  } catch (err) {
    console.error('❌ [Backend] Lỗi trong getLatestPredictionDate:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// Các hàm cũ hơn có thể được giữ lại hoặc xóa đi nếu không dùng
// exports.trainAdvancedModel = ...
// exports.getLatestPrediction = ...
// exports.getPrediction = ...



