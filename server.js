const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors'); // Thêm dòng này
const xsRoutes = require('./routes/xsRoutes');
const nnRoutes = require('./routes/nnRoutes');
const app = express();

app.use(cors()); // Thêm dòng này
app.use(express.json());

// Mount route
app.use('/api/xs', xsRoutes);

// BỎ TÙY CHỌN CŨ KHI KẾT NỐI
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error(err));
  
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

