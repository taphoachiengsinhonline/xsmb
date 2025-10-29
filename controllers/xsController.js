const crawlService = require('../services/crawlService');
const Result = require('../models/Result');

exports.updateResults = async (req, res) => {
  console.log('🚀 [Backend] Bắt đầu cập nhật dữ liệu...');
  try {
    const data = await crawlService.extractXsData(); // hoặc crawlService.extract_xs_data()
    console.log(`🟢 [Backend] Crawl xong, tổng số kết quả: ${data.length}`);

    if (!data || data.length === 0) {
      console.log('⚠️ [Backend] Không có dữ liệu mới để lưu');
      return res.status(200).json({ message: 'Không có dữ liệu mới để lưu' });
    }

    // Lưu chỉ những ngày chưa có
    let insertedCount = 0;
    for (const item of data) {
      const exists = await Result.findOne({ ngay: item.ngay, giai: item.giai });
      if (!exists) {
        await Result.create(item);
        insertedCount++;
      }
    }

    console.log(`✅ [Backend] Đã thêm ${insertedCount} bản ghi mới`);
    return res.json({ message: `Cập nhật xong, thêm ${insertedCount} kết quả mới` });

  } catch (err) {
    console.error('❌ [Backend] Lỗi khi cập nhật dữ liệu:', err);
    return res.status(500).json({ message: 'Lỗi server khi cập nhật dữ liệu', error: err.toString() });
  }
};

exports.getAllResults = async (req, res) => {
  try {
    const results = await Result.find().sort({ ngay: -1, giai: 1 });
    console.log(`📊 [Backend] Trả về tổng ${results.length} kết quả`);
    res.json(results);
  } catch (err) {
    console.error('❌ [Backend] Lỗi khi lấy dữ liệu:', err);
    res.status(500).json({ message: 'Lỗi server khi lấy dữ liệu', error: err.toString() });
  }
};
