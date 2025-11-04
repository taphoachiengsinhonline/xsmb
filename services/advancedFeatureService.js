/**
 * @file advancedFeatureService.js
 * @description Dịch vụ Kỹ thuật Đặc trưng Nâng cao (Advanced Feature Engineering).
 * Nhiệm vụ của file này là trích xuất một bộ features (đặc trưng) cực kỳ phong phú và sâu sắc từ dữ liệu kết quả xổ số.
 * Đây là "bữa ăn thịnh soạn" được chuẩn bị đặc biệt cho mô hình AI, giúp nó "hiểu" được các khía cạnh
 * phức tạp của dữ liệu mà các con số thô không thể hiện được.
 * 
 * Class này sẽ được sử dụng bởi `TensorFlowService` để chuẩn bị dữ liệu đầu vào (input) cho mô hình LSTM.
 */

// =================================================================
// CÁC HẰNG SỐ VÀ BIẾN TOÀN CỤC
// =================================================================

// Thứ tự các giải dùng để đảm bảo tính nhất quán khi trích xuất features.
const PRIZE_ORDER = ['ĐB','G1','G2a','G2b','G3a','G3b','G3c','G3d','G3e','G3f','G4a','G4b','G4c','G4d','G5a','G5b','G5c','G5d','G5e','G5f','G6a','G6b','G6c','G7a','G7b','G7c','G7d'];

// Các giải có tầm ảnh hưởng, thường được dùng trong các phân tích soi cầu.
const INFLUENTIAL_PRIZES = ['G1', 'G2a', 'G2b', 'G3a', 'G3b', 'G3c', 'G7a', 'G7b', 'G7c', 'G7d']; // 10 giải

// Các mẫu hình Chẵn/Lẻ có thể có cho một chuỗi 3 chữ số.
const CL_PATTERNS_3_DIGIT = ['CCC','CCL','CLC','CLL','LCC','LCL','LLC','LLL']; // 8 mẫu

class AdvancedFeatureEngineer {
    extractPremiumFeatures(currentDayResults, previousDaysResults) {
        const resultsMap = new Map(currentDayResults.map(r => [r.giai, r]));

        const prizeCorrelationFeatures = this._extractPrizeCorrelationFeatures(resultsMap);
        const sumFrequencyFeatures = this._extractSumFrequencyFeatures(currentDayResults);
        const chanLePatterns = this._extractChanLePatterns(currentDayResults);
        const gapAnalysis = this._extractGapAnalysis(previousDaysResults);

        // THAY ĐỔI: Trả về một object thay vì một mảng
        return {
            prizeCorrelationFeatures,
            sumFrequencyFeatures,
            chanLePatterns,
            gapAnalysis
        };
    }

    // =================================================================
    // NHÓM 1: TƯƠNG QUAN GIỮA CÁC GIẢI (PRIZE CORRELATION FEATURES) - 50 FEATURES
    // Mục tiêu: Dạy cho AI "nhìn" vào mối liên hệ giữa Giải Đặc Biệt và các giải có ảnh hưởng khác.
    // Logic: Chúng ta tính toán "khoảng cách" số học (hiệu số) giữa từng chữ số của GĐB và chữ số cuối cùng của các giải quan trọng.
    //        Điều này giúp mô hình học được các quy luật như "khi G1 về đuôi X, GĐB thường có chữ số hàng trăm là Y".
    // =================================================================
    _extractPrizeCorrelationFeatures(resultsMap) {
        const features = [];
        const dbResult = resultsMap.get('ĐB');

        // Lấy 5 chữ số của GĐB. Nếu không có, trả về một mảng toàn số 0.
        const dbDigits = dbResult && dbResult.so ? String(dbResult.so).padStart(5, '0').split('').map(Number) : [0, 0, 0, 0, 0];

        // Lặp qua 10 giải có ảnh hưởng đã định nghĩa ở trên.
        for (const prizeCode of INFLUENTIAL_PRIZES) {
            const influentialResult = resultsMap.get(prizeCode);
            // Lấy chữ số cuối cùng của giải ảnh hưởng.
            const lastDigit = influentialResult && influentialResult.so ? Number(String(influentialResult.so).slice(-1)) : 0;
            
            // Lặp qua 5 chữ số của GĐB.
            for (const dbDigit of dbDigits) {
                // Tính hiệu số theo modulo 10. `+ 10` để đảm bảo kết quả không bị âm.
                const difference = (dbDigit - lastDigit + 10) % 10;
                // Chuẩn hóa feature về khoảng [0, 1] để mô hình học tốt hơn.
                features.push(difference / 9.0);
            }
        }
        // Kết quả: 10 giải * 5 chữ số = 50 features.
        return features;
    }

    // =================================================================
    // NHÓM 2: TẦN SUẤT TỔNG (SUM FREQUENCY FEATURES) - 28 FEATURES
    // Mục tiêu: Phân tích "Tổng", một khái niệm rất phổ biến. Mô hình sẽ biết được trong ngày hôm đó,
    //           các tổng nào (tổng của 3 số cuối) xuất hiện nhiều, tổng nào ít.
    // Logic: Đếm số lần xuất hiện của mỗi tổng (từ 0 đến 27) trên 3 số cuối của tất cả các giải, sau đó chuẩn hóa.
    // =================================================================
    _extractSumFrequencyFeatures(currentDayResults) {
        // Tổng tối đa của 3 chữ số là 9 + 9 + 9 = 27. Ta tạo một mảng 28 phần tử (index 0-27) để đếm.
        const sumCounts = Array(28).fill(0);
        let totalPrizesWith3Digits = 0;

        for (const result of currentDayResults) {
            // Chỉ xét các giải có 'basocuoi' là 3 chữ số.
            if (result.basocuoi && result.basocuoi.length === 3) {
                const sum = result.basocuoi.split('').reduce((acc, digit) => acc + Number(digit), 0);
                if (sum >= 0 && sum <= 27) {
                    sumCounts[sum]++;
                }
                totalPrizesWith3Digits++;
            }
        }

        // Chuẩn hóa mảng đếm thành mảng tần suất (tỷ lệ).
        // Nếu không có giải nào hợp lệ, trả về mảng 0 để tránh lỗi chia cho 0.
        if (totalPrizesWith3Digits === 0) {
            return sumCounts;
        }
        const features = sumCounts.map(count => count / totalPrizesWith3Digits);

        // Kết quả: 28 features, mỗi feature đại diện cho tần suất của một tổng.
        return features;
    }

    // =================================================================
    // NHÓM 3: MẪU HÌNH CHẴN/LẺ (CHAN/LE PATTERNS) - 24 FEATURES
    // Mục tiêu: Dạy cho AI nhận biết sự thống trị của các mẫu hình chẵn/lẻ.
    // Logic: Thay vì chỉ nhìn vào số, ta phân tích các pattern như 'CCC', 'LCL'...
    //        Chúng ta làm điều này cho 3 nhóm giải khác nhau (giải cao, giải giữa, giải thấp)
    //        để xem liệu có sự khác biệt về pattern giữa các nhóm không.
    // =================================================================
    _extractChanLePatterns(currentDayResults) {
        // Định nghĩa các nhóm giải
        const highTierPrizes = PRIZE_ORDER.slice(0, 10); // ĐB -> G3f (10 giải)
        const midTierPrizes = PRIZE_ORDER.slice(10, 20); // G4a -> G5f (10 giải)
        const lowTierPrizes = PRIZE_ORDER.slice(20, 23);  // G6a -> G6c (3 giải)

        // Hàm helper để tính toán tần suất cho một nhóm giải cụ thể.
        const calculateTierFrequency = (prizeTier) => {
            const patternCounts = new Map(CL_PATTERNS_3_DIGIT.map(p => [p, 0]));
            let validPrizesInTier = 0;

            for (const prizeCode of prizeTier) {
                const result = currentDayResults.find(r => r.giai === prizeCode);
                if (result && result.chanle && CL_PATTERNS_3_DIGIT.includes(result.chanle)) {
                    patternCounts.set(result.chanle, patternCounts.get(result.chanle) + 1);
                    validPrizesInTier++;
                }
            }
            
            // Lấy ra các giá trị đã đếm theo đúng thứ tự của CL_PATTERNS_3_DIGIT.
            const counts = CL_PATTERNS_3_DIGIT.map(p => patternCounts.get(p));

            if (validPrizesInTier === 0) {
                return Array(8).fill(0);
            }
            return counts.map(count => count / validPrizesInTier);
        };

        const highTierFeatures = calculateTierFrequency(highTierPrizes); // 8 features
        const midTierFeatures = calculateTierFrequency(midTierPrizes);   // 8 features
        const lowTierFeatures = calculateTierFrequency(lowTierPrizes);   // 8 features

        // Kết quả: 8 + 8 + 8 = 24 features.
        return [...highTierFeatures, ...midTierFeatures, ...lowTierFeatures];
    }
    
    // =================================================================
    // NHÓM 4: PHÂN TÍCH KHOẢNG CÁCH (GAP ANALYSIS / "GAN") - 30 FEATURES
    // Mục tiêu: Cung cấp cho AI thông tin về "độ gan" của từng con số ở từng vị trí của 3 càng GĐB.
    // Logic: Với mỗi chữ số (0-9) và mỗi vị trí (Trăm, Chục, Đơn vị), chúng ta sẽ tìm xem
    //        lần cuối cùng nó xuất hiện ở vị trí đó là cách đây bao nhiêu ngày.
    // =================================================================
    _extractGapAnalysis(previousDaysResults) {
        // Khởi tạo đối tượng để lưu gap, mỗi vị trí là một Map.
        const gaps = {
            tram: new Map([...Array(10).keys()].map(i => [String(i), previousDaysResults.length + 1])),
            chuc: new Map([...Array(10).keys()].map(i => [String(i), previousDaysResults.length + 1])),
            donvi: new Map([...Array(10).keys()].map(i => [String(i), previousDaysResults.length + 1])),
        };
        
        // Cờ để đánh dấu xem đã tìm thấy lần xuất hiện gần nhất của một số chưa.
        const found = {
            tram: Array(10).fill(false),
            chuc: Array(10).fill(false),
            donvi: Array(10).fill(false),
        };

        // Lặp ngược từ ngày gần nhất về quá khứ.
        for (let i = 0; i < previousDaysResults.length; i++) {
            const dayResults = previousDaysResults[i];
            const dbResult = dayResults.find(r => r.giai === 'ĐB');
            const daysAgo = i + 1;

            if (dbResult && dbResult.basocuoi && dbResult.basocuoi.length === 3) {
                const [tram, chuc, donvi] = dbResult.basocuoi.split('');

                // Ghi nhận gap cho vị trí Trăm
                if (!found.tram[Number(tram)]) {
                    gaps.tram.set(tram, daysAgo);
                    found.tram[Number(tram)] = true;
                }
                // Ghi nhận gap cho vị trí Chục
                if (!found.chuc[Number(chuc)]) {
                    gaps.chuc.set(chuc, daysAgo);
                    found.chuc[Number(chuc)] = true;
                }
                // Ghi nhận gap cho vị trí Đơn vị
                if (!found.donvi[Number(donvi)]) {
                    gaps.donvi.set(donvi, daysAgo);
                    found.donvi[Number(donvi)] = true;
                }
            }
        }

        const features = [];
        const positions = ['tram', 'chuc', 'donvi'];
        // Lấy ra các giá trị gap đã tính và chuẩn hóa chúng.
        for (const pos of positions) {
            for (let i = 0; i < 10; i++) {
                const gapValue = gaps[pos].get(String(i));
                // Chuẩn hóa: Dùng hàm 1 / (1 + gap) để các gap nhỏ có giá trị gần 1, gap lớn có giá trị gần 0.
                // Đây là cách tốt hơn là chia tuyến tính, vì nó thể hiện được ý nghĩa "gan".
                features.push(1 / (1 + Math.log(gapValue + 1))); // Dùng log để làm mượt giá trị
            }
        }
        
        // Kết quả: 3 vị trí * 10 chữ số = 30 features.
        return features;
    }
}

module.exports = AdvancedFeatureEngineer;
