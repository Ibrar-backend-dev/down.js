// Platform detection, format selection, and filename helpers for the strict
// progressive-MP4 direct-link resolver (GET /api/download/link).

const PLATFORM_DOMAINS = {
  tiktok: ['tiktok.com'],
  instagram: ['instagram.com'],
  facebook: ['facebook.com', 'fb.watch'],
  twitter: ['x.com', 'twitter.com'],
  linkedin: ['linkedin.com', 'lnkd.in']
};

const PLATFORM_REFERERS = {
  tiktok: 'https://www.tiktok.com/',
  instagram: 'https://www.instagram.com/',
  facebook: 'https://www.facebook.com/',
  twitter: 'https://twitter.com/',
  linkedin: 'https://www.linkedin.com/'
};

// TikTok's CDN edge rejects a resolved video URL unless the request carries
// the anonymous anti-bot session cookies yt-dlp received while solving
// TikTok's webpage challenge (ttwid/msToken/tt_csrf_token/_waftokenid, etc).
// These are NOT a signed-in user's personal cookies - any anonymous visit to
// tiktok.com gets them - so we capture them into a per-request cookie jar
// during extraction and hand the header back to the caller alongside the
// URL, instead of requiring anyone to supply their own cookies.
const PLATFORM_COOKIE_DOMAINS = {
  tiktok: { domain: 'tiktok.com', referer: PLATFORM_REFERERS.tiktok }
};

// A quality selector is 'best', 'worst', or a positive-integer height cap -
// optionally written with a trailing "p" (e.g. "720p") so the exact label
// GET /api/info shows for a chosen quality (see server/lib/qualities.js) can
// be passed straight through to this endpoint without the caller having to
// strip it themselves first. Returns the normalized selector ('best',
// 'worst', or a bare number string), or null if the input is not one of
// these forms.
function normalizeQualityParam(quality) {
  if (quality === 'best' || quality === 'worst') return quality;
  if (typeof quality !== 'string') return null;
  const match = /^(\d+)p?$/i.exec(quality);
  if (!match) return null;
  const height = Number(match[1]);
  return height > 0 ? String(height) : null;
}

function hostMatchesDomain(hostname, domain) {
  const host = hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

// Returns 'tiktok' | 'instagram' | 'facebook' | 'twitter' | null
function detectPlatform(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    if (domains.some((domain) => hostMatchesDomain(parsed.hostname, domain))) {
      return platform;
    }
  }

  return null;
}

// A single direct HTTP(S) MP4 container - never a manifest (HLS/DASH) or a
// fragmented/multi-part format. Says nothing about audio/video content.
function isMp4Container(format) {
  if (!format || typeof format !== 'object') return false;
  if (format.ext !== 'mp4') return false;
  if (typeof format.url !== 'string' || !/^https?:\/\//i.test(format.url)) return false;
  if (format.protocol && !/^https?$/i.test(format.protocol)) return false;
  if (Array.isArray(format.fragments) && format.fragments.length > 0) return false;
  return true;
}

// A "progressive" MP4 format carries both audio and video over a single
// direct HTTP(S) URL, and yt-dlp's metadata says so explicitly.
function isProgressiveMp4(format) {
  if (!isMp4Container(format)) return false;
  if (!format.vcodec || format.vcodec === 'none') return false;
  if (!format.acodec || format.acodec === 'none') return false;
  return true;
}

// Some platforms (Facebook hd/sd, Twitter http-*, Vimeo http-*) don't
// populate vcodec/acodec on their genuinely progressive formats, so a
// missing codec field can't be read as "video-only" or "audio-only" the way
// an explicit 'none' can - it has to be verified against the real file
// (see server/lib/ffprobe.js) before it's trusted either way.
function isAmbiguousProgressiveCandidate(format) {
  if (!isMp4Container(format)) return false;
  if (format.vcodec === 'none' || format.acodec === 'none') return false;
  const vcodecKnown = typeof format.vcodec === 'string' && format.vcodec.length > 0;
  const acodecKnown = typeof format.acodec === 'string' && format.acodec.length > 0;
  return !(vcodecKnown && acodecKnown);
}

// The dimension a quality selector is actually compared against: the short
// edge (min(width, height)) when a format reports both - the same
// orientation-agnostic basis GET /api/info uses (see getShortEdge in
// server/lib/qualities.js) - so requesting "720p" resolves to the real 720p
// stream whether the source video is landscape or portrait (portrait is the
// norm for TikTok/Instagram/Facebook reels). Falls back to the raw height
// when width isn't reported (e.g. Facebook hd/sd, Twitter http-* formats
// commonly omit it), preserving the old landscape-only behavior there.
function getQualityDimension(format) {
  const height = typeof format.height === 'number' ? format.height : null;
  const width = typeof format.width === 'number' ? format.width : null;
  if (height === null) return 0;
  return width !== null ? Math.min(width, height) : height;
}

// Orders a list of formats by preference for the requested quality, without
// filtering them - the caller decides which formats are eligible first.
// - 'best'/'worst' order by highest/lowest quality dimension first.
// - a numeric height tries the tallest candidate at or below that height
//   first, then the next-tallest at-or-below, ..., then falls back to
//   candidates above the target height (shortest-above first) - the
//   fallback never reaches outside the given candidate list.
function orderCandidatesByQuality(formats, quality) {
  if (!Array.isArray(formats)) return [];

  const withDimension = formats
    .map((format) => ({ format, dimension: getQualityDimension(format) }))
    .sort((a, b) => a.dimension - b.dimension);

  if (withDimension.length === 0) return [];

  if (quality === 'worst') {
    return withDimension.map((c) => c.format);
  }

  if (!quality || quality === 'best') {
    return [...withDimension].reverse().map((c) => c.format);
  }

  const targetDimension = Number(quality);
  const atOrBelow = withDimension.filter((c) => c.dimension <= targetDimension).reverse();
  const above = withDimension.filter((c) => c.dimension > targetDimension);
  return [...atOrBelow, ...above].map((c) => c.format);
}

// Picks the best progressive MP4 for the requested quality, considering only
// formats yt-dlp explicitly marked as having both audio and video. Formats
// that need ffprobe verification are handled separately by
// resolveDirectLinkFormat in server/lib/formatResolution.js.
function selectProgressiveMp4(formats, quality) {
  if (!Array.isArray(formats)) return null;
  const candidates = formats.filter(isProgressiveMp4);
  return orderCandidatesByQuality(candidates, quality)[0] || null;
}

function cookieDomainMatches(cookieDomain, domain) {
  const cd = cookieDomain.replace(/^\./, '').toLowerCase();
  const d = domain.toLowerCase();
  return cd === d || cd.endsWith(`.${d}`);
}

// Parses a Netscape-format cookie jar (as written by `yt-dlp --cookies`) and
// returns the name=value pairs whose domain matches (or is a parent of) the
// given domain, in file order.
function parseCookieJarForDomain(jarText, domain) {
  if (typeof jarText !== 'string' || !domain) return [];

  const cookies = [];
  for (const rawLine of jarText.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      if (!line.startsWith('#HttpOnly_')) continue;
      line = line.slice('#HttpOnly_'.length);
    }

    const fields = line.split('\t');
    if (fields.length < 7) continue;

    const [cookieDomain, , , , , name, value] = fields;
    if (!name || !cookieDomainMatches(cookieDomain, domain)) continue;

    cookies.push({ name, value });
  }

  return cookies;
}

function buildCookieHeader(cookies) {
  return cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
}

function safeFilename(title, fallback = 'video') {
  const base = (typeof title === 'string' && title.trim()) ? title : fallback;
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = (cleaned || fallback).slice(0, 150).trim() || fallback;
  return `${truncated}.mp4`;
}

module.exports = {
  normalizeQualityParam,
  PLATFORM_REFERERS,
  PLATFORM_COOKIE_DOMAINS,
  detectPlatform,
  isMp4Container,
  isProgressiveMp4,
  isAmbiguousProgressiveCandidate,
  orderCandidatesByQuality,
  selectProgressiveMp4,
  parseCookieJarForDomain,
  buildCookieHeader,
  safeFilename
};
