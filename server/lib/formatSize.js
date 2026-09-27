// Some platforms (confirmed: Instagram DASH video formats) report neither
// filesize nor filesize_approx in yt-dlp's metadata - there is genuinely no
// size figure in the data yt-dlp extracts. The CDN itself still reports the
// real byte count via a standard HTTP Content-Length header on the actual
// media URL, though - a HEAD request (no bytes downloaded) gets that real,
// platform-reported size instead of a calculated/estimated one.
async function fetchRealFilesizeMb(url, options = {}) {
  const { fetchFn = fetch, timeoutMs = 5000, headers } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(url, { method: 'HEAD', signal: controller.signal, headers });
    if (!res.ok) return null;
    // A playlist's Content-Length is its own few hundred bytes, which would round to 0 MB.
    if (/mpegurl|dash\+xml/i.test(res.headers.get('content-type') || '')) return null;

    const contentLength = res.headers.get('content-length');
    if (!contentLength) return null;

    const bytes = Number(contentLength);
    if (!Number.isFinite(bytes) || bytes <= 0) return null;

    return Math.round((bytes / (1024 * 1024)) * 100) / 100;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Live size for direct files, else the platform's own reported size. `format`
// is a qualities.js candidate ({ direct, url, filesize-in-MB }).
async function resolveRealSizeMb(format, options) {
  const live = format.direct && format.url ? await fetchRealFilesizeMb(format.url, options) : null;
  return live ?? format.filesize ?? null;
}

module.exports = { fetchRealFilesizeMb, resolveRealSizeMb };
