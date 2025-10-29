const Result = require('../models/Result');
const { fetchXSData } = require('../services/crawlService');

// GET tất cả dữ liệu
const getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ ngay: -1, giai: 1 });
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST cập nhật dữ liệu mới (crawl + save)
const updateResults = async (req, res) => {
  try {
    const data = await fetchXSData(); // trả về mảng object như CSV cũ
    let newCount = 0;
    for (const item of data) {
      try {
        await Result.updateOne(
          { ngay: item.ngay, giai: item.giai },
          { $setOnInsert: item },
          { upsert: true }
        );
        newCount++;
      } catch {}
    }
    res.json({ message: `Cập nhật xong, ${newCount} bản ghi mới` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { getAllResults, updateResults };
