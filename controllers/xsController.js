const Result = require('../models/Result');
const Prediction = require('../models/Prediction');
const crawlService = require('../services/crawlService');

// --- Lấy tất cả kết quả XSMB ---
exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ ngay: -1 });
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// --- Cập nhật kết quả mới từ crawl ---
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
    console.log(`✅ Thêm ${insertedCount} bản ghi mới`);
    res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() });
  }
};

// --- Huấn luyện model nâng cao ---
exports.trainAdvancedModel = async (req, res) => {
  console.log('🔔 [trainAdvancedModel] Start');
  try {
    const results = await Result.find().sort({ ngay: 1 }).lean();
    if (results.length < 2) return res.status(400).json({ message: "Không đủ dữ liệu để phân tích" });

    // Group theo ngày
    const grouped = {};
    results.forEach(r => {
      grouped[r.ngay] = grouped[r.ngay] || [];
      grouped[r.ngay].push(r);
    });

    const days = Object.keys(grouped).sort((a,b)=> {
      const ka = a.split('/').reverse().join('-');
      const kb = b.split('/').reverse().join('-');
      return ka.localeCompare(kb);
    });

    const analysis = [];

    for (let i = 0; i < days.length - 1; i++) {
      const today = grouped[days[i]] || [];
      const tomorrow = grouped[days[i+1]] || [];
      const dbTomorrowRec = tomorrow.find(r => r.giai === 'ĐB');
      if (!dbTomorrowRec || !dbTomorrowRec.so) continue;

      const dbStr = String(dbTomorrowRec.so).padStart(3,'0');
      const [hangTram, hangChuc, hangDonVi] = dbStr.split('');

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
        ngay: days[i+1],
        giaiDB: dbStr,
        hangTram, hangChuc, hangDonVi,
        tanSuat: positions.length,
        chiTiet: positions
      });
    }

    // Thống kê top 5
    const freqTram={}, freqChuc={}, freqDV={};
    analysis.forEach(a=>{
      freqTram[a.hangTram]=(freqTram[a.hangTram]||0)+1;
      freqChuc[a.hangChuc]=(freqChuc[a.hangChuc]||0)+1;
      freqDV[a.hangDonVi]=(freqDV[a.hangDonVi]||0)+1;
    });
    const top5=f=>Object.entries(f).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5);
    const topTram = top5(freqTram).map(o=>o.k);
    const topChuc = top5(freqChuc).map(o=>o.k);
    const topDonVi = top5(freqDV).map(o=>o.k);

    // Lưu prediction hôm nay
    const todayStr = new Date().toLocaleDateString('vi-VN');
    await Prediction.findOneAndUpdate(
      { ngayDuDoan: todayStr },
      { ngayDuDoan: todayStr, topTram, topChuc, topDonVi, chiTiet: analysis.flatMap(a=>a.chiTiet), danhDauDaSo:false },
      { upsert:true, new:true }
    );

    res.json({ message:"Huấn luyện hoàn tất", topTram, topChuc, topDonVi, analysis });

  } catch(err){
    console.error('❌ trainAdvancedModel error:', err);
    res.status(500).json({ message:'Lỗi server', error: err.toString() });
  }
};

// --- Cập nhật weights dự đoán ---
exports.updatePredictionWeights = async (req,res)=>{
  console.log('🔔 [updatePredictionWeights] Start');
  try{
    const predictions = await Prediction.find({ danhDauDaSo:false }).lean();
    for(const pred of predictions){
      const results = await Result.find({ ngay: pred.ngayDuDoan }).lean();
      if(!results?.length) continue;
      const dbResult = results.find(r=>r.giai==='ĐB');
      if(!dbResult || !dbResult.so) continue;

      const [tram,chuc,donVi] = String(dbResult.so).padStart(3,'0').split('');

      const updatedChiTiet = pred.chiTiet.map(ct=>{
        let inc=0;
        if(ct.positionInPrize===1 && ct.matchedDigit===tram) inc=1;
        if(ct.positionInPrize===2 && ct.matchedDigit===chuc) inc=1;
        if(ct.positionInPrize===3 && ct.matchedDigit===donVi) inc=1;
        return {...ct, weight: ct.weight+inc};
      });

      await Prediction.updateOne({_id:pred._id},{chiTiet:updatedChiTiet,danhDauDaSo:true});
    }

    res.json({ message:"Cập nhật weights xong" });

  }catch(err){
    console.error('❌ updatePredictionWeights error:', err);
    res.status(500).json({ message:'Lỗi server', error: err.toString() });
  }
};

// --- Lấy prediction mới nhất ---
exports.getLatestPrediction = async (req,res)=>{
  try{
    const pred = await Prediction.findOne().sort({ ngayDuDoan:-1 }).lean();
    if(!pred) return res.json({ ngayDuDoan:null, topTram:[], topChuc:[], topDonVi:[], chiTiet:[] });

    const topTram = [...new Set(pred.chiTiet.filter(ct=>ct.positionInPrize===1).sort((a,b)=>b.weight-a.weight).map(ct=>ct.matchedDigit))].slice(0,5);
    const topChuc = [...new Set(pred.chiTiet.filter(ct=>ct.positionInPrize===2).sort((a,b)=>b.weight-a.weight).map(ct=>ct.matchedDigit))].slice(0,5);
    const topDonVi = [...new Set(pred.chiTiet.filter(ct=>ct.positionInPrize===3).sort((a,b)=>b.weight-a.weight).map(ct=>ct.matchedDigit))].slice(0,5);

    res.json({ ngayDuDoan: pred.ngayDuDoan, topTram, topChuc, topDonVi, chiTiet: pred.chiTiet });

  }catch(err){
    console.error('❌ getLatestPrediction error:', err);
    res.status(500).json({ message:'Lỗi server', error: err.toString() });
  }
};

// --- Lấy dự đoán cho ngày cụ thể ---
exports.getPrediction = async (req,res)=>{
  try{
    const { date } = req.query;
    if(!date) return res.status(400).json({ message:'Thiếu tham số date' });

    const results = await Result.find().sort({ ngay:1 }).lean();
    if(!results.length) return res.json([{ ngayDuDoan: date, topTram:[], topChuc:[], topDonVi:[], chiTiet:[] }]);

    const grouped = {};
    results.forEach(r=>{ grouped[r.ngay]=grouped[r.ngay]||[]; grouped[r.ngay].push(r); });
    const sortedDates = Object.keys(grouped).sort((a,b)=>a.split('/').reverse().join('-').localeCompare(b.split('/').reverse().join('-')));
    const idx = sortedDates.indexOf(date);
    if(idx<=0) return res.json([{ ngayDuDoan: date, topTram:[], topChuc:[], topDonVi:[], chiTiet:[] }]);

    const today = grouped[sortedDates[idx-1]];

    const countTram={}, countChuc={}, countDonVi={};
    today.forEach((r,prizeIdx)=>{
      const [tram,chuc,donVi] = String(r.so).padStart(3,'0').split('');
      countTram[tram]=(countTram[tram]||0)+1;
      countChuc[chuc]=(countChuc[chuc]||0)+1;
      countDonVi[donVi]=(countDonVi[donVi]||0)+1;
    });

    const sortTop=obj=>Object.entries(obj).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5);
    const topTram=sortTop(countTram).map(o=>o.k);
    const topChuc=sortTop(countChuc).map(o=>o.k);
    const topDonVi=sortTop(countDonVi).map(o=>o.k);

    const chiTiet=today.map((r,idx)=>{
      const [tram,chuc,donVi]=String(r.so).padStart(3,'0').split('');
      return { number:String(r.so).padStart(3,'0'), group:Math.floor(idx/9)+1, weight:1, positionInPrize:idx+1, tram,chuc,donVi };
    });

    res.json([{ ngayDuDoan: date, topTram, topChuc, topDonVi, chiTiet }]);

  }catch(err){
    console.error('❌ getPrediction error:', err);
    res.status(500).json({ message:'Lỗi server', error: err.toString() });
  }
};

exports.trainHistoricalPredictions = async (req, res) => {
  console.log('🔔 [trainHistoricalPredictions] Start');
  try {
    // Lấy toàn bộ kết quả, sắp theo ngày tăng dần
    const results = await Result.find().sort({ ngay: 1 }).lean();
    if (!results.length) return res.status(400).json({ message: 'Không có dữ liệu results' });

    // group theo ngày
    const grouped = {};
    for (const r of results) {
      grouped[r.ngay] = grouped[r.ngay] || [];
      grouped[r.ngay].push(r);
    }
    const days = Object.keys(grouped).sort((a,b) => a.split('/').reverse().join('-').localeCompare(b.split('/').reverse().join('-')));
    if (days.length < 2) return res.status(400).json({ message: 'Không đủ ngày để train historical' });

    let created = 0;
    for (let i = 1; i < days.length; i++) {
      const prevDay = days[i-1];    // dùng prevDay để predict day
      const targetDay = days[i];   // prediction for targetDay
      const prevResults = grouped[prevDay] || [];

      // build counts per digit position (trăm, chục, đơn vị)
      const countTram = {}, countChuc = {}, countDonVi = {};
      const chiTiet = [];

      prevResults.forEach((r, idx) => {
        const num = String(r.so).padStart(3,'0');
        const [tram,chuc,donvi] = num.split('');
        countTram[tram] = (countTram[tram] || 0) + 1;
        countChuc[chuc] = (countChuc[chuc] || 0) + 1;
        countDonVi[donvi] = (countDonVi[donvi] || 0) + 1;
        const nhomNho = Math.floor(idx / 3) + 1; // 0-2 -> 1; 3-5 -> 2; ...; 24-26 -> 9
        const nhomTo = Math.floor((nhomNho - 1) / 3) + 1; // 1-3 -> 1; 4-6 -> 2; 7-9 -> 3

        chiTiet.push({
          number: num,
          nhomNho: nhomNho, // Thêm
          nhomTo: nhomTo,     // Thêm
          positionInPrize: idx + 1,
          tram, chuc, donvi,
          weight: 1
  });

      const sortTop = (obj) => Object.entries(obj).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5).map(o=>o.k);

      const topTram = sortTop(countTram);
      const topChuc = sortTop(countChuc);
      const topDonVi = sortTop(countDonVi);

      // upsert prediction for targetDay
      const up = await Prediction.findOneAndUpdate(
        { ngayDuDoan: targetDay },
        { ngayDuDoan: targetDay, topTram, topChuc, topDonVi, chiTiet, danhDauDaSo: false },
        { upsert: true, new: true }
      );
      created++;
    }

    console.log(`✅ [trainHistoricalPredictions] Done, created/updated ${created} predictions`);
    return res.json({ message: 'Train historical finished', created });
  } catch (err) {
    console.error('❌ [trainHistoricalPredictions] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- HÀM MỚI: trainPredictionForNextDay -----------------
// Tạo prediction cho "ngày tiếp theo" dựa trên ngày mới nhất có trong DB.results
exports.trainPredictionForNextDay = async (req, res) => {
  console.log('🔔 [trainPredictionForNextDay] Start');
  try {
    // lấy toàn bộ ngày có kết quả, tìm ngày mới nhất
    const daysRes = await Result.aggregate([
      { $group: { _id: '$ngay' } },
      { $sort: { '_id': -1 } },
      { $limit: 1 }
    ]);
    if (!daysRes || !daysRes.length) return res.status(400).json({ message: 'Không có dữ liệu results' });

    const latestDay = daysRes[0]._id; // format dd/mm/yyyy
    // compute next day (string)
    const parts = latestDay.split('/');
    const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    const next = new Date(d.getTime() + 24*3600*1000);
    const dd = String(next.getDate()).padStart(2,'0');
    const mm = String(next.getMonth()+1).padStart(2,'0');
    const yyyy = next.getFullYear();
    const nextDayStr = `${dd}/${mm}/${yyyy}`;

    // lấy kết quả của latestDay
    const prevResults = await Result.find({ ngay: latestDay }).lean();
    if (!prevResults || !prevResults.length) return res.status(400).json({ message: 'Không có dữ liệu ngày trước để dự đoán' });

    // build as trainHistoricalPredictions did
    const countTram = {}, countChuc = {}, countDonVi = {};
    const chiTiet = [];
    prevResults.forEach((r, idx) => {
      const num = String(r.so).padStart(3,'0');
      const [tram,chuc,donvi] = num.split('');
      countTram[tram] = (countTram[tram] || 0) + 1;
      countChuc[chuc] = (countChuc[chuc] || 0) + 1;
      countDonVi[donvi] = (countDonVi[donvi] || 0) + 1;
      chiTiet.push({
        number: num,
        group: Math.floor(idx/9)+1,
        positionInPrize: idx+1,
        tram,chuc,donvi,
        weight: 1
      });
    });
    const sortTop = (obj) => Object.entries(obj).map(([k,v])=>({k,v})).sort((a,b)=>b.v-a.v).slice(0,5).map(o=>o.k);
    const topTram = sortTop(countTram);
    const topChuc = sortTop(countChuc);
    const topDonVi = sortTop(countDonVi);

    const pred = await Prediction.findOneAndUpdate(
      { ngayDuDoan: nextDayStr },
      { ngayDuDoan: nextDayStr, topTram, topChuc, topDonVi, chiTiet, danhDauDaSo: false },
      { upsert: true, new: true }
    );

    console.log(`✅ [trainPredictionForNextDay] Saved prediction for ${nextDayStr}`);
    return res.json({ message: 'Prediction for next day created', ngayDuDoan: nextDayStr, topTram, topChuc, topDonVi });
  } catch (err) {
    console.error('❌ [trainPredictionForNextDay] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- HÀM updatePredictionWeights (CẬP NHẬT) -----------------
// duyệt predictions chưa đánh dấu (danhDauDaSo=false), lấy kết quả thực tế của ngày đó,
// so sánh và tăng weight cho chiTiet tương ứng, đồng thời lưu metrics nhỏ (correctParts)
exports.updatePredictionWeights = async (req, res) => {
  console.log('🔔 [updatePredictionWeights] Start');
  try {
    const preds = await Prediction.find({ danhDauDaSo: false }).lean();
    if (!preds.length) return res.json({ message: 'Không có prediction chưa đánh dấu' });

    let updatedCount = 0;
    for (const p of preds) {
      // lấy kết quả thực tế cho ngayDuDoan
      const actualResults = await Result.find({ ngay: p.ngayDuDoan }).lean();
      if (!actualResults || !actualResults.length) {
        console.log(`⚠️ No results for ${p.ngayDuDoan}, skip`);
        continue;
      }
      const dbRec = actualResults.find(r => r.giai === 'ĐB') || actualResults[0];
      if (!dbRec || !dbRec.so) continue;
      const dbStr = String(dbRec.so).padStart(3,'0');
      const actual = { tram: dbStr[0], chuc: dbStr[1], donVi: dbStr[2] };

      // load the prediction doc (not lean) to update
      const predDoc = await Prediction.findOne({ _id: p._id });
      if (!predDoc) continue;

      let incrTotal = 0;
predDoc.chiTiet = predDoc.chiTiet.map(ct => {
  let originalWeight = ct.weight || 1;
  let newWeight = originalWeight;

  // ct.tram, ct.chuc, ct.donvi là các chữ số của giải ngày N-1
  // actual.tram, actual.chuc, actual.donVi là các chữ số của GĐB ngày N

  // So sánh hàng trăm của GĐB với cả 3 vị trí của giải hôm trước
  if (ct.tram === actual.tram) newWeight++;
  if (ct.chuc === actual.tram) newWeight++;
  if (ct.donvi === actual.tram) newWeight++;

  // So sánh hàng chục của GĐB với cả 3 vị trí của giải hôm trước
  if (ct.tram === actual.chuc) newWeight++;
  if (ct.chuc === actual.chuc) newWeight++;
  if (ct.donvi === actual.chuc) newWeight++;

  // So sánh hàng đơn vị của GĐB với cả 3 vị trí của giải hôm trước
  if (ct.tram === actual.donVi) newWeight++;
  if (ct.chuc === actual.donVi) newWeight++;
  if (ct.donvi === actual.donVi) newWeight++;

  if (newWeight > originalWeight) {
    ct.weight = newWeight;
    incrTotal += (newWeight - originalWeight);
  }
  return ct;
});

      predDoc.danhDauDaSo = true;
      await predDoc.save();
      updatedCount++;
      console.log(`✅ Updated prediction ${p.ngayDuDoan}, increased ${incrTotal} chiTiet entries`);
    }

    return res.json({ message: 'Update weights done', updatedCount });
  } catch (err) {
    console.error('❌ [updatePredictionWeights] Error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};

// ----------------- GET Prediction theo ngày (nếu cần) -----------------
exports.getPredictionByDate = async (req, res) => {
  try {
    const { date } = req.query; // date = dd/mm/yyyy (ngayDuDoan)
    if (!date) return res.status(400).json({ message: 'Thiếu param date' });
    const pred = await Prediction.findOne({ ngayDuDoan: date }).lean();
    if (!pred) return res.status(404).json({ message: 'Không tìm thấy prediction cho ngày này' });
    return res.json(pred);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi server', error: err.toString() });
  }
};


