// test-feature-size.js
const FeatureEngineeringService = require('./services/featureEngineeringService');
const Result = require('./models/Result');

async function testFeatureSize() {
    const featureService = new FeatureEngineeringService();
    
    // Lấy dữ liệu mẫu từ database
    const sampleResults = await Result.find().limit(1).lean();
    if (sampleResults.length === 0) {
        console.log('❌ Không có dữ liệu mẫu');
        return;
    }

    // Nhóm theo ngày
    const grouped = {};
    sampleResults.forEach(r => {
        if (!grouped[r.ngay]) grouped[r.ngay] = [];
        grouped[r.ngay].push(r);
    });

    const firstDay = Object.keys(grouped)[0];
    const features = featureService.extractAllFeatures(
        grouped[firstDay] || [], 
        [], 
        firstDay
    );

    console.log('📊 KẾT QUẢ KIỂM TRA FEATURE SIZE:');
    console.log(`- Số lượng features: ${features.length}`);
    console.log(`- Basic features: ${featureService.PRIZE_ORDER.length * 5}`);
    console.log(`- Statistical features: 4`);
    console.log(`- Temporal features: 7`); 
    console.log(`- Pattern features: 30`);
    console.log(`- Tổng ước tính: ${featureService.PRIZE_ORDER.length * 5 + 4 + 7 + 30}`);
    console.log('- Feature values sample:', features.slice(0, 10));
}

testFeatureSize();
