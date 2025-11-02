// scripts/trainModel.js
const mongoose = require('mongoose');
const Prize = require('../models/Result'); // giả sử file prize.js là schema
const { DateTime } = require('luxon');

const CL_PATTERNS = ['CCC','CCL','CLC','CLL','LLC','LLL','LCC','LCL'];

// Tính thống kê CL giải đặc biệt so với các giải khác
async function getCLAnalysis(date = null) {
  await mongoose.connect(process.env.MONGO_URI);

  // Lấy danh sách ngày có kết quả
  let match = {};
  if (date) match.ngay = date;
  
  const allResults = await Result.find(match).sort({ ngay: 1 }).lean();

  // Group theo ngày
  const grouped = {};
  allResults.forEach(r => {
    if (!grouped[r.ngay]) grouped[r.ngay] = [];
    grouped[r.ngay].push(r);
  });

  const analysis = [];

  for (let [ngay, records] of Object.entries(grouped)) {
    const todayDB = records.find(r => r.giai === 'ĐB');
    if (!todayDB) continue;

    // Tạo thống kê CL ngày hôm trước
    const prevDay = Object.keys(grouped).filter(d => d < ngay).pop();
    const prevRecords = prevDay ? grouped[prevDay] : [];
    const clCount = {};

    // Init count
    CL_PATTERNS.forEach(cl => clCount[cl] = 0);

    // So sánh với tất cả giải có 3 số cuối (basocuoi.length===3)
    prevRecords.forEach(r => {
      if (r.basocuoi.length === 3) {
        const cl = r.chanle || '';
        if (clCount[cl] !== undefined) clCount[cl]++;
      }
    });

    // Lọc ra 2 CL ít ăn nhất
    const sortedCL = Object.entries(clCount).sort((a,b) => b[1]-a[1]);
    const top6 = sortedCL.slice(0,6).map(e => e[0]);

    // Ghép cặp đuôi trùng nhau
    const pairs = [];
    const used = new Set();
    for (let cl of top6) {
      if (used.has(cl)) continue;
      const matchPair = top6.find(c => c !== cl && c.slice(-1) === cl.slice(-1));
      if (matchPair) {
        pairs.push([cl, matchPair]);
        used.add(cl);
        used.add(matchPair);
      }
    }

    analysis.push({
      ngay,
      dbCL: todayDB.chanle,
      clCount,
      top6,
      pairs
    });
  }

  mongoose.disconnect();
  return analysis;
}

module.exports = { getCLAnalysis };
