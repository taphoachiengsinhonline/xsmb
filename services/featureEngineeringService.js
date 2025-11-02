javascript// file: services/featureEngineeringService.js

const { DateTime } = require('luxon');
const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

class FeatureEngineeringService {
    extractAllFeatures(currentDayResults, previousDaysResults = [], dateStr = null) {
        let features = [];

        // 1. Basic number features với embedding prize order
        features = features.concat(this.extractEmbeddedPrizeFeatures(currentDayResults));

        // 2. Statistical features
        features = features.concat(this.extractStatisticalFeatures(currentDayResults));

        // 3. Temporal features
        features = features.concat(this.extractTemporalFeatures(dateStr));

        // 4. Pattern features từ các ngày trước
        features = features.concat(this.extractPatternFeatures(previousDaysResults));

        // 5. External features: Thời tiết và sự kiện (giả định fetch từ API hoặc DB, ví dụ: weather API)
        features = features.concat(this.extractExternalFeatures(dateStr));

        return features;
    }

    extractEmbeddedPrizeFeatures(results) {
        const input = [];
        PRIZE_ORDER.forEach((prize, prizeIndex) => {
            const result = results.find(r => r.giai === prize);
            const numStr = String(result?.so || '0').padStart(5, '0');
            
            // One-hot encode prize order (27 prizes -> 27-bit one-hot)
            const prizeEmbedding = Array(PRIZE_ORDER.length).fill(0);
            prizeEmbedding[prizeIndex] = 1;
            input.push(...prizeEmbedding); // Thêm embedding vào features

            // Thêm digits normalized
            numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
        });
        return input;
    }

    extractBasicFeatures(results) {
        const input = [];
        PRIZE_ORDER.forEach(prize => {
            const result = results.find(r => r.giai === prize);
            const numStr = String(result?.so || '0').padStart(5, '0');
            numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
        });
        return input;
    }

    extractStatisticalFeatures(results) {
        const stats = [];
        const prizeSums = [];
        
        PRIZE_ORDER.forEach(prize => {
            const result = results.find(r => r.giai === prize);
            const numStr = String(result?.so || '0').padStart(5, '0');
            const sum = numStr.split('').reduce((acc, digit) => acc + parseInt(digit), 0);
            prizeSums.push(sum / 45);
        });
        stats.push(...prizeSums);

        const allDigits = results.flatMap(r => 
            String(r.so).split('').map(Number)
        ).filter(d => !isNaN(d));
        
        if (allDigits.length > 0) {
            const mean = allDigits.reduce((a, b) => a + b) / allDigits.length;
            const variance = allDigits.map(d => Math.pow(d - mean, 2)).reduce((a, b) => a + b) / allDigits.length;
            const std = Math.sqrt(variance);
            stats.push(mean / 9, std / 9);
        } else {
            stats.push(0, 0);
        }

        return stats;
    }

    extractTemporalFeatures(dateStr) {
        const features = [];
        if (!dateStr) return features;

        try {
            const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');
            
            // Day of week (one-hot encoding)
            const dayOfWeek = date.weekday;
            const dayOfWeekOneHot = Array(7).fill(0);
            dayOfWeekOneHot[dayOfWeek - 1] = 1;
            features.push(...dayOfWeekOneHot);

            // Month (one-hot encoding)
            const month = date.month;
            const monthOneHot = Array(12).fill(0);
            monthOneHot[month - 1] = 1;
            features.push(...monthOneHot);

            // Tuần trong tháng
            const weekOfMonth = Math.ceil(date.day / 7);
            features.push(weekOfMonth / 5);
        } catch (error) {
            console.warn('Lỗi xử lý ngày tháng:', error);
            features.push(...Array(20).fill(0));
        }

        return features;
    }

    extractPatternFeatures(previousDaysResults) {
        const features = [];

        if (previousDaysResults.length === 0) {
            return Array(30).fill(0);
        }

        const frequency = {
            tram: Array(10).fill(0),
            chuc: Array(10).fill(0),
            donvi: Array(10).fill(0)
        };

        previousDaysResults.forEach(dayResults => {
            const dbResult = dayResults.find(r => r.giai === 'ĐB');
            if (dbResult?.so) {
                const numStr = String(dbResult.so).padStart(5, '0');
                const lastThree = numStr.slice(-3);
                if (lastThree.length === 3) {
                    frequency.tram[parseInt(lastThree[0])]++;
                    frequency.chuc[parseInt(lastThree[1])]++;
                    frequency.donvi[parseInt(lastThree[2])]++;
                }
            }
        });

        const totalDays = previousDaysResults.length;
        features.push(...frequency.tram.map(f => f / totalDays));
        features.push(...frequency.chuc.map(f => f / totalDays));
        features.push(...frequency.donvi.map(f => f / totalDays));

        return features;
    }
    async extractExternalFeatures(dateStr) {
  const features = [];
  if (!dateStr) return Array(20).fill(0); // Tăng padding để match số features mới (~20)

  const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');

  // 1. Thời tiết (temperature, humidity, wind speed, rain probability) - Normalized
  // Giả định fetch từ API (ví dụ: OpenWeatherMap historical - cần API key trong env)
  // Trong thực tế: const response = await axios.get(`https://api.openweathermap.org/data/2.5/onecall/timemachine?lat=21.0285&lon=105.8542&dt=${date.toUnixInteger()}&appid=${process.env.WEATHER_API_KEY}`);
  // Placeholder: Giả sử fetch được data
  const temperature = 25 + Math.random() * 10 - 5; // 20-30°C random placeholder
  const humidity = 70 + Math.random() * 20 - 10;   // 60-80%
  const windSpeed = 5 + Math.random() * 5;         // 5-10 km/h
  const rainProb = Math.random() * 0.5;            // 0-50%

  features.push(temperature / 40, humidity / 100, windSpeed / 20, rainProb); // Normalize

  // 2. Sự kiện (holidays, elections, festivals) - One-hot hoặc binary
  // Danh sách holidays Việt Nam (hardcode hoặc fetch từ calendar API)
  const vietnamHolidays = [
    '01/01', // Tết Dương lịch
    '30/04', // Giải phóng miền Nam
    '01/05', // Lao động
    '02/09', // Quốc khánh
    // Thêm Tết Âm lịch: Cần convert lunar, dùng luxon với plugin hoặc lib riêng
  ];
  const isHoliday = vietnamHolidays.includes(date.toFormat('dd/MM')) ? 1 : 0;

  // Election: Giả định every 5 years for Vietnam National Assembly
  const isElectionYear = (date.year % 5 === 1) ? 1 : 0; // Ví dụ: 2021, 2026,...

  // Festival: Ví dụ Tet (lunar new year) - Giả định check lunar date
  const lunarDate = date.toLunar(); // Cần lib như 'lunar-javascript' để convert
  const isTet = lunarDate.month === 1 && lunarDate.day === 1 ? 1 : 0;

  features.push(isHoliday, isElectionYear, isTet);

  // 3. Temporal bổ sung: Is weekend, lunar phase
  const isWeekend = [6, 7].includes(date.weekday) ? 1 : 0; // Sat-Sun
  const lunarPhase = this.calculateLunarPhase(date); // Hàm tính phase (0-1)
  features.push(isWeekend, lunarPhase);

  // 4. Economic: VN-Index closing price (placeholder, fetch từ API như Alpha Vantage)
  // const stockResponse = await axios.get(`https://api.example.com/stock/VNINDEX?date=${date.toISODate()}`);
  const stockClose = 1200 + Math.random() * 200 - 100; // Placeholder 1100-1300
  const stockVolume = 1000000 + Math.random() * 500000; // Placeholder
  features.push(stockClose / 2000, stockVolume / 2000000); // Normalize

  // 5. Other: Population events, news sentiment (advanced, placeholder)
  const newsSentiment = Math.random() * 2 - 1; // -1 to 1 sentiment score
  features.push(newsSentiment);

  // Tổng ~20 features (có thể điều chỉnh)
  return features;
}

calculateLunarPhase(date) {
  // Tính lunar phase đơn giản (0: new moon, 0.5: full moon)
  const epoch = DateTime.fromISO('1970-01-01');
  const daysSinceEpoch = date.diff(epoch, 'days').days;
  const phase = (daysSinceEpoch % 29.53) / 29.53; // Chu kỳ mặt trăng ~29.53 ngày
  return phase;
}

    validateFeatureVector(features) {
        return Array.isArray(features) && features.length > 0 && features.every(f => !isNaN(f));
    }

   getFeatureVectorSize() {
  return 135 + 29 + 20 + 30 + 20; // +20 cho external features
}
    
}

module.exports = FeatureEngineeringService;
