// file: services/methods/goc.js
const runMethodGoc = (prevDayResults) => {
  const counts = { p1: {}, p2: {}, p3: {}, p4: {}, p5: {} };
  prevDayResults.forEach(r => {
    const num = String(r.so).padStart(5, '0');
    if (num.length === 5) {
        num.split('').forEach((digit, index) => {
            const posKey = `p${index + 1}`;
            counts[posKey][digit] = (counts[posKey][digit] || 0) + 1;
        });
    }
  });
  const generatePrediction = (initialCounts) => {
    const allDigits = ['0','1','2','3','4','5','6','7','8','9'];
    const allCounts = allDigits.map(d => ({ k: d, v: initialCounts[d] || 0 }));
    const top5 = allCounts.sort((a,b)=>b.v-a.v).slice(0,5).map(o=>o.k);
    return top5;
  };
  return {
    pos1: generatePrediction(counts.p1), pos2: generatePrediction(counts.p2),
    pos3: generatePrediction(counts.p3), pos4: generatePrediction(counts.p4),
    pos5: generatePrediction(counts.p5),
  };
};
module.exports = runMethodGoc;
