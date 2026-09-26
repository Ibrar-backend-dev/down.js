const express = require('express');
const { spawn } = require('child_process');
const { extractQualities, formatDuration } = require('../lib/qualities');
const { fetchRealFilesizeMb } = require('../lib/formatSize');
const { stripNullish } = require('../lib/cleanResponse');
const { detectPlatform } = require('../lib/directLink');
const { getYtdlpEnv } = require('../lib/ytdlpRunner');
const router = express.Router();

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

          // One representative format per distinct resolution (highest
          // bitrate variant when there are several - see
          // server/lib/qualities.js). Real filesize comes from yt-dlp's own
          // metadata when the platform reports it (e.g. TikTok) - only when
          // that's genuinely absent (e.g. Instagram) do we fall back to a
          // live HEAD request reading the CDN's Content-Length header (see
          // server/lib/formatSize.js). Trying the HEAD request unconditionally
          // would be wrong: TikTok's CDN requires session cookies we don't
          // have here, so a bare HEAD 403s - which would wrongly turn an
          // already-known real size into null instead of using it.
          const qualityCandidates = extractQualities(videoInfo.formats);
          const qualities = await Promise.all(qualityCandidates.map(async (candidate) => ({
            format_id: candidate.format_id,
            ext: candidate.ext,
            label: candidate.label,
            quality: candidate.quality,
            filesize: candidate.filesize !== null
              ? candidate.filesize
              : (candidate.url ? await fetchRealFilesizeMb(candidate.url) : null)
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
            qualities: qualities.map(stripNullish)
          });

          res.json(info);
        } catch (parseError) {
          console.error('Error parsing JSON:', parseError);
          res.status(500).json({ 
            error: 'Failed to parse video information',
            details: parseError.message 
          });
        }
      } else {
        console.error('yt-dlp error:', error);
        res.status(500).json({ 
          error: 'Failed to get video information',
          details: error 
        });
      }
    });

  } catch (error) {
    console.error('Info extraction error:', error);
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
          console.error('Error parsing playlist JSON:', parseError);
          res.status(500).json({ 
            error: 'Failed to parse playlist information',
            details: parseError.message 
          });
        }
      } else {
        console.error('yt-dlp playlist error:', error);
        res.status(500).json({ 
          error: 'Failed to get playlist information',
          details: error 
        });
      }
    });

  } catch (error) {
    console.error('Playlist extraction error:', error);
    res.status(500).json({ 
      error: 'Failed to extract playlist information',
      details: error.message 
    });
  }
});

module.exports = router;
