const express = require('express');
const mongoose = require('mongoose');
const xsRoutes = require('./routes/xsRoutes');

const app = express();
app.use(express.json());

// Mount route
app.use('/api/xs', xsRoutes);

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error(err));

app.listen(8080, () => console.log('Server running on port 8080'));


