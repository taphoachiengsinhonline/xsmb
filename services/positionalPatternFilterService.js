/**
 * @file positionalPatternFilterService.js
 * @description Lọc các số ứng viên dựa trên tần suất xuất hiện của Mẫu C/L Vị Trí
 * trong tất cả các nhóm hoán vị 3 giải của ngày gần nhất.
 */

// =================================================================
// HELPER FUNCTIONS
// =================================================================
const get3DigitPrizes = (resultsForDay) => {
    return resultsForDay.filter(r => r.basocuoi && r.basocuoi.length === 3);
};

const getCombinations = (arr, k) => {
    if (k > arr.length || k <= 0) return [];
    if (k === arr.length) return [arr];
    if (k === 1) return arr.map(item => [item]);
    const combinations = [];
    arr.forEach((item, index) => {
        const smallerCombos = getCombinations(arr.slice(index + 1), k - 1);
        smallerCombos.forEach(combo => {
            combinations.push([item, ...combo]);
        });
    });
    return combinations;
};

const getChanLeForDigit = (digit) => (parseInt(digit, 10) % 2 === 0 ? 'C' : 'L');

const getChanLeForNumber = (numberStr) => {
    if (!numberStr || numberStr.length !== 3) return '';
    return numberStr.split('').map(getChanLeForDigit).join('');
};

// =================================================================
// CORE LOGIC
// =================================================================

/**
 * Tính toán tần suất xuất hiện của TẤT CẢ các mẫu C/L vị trí (8 mẫu).
 * Đây là bước tối ưu hóa, chỉ chạy 1 lần.
 * @param {Array} latestResults - Kết quả ngày gần nhất.
 * @returns {Map<string, number>} - Map chứa tần suất, vd: {'LCL' => 2, 'CCC' => 5, ...}
 */
const calculatePositionalPatternCounts = (latestResults) => {
    const patternCounts = new Map();
    const prizes = get3DigitPrizes(latestResults);
    if (prizes.length < 3) return patternCounts;

    const prizeGroups = getCombinations(prizes, 3);

    for (const group of prizeGroups) {
        // Lấy ra 3 số của 3 giải trong nhóm
        const numbers = group.map(p => p.basocuoi);

        // Tạo mẫu cho cột Trăm (vị trí 0)
        const tramPattern = numbers.map(n => getChanLeForDigit(n[0])).join('');
        patternCounts.set(tramPattern, (patternCounts.get(tramPattern) || 0) + 1);

        // Tạo mẫu cho cột Chục (vị trí 1)
        const chucPattern = numbers.map(n => getChanLeForDigit(n[1])).join('');
        patternCounts.set(chucPattern, (patternCounts.get(chucPattern) || 0) + 1);

        // Tạo mẫu cho cột Đơn vị (vị trí 2)
        const donviPattern = numbers.map(n => getChanLeForDigit(n[2])).join('');
        patternCounts.set(donviPattern, (patternCounts.get(donviPattern) || 0) + 1);
    }

    console.log(`[PositionalFilter] Đã tính xong tần suất cho ${patternCounts.size} mẫu vị trí.`);
    return patternCounts;
};

/**
 * Hàm lọc chính, áp dụng quy tắc tần suất <= 1.
 * @param {Array<string>} potentialNumbers - Dàn số cần lọc.
 * @param {Array} latestResults - Kết quả ngày gần nhất.
 * @returns {object} - { filteredNumbers: Array, counts: Map }
 */
const filterByPositionalPatternFrequency = (potentialNumbers, latestResults) => {
    const patternCounts = calculatePositionalPatternCounts(latestResults);

    // Nếu không tính được tần suất (do ít hơn 3 giải), không lọc gì cả
    if (patternCounts.size === 0) {
        return { filteredNumbers: potentialNumbers, patternCounts };
    }

    const filteredNumbers = potentialNumbers.filter(num => {
        // Lấy "dấu hiệu" C/L của số đang xét
        const numPattern = getChanLeForNumber(num);
        
        // Lấy tần suất của dấu hiệu này từ bảng đã tính
        const count = patternCounts.get(numPattern) || 0;

        // Áp dụng quy tắc: chỉ giữ lại nếu tần suất là 0 hoặc 1
        return count <= 1;
    });

    return { filteredNumbers, patternCounts };
};


module.exports = { filterByPositionalPatternFrequency };
