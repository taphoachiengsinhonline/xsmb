// crawlService.js
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
// const { DateTime } = require('luxon'); // không bắt buộc ở đây nhưng để nguyên nếu cần dùng sau

const MONGO_URI = process.env.MONGO_URI;
const CRAWL_URL = process.env.CRAWL_URL || 'https://ketqua04.net/so-ket-qua';

// ---------- Mongo kết nối ----------
if (!MONGO_URI) {
  console.warn('⚠️ MONGO_URI chưa được cấu hình. Kết nối sẽ cố gắng nhưng có thể lỗi.');
}
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('✅ MongoDB connected'));

// ---------- Schema ----------
const prizeSchema = new mongoose.Schema({
  ngay: { type: String, required: true }, // dd/mm/yyyy
  giai: String,
  so: String,
  basocuoi: String,
  haisocuoi: String,
  chanle: String,
}, { versionKey: false });

const Result = require('../models/Result');
// ---------- Helper: tính C/L từ 3 số ----------
function getChanLe(numberStr) {
  // numberStr expected exactly 3 digits
  if (!numberStr || numberStr.length !== 3) return '';
  return numberStr.split('').map(d => (parseInt(d, 10) % 2 === 0 ? 'C' : 'L')).join('');
}

// ---------- Helper: làm sạch chuỗi số (loại bỏ ký tự lạ) ----------
function onlyDigits(s) {
  return (s || '').toString().replace(/\D/g, '');
}

// ---------- Tạo record (luôn dựa vào basocuoi để tạo chanle, bỏ qua G7) ----------
function createPrizeRecord(ngay, prizeCode, index, numberRaw) {
  const number = onlyDigits(numberRaw);
  let giai = prizeCode;

  // suffix rules
  if (prizeCode === 'G2') giai += index === 0 ? 'a' : 'b';
  else if (['G3','G4','G5','G6','G7'].includes(prizeCode)) giai += String.fromCharCode(97 + index);

  // tính basocuoi & haisocuoi theo độ dài nguyên số
  let basocuoi = number;
  let haisocuoi = number;

  if (number.length === 5) {
    basocuoi = number.slice(2);   // 3 số cuối
    haisocuoi = number.slice(3);  // 2 số cuối
  } else if (number.length === 4) {
    basocuoi = number.slice(1);   // 3 số cuối
    haisocuoi = number.slice(2);  // 2 số cuối
  } else if (number.length === 3) {
    basocuoi = number;            // toàn bộ 3 số
    haisocuoi = number.slice(1);
  } else if (number.length === 2) {
    basocuoi = number;            // 2 số (G7)
    haisocuoi = number;
  } else {
    // fallback: lấy 3 số cuối nếu có
    basocuoi = number.length >= 3 ? number.slice(-3) : number;
    haisocuoi = number.length >= 2 ? number.slice(-2) : number;
  }

  // Tính chanle dựa trên basocuoi (3 chữ số) — bỏ qua G7 (vì basocuoi sẽ có 2 chữ số)
  const chanle = (basocuoi && basocuoi.length === 3 && !giai.startsWith('G7'))
    ? getChanLe(basocuoi)
    : '';

  return {
    ngay,
    giai,
    so: number,
    basocuoi,
    haisocuoi,
    chanle
  };
}

// ---------- Parse 1 ngày ----------
function parseDayResults(dayText, ngay) {
  const resultData = [];
  const prizeNames = ['Đặc biệt','Giải nhất','Giải nhì','Giải ba','Giải tư','Giải năm','Giải sáu','Giải bảy'];
  const slices = {};

  // Tách từng block theo tên giải (từ vị trí tìm thấy)
  let lastIdx = 0;
  for (let i = 0; i < prizeNames.length; i++) {
    const name = prizeNames[i];
    const idx = dayText.indexOf(name, lastIdx);
    if (idx !== -1) {
      const endIdx = (i < prizeNames.length - 1) ? dayText.indexOf(prizeNames[i+1], idx) : dayText.length;
      slices[name] = dayText.slice(idx, endIdx === -1 ? dayText.length : endIdx);
      lastIdx = idx;
    }
  }

  const findAllLen = (txt, n) => (txt.match(new RegExp(`\\d{${n}}`, 'g')) || []);

  if (slices['Đặc biệt']) findAllLen(slices['Đặc biệt'], 5).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'ĐB', i, num)));
  if (slices['Giải nhất']) findAllLen(slices['Giải nhất'], 5).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G1', i, num)));
  if (slices['Giải nhì']) findAllLen(slices['Giải nhì'], 5).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G2', i, num)));
  if (slices['Giải ba']) findAllLen(slices['Giải ba'], 5).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G3', i, num)));
  if (slices['Giải tư']) findAllLen(slices['Giải tư'], 4).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G4', i, num)));
  if (slices['Giải năm']) findAllLen(slices['Giải năm'], 4).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G5', i, num)));
  if (slices['Giải sáu']) findAllLen(slices['Giải sáu'], 3).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G6', i, num)));
  if (slices['Giải bảy']) findAllLen(slices['Giải bảy'], 2).slice(0,4).forEach((num, i) => resultData.push(createPrizeRecord(ngay, 'G7', i, num)));

  return resultData;
}

// ---------- Crawl toàn bộ ----------
async function extractXsData() {
  console.log('⏳ Đang lấy dữ liệu từ', CRAWL_URL);
  try {
    const res = await axios.get(CRAWL_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const $ = cheerio.load(res.data);
    const allText = $.text();

    const dateMatches = [...allText.matchAll(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/g)];
    const resultData = [];

    for (let dm of dateMatches) {
      const dateStr = dm[0].replace(/-/g, '/');
      const startPos = dm.index + dm[0].length;
      // lấy phần text từ ngày này tới ngày tiếp theo (nếu có) để giới hạn parse
      // tìm vị trí của match tiếp theo
      const nextMatch = dateMatches.find(m => m.index > dm.index);
      const endPos = nextMatch ? nextMatch.index : allText.length;
      const dayText = allText.slice(startPos, endPos);
      const dayData = parseDayResults(dayText, dateStr);
      if (dayData.length) resultData.push(...dayData);
    }

    console.log(`✅ Crawl xong, tổng bản ghi thu được: ${resultData.length}`);
    return resultData;
  } catch (e) {
    console.error('Lỗi crawl:', e && e.message ? e.message : e);
    return [];
  }
}

// ---------- Lưu DB: upsert (new inserted sẽ có chanle) ----------
async function saveToDb(data) {
  if (!Array.isArray(data) || data.length === 0) {
    console.log('Không có dữ liệu để lưu');
    return;
  }

  let inserted = 0;
  for (const item of data) {
    try {
      // SỬA: Prize thành Result
      await Result.updateOne(
        { ngay: item.ngay, giai: item.giai },
        { $setOnInsert: item },
        { upsert: true }
      );
      inserted++;
    } catch (e) {
      console.error('Lỗi insert/update:', e && e.message ? e.message : e, item);
    }
  }
  console.log(`✅ Lưu xong (tổng phần tử đã xử lý): ${inserted}`);
}

// ---------- Hàm fix toàn bộ chanle trong DB (cập nhật các bản ghi có chanle rỗng) ----------
async function fixChanLeInDb() {
  console.log('🔧 Bắt đầu fix chanle cho các bản ghi cũ...');
  try {
    const cursor = Result.find({ $or: [{ chanle: '' }, { chanle: null }, { chanle: { $exists: false } }] }).cursor();
    let count = 0;
    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      const baso = doc.basocuoi || '';
      if (baso && baso.length === 3 && baso.match(/^\d{3}$/) && !String(doc.chanle || '').trim().length && !doc.giai.startsWith('G7')) {
        doc.chanle = getChanLe(baso);
        await doc.save();
        count++;
      }
    }
    console.log(`✅ Đã cập nhật chanle cho ${count} bản ghi.`);
  } catch (e) {
    console.error('Lỗi fixChanLeInDb:', e && e.message ? e.message : e);
  }
}

// ---------- Nếu chạy trực tiếp file này (node crawlService.js) thì crawl + save ----------
async function runOnceAndExit() {
  try {
    const data = await extractXsData();
    await saveToDb(data);
  } catch (e) {
    console.error(e);
  } finally {
    // không disconnect nếu app còn chạy trên server; nếu chạy script độc lập thì disconnect
    try { await mongoose.disconnect(); } catch(e) {}
  }
}

// Export functions
module.exports = {
  extractXsData,
  saveToDb,
  fixChanLeInDb,
  runOnceAndExit
};

// Nếu chạy trực tiếp: node crawlService.js
if (require.main === module) {
  runOnceAndExit();
}

