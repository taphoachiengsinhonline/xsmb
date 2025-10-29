const { mongoUri, port, crawlUrl } = require('./config');
const express = require('express');
const mongoose = require('mongoose');
const xsRoutes = require('./routes/xsRoutes');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`🔹 [Backend] Request ${req.method} ${req.url}`);
  next();
});
app.use('/api', xsRoutes);

mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.log('❌ MongoDB connection error:', err));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

