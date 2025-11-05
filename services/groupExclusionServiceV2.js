const positionalFilterService = require('./positionalPatternFilterService');
/**
 * @file groupExclusionServiceV2.js
 * @description Phiên bản nâng cao của phương pháp lọc loại trừ nhóm,
 * bổ sung 2 quy tắc lọc mới để giảm số lượng dàn số tiềm năng.
 */

// =================================================================
// HELPER FUNCTIONS (Bao gồm cả hàm mới)
// =================================================================

const get3DigitPrizes = (resultsForDay) => {
    return resultsForDay.filter(r => r.basocuoi && r.basocuoi.length === 3 && r.chanle);
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

const normalizePatternGroup = (patterns) => {
    return [...patterns].sort().join(',');
};

/**
 * [HELPER MỚI] Tính mẫu Chẵn/Lẻ cho một số 3 chữ số bất kỳ.
 * @param {string} numberStr - Chuỗi 3 chữ số, ví dụ "123".
 * @returns {string} - Mẫu C/L, ví dụ "LCC".
 */
const getChanLeForNumber = (numberStr) => {
    if (!numberStr || numberStr.length !== 3) return '';
    return numberStr.split('').map(d => (parseInt(d, 10) % 2 === 0 ? 'C' : 'L')).join('');
};


// =================================================================
// CÁC BƯỚC LỌC LOGIC
// =================================================================

/**
 * BƯỚC 1: Tìm các "bộ mẫu C/L bị triệt tiêu" từ ngày T-1 và T. (Logic cũ)
 */
const findLosingPatterns = (todayResults, yesterdayResults) => {
    const losingPatterns = new Set();
    const todayDB = todayResults.find(r => r.giai === 'ĐB');
    if (!todayDB || !todayDB.so) return losingPatterns;

    const dbDigits = new Set(String(todayDB.so).padStart(5, '0').split(''));
    const yesterdayPrizes = get3DigitPrizes(yesterdayResults);

    const triggerPrizes = yesterdayPrizes.filter(prize => {
        const prizeDigits = new Set(prize.so.split(''));
        for (const digit of dbDigits) { if (prizeDigits.has(digit)) return true; }
        return false;
    });

    if (triggerPrizes.length < 3) return losingPatterns;
    
    const triggerGroups = getCombinations(triggerPrizes, 3);
    triggerGroups.forEach(group => {
        losingPatterns.add(normalizePatternGroup(group.map(p => p.chanle)));
    });
    return losingPatterns;
};

/**
 * BƯỚC 2: Áp dụng bộ lọc ban đầu để loại các số dựa trên "bộ mẫu triệt tiêu". (Logic cũ)
 */
const applyInitialFilter = (latestResults, losingPatterns) => {
    const excludedNumbers = new Set();
    if (losingPatterns.size === 0) return excludedNumbers;

    const latestPrizes = get3DigitPrizes(latestResults);
    if (latestPrizes.length < 3) return excludedNumbers;

    const possibleGroups = getCombinations(latestPrizes, 3);
    possibleGroups.forEach(group => {
        const normalizedPatterns = normalizePatternGroup(group.map(p => p.chanle));
        if (losingPatterns.has(normalizedPatterns)) {
            group.forEach(prize => excludedNumbers.add(prize.basocuoi));
        }
    });
    return excludedNumbers;
};

/**
 * BƯỚC 3 [MỚI]: Lọc Dương - Chỉ giữ lại các số có mẫu C/L tồn tại trong ngày gần nhất.
 */
const filterByPatternExistence = (potentialNumbers, latestResults) => {
    const existingPatterns = new Set(get3DigitPrizes(latestResults).map(p => p.chanle));
    if (existingPatterns.size === 0) return potentialNumbers; // Không có mẫu nào thì không lọc

    return potentialNumbers.filter(num => {
        const numPattern = getChanLeForNumber(num);
        return existingPatterns.has(numPattern);
    });
};

/**
 * BƯỚC 4 [MỚI]: Lọc Âm - Loại bỏ các số thuộc về các nhóm có mẫu C/L trùng lặp.
 */
const filterByRepeatingPatterns = (potentialNumbers, latestResults) => {
    const numbersFromRepeatingGroups = new Set();
    const latestPrizes = get3DigitPrizes(latestResults);
    if (latestPrizes.length < 3) return potentialNumbers;

    const possibleGroups = getCombinations(latestPrizes, 3);
    possibleGroups.forEach(group => {
        const patterns = group.map(p => p.chanle);
        // Nếu số lượng mẫu duy nhất nhỏ hơn 3, tức là có sự trùng lặp
        if (new Set(patterns).size < 3) {
            group.forEach(prize => numbersFromRepeatingGroups.add(prize.basocuoi));
        }
    });

    if (numbersFromRepeatingGroups.size === 0) return potentialNumbers;

    return potentialNumbers.filter(num => !numbersFromRepeatingGroups.has(num));
};

// =================================================================
// HÀM CHÍNH ĐIỀU PHỐI
// =================================================================

const analyzeAndFilter = (latestResults, previousResults) => {
    // === Giai đoạn 1: Lọc ban đầu (dựa trên GĐB hôm trước) ===
    const losingPatterns = findLosingPatterns(latestResults, previousResults);
    const initialExcludedSet = applyInitialFilter(latestResults, losingPatterns);
    const allPossibleNumbers = Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0'));
    const potentialNumbers_Step1 = allPossibleNumbers.filter(num => !initialExcludedSet.has(num));

    // === Giai đoạn 2: Lọc Dương (dựa trên mẫu C/L tồn tại) ===
    const potentialNumbers_Step2 = filterByPatternExistence(potentialNumbers_Step1, latestResults);
    
    // === Giai đoạn 3: Lọc Âm (dựa trên nhóm C/L trùng lặp) ===
    const potentialNumbers_Step3 = filterByRepeatingPatterns(potentialNumbers_Step2, latestResults);
    
    // === BƯỚC 4 [LOGIC MỚI]: Lọc theo Tần Suất Mẫu Vị Trí ===
    const { filteredNumbers: potentialNumbers_Final, patternCounts } = 
        positionalFilterService.filterByPositionalPatternFrequency(potentialNumbers_Step3, latestResults);

    // Trả về kết quả chi tiết của tất cả các bước
    return {
        initialTotal: allPossibleNumbers.length,
        step1_afterInitialFilter: {
            count: potentialNumbers_Step1.length,
            excludedCount: initialExcludedSet.size,
        },
        step2_afterPatternExistenceFilter: {
            count: potentialNumbers_Step2.length,
            excludedCount: potentialNumbers_Step1.length - potentialNumbers_Step2.length,
        },
        step3_afterRepeatingPatternFilter: {
            count: potentialNumbers_Step3.length,
            excludedCount: potentialNumbers_Step2.length - potentialNumbers_Step3.length,
        },
        step4_finalResult: {
            count: potentialNumbers_Final.length,
            excludedCount: potentialNumbers_Step3.length - potentialNumbers_Final.length,
            potentialNumbers: potentialNumbers_Final,
        },
        analysisDetails: {
            losingPatterns: Array.from(losingPatterns),
            // Chuyển Map thành Object để dễ gửi qua JSON
            positionalPatternCounts: Object.fromEntries(patternCounts), 
        }
    };
};

module.exports = { analyzeAndFilter };
