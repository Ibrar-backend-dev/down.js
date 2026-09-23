const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ALLOWED_QUALITIES,
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
} = require('../server/lib/directLink');

test('detectPlatform recognizes supported hosts', () => {
  assert.equal(detectPlatform('https://www.tiktok.com/@user/video/123'), 'tiktok');
  assert.equal(detectPlatform('https://vm.tiktok.com/ZMabc123/'), 'tiktok');
  assert.equal(detectPlatform('https://vt.tiktok.com/ZMabc456/'), 'tiktok');

  assert.equal(detectPlatform('https://www.instagram.com/reel/abc123/'), 'instagram');
  assert.equal(detectPlatform('https://instagram.com/p/abc123/'), 'instagram');
  assert.equal(detectPlatform('https://m.instagram.com/tv/abc123/'), 'instagram');

  assert.equal(detectPlatform('https://www.facebook.com/watch/?v=123'), 'facebook');
  assert.equal(detectPlatform('https://m.facebook.com/reel/123'), 'facebook');
  assert.equal(detectPlatform('https://fb.watch/abc123/'), 'facebook');

  assert.equal(detectPlatform('https://x.com/user/status/123'), 'twitter');
  assert.equal(detectPlatform('https://twitter.com/user/status/123'), 'twitter');
  assert.equal(detectPlatform('https://mobile.twitter.com/user/status/123'), 'twitter');
  assert.equal(detectPlatform('https://mobile.x.com/user/status/123'), 'twitter');

  assert.equal(detectPlatform('https://www.linkedin.com/posts/user_activity-123'), 'linkedin');
  assert.equal(detectPlatform('https://linkedin.com/feed/update/urn:li:activity:123/'), 'linkedin');
  assert.equal(detectPlatform('https://lnkd.in/p/du7N_dnz'), 'linkedin');
});

test('detectPlatform rejects unknown hosts and invalid URLs', () => {
  assert.equal(detectPlatform('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(detectPlatform('https://vimeo.com/12345'), null);
  assert.equal(detectPlatform('https://nottiktok.com/@user/video/123'), null);
  assert.equal(detectPlatform('not-a-url'), null);
  assert.equal(detectPlatform('ftp://tiktok.com/video/123'), null);
});

function mp4Format(overrides = {}) {
  return {
    ext: 'mp4',
    vcodec: 'h264',
    acodec: 'aac',
    protocol: 'https',
    url: 'https://cdn.example.com/video.mp4',
    width: 720,
    height: 1280,
    ...overrides
  };
}

test('isProgressiveMp4 accepts a direct https mp4 with both audio and video', () => {
  assert.equal(isProgressiveMp4(mp4Format()), true);
});

test('isProgressiveMp4 rejects video-only mp4', () => {
  assert.equal(isProgressiveMp4(mp4Format({ acodec: 'none' })), false);
});

test('isProgressiveMp4 rejects audio-only mp4', () => {
  assert.equal(isProgressiveMp4(mp4Format({ vcodec: 'none' })), false);
});

test('isProgressiveMp4 rejects HLS/DASH manifests', () => {
  assert.equal(isProgressiveMp4(mp4Format({ protocol: 'm3u8_native', url: 'https://cdn.example.com/master.m3u8' })), false);
  assert.equal(isProgressiveMp4(mp4Format({ protocol: 'http_dash_segments' })), false);
});

test('isProgressiveMp4 rejects non-mp4 media', () => {
  assert.equal(isProgressiveMp4(mp4Format({ ext: 'webm' })), false);
});

test('isProgressiveMp4 rejects fragmented/multi-part formats', () => {
  assert.equal(isProgressiveMp4(mp4Format({ fragments: [{ url: 'https://cdn.example.com/seg1.mp4' }] })), false);
});

test('isProgressiveMp4 rejects formats without a direct http(s) url', () => {
  assert.equal(isProgressiveMp4(mp4Format({ url: null })), false);
  assert.equal(isProgressiveMp4(mp4Format({ url: 'rtmp://cdn.example.com/video' })), false);
});

test('isMp4Container accepts any direct https mp4 regardless of codec info', () => {
  assert.equal(isMp4Container(mp4Format({ vcodec: undefined, acodec: undefined })), true);
  assert.equal(isMp4Container(mp4Format({ ext: 'webm' })), false);
  assert.equal(isMp4Container(mp4Format({ protocol: 'm3u8_native' })), false);
  assert.equal(isMp4Container(mp4Format({ fragments: [{ url: 'x' }] })), false);
});

test('isAmbiguousProgressiveCandidate accepts formats with missing codec fields (Facebook hd/sd, Twitter http-*, Vimeo http-*)', () => {
  const format = mp4Format({ vcodec: undefined, acodec: undefined });
  assert.equal(isAmbiguousProgressiveCandidate(format), true);
  assert.equal(isProgressiveMp4(format), false);
});

test('isAmbiguousProgressiveCandidate rejects formats explicitly declared video-only or audio-only', () => {
  assert.equal(isAmbiguousProgressiveCandidate(mp4Format({ vcodec: undefined, acodec: 'none' })), false);
  assert.equal(isAmbiguousProgressiveCandidate(mp4Format({ vcodec: 'none', acodec: undefined })), false);
});

test('isAmbiguousProgressiveCandidate rejects formats yt-dlp already confirmed progressive', () => {
  assert.equal(isAmbiguousProgressiveCandidate(mp4Format()), false);
});

test('isAmbiguousProgressiveCandidate rejects non-mp4-container formats', () => {
  assert.equal(isAmbiguousProgressiveCandidate(mp4Format({ ext: 'webm', vcodec: undefined, acodec: undefined })), false);
  assert.equal(isAmbiguousProgressiveCandidate(mp4Format({ protocol: 'm3u8_native', vcodec: undefined, acodec: undefined })), false);
});

test('orderCandidatesByQuality orders best-first, worst-first, and at-or-below-then-fallback', () => {
  const f360 = mp4Format({ height: 360, url: 'https://cdn.example.com/360.mp4' });
  const f480 = mp4Format({ height: 480, url: 'https://cdn.example.com/480.mp4' });
  const f1080 = mp4Format({ height: 1080, url: 'https://cdn.example.com/1080.mp4' });
  const formats = [f360, f480, f1080];

  assert.deepEqual(orderCandidatesByQuality(formats, 'best').map((f) => f.height), [1080, 480, 360]);
  assert.deepEqual(orderCandidatesByQuality(formats, 'worst').map((f) => f.height), [360, 480, 1080]);
  assert.deepEqual(orderCandidatesByQuality(formats, '720').map((f) => f.height), [480, 360, 1080]);
  assert.deepEqual(orderCandidatesByQuality(formats, '200').map((f) => f.height), [360, 480, 1080]);
  assert.deepEqual(orderCandidatesByQuality([], 'best'), []);
});

test('PLATFORM_REFERERS declares a referer for every supported platform', () => {
  assert.deepEqual(Object.keys(PLATFORM_REFERERS).sort(), ['facebook', 'instagram', 'linkedin', 'tiktok', 'twitter']);
});

test('selectProgressiveMp4 picks the tallest candidate for "best"', () => {
  const formats = [
    mp4Format({ height: 360, url: 'https://cdn.example.com/360.mp4' }),
    mp4Format({ height: 720, url: 'https://cdn.example.com/720.mp4' }),
    mp4Format({ height: 1080, url: 'https://cdn.example.com/1080.mp4' })
  ];
  assert.equal(selectProgressiveMp4(formats, 'best').url, 'https://cdn.example.com/1080.mp4');
});

test('selectProgressiveMp4 picks the shortest candidate for "worst"', () => {
  const formats = [
    mp4Format({ height: 360, url: 'https://cdn.example.com/360.mp4' }),
    mp4Format({ height: 1080, url: 'https://cdn.example.com/1080.mp4' })
  ];
  assert.equal(selectProgressiveMp4(formats, 'worst').url, 'https://cdn.example.com/360.mp4');
});

test('selectProgressiveMp4 picks the best match at or below the requested height', () => {
  const formats = [
    mp4Format({ height: 360, url: 'https://cdn.example.com/360.mp4' }),
    mp4Format({ height: 480, url: 'https://cdn.example.com/480.mp4' }),
    mp4Format({ height: 1080, url: 'https://cdn.example.com/1080.mp4' })
  ];
  assert.equal(selectProgressiveMp4(formats, '720').url, 'https://cdn.example.com/480.mp4');
});

test('selectProgressiveMp4 falls back within progressive candidates when none qualify at/below height', () => {
  const formats = [
    mp4Format({ height: 720, url: 'https://cdn.example.com/720.mp4' }),
    mp4Format({ height: 1080, url: 'https://cdn.example.com/1080.mp4' })
  ];
  assert.equal(selectProgressiveMp4(formats, '360').url, 'https://cdn.example.com/720.mp4');
});

test('selectProgressiveMp4 ignores non-progressive formats when choosing', () => {
  const formats = [
    mp4Format({ height: 1080, protocol: 'm3u8_native', url: 'https://cdn.example.com/master.m3u8' }),
    mp4Format({ height: 480, acodec: 'none', url: 'https://cdn.example.com/video-only.mp4' }),
    mp4Format({ height: 480, url: 'https://cdn.example.com/480.mp4' })
  ];
  assert.equal(selectProgressiveMp4(formats, 'best').url, 'https://cdn.example.com/480.mp4');
});

test('selectProgressiveMp4 returns null when there are no progressive mp4 candidates', () => {
  const formats = [
    mp4Format({ protocol: 'm3u8_native', url: 'https://cdn.example.com/master.m3u8' }),
    mp4Format({ ext: 'webm' })
  ];
  assert.equal(selectProgressiveMp4(formats, 'best'), null);
  assert.equal(selectProgressiveMp4([], 'best'), null);
  assert.equal(selectProgressiveMp4(null, 'best'), null);
});

test('platform profiles each resolve a valid progressive mp4', () => {
  const platformUrls = {
    tiktok: 'https://www.tiktok.com/@user/video/123',
    instagram: 'https://www.instagram.com/reel/abc123/',
    facebook: 'https://www.facebook.com/watch/?v=123',
    twitter: 'https://x.com/user/status/123',
    linkedin: 'https://www.linkedin.com/posts/user_activity-123'
  };

  for (const [platform, url] of Object.entries(platformUrls)) {
    assert.equal(detectPlatform(url), platform);
    const formats = [mp4Format({ height: 720, url: `https://cdn.example.com/${platform}.mp4` })];
    const selected = selectProgressiveMp4(formats, 'best');
    assert.equal(selected.url, `https://cdn.example.com/${platform}.mp4`);
  }
});

test('ALLOWED_QUALITIES matches the documented values', () => {
  assert.deepEqual(
    [...ALLOWED_QUALITIES].sort(),
    ['1080', '1440', '2160', '360', '480', '720', 'best', 'worst'].sort()
  );
});

test('safeFilename strips unsafe characters and appends .mp4', () => {
  assert.equal(safeFilename('My: Cool/Video*Name?'), 'My Cool Video Name.mp4');
});

test('safeFilename falls back when the title is empty or missing', () => {
  assert.equal(safeFilename(''), 'video.mp4');
  assert.equal(safeFilename(undefined), 'video.mp4');
  assert.equal(safeFilename('   '), 'video.mp4');
});

test('safeFilename truncates very long titles', () => {
  const longTitle = 'a'.repeat(300);
  const result = safeFilename(longTitle);
  assert.ok(result.length <= 154);
  assert.ok(result.endsWith('.mp4'));
});

const NETSCAPE_JAR = [
  '# Netscape HTTP Cookie File',
  '.tiktok.com\tTRUE\t/\tTRUE\t1821253916\tttwid\tabc123',
  'www.tiktok.com\tFALSE\t/\tTRUE\t1791013916\tmsToken\txyz789',
  '#HttpOnly_.tiktok.com\tTRUE\t/\tTRUE\t0\ttt_csrf_token\tsecret',
  '.instagram.com\tTRUE\t/\tTRUE\t1821253916\tsessionid\tignored',
  ''
].join('\n');

test('parseCookieJarForDomain returns only cookies for the domain and its subdomains', () => {
  const cookies = parseCookieJarForDomain(NETSCAPE_JAR, 'tiktok.com');
  assert.deepEqual(cookies, [
    { name: 'ttwid', value: 'abc123' },
    { name: 'msToken', value: 'xyz789' },
    { name: 'tt_csrf_token', value: 'secret' }
  ]);
});

test('parseCookieJarForDomain ignores comments and cookies for other domains', () => {
  assert.deepEqual(parseCookieJarForDomain(NETSCAPE_JAR, 'instagram.com'), [
    { name: 'sessionid', value: 'ignored' }
  ]);
});

test('parseCookieJarForDomain handles missing or malformed input', () => {
  assert.deepEqual(parseCookieJarForDomain('', 'tiktok.com'), []);
  assert.deepEqual(parseCookieJarForDomain(null, 'tiktok.com'), []);
  assert.deepEqual(parseCookieJarForDomain('not\ta\tvalid\tline', 'tiktok.com'), []);
});

test('buildCookieHeader joins cookies as a single Cookie header value', () => {
  const cookies = parseCookieJarForDomain(NETSCAPE_JAR, 'tiktok.com');
  assert.equal(buildCookieHeader(cookies), 'ttwid=abc123; msToken=xyz789; tt_csrf_token=secret');
  assert.equal(buildCookieHeader([]), '');
});

test('PLATFORM_COOKIE_DOMAINS only declares the known TikTok CDN quirk', () => {
  assert.deepEqual(Object.keys(PLATFORM_COOKIE_DOMAINS), ['tiktok']);
  assert.equal(PLATFORM_COOKIE_DOMAINS.tiktok.domain, 'tiktok.com');
  assert.equal(PLATFORM_COOKIE_DOMAINS.tiktok.referer, 'https://www.tiktok.com/');
});
