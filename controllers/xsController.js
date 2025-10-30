const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');

exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ ngay: -1 });
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
    console.log(`✅ [Backend] Thêm ${insertedCount} bản ghi mới`);
    res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() });
  }
};

// --- thêm/replace hàm trainAdvancedModel với logging chi tiết ---
exports.trainAdvancedModel = async (req, res) => {
  console.log('🔔 [trainAdvancedModel] Start');

  try {
    const results = await Result.find().sort({ ngay: 1 }).lean();
    console.log(`🔎 Total results: ${results.length}`);

    if (results.length < 2) {
      return res.status(400).json({ message: "Không đủ dữ liệu để phân tích" });
    }

    // --- Group theo ngày ---
    const grouped = {};
    for (const r of results) {
      grouped[r.ngay] = grouped[r.ngay] || [];
      grouped[r.ngay].push(r);
    }

    const days = Object.keys(grouped).sort((a,b)=> {
      const ka = a.split('/').reverse().join('-');
      const kb = b.split('/').reverse().join('-');
      return ka.localeCompare(kb);
    });
    console.log(`📆 Total days: ${days.length}`);

    const analysis = [];

    for (let i = 0; i < days.length - 1; i++) {
      const day = days[i];
      const nextDay = days[i+1];
      const today = grouped[day] || [];
      const tomorrow = grouped[nextDay] || [];

      console.log(`➡️ Analyze ${day} -> ${nextDay}: today=${today.length}, next=${tomorrow.length}`);

      const dbTomorrowRec = tomorrow.find(r => r.giai === 'ĐB');
      if (!dbTomorrowRec || !dbTomorrowRec.so) continue;

      const dbStr = String(dbTomorrowRec.so).padStart(3,'0'); // 3 số
      const hangTram = dbStr.length >= 3 ? dbStr[0] : '0';
      const hangChuc = dbStr.length >= 2 ? dbStr[1] : '0';
      const hangDonVi = dbStr[2];

      const positions = [];

      today.forEach((r, idx) => {
        if (!r.so) return;
        const numStr = String(r.so).padStart(3,'0');

        ['trăm','chục','đơn vị'].forEach((pos, pIdx) => {
          const digit = numStr[pIdx];
          if ([hangTram, hangChuc, hangDonVi].includes(digit)) {
            positions.push({
              matchedDigit: digit,
              group: Math.floor(idx/9)+1,
              prizeIndex: idx+1,
              positionInPrize: pIdx+1,
              prizeCode: r.giai,
              number: numStr,
              weight: 1
            });
          }
        });
      });

      analysis.push({
        ngay: nextDay,
        giaiDB: dbStr,
        hangTram,
        hangChuc,
        hangDonVi,
        tanSuat: positions.length,
        chiTiet: positions
      });
    }

    // --- Thống kê top 5 trăm/chục/đơn vị ---
    const freqTram = {}, freqChuc = {}, freqDV = {};
    analysis.forEach(a => {
      freqTram[a.hangTram] = (freqTram[a.hangTram] || 0) + 1;
      freqChuc[a.hangChuc] = (freqChuc[a.hangChuc] || 0) + 1;
      freqDV[a.hangDonVi] = (freqDV[a.hangDonVi] || 0) + 1;
    });

    const top5 = freq => Object.entries(freq).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5);

    const topTram = top5(freqTram);
    const topChuc = top5(freqChuc);
    const topDonVi = top5(freqDV);

    console.log('🏁 Done trainAdvancedModel:', { topTram, topChuc, topDonVi });

    // --- Lưu dự đoán vào DB ---
    const todayStr = new Date().toLocaleDateString('vi-VN'); // ngày dự đoán: hôm nay
    const pred = await Prediction.findOneAndUpdate(
      { ngayDuDoan: todayStr },
      { ngayDuDoan: todayStr, topTram, topChuc, topDonVi, chiTiet: analysis.flatMap(a=>a.chiTiet), danhDauDaSo: false },
      { upsert: true, new: true }
    );

    return res.json({ message: "Huấn luyện nâng cao hoàn tất", topTram, topChuc, topDonVi, analysis });

  } catch(err) {
    console.error('❌ trainAdvancedModel error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

exports.updatePredictionWeights = async (req, res) => {
  console.log('🔔 [updatePredictionWeights] Start');

  try {
    // Lấy tất cả dự đoán chưa đánh dấu
    const predictions = await Prediction.find({ danhDauDaSo: false }).lean();
    console.log(`📌 Dự đoán chưa đánh dấu: ${predictions.length}`);

    for (const pred of predictions) {
      const ngay = pred.ngayDuDoan;
      const results = await Result.find({ ngay }).lean();
      if (!results || results.length === 0) {
        console.log(`⚠️ Không có kết quả thực tế cho ngày ${ngay}, bỏ qua`);
        continue;
      }

      // tìm ĐB
      const dbResult = results.find(r => r.giai === 'ĐB');
      if (!dbResult || !dbResult.so) continue;

      const dbStr = String(dbResult.so).padStart(3,'0');
      const actual = {
        tram: dbStr[0],
        chuc: dbStr[1],
        donVi: dbStr[2]
      };

      // update weight cho chiTiet
      const updatedChiTiet = pred.chiTiet.map(ct => {
        let inc = 0;
        if (ct.positionInPrize === 1 && ct.matchedDigit === actual.tram) inc = 1;
        if (ct.positionInPrize === 2 && ct.matchedDigit === actual.chuc) inc = 1;
        if (ct.positionInPrize === 3 && ct.matchedDigit === actual.donVi) inc = 1;
        return { ...ct, weight: ct.weight + inc };
      });

      await Prediction.updateOne(
        { _id: pred._id },
        { chiTiet: updatedChiTiet, danhDauDaSo: true }
      );

      console.log(`✅ Update weight prediction ngày ${ngay}, tăng ${updatedChiTiet.filter(ct=>ct.weight>1).length} entries`);
    }

    res.json({ message: "Cập nhật weights dự đoán xong" });

  } catch(err) {
    console.error('❌ updatePredictionWeights error:', err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

