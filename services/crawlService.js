// crawlService.js
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const fs = require('fs');         // THÊM MỚI: Module để đọc file hệ thống
const path = require('path');     // THÊM MỚI: Module để xử lý đường dẫn file

// THÊM MỚI: Định nghĩa đường dẫn tuyệt đối đến file kqxs.html
// Giả sử file crawlService.js và kqxs.html đều nằm trong cùng thư mục `services`
const HTML_FILE_PATH = path.resolve(__dirname, '21.03.2024den14.01.2025.html');

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
// Lưu ý: Đoạn này đã được sửa để import Model thay vì định nghĩa Schema lại
// Điều này giúp tránh lỗi "OverwriteModelError" nếu service này được gọi nhiều lần
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

// ---------- Hàm Crawl từ URL (HÀM CŨ, GIỮ NGUYÊN) ----------
async function extractXsData() {
  console.log('⏳ Đang lấy dữ liệu từ URL', CRAWL_URL);
  try {
    const res = await axios.get(CRAWL_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 20000 });
    const $ = cheerio.load(res.data);
    const allText = $.text();

    const dateMatches = [...allText.matchAll(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/g)];
    const resultData = [];

    for (let dm of dateMatches) {
      const dateStr = dm[0].replace(/-/g, '/');
      const startPos = dm.index + dm[0].length;
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

// ---------- HÀM MỚI: Đọc và trích xuất dữ liệu từ file HTML local ----------
async function extractXsDataFromFile() {
  console.log('⏳ Đang đọc dữ liệu từ file local:', HTML_FILE_PATH);
  try {
    // 1. Kiểm tra file có tồn tại không
    if (!fs.existsSync(HTML_FILE_PATH)) {
        throw new Error(`File không tồn tại tại đường dẫn: ${HTML_FILE_PATH}`);
    }

    // 2. Đọc nội dung file HTML bằng module 'fs'
    const htmlContent = fs.readFileSync(HTML_FILE_PATH, 'utf8');

    // 3. Sử dụng Cheerio để parse nội dung HTML (giống hệt cách cũ)
    const $ = cheerio.load(htmlContent);
    const allText = $.text();

    // 4. Logic parse text từ đây trở đi giống hệt hàm extractXsData
    const dateMatches = [...allText.matchAll(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/g)];
    const resultData = [];

    for (let dm of dateMatches) {
      const dateStr = dm[0].replace(/-/g, '/');
      const startPos = dm.index + dm[0].length;
      const nextMatch = dateMatches.find(m => m.index > dm.index);
      const endPos = nextMatch ? nextMatch.index : allText.length;
      const dayText = allText.slice(startPos, endPos);
      const dayData = parseDayResults(dayText, dateStr);
      if (dayData.length) resultData.push(...dayData);
    }

    console.log(`✅ Đọc file xong, tổng bản ghi thu được: ${resultData.length}`);
    return resultData;
  } catch (e) {
    console.error('Lỗi đọc và trích xuất file:', e && e.message ? e.message : e);
    return [];
  }
}


// ---------- Lưu DB: upsert (new inserted sẽ có chanle) ----------
async function saveToDb(data) {
  if (!Array.isArray(data) || data.length === 0) {
    console.log('ℹ️ Không có dữ liệu mới để lưu.');
    return { insertedCount: 0, processedCount: 0 };
  }

  console.log(`⚙️ Chuẩn bị ghi ${data.length} bản ghi vào CSDL...`);

  // 1. Tạo một mảng các "lệnh" để gửi đi cùng lúc
  const operations = data.map(item => ({
    updateOne: {
      // Điều kiện để tìm bản ghi (giống như trước)
      filter: { ngay: item.ngay, giai: item.giai },
      // Dữ liệu để chèn vào nếu bản ghi không tồn tại (upsert)
      update: { $setOnInsert: item },
      // Bật cờ upsert
      upsert: true
    }
  }));

  try {
    // 2. Gọi hàm bulkWrite với mảng lệnh đã tạo
    // { ordered: false } cho phép MongoDB xử lý các lệnh song song, tăng tốc độ
    // và sẽ tiếp tục thực hiện ngay cả khi một vài lệnh bị lỗi.
    const result = await Result.bulkWrite(operations, { ordered: false });

    // 3. In ra kết quả
    const insertedCount = result.upsertedCount || 0;
    console.log('✅ Hoàn tất lưu trữ!');
    console.log(`   - Bản ghi mới được thêm: ${insertedCount}`);
    console.log(`   - Bản ghi đã tồn tại (bỏ qua): ${result.matchedCount || 0}`);
    console.log(`   - Tổng số đã xử lý: ${data.length}`);
    
    if (result.hasWriteErrors()) {
        console.warn('⚠️ Có một số lỗi ghi không nghiêm trọng:', result.getWriteErrors());
    }

    return { 
        insertedCount: insertedCount, 
        processedCount: data.length 
    };

  } catch (e) {
    console.error('❌ Lỗi nghiêm trọng trong quá trình bulkWrite:', e.message);
    // Ném lỗi ra để controller có thể bắt và xử lý
    throw e;
  }
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

// ---------- CHỈNH SỬA: Hàm chạy chính khi gọi trực tiếp file này ----------
async function runFromFileAndExit() {
  try {
    // Sửa ở đây: Gọi hàm đọc từ file thay vì hàm crawl URL
    const data = await extractXsDataFromFile();
    await saveToDb(data);
  } catch (e) {
    console.error(e);
  } finally {
    // ngắt kết nối DB sau khi chạy xong
    try { 
        await mongoose.disconnect(); 
        console.log('🔌 MongoDB disconnected');
    } catch(e) {}
  }
}

// Export functions để có thể gọi từ các file khác
module.exports = {
  extractXsData,          // Hàm cũ crawl từ URL
  extractXsDataFromFile,  // Hàm mới đọc từ file
  saveToDb,
  fixChanLeInDb,
};

// Nếu chạy trực tiếp file này bằng lệnh: node services/crawlService.js
// Script sẽ tự động chạy hàm runFromFileAndExit
if (require.main === module) {
  runFromFileAndExit(); // CHỈNH SỬA: Chạy hàm đọc từ file làm mặc định
}




