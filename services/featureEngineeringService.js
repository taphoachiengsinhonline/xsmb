const { DateTime } = require('luxon');

const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

class FeatureEngineeringService {
  prepareEnhancedInput(resultsForDay, previousDaysResults = []) {
    let features = [];

    // 1. Basic number features (giữ nguyên)
    features = features.concat(this.getBasicNumberFeatures(resultsForDay));

    // 2. Statistical features
    features = features.concat(this.getStatisticalFeatures(resultsForDay));

    // 3. Temporal features
    features = features.concat(this.getTemporalFeatures(resultsForDay[0]?.ngay));

    // 4. Pattern features từ các ngày trước
    features = features.concat(this.getPatternFeatures(previousDaysResults));

    return features;
  }

  getBasicNumberFeatures(resultsForDay) {
    const input = [];
    PRIZE_ORDER.forEach(prize => {
      const result = resultsForDay.find(r => r.giai === prize);
      const numStr = String(result?.so || '0').padStart(5, '0');
      numStr.split('').forEach(digit => input.push(parseInt(digit) / 9.0));
    });
    return input;
  }

  getStatisticalFeatures(resultsForDay) {
    const stats = [];

    // Tính tổng các số trong từng giải
    const prizeSums = [];
    PRIZE_ORDER.forEach(prize => {
      const result = resultsForDay.find(r => r.giai === prize);
      const numStr = String(result?.so || '0').padStart(5, '0');
      const sum = numStr.split('').reduce((acc, digit) => acc + parseInt(digit), 0);
      prizeSums.push(sum / 45); // Chuẩn hóa bằng tổng lớn nhất có thể (9*5=45)
    });
    stats.push(...prizeSums);

    // Tính trung bình và độ lệch chuẩn của các giải
    const allDigits = resultsForDay.flatMap(r => 
      String(r.so).split('').map(Number)
    ).filter(d => !isNaN(d));
    
    if (allDigits.length > 0) {
      const mean = allDigits.reduce((a, b) => a + b) / allDigits.length;
      const std = Math.sqrt(
        allDigits.map(d => Math.pow(d - mean, 2)).reduce((a, b) => a + b) / allDigits.length
      );
      stats.push(mean / 9, std / 9); // Chuẩn hóa
    } else {
      stats.push(0, 0);
    }

    return stats;
  }

  getTemporalFeatures(dateStr) {
    const features = [];
    if (!dateStr) return features;

    const date = DateTime.fromFormat(dateStr, 'dd/MM/yyyy');
    
    // Day of week (one-hot encoding)
    const dayOfWeek = date.weekday; // 1: Monday, 7: Sunday
    const dayOfWeekOneHot = Array(7).fill(0);
    dayOfWeekOneHot[dayOfWeek - 1] = 1;
    features.push(...dayOfWeekOneHot);

    // Month (one-hot encoding)
    const month = date.month; // 1-12
    const monthOneHot = Array(12).fill(0);
    monthOneHot[month - 1] = 1;
    features.push(...monthOneHot);

    // Tuần trong tháng (1-5)
    const weekOfMonth = Math.ceil(date.day / 7);
    features.push(weekOfMonth / 5);

    return features;
  }

  getPatternFeatures(previousDaysResults) {
    const features = [];

    // Nếu không có dữ liệu trước, trả về zeros
    if (previousDaysResults.length === 0) {
      return Array(10 * 3).fill(0); // 10 số * 3 vị trí (trăm, chục, đơn vị)
    }

    // Tính tần suất xuất hiện của các số ở các vị trí
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

    // Chuẩn hóa bằng số ngày
    const totalDays = previousDaysResults.length;
    features.push(...frequency.tram.map(f => f / totalDays));
    features.push(...frequency.chuc.map(f => f / totalDays));
    features.push(...frequency.donvi.map(f => f / totalDays));

    return features;
  }
}

module.exports = FeatureEngineeringService;
