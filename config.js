// config.js
module.exports = {
  mongoUri: process.env.MONGO_URI || '',      // URI MongoDB
  port: process.env.PORT || 5000,             // port server
  crawlUrl: process.env.CRAWL_URL || 'https://ketqua04.net/so-ket-qua', // URL crawl
};
