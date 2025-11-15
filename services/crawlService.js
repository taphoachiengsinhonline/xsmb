// crawlService.js (Phiên bản chạy trên Railway)
const fs = require('fs');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const path = require('path');

// --- CẤU HÌNH ---
// Xây dựng đường dẫn tuyệt đối đến file kqxs.html
// Giả sử file crawlService.js và kqxs.html đều nằm trong cùng thư mục `services`
const HTML_FILE_PATH = path.resolve(__dirname, '22.07.2022den21.05.2023.html');

// --- SCHEMA & MODEL (Đồng bộ hóa với 'Result') ---
const resultSchema = new mongoose.Schema({
  ngay: { type: String, required: true },
  giai: { type: String, required: true },
  so: { type: String, required: true },
  basocuoi: String,
  haisocuoi: String,
  chanle: String,
}, { versionKey: false });

resultSchema.index({ ngay: 1, giai: 1 }, { unique: true });
const Result = mongoose.models.Result || mongoose.model('Result', resultSchema);

// =================================================================
// >>>>>>>> SỬ DỤNG LẠI TOÀN BỘ LOGIC PARSE GỐC CỦA BẠN <<<<<<<<
// =================================================================

function getChanLe(numberStr) {
  if (!numberStr || numberStr.length !== 3) return '';
  return numberStr.split('').map(d => (parseInt(d, 10) % 2 === 0 ? 'C' : 'L')).join('');
}

function onlyDigits(s) {
  return (s || '').toString().replace(/\D/g, '');
}

function createPrizeRecord(ngay, prizeCode, index, numberRaw) {
  const number = onlyDigits(numberRaw);
  let giai = prizeCode;
  
  if (prizeCode === 'ĐB' || prizeCode === 'G1') {
    // No suffix
  } else if (prizeCode === 'G2') {
    giai += index === 0 ? 'a' : 'b';
  } else if (['G3','G4','G5','G6','G7'].includes(prizeCode)) {
    giai += String.fromCharCode(97 + index);
  }

  let basocuoi = number;
  let haisocuoi = number;

  if (number.length === 5) {
    basocuoi = number.slice(2);
    haisocuoi = number.slice(3);
  } else if (number.length === 4) {
    basocuoi = number.slice(1);
    haisocuoi = number.slice(2);
  } else if (number.length === 3) {
    haisocuoi = number.slice(1);
  } else if (number.length === 2) {
    // G7
  }

  const chanle = (basocuoi && basocuoi.length === 3 && !giai.startsWith('G7'))
    ? getChanLe(basocuoi)
    : '';

  return { ngay, giai, so: number, basocuoi, haisocuoi, chanle };
}

function parseDayResults(dayText, ngay) {
  const resultData = [];
  const prizeNames = ['Đặc biệt','Giải nhất','Giải nhì','Giải ba','Giải tư','Giải năm','Giải sáu','Giải bảy'];
  const slices = {};

  let lastIdx = 0;
  for (let i = 0; i < prizeNames.length; i++) {
    const name = prizeNames[i];
    const idx = dayText.indexOf(name, lastIdx);
    if (idx !== -1) {
      const endIdx = (i < prizeNames.length - 1) ? dayText.indexOf(prizeNames[i+1], idx) : dayText.length;
      slices[name] = dayText.slice(idx, endIdx === -1 ? undefined : endIdx);
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

function parseOriginalData(allText) {
  try {
    const dateMatches = [...allText.matchAll(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/g)];
    const resultData = [];

    for (const dm of dateMatches) {
      const dateStr = dm[0].replace(/-/g, '/');
      const startPos = dm.index + dm[0].length;
      const nextMatch = dateMatches.find(m => m.index > dm.index);
      const endPos = nextMatch ? nextMatch.index : allText.length;
      const dayText = allText.slice(startPos, endPos);
      const dayData = parseDayResults(dayText, dateStr);
      if (dayData.length) {
        resultData.push(...dayData);
      }
    }
    const numDaysFound = new Set(resultData.map(r => r.ngay)).size;
    console.log(`✅ Phân tích xong (theo logic gốc), thu được ${resultData.length} giải cho ${numDaysFound} ngày.`);
    return resultData;
  } catch (e) {
    console.error('Lỗi khi phân tích dữ liệu gốc:', e.message);
    return [];
  }
}

// --- HÀM LẤY DỮ LIỆU TỪ FILE ---
async function extractDataFromFile() {
    console.log(`⏳ Bắt đầu đọc dữ liệu từ file: ${HTML_FILE_PATH}`);
    try {
        const htmlContent = fs.readFileSync(HTML_FILE_PATH, 'utf8');
        console.log('✅ Đọc file thành công, trích xuất văn bản...');
        
        const $ = cheerio.load(htmlContent);
        $('script, style').remove();
        const rawText = $('body').text();

        const resultData = parseOriginalData(rawText);
        return resultData;

    } catch (e) {
        console.error('Lỗi khi đọc file:', e.message);
        return [];
    }
}

// --- CÁC HÀM LƯU DB VÀ CHẠY ---
async function saveToDb(data) {
    if (!Array.isArray(data) || data.length === 0) { return 0; }
    console.log(`💾 Chuẩn bị lưu/cập nhật ${data.length} bản ghi vào collection 'results'...`);
    const operations = data.map(item => ({
        updateOne: { filter: { ngay: item.ngay, giai: item.giai }, update: { $set: item }, upsert: true },
    }));
    try {
        const result = await Result.bulkWrite(operations, { ordered: false });
        const processedCount = result.upsertedCount + result.modifiedCount;
        console.log(`✅ Lưu vào DB thành công! Đã xử lý ${processedCount} giải.`);
        return processedCount;
    } catch (e) {
        console.error('Lỗi khi lưu DB:', e.message);
        return 0;
    }
}

// Hàm này sẽ được gọi từ xsController
async function updateFromFile() {
    const data = await extractDataFromFile();
    if (data.length > 0) {
        return await saveToDb(data);
    }
    return 0;
}

async function runOnceAndExit() {
  if (!process.env.MONGO_URI) {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  }
  
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ (Standalone) MongoDB connected.");
  
  try {
    await updateFromFile();
  } catch (e) {
    console.error("Lỗi trong quá trình chạy chính:", e);
  } finally {
    console.log("(Standalone) Ngắt kết nối MongoDB.");
    await mongoose.disconnect();
  }
}

// EXPORT các hàm cần thiết
module.exports = {
  updateFromFile // Chỉ cần export hàm này
};

// Logic để chạy file này trực tiếp
if (require.main === module) {
  runOnceAndExit();
}

