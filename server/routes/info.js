const express = require('express');
const { spawn } = require('child_process');
const { extractQualities, keepSizedQualities, extractBestAudio, formatDuration } = require('../lib/qualities');
const { resolveRealSizeMb } = require('../lib/formatSize');
const { stripNullish } = require('../lib/cleanResponse');
const { detectPlatform } = require('../lib/directLink');
const { getYtdlpEnv } = require('../lib/ytdlpRunner');
const router = express.Router();

// POST /api/download merges a video-only format with the best audio track, so its size includes both.
async function downloadSizeMb(candidate, bestAudio, audioSizeMb) {
  const videoSizeMb = await resolveRealSizeMb(candidate);
  if (videoSizeMb === null || !candidate.videoOnly || !bestAudio) return videoSizeMb;
  return audioSizeMb === null ? null : Math.round((videoSizeMb + audioSizeMb) * 100) / 100;
}

// GET /api/info?url=<video_url> - Get video information
router.get('/', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Basic URL validation - let yt-dlp handle specific format validation
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(url)) {
      return res.status(400).json({ error: 'Invalid URL format. Please provide a valid HTTP/HTTPS URL.' });
    }

    const args = [
      '--dump-json',
      '--no-playlist',
      url
    ];

    const ytdlp = spawn('yt-dlp', args, { env: getYtdlpEnv() });
    let output = '';
    let error = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      error += data.toString();
    });

    ytdlp.on('close', async (code) => {
      if (code === 0) {
        try {
          const videoInfo = JSON.parse(output);

          const qualityCandidates = extractQualities(videoInfo.formats);
          const bestAudio = extractBestAudio(videoInfo.formats);
          const audioSizeMb = bestAudio && qualityCandidates.some((c) => c.videoOnly)
            ? await resolveRealSizeMb(bestAudio)
            : null;
          const qualities = await Promise.all(qualityCandidates.map(async (candidate) => ({
            format_id: candidate.format_id,
            ext: candidate.ext,
            label: candidate.label,
            quality: candidate.quality,
            filesize: await downloadSizeMb(candidate, bestAudio, audioSizeMb)
          })));

          // LOCKED RESPONSE SHAPE - do not add/remove/rename top-level or
          // `qualities` fields without explicit user confirmation first.
          // This exact shape was iteratively pinned down across many
          // requests (dropped description/uploader/upload_date/view_count/
          // webpage_url/extractor/width/height/formats on purpose) - ask
          // before changing it again, even for a seemingly obvious cleanup.
          const info = stripNullish({
            id: videoInfo.id,
            title: videoInfo.title,
            // "9 seconds" under a minute, "1 minute 30 seconds"/"2 minutes"
            // once it reaches one - see server/lib/qualities.js.
            duration: formatDuration(videoInfo.duration),
            // Best-effort platform match against the same 5 platforms
            // GET /api/download/link supports; null for every other site
            // yt-dlp itself still handles fine (e.g. YouTube, Vimeo, Reddit).
            platform: detectPlatform(url),
            // Only fields that actually have a value - see
            // server/lib/cleanResponse.js - a format/platform not reporting
            // something (e.g. no real filesize) just omits the key instead
            // of cluttering the response with nulls.
            qualities: keepSizedQualities(qualities).map(stripNullish)
          });

          res.json(info);
        } catch (parseError) {
          res.status(500).json({ 
            error: 'Failed to parse video information',
            details: parseError.message 
          });
        }
      } else {
        res.status(500).json({ 
          error: 'Failed to get video information',
          details: error 
        });
      }
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to extract video information',
      details: error.message 
    });
  }
});

// GET /api/info/playlist?url=<playlist_url> - Get playlist information
router.get('/playlist', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const args = [
      '--flat-playlist',
      '--dump-json',
      url
    ];

    const ytdlp = spawn('yt-dlp', args, { env: getYtdlpEnv() });
    let output = '';
    let error = '';

    ytdlp.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      error += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        try {
          const lines = output.trim().split('\n').filter(line => line.trim());
          const playlist = lines.map(line => JSON.parse(line));
          
          res.json({
            entries: playlist.map(entry => ({
              id: entry.id,
              title: entry.title,
              url: entry.url,
              duration: entry.duration,
              uploader: entry.uploader
            }))
          });
        } catch (parseError) {
          res.status(500).json({ 
            error: 'Failed to parse playlist information',
            details: parseError.message 
          });
        }
      } else {
        res.status(500).json({ 
          error: 'Failed to get playlist information',
          details: error 
        });
      }
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to extract playlist information',
      details: error.message 
    });
  }
});

module.exports = router;
