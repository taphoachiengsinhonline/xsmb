const Result = require('../models/Result');
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

// ✅ Thêm mới Machine Learning nâng cao
exports.trainAdvancedModel = async (req, res) => {
  try {
    const results = await Result.find().sort({ ngay: 1 }); // tăng dần để xem ngày hôm sau

    if (results.length < 2) {
      return res.status(400).json({ message: "Không đủ dữ liệu để phân tích" });
    }

    const grouped = {};
    results.forEach(r => {
      if (!grouped[r.ngay]) grouped[r.ngay] = [];
      grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped);
    const analysis = [];

    for (let i = 0; i < days.length - 1; i++) {
      const day = days[i];
      const nextDay = days[i + 1];

      const today = grouped[day];
      const tomorrow = grouped[nextDay];

      const gdbTomorrow = tomorrow.find(r => r.giai === "ĐB")?.ketqua;
      if (!gdbTomorrow) continue;

      const hangChuc = gdbTomorrow[0];
      const hangDonVi = gdbTomorrow[1];

      const positions = [];

      // ✅ 27 giải → chia 3 nhóm → mỗi nhóm 9 giải
      today.forEach((r, idx) => {
        if (!r.ketqua) return;
        const group = Math.floor(idx / 9) + 1;
        const digits = r.ketqua.split("");

        digits.forEach((d, pos) => {
          if (d === hangChuc || d === hangDonVi) {
            positions.push({
              ngay: nextDay,
              soTrung: d,
              group,
              giaiIndex: idx + 1,
              viTriTrongGiai: pos + 1
            });
          }
        });
      });

      analysis.push({
        ngay: nextDay,
        giaiDB: gdbTomorrow,
        hangChuc,
        hangDonVi,
        tanSuat: positions.length,
        chiTiet: positions
      });
    }

    // ✅ Tổng hợp thống kê gợi ý số
    const freqChuc = {}, freqDV = {};
    analysis.forEach(a => {
      freqChuc[a.hangChuc] = (freqChuc[a.hangChuc] || 0) + 1;
      freqDV[a.hangDonVi] = (freqDV[a.hangDonVi] || 0) + 1;
    });

    const sortedChuc = Object.keys(freqChuc).sort((a,b)=>freqChuc[b]-freqChuc[a]).slice(0,5);
    const sortedDV = Object.keys(freqDV).sort((a,b)=>freqDV[b]-freqDV[a]).slice(0,5);

    res.json({
      message: "✅ Huấn luyện Machine Learning nâng cao thành công",
      soGoiy: sortedChuc.map(h=>h) + sortedDV.map(h=>h),
      topChuc: sortedChuc,
      topDonVi: sortedDV,
      analysis
    });

  } catch(err) {
    console.error(err);
    res.status(500).json({ message: "Lỗi server", error: err.toString() });
  }
};
