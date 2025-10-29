const express = require('express');
const router = express.Router();
const { getAllResults, updateResults } = require('../controllers/xsController');

router.get('/results', getAllResults);
router.post('/update', updateResults);

module.exports = router;
