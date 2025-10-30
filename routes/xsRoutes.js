const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController');

router.get('/results', getAllResults);      // GET /api/xs/results
router.post('/update', updateResults);      // POST /api/xs/update
router.get('/train-advanced', xsController.trainAdvancedModel); // ✅ API ML nâng cao

module.exports = router;


