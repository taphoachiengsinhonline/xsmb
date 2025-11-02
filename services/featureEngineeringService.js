// file: services/featureEngineeringService.js

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
 
}


    validateFeatureVector(features) {
        return Array.isArray(features) && features.length > 0 && features.every(f => !isNaN(f));
    }

   getFeatureVectorSize() {
  return 135 + 29 + 20 + 30 ; // +20 cho external features
}
    
}

module.exports = FeatureEngineeringService;
