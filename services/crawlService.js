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

// ---------- Parse 1 ngày (Cải thiện robust parsing với selectors) ----------
function parseDayResults($, ngay) {
  const resultData = [];
  const prizeCodes = ['ĐB', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
  const prizeNames = ['Đặc biệt', 'Giải nhất', 'Giải nhì', 'Giải ba', 'Giải tư', 'Giải năm', 'Giải sáu', 'Giải bảy'];

  // Giả định cấu trúc site: Tìm div hoặc table chứa kết quả cho ngày cụ thể
  // Thay vì $.text(), sử dụng selectors: Ví dụ, '.ketqua' là class chứa table kết quả
  // Điều chỉnh selectors dựa trên inspect site thực tế (ví dụ: '#result_table tr' cho rows)
  const resultContainer = $('.ketqua'); // Thay bằng selector thực tế, ví dụ: 'div[id^="result_"]' hoặc 'table.ketqua'
  if (resultContainer.length === 0) {
    console.warn(`Không tìm thấy container cho ngày ${ngay}`);
    return [];
  }

  prizeNames.forEach((name, idx) => {
    // Tìm phần tử chứa tên giải (robust: tìm text chứa name)
    const prizeSection = resultContainer.find(`:contains("${name}")`).closest('tr'); // Giả định table, tìm row chứa name
    if (prizeSection.length > 0) {
      // Lấy các số từ các td tiếp theo (robust: lấy text từ td.number hoặc class tương tự)
      const numbers = prizeSection.nextAll('td.number').map((i, el) => $(el).text().trim()).get(); // Thay 'td.number' bằng selector thực tế
      numbers.forEach((num, subIdx) => {
        if (num) {
          resultData.push(createPrizeRecord(ngay, prizeCodes[idx], subIdx, num));
        }
      });
    }
  });

  return resultData;
}

// ---------- Crawl toàn bộ ----------
async function extractXsData() {
  console.log('⏳ Đang lấy dữ liệu từ', CRAWL_URL);
  try {
    const res = await axios.get(CRAWL_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const $ = cheerio.load(res.data);

    const resultData = [];
    // Tìm tất cả các ngày (robust: tìm div hoặc h3 chứa ngày)
    const dateElements = $('h3.ngay, div.date-header'); // Thay bằng selector thực tế cho ngày
    dateElements.each((idx, el) => {
      const dateStr = $(el).text().trim().match(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/)?.[0].replace(/-/g, '/') || '';
      if (dateStr) {
        // Lấy phần kết quả cho ngày này (robust: lấy sibling table hoặc div tiếp theo)
        const dayContainer = $(el).next('table.ketqua'); // Thay bằng selector thực tế
        const dayData = parseDayResults(dayContainer, dateStr);
        if (dayData.length) resultData.push(...dayData);
      }
    });

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
      // Kiểm tra tồn tại trước upsert để tránh duplicate (dù index unique)
      const exists = await Result.findOne({ ngay: item.ngay, giai: item.giai });
      if (!exists) {
        await Result.create(item); // Sử dụng create thay vì updateOne để tận dụng schema validation
        inserted++;
      } else {
        console.log(`Bản ghi đã tồn tại: ${item.ngay} - ${item.giai}, bỏ qua.`);
      }
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
      if (baso && baso.length === 3 && !String(doc.chanle).trim() && !doc.giai.startsWith('G7')) {
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
