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

// --- thêm/replace hàm trainAdvancedModel với logging chi tiết ---
exports.trainAdvancedModel = async (req, res) => {
  console.log('🔔 [trainAdvancedModel] Bắt đầu request trainAdvancedModel');
  try {
    // Lấy toàn bộ dữ liệu (sắp tăng dần theo ngày)
    const results = await Result.find().sort({ ngay: 1 }).lean();
    console.log(`🔎 [trainAdvancedModel] Tổng bản ghi lấy từ DB: ${results.length}`);

    if (results.length < 2) {
      console.log('⚠️ [trainAdvancedModel] Không đủ dữ liệu để phân tích (<2)');
      return res.status(400).json({ message: "Không đủ dữ liệu để phân tích" });
    }

    // Group theo ngày
    const grouped = {};
    for (const r of results) {
      grouped[r.ngay] = grouped[r.ngay] || [];
      grouped[r.ngay].push(r);
    }
    const days = Object.keys(grouped).sort((a,b) => {
  const ka = a.split('/').reverse().join('-');
  const kb = b.split('/').reverse().join('-');
  return kb.localeCompare(ka); // đảo ngược
});

    console.log(`📆 [trainAdvancedModel] Tổng ngày: ${days.length}`);

    const analysis = [];
    // duyệt từng cặp (day -> nextDay)
    for (let i = 0; i < days.length - 1; i++) {
      const day = days[i];
      const nextDay = days[i+1];
      const today = grouped[day] || [];
      const tomorrow = grouped[nextDay] || [];

      // log kích thước
      console.log(`➡️ [trainAdvancedModel] Phân tích: prev=${day}(${today.length}) -> next=${nextDay}(${tomorrow.length})`);

      const dbTomorrowRec = tomorrow.find(r => r.giai === 'ĐB');
      if (!dbTomorrowRec || !dbTomorrowRec.so) {
        console.log(`   ⚠️ [trainAdvancedModel] Next day ${nextDay} không có ĐB, bỏ qua`);
        continue;
      }

      const dbStr = String(dbTomorrowRec.so).padStart(2, '0');
      const hangChuc = dbStr.length >= 2 ? dbStr[dbStr.length - 2] : dbStr[0];
      const hangDonVi = dbStr[dbStr.length - 1];

      // scan 27 results of today (if some missing we still scan)
      const positions = [];
      // create ordered list by known prize order if needed (assume 'today' may be unordered)
      // build map giai->index using expected order if you have PRIZE_ORDER; else rely on array order
      for (let idx = 0; idx < today.length; idx++) {
        const r = today[idx];
        if (!r || !r.so) continue;
        const numStr = String(r.so);
        const group = Math.floor(idx / 9) + 1; // 1..3 groups of 9 (as user requested)
        for (let pos = 0; pos < numStr.length; pos++) {
          const ch = numStr[pos];
          if (ch === hangChuc || ch === hangDonVi) {
            positions.push({
              ngayPrev: day,
              ngayNext: nextDay,
              matchedDigit: ch,
              group,
              prizeIndex: idx + 1,
              positionInPrize: pos + 1,
              prizeCode: r.giai || null,
              number: numStr
            });
            console.log(`     ✅ Match found: prev=${day} idx=${idx+1} giai=${r.giai} num=${numStr} pos=${pos+1} digit=${ch}`);
          }
        }
      }

      analysis.push({
        ngay: nextDay,
        giaiDB: dbStr,
        hangChuc,
        hangDonVi,
        tanSuat: positions.length,
        chiTiet: positions
      });

      console.log(`   🔢 [trainAdvancedModel] Day ${day} -> next ${nextDay}: matches=${positions.length}`);
    }

    // tổng hợp top5
    const freqChuc = {}, freqDV = {};
    for (const a of analysis) {
      freqChuc[a.hangChuc] = (freqChuc[a.hangChuc] || 0) + 1;
      freqDV[a.hangDonVi] = (freqDV[a.hangDonVi] || 0) + 1;
    }
    const sortTop = (freq) => Object.entries(freq).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5);
    const topChuc = sortTop(freqChuc);
    const topDonVi = sortTop(freqDV);

    console.log('🏁 [trainAdvancedModel] Hoàn tất. Top hàng chục:', topChuc, 'Top đơn vị:', topDonVi);

    return res.json({
      message: "Huấn luyện nâng cao hoàn tất",
      topChuc,
      topDonVi,
      analysis
    });

  } catch (err) {
    console.error('❌ [trainAdvancedModel] Lỗi:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

