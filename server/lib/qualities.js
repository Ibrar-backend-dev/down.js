// Reduces yt-dlp's raw format list (which often has many duplicate/near-
// duplicate entries - separate audio/video tracks, several HLS+DASH+fallback
// variants of the same real quality, etc.) to one representative format per
// distinct QUALITY (the "<n>p" short-edge label - see formatQualityLabel),
// highest quality first. Deduping by the label itself, not by exact
// width x height, matters because the same real quality is often reported
// under slightly different dimensions across a site's own hls-*/dash-*/
// fallback formats (e.g. Reddit's 480p "fallback" vs "hls-451" formats) -
// deduping by exact dimensions would let both slip through as if they were
// different qualities. Audio-only or unknown-resolution formats are
// excluded, so every remaining entry is a real, distinct choice a caller
// could ask for. When a quality has multiple variants, a direct file beats an
// HLS/DASH manifest of the same stream (see isPreferredVariant), then the
// highest bitrate wins. Pure/sync - callers needing a real
// filesize fetch it separately (see server/lib/formatSize.js), since that
// requires a network request.
function extractQualities(formats) {
  if (!Array.isArray(formats)) return [];

  const bestByQuality = new Map();

  for (const format of formats) {
    if (!format || typeof format.width !== 'number' || typeof format.height !== 'number') {
      continue;
    }
    // Storyboard thumbnails (e.g. YouTube's sb* formats) have dimensions but no video.
    if (format.vcodec === 'none') continue;
    const shortEdge = getShortEdge(format.width, format.height);
    if (!shortEdge || shortEdge <= 0) continue;

    const existing = bestByQuality.get(shortEdge);
    if (!existing || isPreferredVariant(format, existing)) {
      bestByQuality.set(shortEdge, format);
    }
  }

  const qualities = Array.from(bestByQuality.values()).map((format) => ({
    format_id: format.format_id,
    ext: format.ext,
    width: format.width,
    height: format.height,
    label: getResolutionLabel(format.width, format.height),
    quality: formatQualityLabel(format),
    direct: isDirectFile(format),
    videoOnly: format.acodec === 'none',
    // yt-dlp's own reported real filesize (e.g. TikTok provides this
    // directly - no network call needed, and it must be tried first: a
    // live HEAD request to TikTok's CDN fails without its session cookies,
    // which would wrongly turn an already-known real size into null).
    // null here just means the caller should fall back to a live check
    // (see server/lib/formatSize.js) - it does NOT mean no size exists.
    filesize: formatFilesizeMb(format),
    url: format.url
  }));

  qualities.sort((a, b) => getShortEdge(b.width, b.height) - getShortEdge(a.width, a.height));
  return qualities;
}

// Drops qualities with no real size, but keeps the best one if none has a size so the list is never empty.
function keepSizedQualities(qualities) {
  const sized = qualities.filter((q) => typeof q.filesize === 'number');
  return sized.length > 0 ? sized : qualities.slice(0, 1);
}

// The audio track `bestaudio` would merge into a video-only download, picked by the same rule.
function extractBestAudio(formats) {
  if (!Array.isArray(formats)) return null;
  let best = null;
  for (const format of formats) {
    if (!format || format.vcodec !== 'none' || !format.acodec || format.acodec === 'none') continue;
    if (!best || isPreferredVariant(format, best)) best = format;
  }
  if (!best) return null;
  return {
    format_id: best.format_id,
    direct: isDirectFile(best),
    filesize: formatFilesizeMb(best),
    url: best.url
  };
}

// A single downloadable file, not an HLS/DASH manifest whose own bytes are just a playlist.
function isDirectFile(format) {
  if (Array.isArray(format.fragments) && format.fragments.length > 0) return false;
  if (format.protocol) return /^https?$/i.test(format.protocol);
  return typeof format.url === 'string' && !/\.(m3u8|mpd)(\?|$)/i.test(format.url);
}

// Direct files beat manifests (a live size check only works on them), then higher bitrate wins.
// Mirrors POST /api/download's `-S res,proto,tbr` sort so both endpoints pick the same file.
function isPreferredVariant(candidate, existing) {
  const candidateDirect = isDirectFile(candidate);
  const existingDirect = isDirectFile(existing);
  if (candidateDirect !== existingDirect) return candidateDirect;
  const bitrate = (format) => (typeof format.tbr === 'number' ? format.tbr : 0);
  return bitrate(candidate) > bitrate(existing);
}

// Only yt-dlp's exact `filesize` counts as real - `filesize_approx` is a
// calculated estimate (bitrate * duration), not a reported size, so it's
// deliberately not used as a fallback here. Returns megabytes rounded to
// 2 decimals, or null when no exact size was reported (common for
// HLS/DASH formats).
function formatFilesizeMb(format) {
  const bytes = format && typeof format.filesize === 'number' ? format.filesize : null;
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

// The conventional "720p"/"1080p" number is always the SHORT edge
// (min(width, height)), not literally the height field - that only holds
// for landscape video. A portrait clip (e.g. a vertical TikTok/Reel) is
// reported as 720x1280: width=720 is the short edge that actually defines
// "720p", height=1280 is just the longer dimension the frame happens to be
// stretched along. Reading .height directly would wrongly label a portrait
// 720p clip as "1280p".
function getShortEdge(width, height) {
  if (typeof width !== 'number' || typeof height !== 'number') return null;
  return Math.min(width, height);
}

// A human-readable "720p"-style label from the short edge. null (not a
// fabricated label) for formats with no real resolution, e.g. audio-only.
function formatQualityLabel(format) {
  const shortEdge = format && getShortEdge(format.width, format.height);
  if (!shortEdge || shortEdge <= 0) {
    return null;
  }
  return `${shortEdge}p`;
}

// Standard marketing-style tier names (HD, Full HD, 2K, 4K, 8K, SD),
// keyed by the same short edge. Anything below SD falls back to a raw
// "<n>p" label (e.g. "360p") since those don't have a common tier name.
// There's no tier above 8K - it's the practical ceiling.
const RESOLUTION_TIERS = [
  { minShortEdge: 4320, label: '8K' },
  { minShortEdge: 2160, label: '4K' },
  { minShortEdge: 1440, label: '2K' },
  { minShortEdge: 1080, label: 'Full HD' },
  { minShortEdge: 720, label: 'HD' },
  { minShortEdge: 480, label: 'SD' }
];

function getResolutionLabel(width, height) {
  const shortEdge = getShortEdge(width, height);
  if (!shortEdge || shortEdge <= 0) return null;

  for (const tier of RESOLUTION_TIERS) {
    if (shortEdge >= tier.minShortEdge) return tier.label;
  }
  return `${shortEdge}p`;
}

// A human-readable duration: plain seconds under a minute (e.g. "9
// seconds"), minutes (+ leftover seconds, if any) once it reaches a full
// minute (e.g. "1 minute 30 seconds", "2 minutes"). null for missing/
// invalid input rather than a fabricated "0 seconds".
function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const totalSeconds = Math.round(seconds);

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  const minutesPart = `${minutes} minute${minutes === 1 ? '' : 's'}`;

  if (remainingSeconds === 0) {
    return minutesPart;
  }
  return `${minutesPart} ${remainingSeconds} second${remainingSeconds === 1 ? '' : 's'}`;
}

module.exports = {
  extractQualities,
  keepSizedQualities,
  extractBestAudio,
  isDirectFile,
  formatFilesizeMb,
  formatQualityLabel,
  getResolutionLabel,
  formatDuration
};
