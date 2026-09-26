const express = require('express');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const {
  normalizeQualityParam,
  PLATFORM_REFERERS,
  PLATFORM_COOKIE_DOMAINS,
  detectPlatform,
  parseCookieJarForDomain,
  buildCookieHeader,
  safeFilename
} = require('../lib/directLink');
const { resolveDirectLinkFormat } = require('../lib/formatResolution');
const { formatQualityLabel } = require('../lib/qualities');
const { fetchRealFilesizeMb } = require('../lib/formatSize');
const { probeRemoteVideoResolution, probeLocalVideoResolution } = require('../lib/ffprobe');
const { runYtdlpWithRetry, getYtdlpEnv } = require('../lib/ytdlpRunner');
const {
  isB2Enabled,
  uploadFile: uploadToB2,
  listFiles: listB2Files,
  deleteFile: deleteB2File,
  getDownloadUrl: getB2DownloadUrl
} = require('../lib/storage');
const router = express.Router();

const DIRECT_LINK_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const AUDIO_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg'
};

// How long POST /api/download will wait out a platform reporting the video
// is still being processed on their end (e.g. Reddit right after upload),
// retrying the whole yt-dlp invocation every PROCESSING_RETRY_DELAY_MS
// instead of failing on the first attempt.
const PROCESSING_RETRY_DELAY_MS = Number(process.env.PROCESSING_RETRY_DELAY_MS) || 5000;
const PROCESSING_MAX_WAIT_MS = Number(process.env.PROCESSING_MAX_WAIT_MS) || 120000;

// How long a file (local or B2) stays available after a POST /api/download
// job finishes before it's automatically deleted. Callers must fetch it via
// GET /api/download/:filename within this window.
const AUTO_CLEANUP_DELAY_MS = Number(process.env.AUTO_CLEANUP_DELAY_MS) || 45000;

const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR
  ? path.resolve(process.env.DOWNLOADS_DIR)
  : path.join(__dirname, '../../downloads');

const DEFAULT_NOTE = 'The URL may expire in 40 seconds.';
// TikTok's CDN edge (Varnish) rejects the resolved video URL - 403 / internal
// error 54113 - unless the request also carries the anonymous anti-bot
// session cookies yt-dlp received while solving TikTok's webpage challenge.
// We capture those into a per-request cookie jar during extraction (see
// PLATFORM_COOKIE_DOMAINS) and return them as `requestHeaders` below, so the
// caller can attach them to the download request instead of getting a 403.
const TIKTOK_NOTE_WITH_HEADERS = 'The URL may expire in 40 seconds. TikTok also requires the "requestHeaders" (Cookie + Referer) below to be sent with the download request - the CDN returns 403 without them.';
const TIKTOK_NOTE_NO_HEADERS = 'The URL may expire in 40 seconds. TikTok additionally ties this CDN URL to the session that resolved it - the server could not capture that session this time, so some clients may see a 403 from TikTok even though the link is valid; retry resolution.';

function logLinkStep(requestId, platform, step, details = {}) {
  console.log(`[direct-link] req=${requestId} platform=${platform || 'unknown'} step=${step}`, details);
}

// GET /api/download/link?url=<source-url>&quality=<best|worst|height|heightp>
// Resolves a single direct, progressive (video+audio) HTTPS MP4 URL for a
// supported platform post - never a playlist, manifest, or fragmented format.
// `quality` accepts the exact "<n>p" label GET /api/info shows for a chosen
// quality (e.g. "720p") as well as a bare height ("720") - see
// normalizeQualityParam in server/lib/directLink.js.
router.get('/link', (req, res) => {
  const requestId = crypto.randomUUID();
  const { url, quality = 'best' } = req.query;

  logLinkStep(requestId, null, 'request_received', { url, quality });

  if (typeof url !== 'string' || !/^https?:\/\/.+/i.test(url)) {
    logLinkStep(requestId, null, 'rejected_invalid_url');
    return res.status(400).json({ error: 'A valid HTTP/HTTPS URL is required', code: 'INVALID_URL' });
  }

  const selectedQuality = normalizeQualityParam(quality);
  if (!selectedQuality) {
    logLinkStep(requestId, null, 'rejected_invalid_quality', { quality });
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
  const ytdlp = spawn('yt-dlp', args, { env: getYtdlpEnv() });

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

    const title = path.parse(safeFilename(metadata.title)).name;
    // Some platforms (confirmed: Instagram, Facebook hd/sd) omit
    // width/height from yt-dlp's own metadata for an otherwise perfectly
    // valid progressive format - the real resolution still exists, it's
    // just not in the data yt-dlp extracted. Rather than reporting a
    // fabricated-looking quality: null for those, probe the actual CDN URL
    // with ffprobe (same approach as the ambiguous-format verification
    // above) to read the real dimensions.
    const resolvedDimensions = (typeof selected.width === 'number' && typeof selected.height === 'number')
      ? selected
      : await probeRemoteVideoResolution(selected.url, {
        userAgent: DIRECT_LINK_USER_AGENT,
        referer: PLATFORM_REFERERS[platform]
      });
    // Same "720p"-style short-edge label as GET /api/info and
    // POST /api/download (see server/lib/qualities.js) - not a raw
    // {width, height} object, and null (not a fabricated label) when even
    // the live probe can't determine a real resolution.
    const quality = resolvedDimensions ? formatQualityLabel(resolvedDimensions) : null;
    // Real, platform-reported size in MB via a HEAD request to the actual
    // CDN URL - never estimated. Sent with the same requestHeaders the
    // download itself needs (e.g. TikTok's session cookies), since the CDN
    // rejects a bare request without them just as it would for the download.
    const fileSize = await fetchRealFilesizeMb(selected.url, { headers: requestHeaders || undefined });

    respondOnce(200, {
      platform,
      contentType: 'video/mp4',
      title,
      quality,
      fileSize,
      note,
      expiresAt: null,
      requestHeaders,
      downloadUrl: selected.url
    });
  });
});

// POST /api/download - downloads synchronously and responds with the
// finished result directly (no Socket.IO/background job - the request
// stays open for the duration of the download).
router.post('/', async (req, res) => {
  try {
    const { url, format, quality, audioOnly } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Basic URL validation - let yt-dlp handle specific format validation
    const urlPattern = /^https?:\/\/.+/i;
    if (!urlPattern.test(url)) {
      return res.status(400).json({ error: 'Invalid URL format. Please provide a valid HTTP/HTTPS URL.' });
    }

    const downloadsDir = DOWNLOADS_DIR;
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

    const result = await runYtdlpWithRetry(args, {
      retryDelayMs: PROCESSING_RETRY_DELAY_MS,
      maxWaitMs: PROCESSING_MAX_WAIT_MS,
      onStdoutChunk: (chunk) => console.log('yt-dlp stdout:', chunk),
      onAttempt: (attempt, attemptResult, isTransient) => {
        if (isTransient) {
          console.log(`[retry] attempt ${attempt} reported the video is still processing - waiting ${PROCESSING_RETRY_DELAY_MS}ms before retrying`);
        } else if (attemptResult.stderr) {
          console.error('yt-dlp stderr:', attemptResult.stderr);
        }
      }
    });

    if (result.spawnError) {
      return res.status(502).json({ error: 'Unable to start yt-dlp', details: result.spawnError.message });
    }

    if (result.exitCode !== 0) {
      return res.status(502).json({
        error: 'Download failed',
        details: result.stderr.slice(-4096) || `yt-dlp exited with code ${result.exitCode}`
      });
    }

    // A merged video+audio download (see the -f selector above) writes temp
    // component files first - each logs its own "[download] Destination:"
    // line - then merges them into the final file via ffmpeg, logged
    // separately. If a component (or the whole output) already exists on
    // disk from an earlier request, yt-dlp logs "<path> has already been
    // downloaded" instead of a "Destination:" line for that component - a
    // real success (the file genuinely exists), just a different message
    // format, so it needs its own pattern rather than being read as "no
    // filename found". Take the *last* match across all three so a merge
    // target overrides its temp components, matching log order.
    let filename = '';
    for (const m of result.stdout.matchAll(/\[download\] Destination: (.+)/g)) {
      filename = path.basename(m[1].trim());
    }
    for (const m of result.stdout.matchAll(/\[download\] (.+) has already been downloaded/g)) {
      filename = path.basename(m[1].trim());
    }
    for (const m of result.stdout.matchAll(/\[Merger\] Merging formats into "(.+)"/g)) {
      filename = path.basename(m[1].trim());
    }

    if (!filename) {
      return res.status(502).json({ error: 'Download completed but the output filename could not be determined' });
    }

    const localFilePath = path.join(downloadsDir, filename);
    const platform = detectPlatform(url);
    const contentType = audioOnly ? (AUDIO_CONTENT_TYPES[format] || AUDIO_CONTENT_TYPES.mp3) : 'video/mp4';
    const title = path.parse(filename).name;
    // Read the real, final pixel dimensions from the downloaded file itself
    // - not just an echo of the requested quality string - then report them
    // as the same "720p"-style short-edge label used by GET /api/info (see
    // server/lib/qualities.js), not a raw {width, height} object. null for
    // audio-only downloads or if ffprobe can't determine it.
    const resolvedResolution = audioOnly ? null : await probeLocalVideoResolution(localFilePath);
    const resolvedQualityLabel = resolvedResolution ? formatQualityLabel(resolvedResolution) : null;

    // The real, final byte size of the file yt-dlp actually produced - never
    // estimated - reported in MB. null if the file can't be stat'd for some
    // reason (it must exist by this point in real use; this is just a safe
    // fallback, not a calculated guess).
    const fileSizeBytes = await fs.stat(localFilePath).then((stats) => stats.size).catch(() => null);
    const fileSize = typeof fileSizeBytes === 'number'
      ? Math.round((fileSizeBytes / (1024 * 1024)) * 100) / 100
      : null;

    // yt-dlp always writes to local disk first (it has no B2-aware output
    // mode); when B2 is configured, upload the finished file there and
    // remove the local copy so B2 is the only place it ends up living -
    // local disk is a staging area in that case, not a second copy.
    let storage;
    let downloadUrl;
    if (isB2Enabled()) {
      try {
        await uploadToB2(localFilePath, filename);
        await fs.remove(localFilePath);
        storage = 'b2';
        // The file only exists for AUTO_CLEANUP_DELAY_MS, so hand back a
        // presigned URL that's directly clickable/downloadable right now -
        // not another hop through our own API - valid for exactly that
        // same window, not longer than the object itself will exist.
        downloadUrl = await getB2DownloadUrl(filename, {
          expiresInSeconds: Math.ceil(AUTO_CLEANUP_DELAY_MS / 1000)
        });
      } catch (uploadError) {
        console.error('B2 upload error:', uploadError);
        return res.status(502).json({
          error: 'Download completed but failed to upload to B2',
          details: uploadError.message
        });
      }
    } else {
      storage = 'local';
      // Fully-qualified so it's directly usable/clickable without the
      // caller having to know or guess our base URL.
      downloadUrl = `${req.protocol}://${req.get('host')}/api/download/${encodeURIComponent(filename)}`;
    }

    // Give callers a fixed window to fetch the file via
    // GET /api/download/:filename before it's removed automatically.
    const cleanupFromB2 = storage === 'b2';
    setTimeout(async () => {
      try {
        if (cleanupFromB2) {
          await deleteB2File(filename);
        } else {
          await fs.remove(localFilePath);
        }
        console.log(`[auto-cleanup] removed "${filename}" (${cleanupFromB2 ? 'b2' : 'local'}) after ${AUTO_CLEANUP_DELAY_MS}ms`);
      } catch (cleanupError) {
        console.error(`[auto-cleanup] failed to remove "${filename}":`, cleanupError);
      }
    }, AUTO_CLEANUP_DELAY_MS);

    res.json({
      downloadId,
      platform,
      contentType,
      title,
      quality: resolvedQualityLabel,
      fileSize,
      storage,
      downloadUrl
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
    if (isB2Enabled()) {
      const fileList = await listB2Files();
      return res.json(fileList);
    }

    const downloadsDir = DOWNLOADS_DIR;
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

// GET /api/download/:filename - Fetch a finished download's bytes. Files
// are removed automatically AUTO_CLEANUP_DELAY_MS after the job completes
// (see the POST handler above), so this must be called within that window.
router.get('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    if (isB2Enabled()) {
      const url = await getB2DownloadUrl(filename, { expiresInSeconds: 60 });
      return res.redirect(302, url);
    }

    const filePath = path.join(DOWNLOADS_DIR, filename);

    // Security check - ensure file is in downloads directory
    if (!filePath.startsWith(DOWNLOADS_DIR)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    if (!(await fs.pathExists(filePath))) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, filename);
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// DELETE /api/download/:filename - Delete a downloaded file
router.delete('/:filename', async (req, res) => {
  try {
    const { filename } = req.params;

    if (isB2Enabled()) {
      await deleteB2File(filename);
      return res.json({ success: true, message: 'File deleted successfully' });
    }

    const filePath = path.join(DOWNLOADS_DIR, filename);

    // Security check - ensure file is in downloads directory
    if (!filePath.startsWith(DOWNLOADS_DIR)) {
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
