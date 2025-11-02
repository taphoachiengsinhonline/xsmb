// file: services/featureEngineeringService.js

const { DateTime } = require('luxon');
const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

class FeatureEngineeringService {
    constructor() {
        this.prizeOrderLength = PRIZE_ORDER.length; // 27
    }

    extractAllFeatures(currentDayResults, previousDaysResults = [], dateStr = null) {
        let features = [];

        // 1. Basic number features (digits normalized, 27 prizes * 5 digits = 135)
        features = features.concat(this.extractBasicFeatures(currentDayResults));

        // 2. Statistical features (29)
        features = features.concat(this.extractStatisticalFeatures(currentDayResults));

        // 3. Temporal features (20)
        features = features.concat(this.extractTemporalFeatures(dateStr));

        // 4. Pattern features từ các ngày trước (30)
        features = features.concat(this.extractPatternFeatures(previousDaysResults));

        // 5. External features: Thời tiết và sự kiện (async, placeholder ~20)
        // Note: In practice, call await this.extractExternalFeatures(dateStr) in async context
        // For sync fallback, use empty array here; handle async in caller (e.g., tensorflowService)
        // features = features.concat(this.extractExternalFeaturesSync(dateStr)); // Sync placeholder

        return features;
    }

    extractBasicFeatures(results) {
        const input = [];
        PRIZE_ORDER.forEach(prize => {
            const result = results.find(r => r.giai === prize);
            const numStr = String(result?.so || '0').padStart(5, '0');
            numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
        });
        return input; // 27 * 5 = 135 features
    }

    // Deprecated: extractEmbeddedPrizeFeatures (too many dims: 27*32=864, overkill)
    // extractEmbeddedPrizeFeatures(results) { ... } // Keep for reference if needed

    extractStatisticalFeatures(results) {
        const stats = [];
        const prizeSums = [];
        
        PRIZE_ORDER.forEach(prize => {
            const result = results.find(r => r.giai === prize);
            const numStr = String(result?.so || '0').padStart(5, '0');
            const sum = numStr.split('').reduce((acc, digit) => acc + parseInt(digit), 0);
            prizeSums.push(sum / 45);
        });
        stats.push(...prizeSums); // 27

        const allDigits = results.flatMap(r => 
            String(r.so || '0').split('').map(Number)
        ).filter(d => !isNaN(d));
        
        if (allDigits.length > 0) {
            const mean = allDigits.reduce((a, b) => a + b, 0) / allDigits.length;
            const variance = allDigits.map(d => Math.pow(d - mean, 2)).reduce((a, b) => a + b, 0) / allDigits.length;
            const std = Math.sqrt(variance);
            stats.push(mean / 9, std / 9); // +2 = 29 total
        } else {
            stats.push(0, 0);
        }

        return stats;
    }

    extractTemporalFeatures(dateStr) {
        const features = [];
        if (!dateStr) return Array(20).fill(0); // Fallback

        try {
            const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');
            
            // Day of week (one-hot: 7)
            const dayOfWeek = date.weekday;
            const dayOfWeekOneHot = Array(7).fill(0);
            dayOfWeekOneHot[dayOfWeek - 1] = 1;
            features.push(...dayOfWeekOneHot);

            // Month (one-hot: 12)
            const month = date.month;
            const monthOneHot = Array(12).fill(0);
            monthOneHot[month - 1] = 1;
            features.push(...monthOneHot);

            // Week of month (1)
            const weekOfMonth = Math.ceil(date.day / 7);
            features.push(weekOfMonth / 5.0); // Normalized

            // Pad if needed (total 20)
            while (features.length < 20) features.push(0);
        } catch (error) {
            console.warn('Lỗi xử lý ngày tháng:', error);
            return Array(20).fill(0);
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
        features.push(...frequency.tram.map(f => f / totalDays)); // 10
        features.push(...frequency.chuc.map(f => f / totalDays)); // +10=20
        features.push(...frequency.donvi.map(f => f / totalDays)); // +10=30

        return features;
    }

    // Async version for external features (call in async contexts like prepareTrainingData)
    async extractExternalFeatures(dateStr) {
        const features = [];
        if (!dateStr) return Array(20).fill(0);

        try {
            const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');

            // 1. Thời tiết placeholder (real: await axios OpenWeather)
            const temperature = 25 + Math.random() * 10 - 5; // 20-30°C
            const humidity = 70 + Math.random() * 20 - 10;   // 60-80%
            const windSpeed = 5 + Math.random() * 5;         // 5-10 km/h
            const rainProb = Math.random() * 0.5;            // 0-50%
            features.push(temperature / 40, humidity / 100, windSpeed / 20, rainProb); // 4

            // 2. Sự kiện (holidays, etc.)
            const vietnamHolidays = ['01/01', '30/04', '01/05', '02/09'];
            const isHoliday = vietnamHolidays.includes(date.toFormat('dd/MM')) ? 1 : 0;
            const isElectionYear = (date.year % 5 === 1) ? 1 : 0;
            const isTet = 0; // Placeholder: Need lunar lib
            features.push(isHoliday, isElectionYear, isTet); // +3 =7

            // 3. Temporal bổ sung
            const isWeekend = [6, 7].includes(date.weekday) ? 1 : 0;
            const lunarPhase = this.calculateLunarPhase(date);
            features.push(isWeekend, lunarPhase); // +2=9

            // 4. Economic placeholder
            const stockClose = 1200 + Math.random() * 200 - 100;
            const stockVolume = 1000000 + Math.random() * 500000;
            features.push(stockClose / 2000, stockVolume / 2000000); // +2=11

            // 5. Other
            const newsSentiment = Math.random() * 2 - 1;
            features.push(newsSentiment); // +1=12

            // Pad to 20
            while (features.length < 20) features.push(0);

            return features;
        } catch (error) {
            console.warn('Lỗi extract external features:', error);
            return Array(20).fill(0);
        }
    }

    // Sync fallback for external (use random placeholders)
    extractExternalFeaturesSync(dateStr) {
        // Same as async but without await/random seed if needed
        return Array(20).fill(0); // Or implement sync version
    }

    calculateLunarPhase(date) {
        // Tính lunar phase đơn giản (0: new moon, 0.5: full moon)
        const epoch = DateTime.fromISO('1970-01-01');
        const daysSinceEpoch = date.diff(epoch, 'days').days;
        const phase = (daysSinceEpoch % 29.53) / 29.53; // Chu kỳ mặt trăng ~29.53 ngày
        return phase;
    }

    validateFeatureVector(features) {
        return Array.isArray(features) && features.length > 0 && features.every(f => typeof f === 'number' && !isNaN(f));
    }

    getFeatureVectorSize() {
        // Basic: 135 (27*5)
        // Stats: 29
        // Temporal: 20
        // Pattern: 30
        // External: 20
        return 135 + 29 + 20 + 30 + 20; // 234 total
    }
}

module.exports = FeatureEngineeringService;
