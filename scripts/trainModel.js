// trainModel.js
const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGO_URI;

// Kết nối MongoDB
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
});
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('✅ MongoDB connected'));

// Schema giống crawlService.js
const prizeSchema = new mongoose.Schema({
  ngay: String,
  giai: String,
  so: String,
  basocuoi: String,
  haisocuoi: String,
  chanle: String
}, { versionKey: false });

const Prize = mongoose.model('Prize', prizeSchema);

// Tất cả CL có 3 chữ số
const CL_VALUES = ['CCC','CCL','CLL','CLC','LLL','LLC','LCC','LCL'];

// Lấy danh sách ngày từ DB, sắp xếp tăng dần
async function getSortedDates() {
  const dates = await Prize.distinct('ngay');
  return dates.sort((a,b) => {
    const [dA,mA,yA] = a.split('/').map(Number);
    const [dB,mB,yB] = b.split('/').map(Number);
    return new Date(yA,mA-1,dA) - new Date(yB,mB-1,dB);
  });
}

// Thống kê tần suất CL hôm trước
async function analyzeDay(day) {
  const [d,m,y] = day.split('/').map(Number);
  const prevDate = new Date(y,m-1,d-1);
  const pd = `${String(prevDate.getDate()).padStart(2,'0')}/${String(prevDate.getMonth()+1).padStart(2,'0')}/${prevDate.getFullYear()}`;

  // Lấy tất cả giải có 3 số cuối của ngày hôm trước
  const prevRecords = await Prize.find({
    ngay: pd,
    chanle: { $in: CL_VALUES }
  });

  const countMap = {};
  CL_VALUES.forEach(c => countMap[c] = 0);
  prevRecords.forEach(r => {
    if (CL_VALUES.includes(r.chanle)) countMap[r.chanle]++;
  });

  console.log(`\n📅 Ngày hôm trước: ${pd} — thống kê CL:`);
  console.table(countMap);

  // Lấy CL giải ĐB hôm nay
  const todayRecords = await Prize.find({ ngay: day, giai: 'ĐB' });
  if (!todayRecords.length) return;

  const todayCL = todayRecords[0].chanle;
  console.log(`CL giải ĐB ngày ${day}: ${todayCL}`);

  // So sánh với CL hôm trước
  console.log('So sánh với CL hôm trước:');
  CL_VALUES.forEach(cl => {
    if (countMap[cl] > 0) {
      console.log(`${cl}: ${countMap[cl]} lần`);
    }
  });

  // Lấy 6 CL khả năng cao nhất (loại 2 ít ăn nhất)
  const sortedCL = Object.entries(countMap)
    .sort((a,b) => b[1]-a[1])
    .map(e => e[0])
    .slice(0,6);

  console.log('✅ 6 CL khả năng cao:', sortedCL.join(', '));

  // Ghép thành cặp đuôi trùng nhau
  const pairs = [];
  const used = new Set();
  for (let i=0;i<sortedCL.length;i++) {
    if (used.has(sortedCL[i])) continue;
    for (let j=i+1;j<sortedCL.length;j++) {
      if (used.has(sortedCL[j])) continue;
      if (sortedCL[i][1] === sortedCL[j][1]) { // đuôi trùng
        pairs.push([sortedCL[i],sortedCL[j]]);
        used.add(sortedCL[i]);
        used.add(sortedCL[j]);
        break;
      }
    }
  }

  console.log(`Các cặp CL có đuôi trùng nhau:`);
  pairs.forEach((p,i)=>console.log(`Cặp ${i+1}: ${p[0]} & ${p[1]}`));

  return { day, todayCL, top6: sortedCL, pairs };
}

// Chạy toàn bộ lịch sử
async function trainAll() {
  const dates = await getSortedDates();
  for (let day of dates) {
    await analyzeDay(day);
  }
  mongoose.disconnect();
}

if (require.main === module) trainAll();

module.exports = { analyzeDay, trainAll };
