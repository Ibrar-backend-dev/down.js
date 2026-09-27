const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchRealFilesizeMb, resolveRealSizeMb } = require('../server/lib/formatSize');

function fakeFetch({ ok = true, contentLength, contentType = 'video/mp4', throws = null } = {}) {
  return async (url, options) => {
    if (throws) throw throws;
    const headers = { 'content-length': contentLength, 'content-type': contentType };
    return { ok, headers: { get: (name) => headers[name] ?? null } };
  };
}

test('fetchRealFilesizeMb returns null for an HLS/DASH playlist instead of its own tiny size', async () => {
  // Real Reddit data: a 270p .m3u8 answers HEAD with Content-Length 171, which rounded to 0 MB.
  const hls = fakeFetch({ contentLength: '171', contentType: 'application/x-mpegurl' });
  assert.equal(await fetchRealFilesizeMb('https://v.redd.it/x/CMAF_270.m3u8', { fetchFn: hls }), null);
  const dash = fakeFetch({ contentLength: '2048', contentType: 'application/dash+xml' });
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/manifest.mpd', { fetchFn: dash }), null);
});

test('resolveRealSizeMb measures direct files live and falls back to the platform-reported size', async () => {
  const live = fakeFetch({ contentLength: '336263' });
  assert.equal(await resolveRealSizeMb({ direct: true, url: 'https://v.redd.it/x/CMAF_270.mp4', filesize: 9 }, { fetchFn: live }), 0.32);

  const failing = fakeFetch({ ok: false });
  assert.equal(await resolveRealSizeMb({ direct: true, url: 'https://cdn.example.com/a.mp4', filesize: 1.91 }, { fetchFn: failing }), 1.91);
  assert.equal(await resolveRealSizeMb({ direct: true, url: 'https://cdn.example.com/a.mp4', filesize: null }, { fetchFn: failing }), null);
});

test('resolveRealSizeMb never live-checks a manifest', async () => {
  let called = false;
  const fetchFn = async () => { called = true; return { ok: true, headers: { get: () => '171' } }; };
  assert.equal(await resolveRealSizeMb({ direct: false, url: 'https://cdn.example.com/a.m3u8', filesize: null }, { fetchFn }), null);
  assert.equal(called, false);
});

test('fetchRealFilesizeMb converts a real Content-Length header to MB, rounded to 2 decimals', async () => {
  const fetchFn = fakeFetch({ contentLength: '1845676' });
  const mb = await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn });
  assert.equal(mb, 1.76);
});

test('fetchRealFilesizeMb sends a HEAD request', async () => {
  let seenMethod = null;
  const fetchFn = async (url, options) => {
    seenMethod = options.method;
    return { ok: true, headers: { get: () => '1048576' } };
  };
  await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn });
  assert.equal(seenMethod, 'HEAD');
});

test('fetchRealFilesizeMb returns null when there is no Content-Length header', async () => {
  const fetchFn = fakeFetch({ contentLength: null });
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn }), null);
});

test('fetchRealFilesizeMb returns null when the response is not ok', async () => {
  const fetchFn = fakeFetch({ ok: false, contentLength: '1048576' });
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn }), null);
});

test('fetchRealFilesizeMb returns null on a network error instead of throwing', async () => {
  const fetchFn = fakeFetch({ throws: new Error('network down') });
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn }), null);
});

test('fetchRealFilesizeMb returns null for a malformed/zero/negative Content-Length', async () => {
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/a.mp4', { fetchFn: fakeFetch({ contentLength: 'not-a-number' }) }), null);
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/a.mp4', { fetchFn: fakeFetch({ contentLength: '0' }) }), null);
  assert.equal(await fetchRealFilesizeMb('https://cdn.example.com/a.mp4', { fetchFn: fakeFetch({ contentLength: '-5' }) }), null);
});

test('fetchRealFilesizeMb times out and resolves null instead of hanging when fetch never responds', async () => {
  // Mirrors real fetch()'s behavior of rejecting once its AbortSignal fires,
  // so this actually exercises the timeout path instead of hanging forever.
  const fetchFn = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const start = Date.now();
  const result = await fetchRealFilesizeMb('https://cdn.example.com/video.mp4', { fetchFn, timeoutMs: 50 });
  assert.equal(result, null);
  assert.ok(Date.now() - start < 2000, 'should not hang waiting for a response that never comes');
});
