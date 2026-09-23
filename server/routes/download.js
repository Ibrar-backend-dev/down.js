const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const {
  ALLOWED_QUALITIES,
  PLATFORM_REFERERS,
  PLATFORM_COOKIE_DOMAINS,
  detectPlatform,
  parseCookieJarForDomain,
  buildCookieHeader,
  safeFilename
} = require('../lib/directLink');
const { resolveDirectLinkFormat } = require('../lib/formatResolution');
const router = express.Router();

const DIRECT_LINK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const DEFAULT_NOTE = 'Provider URLs may expire.';
// TikTok's CDN edge (Varnish) rejects the resolved video URL - 403 / internal
// error 54113 - unless the request also carries the anonymous anti-bot
// session cookies yt-dlp received while solving TikTok's webpage challenge.
// We capture those into a per-request cookie jar during extraction (see
// PLATFORM_COOKIE_DOMAINS) and return them as `requestHeaders` below, so the
// caller can attach them to the download request instead of getting a 403.
const TIKTOK_NOTE_WITH_HEADERS = 'Provider URLs may expire. TikTok also requires the "requestHeaders" (Cookie + Referer) below to be sent with the download request - the CDN returns 403 without them.';
const TIKTOK_NOTE_NO_HEADERS = 'Provider URLs may expire. TikTok additionally ties this CDN URL to the session that resolved it - the server could not capture that session this time, so some clients may see a 403 from TikTok even though the link is valid; retry resolution.';

function logLinkStep(requestId, platform, step, details = {}) {
  console.log(`[direct-link] req=${requestId} platform=${platform || 'unknown'} step=${step}`, details);
}

// GET /api/download/link?url=<source-url>&quality=<best|worst|height>
// Resolves a single direct, progressive (video+audio) HTTPS MP4 URL for a
// supported platform post - never a playlist, manifest, or fragmented format.
router.get('/link', (req, res) => {
  const requestId = crypto.randomUUID();
  const { url, quality = 'best' } = req.query;

  logLinkStep(requestId, null, 'request_received', { url, quality });

  if (typeof url !== 'string' || !/^https?:\/\/.+/i.test(url)) {
    logLinkStep(requestId, null, 'rejected_invalid_url');
    return res.status(400).json({ error: 'A valid HTTP/HTTPS URL is required', code: 'INVALID_URL' });
  }

  const selectedQuality = typeof quality === 'string' ? quality : 'best';
  if (!ALLOWED_QUALITIES.has(selectedQuality)) {
    logLinkStep(requestId, null, 'rejected_invalid_quality', { quality: selectedQuality });
    return res.status(400).json({ error: 'Invalid quality value', code: 'INVALID_QUALITY' });
  }

  const platform = detectPlatform(url);
  if (!platform) {
    logLinkStep(requestId, null, 'rejected_unsupported_platform', { url });
    return res.status(422).json({
      error: 'This site is not supported for direct-link resolution',
      code: 'UNSUPPORTED_DIRECT_LINK_PLATFORM'
    });
  }

  logLinkStep(requestId, platform, 'platform_detected', { quality: selectedQuality });

  const cookieConfig = PLATFORM_COOKIE_DOMAINS[platform] || null;
  const cookieJarPath = cookieConfig
    ? path.join(os.tmpdir(), `direct-link-cookies-${requestId}.txt`)
    : null;

  const args = [
    '--user-agent', DIRECT_LINK_USER_AGENT,
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--no-playlist',
    '--no-progress',
    '--dump-single-json'
  ];

  if (cookieJarPath) {
    args.push('--cookies', cookieJarPath);
  }

  args.push(url);

  logLinkStep(requestId, platform, 'ytdlp_spawn', { args });

  const MAX_METADATA_BYTES = 8 * 1024 * 1024;
  let output = '';
  let stderr = '';
  let responded = false;
  const ytdlp = spawn('yt-dlp', args);

  const respondOnce = (status, payload) => {
    if (!responded) {
      responded = true;
      logLinkStep(requestId, platform, 'response_sent', { status, code: payload.code });
      res.status(status).json(payload);
      if (cookieJarPath) {
        fs.remove(cookieJarPath).catch(() => {});
      }
    }
  };

  ytdlp.stdout.on('data', (data) => {
    if (output.length < MAX_METADATA_BYTES) {
      output += data.toString();
    }
  });

  ytdlp.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-4096);
  });

  ytdlp.on('error', (error) => {
    logLinkStep(requestId, platform, 'ytdlp_start_failed', { message: error.message });
    respondOnce(502, {
      error: 'Unable to start yt-dlp',
      code: 'YTDLP_START_FAILED',
      details: error.message
    });
  });

  ytdlp.on('close', async (code) => {
    if (responded) {
      return;
    }

    logLinkStep(requestId, platform, 'ytdlp_closed', { code, stderrTail: code !== 0 ? stderr.slice(-500) : undefined });

    if (code !== 0) {
      return respondOnce(502, {
        error: 'yt-dlp failed to extract media information',
        code: 'YTDLP_EXTRACTOR_FAILED',
        details: stderr || `yt-dlp exited with code ${code}`
      });
    }

    let metadata;
    try {
      metadata = JSON.parse(output);
    } catch (parseError) {
      logLinkStep(requestId, platform, 'metadata_parse_failed', { message: parseError.message });
      return respondOnce(502, {
        error: 'yt-dlp returned malformed metadata',
        code: 'YTDLP_EXTRACTOR_FAILED',
        details: parseError.message
      });
    }

    const formats = Array.isArray(metadata.formats) && metadata.formats.length > 0
      ? metadata.formats
      : (metadata.url ? [metadata] : []);

    logLinkStep(requestId, platform, 'metadata_parsed', { title: metadata.title, formatCount: formats.length });

    const selected = await resolveDirectLinkFormat(formats, selectedQuality, {
      userAgent: DIRECT_LINK_USER_AGENT,
      referer: PLATFORM_REFERERS[platform],
      onAttempt: (format, outcome) => {
        logLinkStep(requestId, platform, 'format_attempt', {
          formatId: format.format_id,
          protocol: format.protocol,
          height: format.height,
          outcome
        });
      }
    });
    if (!selected) {
      logLinkStep(requestId, platform, 'no_progressive_mp4_found');
      return respondOnce(422, {
        error: 'No direct progressive MP4 is available for this post',
        code: 'DIRECT_LINK_UNAVAILABLE'
      });
    }

    let selectedHost = null;
    try {
      selectedHost = new URL(selected.url).host;
    } catch {
      // selected.url is already validated as http(s) upstream; ignore.
    }
    logLinkStep(requestId, platform, 'format_selected', {
      formatId: selected.format_id,
      ext: selected.ext,
      protocol: selected.protocol,
      width: selected.width,
      height: selected.height,
      host: selectedHost
    });

    let requestHeaders = null;
    let note = DEFAULT_NOTE;

    if (cookieConfig) {
      try {
        const jarText = await fs.readFile(cookieJarPath, 'utf8');
        const cookies = parseCookieJarForDomain(jarText, cookieConfig.domain);
        const cookieHeader = buildCookieHeader(cookies);
        if (cookieHeader) {
          requestHeaders = { Referer: cookieConfig.referer, Cookie: cookieHeader };
          note = TIKTOK_NOTE_WITH_HEADERS;
        } else {
          note = TIKTOK_NOTE_NO_HEADERS;
        }
        logLinkStep(requestId, platform, 'cookie_jar_captured', { cookieCount: cookies.length });
      } catch (jarError) {
        note = TIKTOK_NOTE_NO_HEADERS;
        logLinkStep(requestId, platform, 'cookie_jar_read_failed', { message: jarError.message });
      }
    }

    respondOnce(200, {
      downloadUrl: selected.url,
      filename: safeFilename(metadata.title),
      contentType: 'video/mp4',
      platform,
      quality: {
        width: typeof selected.width === 'number' ? selected.width : null,
        height: typeof selected.height === 'number' ? selected.height : null
      },
      expiresAt: null,
      requestHeaders,
      note
    });
  });
});

// POST /api/download
router.post('/', async (req, res) => {
  try {
    const { url, format, quality, audioOnly, outputPath } = req.body;
    const io = req.app.get('socketio');

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Basic URL validation - let yt-dlp handle specific format validation
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(url)) {
      return res.status(400).json({ error: 'Invalid URL format. Please provide a valid HTTP/HTTPS URL.' });
    }

    const downloadsDir = path.join(__dirname, '../../downloads');
    await fs.ensureDir(downloadsDir);

    // Build yt-dlp command with better YouTube handling
    const args = [];

    // Add user agent and headers to bypass some restrictions
    args.push('--user-agent', DIRECT_LINK_USER_AGENT);
    args.push('--add-header', 'Accept-Language:en-US,en;q=0.9');

    if (audioOnly) {
      args.push('-f', 'bestaudio/best');
      args.push('--extract-audio');
      args.push('--audio-format', format || 'mp3');
    } else {
      // Sites that only ever serve split video-only/audio-only tracks (e.g.
      // Reddit) have no genuine single pre-merged format, so a "best single
      // format" selector like 'b' or 'best[height<=Q]' can outright fail
      // with "Requested format is not available". Prefer merging the best
      // video+audio pair (yt-dlp/ffmpeg does the mux) and only fall back to
      // a video-only 'best' pick when a video genuinely has no audio track.
      if (quality && quality !== 'best') {
        args.push('-f', `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`);
      } else {
        args.push('-f', 'bestvideo+bestaudio/best');
      }
      args.push('--merge-output-format', 'mp4');
    }

    args.push('-o', path.join(downloadsDir, '%(title)s.%(ext)s'));
    args.push('--no-playlist');
    args.push('--progress');
    args.push(url);

    const downloadId = Date.now().toString();
    
    // Spawn yt-dlp process
    const ytdlp = spawn('yt-dlp', args);

    let downloadInfo = {
      id: downloadId,
      url,
      status: 'starting',
      progress: 0,
      filename: '',
      error: null
    };

    io.emit('download-start', downloadInfo);

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('yt-dlp stdout:', output);
      
      // Parse progress information
      const progressMatch = output.match(/(\d+\.\d+)%/);
      if (progressMatch) {
        downloadInfo.progress = parseFloat(progressMatch[1]);
        downloadInfo.status = 'downloading';
        io.emit('download-progress', downloadInfo);
      }
      
      // Extract filename
      const filenameMatch = output.match(/\[download\] Destination: (.+)/);
      if (filenameMatch) {
        downloadInfo.filename = path.basename(filenameMatch[1]);
      }
    });

    ytdlp.stderr.on('data', (data) => {
      const error = data.toString();
      console.error('yt-dlp stderr:', error);
      downloadInfo.error = error;
      downloadInfo.status = 'error';
      io.emit('download-error', downloadInfo);
    });

    ytdlp.on('close', (code) => {
      if (code === 0) {
        downloadInfo.status = 'completed';
        downloadInfo.progress = 100;
        io.emit('download-complete', downloadInfo);
      } else {
        downloadInfo.status = 'error';
        downloadInfo.error = `Process exited with code ${code}`;
        io.emit('download-error', downloadInfo);
      }
    });

    res.json({
      success: true,
      downloadId,
      message: 'Download started'
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ 
      error: 'Download failed',
      details: error.message 
    });
  }
});

// GET /api/download/list - List downloaded files
router.get('/list', async (req, res) => {
  try {
    const downloadsDir = path.join(__dirname, '../../downloads');
    const files = await fs.readdir(downloadsDir);
    
    const fileList = await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(downloadsDir, file);
        const stats = await fs.stat(filePath);
        return {
          name: file,
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime
        };
      })
    );

    res.json(fileList);
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// DELETE /api/download/:filename - Delete a downloaded file
router.delete('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, '../../downloads', filename);
    
    // Security check - ensure file is in downloads directory
    if (!filePath.startsWith(path.join(__dirname, '../../downloads'))) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    await fs.remove(filePath);
    res.json({ success: true, message: 'File deleted successfully' });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

module.exports = router;
