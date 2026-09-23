const {
  isProgressiveMp4,
  isAmbiguousProgressiveCandidate,
  orderCandidatesByQuality
} = require('./directLink');
const { probeHasVideoAndAudio } = require('./ffprobe');

const DEFAULT_MAX_PROBES = 6;

// Resolves the best progressive MP4 for the requested quality, trying
// candidates in preference order. Formats yt-dlp already marked as
// progressive are accepted immediately (no network cost). Formats with
// missing codec metadata are verified with a live ffprobe check before
// being trusted - see server/lib/ffprobe.js for why that's necessary. Stops
// after `maxProbes` ambiguous candidates so an unlucky format list can't
// stall the response.
async function resolveDirectLinkFormat(formats, quality, options = {}) {
  const {
    probe = probeHasVideoAndAudio,
    userAgent,
    referer,
    maxProbes = DEFAULT_MAX_PROBES,
    onAttempt
  } = options;

  if (!Array.isArray(formats)) return null;

  const candidates = formats.filter(
    (format) => isProgressiveMp4(format) || isAmbiguousProgressiveCandidate(format)
  );
  const ordered = orderCandidatesByQuality(candidates, quality);

  let probesUsed = 0;

  for (const format of ordered) {
    if (isProgressiveMp4(format)) {
      if (onAttempt) onAttempt(format, 'definite');
      return format;
    }

    if (probesUsed >= maxProbes) {
      if (onAttempt) onAttempt(format, 'skipped_probe_limit');
      continue;
    }

    probesUsed += 1;
    const confirmed = await probe(format.url, { userAgent, referer });
    if (onAttempt) onAttempt(format, confirmed ? 'confirmed' : 'rejected');
    if (confirmed) return format;
  }

  return null;
}

module.exports = { resolveDirectLinkFormat, DEFAULT_MAX_PROBES };
