/**
 * @file groupExclusionService.js
 * @description Implement a group exclusion filtering method based on Chan/Le patterns.
 * This service analyzes past results to find "losing patterns" and applies them to filter
 * potential numbers for the next day.
 */

// =================================================================
// HELPER FUNCTIONS
// =================================================================

/**
 * Lấy tất cả các giải có 3 số cuối từ một danh sách kết quả.
 * @param {Array} resultsForDay - Mảng kết quả của một ngày.
 * @returns {Array} - Mảng các giải có 3 số cuối hợp lệ.
 */
const get3DigitPrizes = (resultsForDay) => {
    return resultsForDay.filter(r => r.basocuoi && r.basocuoi.length === 3 && r.chanle);
};

/**
 * Tạo tất cả các tổ hợp chập k của một mảng.
 * @param {Array} arr - Mảng đầu vào.
 * @param {number} k - Kích thước của mỗi tổ hợp.
 * @returns {Array<Array>} - Mảng chứa tất cả các tổ hợp.
 */
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

/**
 * Chuẩn hóa một bộ 3 mẫu C/L bằng cách sắp xếp chúng.
 * Giúp coi (CCC, LLL, CLC) và (CLC, CCC, LLL) là một.
 * @param {Array<string>} patterns - Mảng 3 mẫu C/L, vd: ['CCC', 'LLL', 'CLC'].
 * @returns {string} - Chuỗi đã chuẩn hóa, vd: "CCC,CLC,LLL".
 */
const normalizePatternGroup = (patterns) => {
    return [...patterns].sort().join(',');
};


// =================================================================
// CORE LOGIC
// =================================================================

/**
 * Bước 1: Phân tích ngược để tìm ra các "bộ mẫu C/L bị triệt tiêu".
 * @param {Array} todayResults - Kết quả của ngày T (ngày GĐB đã về).
 * @param {Array} yesterdayResults - Kết quả của ngày T-1.
 * @returns {Set<string>} - Một Set chứa các bộ mẫu đã chuẩn hóa.
 */
const findLosingPatterns = (todayResults, yesterdayResults) => {
    const losingPatterns = new Set();
    
    const todayDB = todayResults.find(r => r.giai === 'ĐB');
    if (!todayDB || !todayDB.so) return losingPatterns;

    const dbDigits = new Set(String(todayDB.so).padStart(5, '0').split(''));
    const yesterdayPrizes = get3DigitPrizes(yesterdayResults);

    // Tìm các "giải kích hoạt" từ ngày hôm qua
    const triggerPrizes = yesterdayPrizes.filter(prize => {
        const prizeDigits = new Set(prize.so.split(''));
        for (const digit of dbDigits) {
            if (prizeDigits.has(digit)) return true;
        }
        return false;
    });

    // Nếu không đủ 3 giải kích hoạt, không thể tạo nhóm
    if (triggerPrizes.length < 3) return losingPatterns;
    
    // Tạo các nhóm 3 giải từ các giải kích hoạt
    const triggerGroups = getCombinations(triggerPrizes, 3);
    
    triggerGroups.forEach(group => {
        const patterns = group.map(prize => prize.chanle);
        const normalized = normalizePatternGroup(patterns);
        losingPatterns.add(normalized);
    });
    
    console.log(`[GroupExclusion] Tìm thấy ${losingPatterns.size} bộ mẫu C/L bị triệt tiêu.`);
    return losingPatterns;
};

/**
 * Bước 2: Áp dụng bộ lọc để tìm các số cần loại bỏ.
 * @param {Array} latestResults - Kết quả của ngày T (ngày hiện tại, để dự đoán cho T+1).
 * @param {Set<string>} losingPatterns - Set các bộ mẫu cần loại bỏ.
 * @returns {Set<string>} - Một Set chứa các số 3 càng cần loại bỏ.
 */
const applyFilter = (latestResults, losingPatterns) => {
    const excludedNumbers = new Set();
    if (losingPatterns.size === 0) return excludedNumbers;

    const latestPrizes = get3DigitPrizes(latestResults);
    if (latestPrizes.length < 3) return excludedNumbers;

    const possibleGroups = getCombinations(latestPrizes, 3);
    
    possibleGroups.forEach(group => {
        const patterns = group.map(prize => prize.chanle);
        const normalized = normalizePatternGroup(patterns);

        // Nếu bộ mẫu của nhóm này nằm trong danh sách triệt tiêu -> loại bỏ
        if (losingPatterns.has(normalized)) {
            group.forEach(prize => {
                excludedNumbers.add(prize.basocuoi);
            });
        }
    });
    
    console.log(`[GroupExclusion] Đã loại trừ ${excludedNumbers.size} số dựa trên các bộ mẫu.`);
    return excludedNumbers;
};


// =================================================================
// MAIN EXPORTED FUNCTION
// =================================================================

/**
 * Chạy toàn bộ quy trình phân tích và lọc.
 * @param {Array} latestResults - Kết quả của ngày gần nhất (ngày T).
 * @param {Array} previousResults - Kết quả của ngày trước đó (ngày T-1).
 * @returns {object} - { excludedNumbers: Array, potentialNumbers: Array }
 */
const analyzeAndFilter = (latestResults, previousResults) => {
    // Bước 1: Tìm các quy luật triệt tiêu từ T và T-1
    const losingPatterns = findLosingPatterns(latestResults, previousResults);

    // Bước 2: Áp dụng quy luật vào ngày T để lọc cho ngày T+1
    const excludedNumbersSet = applyFilter(latestResults, losingPatterns);
    
    const allPossibleNumbers = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
    
    const excludedNumbers = Array.from(excludedNumbersSet);
    const potentialNumbers = allPossibleNumbers.filter(num => !excludedNumbersSet.has(num));

    return {
        excludedNumbers,
        potentialNumbers,
        analysisDetails: {
            losingPatternsCount: losingPatterns.size,
            losingPatterns: Array.from(losingPatterns),
        }
    };
};

module.exports = { analyzeAndFilter };
