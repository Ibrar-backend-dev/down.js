const test = require('node:test');
const assert = require('node:assert/strict');

const { extractQualities, formatFilesizeMb, formatQualityLabel, getResolutionLabel, formatDuration } = require('../server/lib/qualities');

test('extractQualities deduplicates by resolution, keeping the highest-bitrate variant', () => {
  const formats = [
    { format_id: 'hls-1', ext: 'mp4', width: 1280, height: 720, tbr: 900, url: 'https://cdn.example.com/hls-1.mp4' },
    { format_id: 'dash-1', ext: 'mp4', width: 1280, height: 720, tbr: 1800, url: 'https://cdn.example.com/dash-1.mp4' },
    { format_id: 'hls-2', ext: 'mp4', width: 854, height: 480, tbr: 500, url: 'https://cdn.example.com/hls-2.mp4' }
  ];
  assert.deepEqual(extractQualities(formats), [
    { format_id: 'dash-1', ext: 'mp4', width: 1280, height: 720, label: 'HD', quality: '720p', filesize: null, url: 'https://cdn.example.com/dash-1.mp4' },
    { format_id: 'hls-2', ext: 'mp4', width: 854, height: 480, label: 'SD', quality: '480p', filesize: null, url: 'https://cdn.example.com/hls-2.mp4' }
  ]);
});

test('extractQualities dedupes by the quality label (short edge), not exact width x height, keeping the highest-bitrate variant', () => {
  // Real Reddit data: a "fallback" and an "hls-*" format both report short
  // edge 480 (same real quality) but under different width x height - a
  // dedup keyed on exact dimensions would wrongly let both through as if
  // they were distinct qualities.
  const formats = [
    { format_id: 'fallback', ext: 'mp4', width: 854, height: 480, tbr: 600, filesize: 2_684_355, url: 'https://cdn.example.com/fallback-480.mp4' },
    { format_id: 'hls-451', ext: 'mp4', width: 640, height: 480, url: 'https://cdn.example.com/hls-451.m3u8' }
  ];
  const qualities = extractQualities(formats);
  assert.equal(qualities.length, 1);
  assert.equal(qualities[0].format_id, 'fallback');
  assert.equal(qualities[0].quality, '480p');
});

test('extractQualities carries through yt-dlp\'s own real filesize when the platform reports one (e.g. TikTok)', () => {
  const formats = [
    { format_id: 'bytevc1_720p', ext: 'mp4', width: 720, height: 1280, filesize: 377066, url: 'https://cdn.example.com/720.mp4' }
  ];
  assert.equal(extractQualities(formats)[0].filesize, 0.36);
});

test('extractQualities sorts highest resolution first', () => {
  const formats = [
    { format_id: 'a', ext: 'mp4', width: 640, height: 360 },
    { format_id: 'b', ext: 'mp4', width: 1920, height: 1080 },
    { format_id: 'c', ext: 'mp4', width: 1280, height: 720 }
  ];
  assert.deepEqual(extractQualities(formats).map((q) => q.format_id), ['b', 'c', 'a']);
});

test('extractQualities excludes audio-only and unknown-resolution formats', () => {
  const formats = [
    { format_id: 'audio', vcodec: 'none', acodec: 'mp3', width: null, height: null },
    { format_id: 'unknown', width: undefined, height: undefined },
    { format_id: 'video', ext: 'mp4', width: 1280, height: 720 }
  ];
  assert.deepEqual(extractQualities(formats).map((q) => q.format_id), ['video']);
});

test('extractQualities guarantees at least one entry when any format has valid dimensions', () => {
  const formats = [{ format_id: 'only', ext: 'mp4', width: 640, height: 480 }];
  const qualities = extractQualities(formats);
  assert.equal(qualities.length, 1);
  assert.equal(qualities[0].label, 'SD');
  assert.equal(qualities[0].quality, '480p');
});

test('extractQualities returns an empty array for missing/invalid/all-audio input', () => {
  assert.deepEqual(extractQualities([]), []);
  assert.deepEqual(extractQualities(null), []);
  assert.deepEqual(extractQualities(undefined), []);
  assert.deepEqual(extractQualities([{ vcodec: 'none', width: null, height: null }]), []);
});

test('formatFilesizeMb converts exact filesize bytes to MB, rounded to 2 decimals', () => {
  assert.equal(formatFilesizeMb({ filesize: 12_582_912 }), 12);
  assert.equal(formatFilesizeMb({ filesize: 1_048_576 + 512_000 }), 1.49);
});

test('formatFilesizeMb ignores filesize_approx - it is a calculated estimate, not a real size', () => {
  assert.equal(formatFilesizeMb({ filesize: null, filesize_approx: 5_242_880 }), null);
  assert.equal(formatFilesizeMb({ filesize_approx: 2_097_152 }), null);
  assert.equal(formatFilesizeMb({ filesize: 1_048_576, filesize_approx: 9_999_999 }), 1);
});

test('formatFilesizeMb returns null when no exact size was reported or it is unusable', () => {
  assert.equal(formatFilesizeMb({}), null);
  assert.equal(formatFilesizeMb({ filesize: null, filesize_approx: null }), null);
  assert.equal(formatFilesizeMb({ filesize: 0 }), null);
  assert.equal(formatFilesizeMb({ filesize: -5 }), null);
  assert.equal(formatFilesizeMb(null), null);
});

test('formatQualityLabel builds a "720p"-style label from the short edge (landscape: height)', () => {
  assert.equal(formatQualityLabel({ width: 1280, height: 720 }), '720p');
  assert.equal(formatQualityLabel({ width: 1920, height: 1080 }), '1080p');
});

test('formatQualityLabel uses the short edge, not literal height, for portrait/vertical video', () => {
  // A real portrait 720p clip (e.g. a vertical TikTok/Reel) is reported as
  // 720x1280 - width is the short edge that actually defines "720p";
  // reading height directly would wrongly say "1280p".
  assert.equal(formatQualityLabel({ width: 720, height: 1280 }), '720p');
  assert.equal(formatQualityLabel({ width: 1080, height: 1920 }), '1080p');
});

test('formatQualityLabel returns null (not a fabricated label) when there is no real resolution', () => {
  assert.equal(formatQualityLabel({ width: 1280, height: null }), null);
  assert.equal(formatQualityLabel({ width: 1280, height: 0 }), null);
  assert.equal(formatQualityLabel({}), null);
  assert.equal(formatQualityLabel(null), null);
});

test('getResolutionLabel maps the short edge to standard marketing tiers, regardless of orientation', () => {
  // Landscape
  assert.equal(getResolutionLabel(7680, 4320), '8K');
  assert.equal(getResolutionLabel(3840, 2160), '4K');
  assert.equal(getResolutionLabel(2560, 1440), '2K');
  assert.equal(getResolutionLabel(1920, 1080), 'Full HD');
  assert.equal(getResolutionLabel(1280, 720), 'HD');
  assert.equal(getResolutionLabel(854, 480), 'SD');
  // Portrait/vertical - same tiers, axes swapped (the exact case from the
  // real Instagram qualities that prompted this: 1440x2560, 1080x1920,
  // 720x1280)
  assert.equal(getResolutionLabel(1440, 2560), '2K');
  assert.equal(getResolutionLabel(1080, 1920), 'Full HD');
  assert.equal(getResolutionLabel(720, 1280), 'HD');
});

test('getResolutionLabel falls back to a raw "<n>p" label below SD, and there is no tier above 8K', () => {
  assert.equal(getResolutionLabel(640, 360), '360p');
  assert.equal(getResolutionLabel(426, 240), '240p');
  // Well above 8K still just reports "8K" - it's the practical ceiling.
  assert.equal(getResolutionLabel(15360, 8640), '8K');
});

test('getResolutionLabel returns null for missing/invalid dimensions', () => {
  assert.equal(getResolutionLabel(null, 720), null);
  assert.equal(getResolutionLabel(1280, null), null);
  assert.equal(getResolutionLabel(0, 0), null);
});

test('formatDuration shows plain seconds under a minute', () => {
  assert.equal(formatDuration(9), '9 seconds');
  assert.equal(formatDuration(1), '1 second');
  assert.equal(formatDuration(0), '0 seconds');
  assert.equal(formatDuration(59), '59 seconds');
});

test('formatDuration shows minutes (+ leftover seconds) once it reaches a full minute', () => {
  assert.equal(formatDuration(60), '1 minute');
  assert.equal(formatDuration(90), '1 minute 30 seconds');
  assert.equal(formatDuration(125), '2 minutes 5 seconds');
  assert.equal(formatDuration(120), '2 minutes');
});

test('formatDuration rounds fractional seconds', () => {
  assert.equal(formatDuration(9.6), '10 seconds');
});

test('formatDuration returns null for missing/invalid input', () => {
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(undefined), null);
  assert.equal(formatDuration(-5), null);
  assert.equal(formatDuration('9'), null);
});
