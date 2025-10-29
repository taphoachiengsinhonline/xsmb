const express = require('express');
const router = express.Router();
const { getAllResults, updateResults } = require('../controllers/xsController');

router.get('/results', getAllResults);      // GET /api/xs/results
router.post('/update', updateResults);      // POST /api/xs/update

module.exports = router;
