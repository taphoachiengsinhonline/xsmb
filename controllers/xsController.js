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





// Sửa hàm này trong file: controllers/xsController.js

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [Node.js] Bắt đầu huấn luyện lịch sử bằng ML...');
  try {
    // 1. Xóa hết các dự đoán cũ để làm lại từ đầu
    await Prediction.deleteMany({});
    console.log('   -> Đã xóa các dự đoán cũ.');

    // 2. Gọi Python service để tính toán toàn bộ lịch sử
    const mlResponse = await axios.post('http://localhost:5000/train_historical');
    const historicalPredictions = mlResponse.data;

    if (!Array.isArray(historicalPredictions) || historicalPredictions.length === 0) {
      throw new Error("Không nhận được dữ liệu lịch sử từ ML service.");
    }
    console.log(`   -> Nhận được ${historicalPredictions.length} bản ghi dự đoán lịch sử từ Python.`);

    // 3. Lấy dữ liệu chiTiet (để xem lại)
    const results = await Result.find().sort({ ngay: 1 }).lean();
    const groupedResults = {};
    results.forEach(r => { groupedResults[r.ngay] = r; });

    // 4. Lưu từng bản ghi dự đoán vào DB
    for (const pred of historicalPredictions) {
      const prevDayData = groupedResults[getPreviousDay(pred.ngayDuDoan)] || [];
      const chiTiet = prevDayData.map((r, idx) => { /* ... logic tạo chiTiet như cũ ... */ });
      
      pred.chiTiet = chiTiet; // Thêm chiTiet vào
      pred.danhDauDaSo = false; // Mặc định
    }

    await Prediction.insertMany(historicalPredictions);
    
    console.log(`✅ [Node.js] Đã lưu thành công ${historicalPredictions.length} dự đoán lịch sử vào DB.`);
    return res.json({ message: `Huấn luyện lịch sử bằng ML thành công! Đã tạo ${historicalPredictions.length} bản ghi.` });

  } catch (err) {
    console.error('❌ [Node.js] Lỗi khi huấn luyện lịch sử bằng ML:', err.response ? err.response.data : err.message);
    return res.status(500).json({ message: 'Lỗi khi huấn luyện lịch sử bằng ML', error: err.toString() });
  }
};

// Bạn sẽ cần thêm một hàm helper để tính ngày hôm trước
function getPreviousDay(dateString) { // dateString format: dd/mm/yyyy
    const parts = dateString.split('/');
    const d = new Date(parts[2], parts[1] - 1, parts[0]);
    d.setDate(d.getDate() - 1);
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// ----------------- HÀM TẠO DỰ ĐOÁN NGÀY TIẾP THEO (VỚI "TRÍ NHỚ" - ĐÃ SỬA) -----------------
exports.trainPredictionForNextDay = async (req, res) => {
    console.log('🔔 [trainPredictionForNextDay] Start (with MEMORY)');
    try {
        const latestResultArr = await Result.aggregate([
            { $addFields: { convertedDate: { $dateFromString: { dateString: '$ngay', format: '%d/%m/%Y', timezone: 'Asia/Ho_Chi_Minh' } } } },
            { $sort: { convertedDate: -1 } },
            { $limit: 1 }
        ]);
        if (!latestResultArr || latestResultArr.length === 0) return res.status(400).json({ message: 'Không có dữ liệu results.' });
        
        const latestDay = latestResultArr[0].ngay;

        // >>> ĐOẠN CODE BỊ THIẾU ĐÃ ĐƯỢC THÊM LẠI <<<
        const parts = latestDay.split('/');
        const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        d.setDate(d.getDate() + 1);
        const nextDayStr = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
        
        const previousPrediction = await Prediction.findOne({ ngayDuDoan: latestDay }).lean();
        const prevResults = await Result.find({ ngay: latestDay }).lean();
        if (!prevResults.length) return res.status(400).json({ message: 'Không có dữ liệu ngày trước để dự đoán.' });

        const countTram = {}, countChuc = {}, countDonVi = {};
        const chiTiet = [];
        prevResults.forEach((r, idx) => {
            const num = String(r.so).padStart(3, '0');
            const [tram, chuc, donvi] = num.split('');

            const memoryChiTiet = previousPrediction?.chiTiet?.find(ct => ct.positionInPrize === idx + 1);
            const weight = memoryChiTiet?.weight || 1;

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







