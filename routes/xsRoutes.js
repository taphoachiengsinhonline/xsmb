const express = require('express');
const router = express.Router();
const xsController = require('../controllers/xsController'); // ✅ Lấy toàn bộ controller

// ✅ Định nghĩa routes đúng chuẩn
router.get('/results', xsController.getAllResults);
router.post('/update', xsController.updateResults);
router.get('/train-advanced', xsController.trainAdvancedModel); // ✅ Phương pháp ML nâng cao

module.exports = router;
