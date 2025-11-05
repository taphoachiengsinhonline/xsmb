async function getLatestTwoDaysResults() {
    const latestDates = await Result.find().sort({ ngay: -1 }).distinct('ngay');
    if (latestDates.length < 2) {
        throw new Error('Not enough data for analysis (requires at least 2 days).');
    }
    const latestDateStr = latestDates[0];
    const prevDateStr = latestDates[1];

    const latestResults = await Result.find({ ngay: latestDateStr });
    const prevResults = await Result.find({ ngay: prevDateStr });
    
    return { latestDate: latestDateStr, prevDate: prevDateStr, latestResults, prevResults };
}
