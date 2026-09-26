const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure downloads directory exists
const downloadsDir = process.env.DOWNLOADS_DIR
  ? path.resolve(process.env.DOWNLOADS_DIR)
  : path.join(__dirname, '../downloads');
fs.ensureDirSync(downloadsDir);

// Routes
app.use('/api/download', require('./routes/download'));
app.use('/api/info', require('./routes/info'));
app.use('/api/formats', require('./routes/formats'));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
