const express = require('express');
const router = express.Router();
const { getCLAnalysis } = require('../scripts/trainModel');

router.get('/train', async (req, res) => {
  const { date } = req.query; // optional: ?date=dd/mm/yyyy
  try {
    const data = await getCLAnalysis(date);
    res.json(data);
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
