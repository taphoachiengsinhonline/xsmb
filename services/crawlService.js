// crawlService.js
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');
const { DateTime } = require('luxon');

const MONGO_URI = process.env.MONGO_URI;
const CRAWL_URL = process.env.CRAWL_URL || 'https://ketqua04.net/so-ket-qua';

// Kết nối MongoDB
mongoose.connect(MONGO_URI);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('✅ MongoDB connected'));

// Schema kết quả xổ số
const prizeSchema = new mongoose.Schema({
  ngay: { type: String, required: true },
  giai: String,
  so: String,
  basocuoi: String,
  haisocuoi: String,
  chanle: String,
}, { versionKey: false });

prizeSchema.index({ ngay: 1, giai: 1 }, { unique: true });
const Prize = mongoose.model('Prize', prizeSchema);

// Tạo C/L cho số 3 chữ số
function getChanLe(numberStr) {
  if (numberStr.length !== 3) return '';
  return numberStr.split('').map(d => (parseInt(d) % 2 === 0 ? 'C' : 'L')).join('');
}

// Tạo record DB
function createPrizeRecord(ngay, prizeCode, index, number) {
  let giai = prizeCode;

  // Suffix theo index
  if (prizeCode === 'G2') giai += index === 0 ? 'a' : 'b';
  else if (['G3','G4','G5','G6','G7'].includes(prizeCode)) giai += String.fromCharCode(97 + index);

  let basocuoi = number, haisocuoi = number;
  if (number.length === 5) { basocuoi = number.slice(2); haisocuoi = number.slice(3); }
  else if (number.length === 4) { basocuoi = number.slice(1); haisocuoi = number.slice(2); }
  else if (number.length === 3) { basocuoi = number; haisocuoi = number.slice(1); }
  else if (number.length === 2) { basocuoi = number; haisocuoi = number; }

  // Chỉ tạo chanle nếu 3 chữ số và không phải G7
  const chanle = (number.length === 3 && prizeCode !== 'G7') ? getChanLe(basocuoi) : '';

  return { ngay, giai, so: number, basocuoi, haisocuoi, chanle };
}

// Parse kết quả 1 ngày
function parseDayResults(dayText, ngay) {
  const resultData = [];
  const prizeNames = ['Đặc biệt','Giải nhất','Giải nhì','Giải ba','Giải tư','Giải năm','Giải sáu','Giải bảy'];
  const slices = {};

  // Tách từng giải
  let lastIdx = 0;
  for (let i = 0; i < prizeNames.length; i++) {
    const name = prizeNames[i];
    const idx = dayText.indexOf(name,lastIdx);
    if (idx !== -1) {
      let endIdx = (i < prizeNames.length-1) ? dayText.indexOf(prizeNames[i+1], idx) : dayText.length;
      slices[name] = dayText.slice(idx,endIdx);
      lastIdx = idx;
    }
  }

  const findAllLen = (txt,n) => txt.match(new RegExp(`\\d{${n}}`,'g')) || [];

  // Sắp xếp theo thứ tự chuẩn: ĐB - G1 - G2a/b - G3a-d - G4a-d - G5a-d - G6a-c - G7a-d
  if (slices['Đặc biệt']) findAllLen(slices['Đặc biệt'],5).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'ĐB',i,num)));
  if (slices['Giải nhất']) findAllLen(slices['Giải nhất'],5).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G1',i,num)));
  if (slices['Giải nhì']) findAllLen(slices['Giải nhì'],5).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G2',i,num)));
  if (slices['Giải ba']) findAllLen(slices['Giải ba'],5).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G3',i,num)));
  if (slices['Giải tư']) findAllLen(slices['Giải tư'],4).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G4',i,num)));
  if (slices['Giải năm']) findAllLen(slices['Giải năm'],4).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G5',i,num)));
  if (slices['Giải sáu']) findAllLen(slices['Giải sáu'],3).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G6',i,num)));
  if (slices['Giải bảy']) findAllLen(slices['Giải bảy'],2).slice(0,4).forEach((num,i)=>resultData.push(createPrizeRecord(ngay,'G7',i,num)));

  return resultData;
}

// Crawl dữ liệu
async function extractXsData() {
  console.log('⏳ Đang lấy dữ liệu...');
  try {
    const res = await axios.get(CRAWL_URL, { headers: { 'User-Agent':'Mozilla/5.0' }});
    const $ = cheerio.load(res.data);
    const allText = $.text();

    const dateMatches = [...allText.matchAll(/\d{1,2}[\/-]\d{1,2}[\/-]\d{4}/g)];
    const resultData = [];

    for (let dm of dateMatches) {
      const dateStr = dm[0].replace(/-/g,'/');
      const startPos = dm.index + dm[0].length;
      const dayText = allText.slice(startPos);
      const dayData = parseDayResults(dayText,dateStr);
      if (dayData.length) resultData.push(...dayData);
    }

    return resultData;
  } catch(e) {
    console.error('Lỗi crawl:',e.message);
    return [];
  }
}

// Lưu DB
async function saveToDb(data) {
  if (!data.length) return;
  for (let item of data) {
    try {
      await Prize.updateOne(
        { ngay: item.ngay, giai: item.giai },
        { $setOnInsert: item },
        { upsert: true }
      );
    } catch(e) {
      console.error('Lỗi insert:', e.message, item);
    }
  }
  console.log(`✅ Cập nhật xong ${data.length} bản ghi`);
}

module.exports = { extractXsData, saveToDb };
