const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDirectLinkFormat } = require('../server/lib/formatResolution');

function mp4(overrides = {}) {
  return {
    ext: 'mp4',
    protocol: 'https',
    url: 'https://cdn.example.com/video.mp4',
    ...overrides
  };
}

test('resolveDirectLinkFormat accepts a definite progressive format without probing', async () => {
  const format = mp4({ vcodec: 'h264', acodec: 'aac', height: 720 });
  let probeCalled = false;
  const result = await resolveDirectLinkFormat([format], 'best', {
    probe: async () => { probeCalled = true; return true; }
  });
  assert.equal(result, format);
  assert.equal(probeCalled, false);
});

test('resolveDirectLinkFormat probes an ambiguous format and accepts it when confirmed (Facebook hd/sd style)', async () => {
  const format = mp4({ height: 720, url: 'https://cdn.example.com/hd.mp4' });
  const result = await resolveDirectLinkFormat([format], 'best', {
    probe: async (url) => url === 'https://cdn.example.com/hd.mp4'
  });
  assert.equal(result, format);
});

test('resolveDirectLinkFormat rejects an ambiguous format the probe finds is video-only (Instagram reel style)', async () => {
  const format = mp4({ height: 720 });
  const result = await resolveDirectLinkFormat([format], 'best', {
    probe: async () => false
  });
  assert.equal(result, null);
});

test('resolveDirectLinkFormat falls through to the next candidate when the first probe fails', async () => {
  const rejected = mp4({ height: 1080, url: 'https://cdn.example.com/video-only.mp4' });
  const accepted = mp4({ height: 720, url: 'https://cdn.example.com/progressive.mp4' });
  const probedUrls = [];

  const result = await resolveDirectLinkFormat([rejected, accepted], 'best', {
    probe: async (url) => {
      probedUrls.push(url);
      return url === accepted.url;
    }
  });

  assert.equal(result, accepted);
  assert.deepEqual(probedUrls, [rejected.url, accepted.url]);
});

test('resolveDirectLinkFormat prefers a definite match over a higher-preference ambiguous one only by try-order', async () => {
  // Both candidates are eligible for 'best'; the taller one (ambiguous) is tried first.
  const ambiguous = mp4({ height: 1080, url: 'https://cdn.example.com/ambiguous.mp4' });
  const definite = mp4({ height: 720, vcodec: 'h264', acodec: 'aac', url: 'https://cdn.example.com/definite.mp4' });

  const result = await resolveDirectLinkFormat([ambiguous, definite], 'best', {
    probe: async () => false
  });

  assert.equal(result, definite);
});

test('resolveDirectLinkFormat stops probing after maxProbes ambiguous candidates', async () => {
  const formats = [
    mp4({ height: 1080, url: 'https://cdn.example.com/a.mp4' }),
    mp4({ height: 900, url: 'https://cdn.example.com/b.mp4' }),
    mp4({ height: 720, url: 'https://cdn.example.com/c.mp4' })
  ];
  const probedUrls = [];

  const result = await resolveDirectLinkFormat(formats, 'best', {
    maxProbes: 1,
    probe: async (url) => {
      probedUrls.push(url);
      return false;
    }
  });

  assert.equal(result, null);
  assert.deepEqual(probedUrls, ['https://cdn.example.com/a.mp4']);
});

test('resolveDirectLinkFormat returns null for an empty or invalid format list', async () => {
  assert.equal(await resolveDirectLinkFormat([], 'best'), null);
  assert.equal(await resolveDirectLinkFormat(null, 'best'), null);
});

test('resolveDirectLinkFormat passes userAgent/referer through to the probe', async () => {
  const format = mp4({ height: 720 });
  let seenOptions = null;
  await resolveDirectLinkFormat([format], 'best', {
    userAgent: 'test-agent',
    referer: 'https://example.com/',
    probe: async (_url, options) => {
      seenOptions = options;
      return true;
    }
  });
  assert.deepEqual(seenOptions, { userAgent: 'test-agent', referer: 'https://example.com/' });
});
