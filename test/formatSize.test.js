const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchRealFilesizeMb } = require('../server/lib/formatSize');

function fakeFetch({ ok = true, contentLength, throws = null } = {}) {
  return async (url, options) => {
    if (throws) throw throws;
    return {
      ok,
      headers: { get: (name) => (name === 'content-length' ? contentLength : null) }
    };
  };
}

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
