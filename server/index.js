const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs-extra');
const { isB2Enabled, listFiles, deleteFile, isAutoCleanupObject } = require('./lib/storage');
const { startCleanupSweep } = require('./lib/cleanupSweep');

const app = express();

const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors());
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
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(PORT);

if (isB2Enabled()) {
  startCleanupSweep({
    intervalMs: Number(process.env.CLEANUP_SWEEP_INTERVAL_MS) || 60000,
    maxAgeMs: Number(process.env.AUTO_CLEANUP_DELAY_MS) || 45000,
    listFiles,
    deleteFile,
    isAutoCleanupObject
  });
}

module.exports = app;
