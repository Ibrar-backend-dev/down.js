const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// download.js reads these at require time, so they must be set before the
// router module is first required. Delays are kept tiny so tests don't have
// to wait out the real (45s cleanup / 5s retry / 120s max-wait) defaults.
// DOWNLOADS_DIR points at an isolated temp directory instead of the real
// project downloads/ folder.
process.env.AUTO_CLEANUP_DELAY_MS = '20';
process.env.PROCESSING_RETRY_DELAY_MS = '20';
process.env.PROCESSING_MAX_WAIT_MS = '200';
const TEST_DOWNLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'download-route-test-'));
process.env.DOWNLOADS_DIR = TEST_DOWNLOADS_DIR;

// download.js resolves `spawn` from child_process at require time, so the
// mock must replace it before the router module is first required.
const childProcess = require('child_process');
let mockImpl = null;
childProcess.spawn = (...args) => {
  if (!mockImpl) {
    throw new Error('No yt-dlp mock configured for this test');
  }
  return mockImpl(...args);
};

// Same idea for the storage module: download.js destructures these at
// require time, so the mock must replace the module's exports before that
// happens. storageMock is null by default (real B2-disabled behavior).
const storage = require('../server/lib/storage');
let storageMock = null;
const realIsB2Enabled = storage.isB2Enabled;
storage.isB2Enabled = (...args) => (storageMock ? storageMock.isB2Enabled() : realIsB2Enabled(...args));
storage.uploadFile = (...args) => {
  if (!storageMock) throw new Error('No storage mock configured for this test');
  return storageMock.uploadFile(...args);
};
storage.listFiles = (...args) => {
  if (!storageMock) throw new Error('No storage mock configured for this test');
  return storageMock.listFiles(...args);
};
storage.deleteFile = (...args) => {
  if (!storageMock) throw new Error('No storage mock configured for this test');
  return storageMock.deleteFile(...args);
};
storage.getDownloadUrl = (...args) => {
  if (!storageMock) throw new Error('No storage mock configured for this test');
  return storageMock.getDownloadUrl(...args);
};

// GET /api/download/link does a real HEAD request (via the global `fetch`)
// to report the CDN's real file size - mock it here so tests never hit the
// real network. Only HEAD calls are intercepted; everything else (the test's
// own calls to the local test server) goes through the real fetch untouched.
// Defaults to "no size available" so tests that don't care about fileSize
// don't need to configure anything.
const realFetch = global.fetch;
let fetchMock = null;
global.fetch = (url, options = {}) => {
  if (options.method === 'HEAD') {
    if (fetchMock) return fetchMock(url, options);
    return Promise.resolve({ ok: false, headers: { get: () => null } });
  }
  return realFetch(url, options);
};

const downloadRouter = require('../server/routes/download');

function makeFakeProcess({ stdout = '', stderr = '', exitCode = 0, spawnError = null }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.killed = true; };
  setImmediate(() => {
    if (spawnError) {
      proc.emit('error', spawnError);
      return;
    }
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', exitCode);
  });
  return proc;
}

// ffprobe.js only reads stdout (no stderr) - reuses the same fake process shape.
function makeFakeProbeProcess({ streams = [], exitCode = 0 }) {
  return makeFakeProcess({ stdout: JSON.stringify({ streams }), exitCode });
}

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/download', downloadRouter);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = await startServer();
  try {
    await fn(baseUrl);
    // A successful download schedules its auto-cleanup via setTimeout
    // independently of the request/response cycle (see AUTO_CLEANUP_DELAY_MS
    // in download.js). Outlive it here so it fires against *this* test's
    // still-active mocks, instead of racing against the next test's.
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.AUTO_CLEANUP_DELAY_MS) + 30));
  } finally {
    mockImpl = null;
    storageMock = null;
    fetchMock = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

test('GET /api/download/link rejects an invalid URL', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/link?url=not-a-url`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_URL');
  });
});

test('GET /api/download/link rejects an invalid quality value', async () => {
  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.tiktok.com/@user/video/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}&quality=ultra`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_QUALITY');
  });
});

test('GET /api/download/link accepts the exact "<n>p" quality label GET /api/info shows (not just the old fixed preset list)', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: JSON.stringify({
      title: 'Cool Video',
      formats: [
        { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', url: 'https://cdn.example.com/576.mp4', width: 576, height: 1024 }
      ]
    }),
    exitCode: 0
  });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.tiktok.com/@user/video/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}&quality=576p`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.downloadUrl, 'https://cdn.example.com/576.mp4');
    assert.equal(body.quality, '576p');
  });
});

test('GET /api/download/link rejects an unsupported platform host', async () => {
  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.youtube.com/watch?v=abc');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'UNSUPPORTED_DIRECT_LINK_PLATFORM');
  });
});

test('GET /api/download/link returns a progressive mp4 for a supported platform', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: JSON.stringify({
      title: 'Cool Video',
      formats: [
        { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', url: 'https://cdn.example.com/tiktok.mp4', width: 720, height: 1280 }
      ]
    }),
    exitCode: 0
  });

  fetchMock = async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? '377066' : null) } });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.tiktok.com/@user/video/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.downloadUrl, 'https://cdn.example.com/tiktok.mp4');
    assert.equal(body.platform, 'tiktok');
    assert.equal(body.contentType, 'video/mp4');
    assert.equal(body.title, 'Cool Video');
    // Same "720p"-style short-edge label as GET /api/info and
    // POST /api/download (see server/lib/qualities.js) - a raw 720x1280
    // resolution's short edge is 720.
    assert.equal(body.quality, '720p');
    // Real, platform-reported size in MB via a HEAD request to the CDN URL.
    assert.equal(body.fileSize, 0.36);
    assert.equal(body.expiresAt, null);
    assert.equal(body.requestHeaders, null);
    assert.match(body.note, /could not capture that session/);
  });
});

test('GET /api/download/link returns Cookie/Referer requestHeaders when TikTok session cookies were captured', async () => {
  mockImpl = (command, args) => {
    const cookiesFlagIndex = args.indexOf('--cookies');
    const cookieJarPath = args[cookiesFlagIndex + 1];
    fs.writeFileSync(
      cookieJarPath,
      [
        '# Netscape HTTP Cookie File',
        '.tiktok.com\tTRUE\t/\tTRUE\t1821253916\tttwid\tabc123',
        '.tiktok.com\tTRUE\t/\tTRUE\t0\tmsToken\txyz789',
        ''
      ].join('\n')
    );
    return makeFakeProcess({
      stdout: JSON.stringify({
        title: 'Cool Video',
        formats: [
          { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', url: 'https://cdn.example.com/tiktok.mp4', width: 720, height: 1280 }
        ]
      }),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.tiktok.com/@user/video/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.requestHeaders, {
      Referer: 'https://www.tiktok.com/',
      Cookie: 'ttwid=abc123; msToken=xyz789'
    });
    assert.match(body.note, /requestHeaders.*Cookie \+ Referer/);
  });
});

test('GET /api/download/link uses the generic note for platforms without a known CDN quirk', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: JSON.stringify({
      title: 'Cool Tweet',
      formats: [
        { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', url: 'https://cdn.example.com/twitter.mp4', width: 720, height: 1280 }
      ]
    }),
    exitCode: 0
  });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://x.com/user/status/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.note, 'The URL may expire in 40 seconds.');
    assert.equal(body.requestHeaders, null);
  });
});

test('GET /api/download/link probes the real resolution via ffprobe when yt-dlp reports no width/height (Instagram style)', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') {
      return makeFakeProbeProcess({ streams: [{ codec_type: 'video', width: 720, height: 1280 }, { codec_type: 'audio' }] });
    }
    return makeFakeProcess({
      stdout: JSON.stringify({
        title: 'Video by panignite',
        // A definite progressive format (explicit vcodec/acodec) - no probe
        // needed to confirm it has audio+video - but yt-dlp still didn't
        // report width/height for it, same as real Instagram data.
        formats: [
          { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'https', url: 'https://cdn.example.com/instagram.mp4' }
        ]
      }),
      exitCode: 0
    });
  };
  fetchMock = async () => ({ ok: true, headers: { get: (name) => (name === 'content-length' ? '6837555' : null) } });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.instagram.com/reel/abc123/');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    // The live ffprobe read a real 720x1280 stream - short edge 720 -
    // instead of falling back to a fabricated-looking quality: null.
    assert.equal(body.quality, '720p');
    assert.equal(body.fileSize, 6.52);
  });
});

test('GET /api/download/link probes an ambiguous format and accepts it when ffprobe confirms audio+video (Facebook hd/sd style)', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') {
      return makeFakeProbeProcess({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] });
    }
    return makeFakeProcess({
      stdout: JSON.stringify({
        title: 'Cool Facebook Video',
        formats: [
          { ext: 'mp4', protocol: 'https', url: 'https://cdn.example.com/hd.mp4', height: 720 }
        ]
      }),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.facebook.com/watch/?v=123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.downloadUrl, 'https://cdn.example.com/hd.mp4');
    assert.equal(body.platform, 'facebook');
  });
});

test('GET /api/download/link resolves a LinkedIn video with no special headers required', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') {
      return makeFakeProbeProcess({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] });
    }
    return makeFakeProcess({
      stdout: JSON.stringify({
        title: 'Cool LinkedIn Video',
        formats: [
          { ext: 'mp4', protocol: 'https', url: 'https://dms.licdn.com/playlist/vid/0.mp4', height: 640 }
        ]
      }),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.linkedin.com/posts/user_activity-123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.downloadUrl, 'https://dms.licdn.com/playlist/vid/0.mp4');
    assert.equal(body.platform, 'linkedin');
    assert.equal(body.requestHeaders, null);
    assert.equal(body.note, 'The URL may expire in 40 seconds.');
  });
});

test('GET /api/download/link probes an ambiguous format and rejects it when ffprobe finds no audio track (Instagram reel style)', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') {
      return makeFakeProbeProcess({ streams: [{ codec_type: 'video' }] });
    }
    return makeFakeProcess({
      stdout: JSON.stringify({
        title: 'Cool Reel',
        formats: [
          { ext: 'mp4', protocol: 'https', url: 'https://cdn.example.com/video-only.mp4', height: 720 }
        ]
      }),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.instagram.com/reel/abc123/');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'DIRECT_LINK_UNAVAILABLE');
  });
});

test('GET /api/download/link returns 422 when no progressive mp4 is available', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: JSON.stringify({
      title: 'HLS only',
      formats: [
        { ext: 'mp4', vcodec: 'h264', acodec: 'aac', protocol: 'm3u8_native', url: 'https://cdn.example.com/master.m3u8' }
      ]
    }),
    exitCode: 0
  });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://x.com/user/status/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'DIRECT_LINK_UNAVAILABLE');
  });
});

test('GET /api/download/link returns 502 when yt-dlp exits non-zero', async () => {
  mockImpl = () => makeFakeProcess({ stderr: 'ERROR: unsupported url', exitCode: 1 });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.instagram.com/p/abc123/');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'YTDLP_EXTRACTOR_FAILED');
  });
});

test('GET /api/download/link returns 502 when yt-dlp fails to start', async () => {
  mockImpl = () => makeFakeProcess({ spawnError: new Error('spawn yt-dlp ENOENT') });

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.facebook.com/watch/?v=123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).code, 'YTDLP_START_FAILED');
  });
});

test('existing disk-download and list routes retain their current validation behavior', async () => {
  await withServer(async (baseUrl) => {
    const download = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(download.status, 400);
    assert.equal((await download.json()).error, 'URL is required');

    const list = await fetch(`${baseUrl}/api/download/list`);
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(await list.json()));
  });
});

test('GET /api/download/stream no longer exists', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/stream?url=https://example.com/video`);
    assert.equal(res.status, 404);
  });
});

test('POST /api/download retries and succeeds once a "still processing" platform response clears', async () => {
  let ytdlpCalls = 0;
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    ytdlpCalls += 1;
    if (ytdlpCalls < 3) {
      return makeFakeProcess({ stderr: 'ERROR: [Reddit] abc: This video is processing', exitCode: 1 });
    }
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "Ready Now.mp4"', exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/abc/ready_now/', quality: 'best' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Ready Now');
    assert.equal(ytdlpCalls, 3);
  });
});

test('POST /api/download gives up and returns 502 if a platform still reports "processing" after the max wait', async () => {
  let ytdlpCalls = 0;
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    ytdlpCalls += 1;
    return makeFakeProcess({ stderr: 'ERROR: [Reddit] abc: This video is processing', exitCode: 1 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/abc/still_processing/', quality: 'best' })
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.details, /processing/);
    assert.ok(ytdlpCalls > 1, 'should have retried at least once before giving up');
  });
});

test('POST /api/download merges best video+audio instead of a single-format selector, and forces an mp4 container', async () => {
  // Sites that only ever serve split video-only/audio-only tracks (e.g.
  // Reddit) have no genuine pre-merged format, so a bare 'b'/'best[height<=Q]'
  // selector can fail outright with "Requested format is not available".
  let seenArgs = null;
  mockImpl = (command, args) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    seenArgs = args;
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "This is a robbery.mp4"', exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', quality: 'best' })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).title, 'This is a robbery');

    assert.deepEqual(seenArgs.slice(seenArgs.indexOf('-f'), seenArgs.indexOf('-f') + 2), ['-f', 'bestvideo+bestaudio/best']);
    assert.ok(seenArgs.includes('--merge-output-format'));
    assert.equal(seenArgs[seenArgs.indexOf('--merge-output-format') + 1], 'mp4');
    assert.ok(!seenArgs.includes('b'), 'should not use the fragile single-format "b" selector');
  });
});

test('POST /api/download applies the height cap to both sides of the video+audio merge selector', async () => {
  let seenArgs = null;
  mockImpl = (command, args) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    seenArgs = args;
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "This is a robbery.mp4"', exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', quality: '480' })
    });
    assert.equal(res.status, 200);
    assert.equal(seenArgs[seenArgs.indexOf('-f') + 1], 'bestvideo[height<=480]+bestaudio/best[height<=480]/best');
  });
});

test('POST /api/download leaves the audioOnly selector unchanged', async () => {
  let seenArgs = null;
  mockImpl = (command, args) => {
    seenArgs = args;
    return makeFakeProcess({ stdout: '[download] Destination: This is a robbery.mp3', exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', audioOnly: true })
    });
    assert.equal(res.status, 200);
    assert.equal(seenArgs[seenArgs.indexOf('-f') + 1], 'bestaudio/best');
    assert.ok(!seenArgs.includes('--merge-output-format'));
  });
});

test('POST /api/download captures the merged filename, not a deleted temp component', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    return makeFakeProcess({
      stdout: [
        '[download] Destination: This is a robbery.fhls-451.mp4',
        '[download] Destination: This is a robbery.fdash-9.m4a',
        '[Merger] Merging formats into "This is a robbery.mp4"',
        'Deleting original file This is a robbery.fhls-451.mp4 (pass -k to keep)',
        'Deleting original file This is a robbery.fdash-9.m4a (pass -k to keep)'
      ].join('\n'),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', quality: 'best' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Fully-qualified with this server's own host - directly usable without
    // the caller having to know/guess the base URL.
    assert.match(body.downloadUrl, /^http:\/\/127\.0\.0\.1:\d+\/api\/download\/This%20is%20a%20robbery\.mp4$/);
    assert.equal(body.title, 'This is a robbery');
    assert.equal(body.storage, 'local');
  });
});

test('POST /api/download recognizes "has already been downloaded" as success, not a missing filename', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    return makeFakeProcess({
      stdout: [
        '[TikTok] 123: Downloading webpage',
        '[download] downloads\\Cool Video.mp4 has already been downloaded',
        '[download] Download completed'
      ].join('\n'),
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.tiktok.com/@user/video/123', quality: 'best' })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Cool Video');
    assert.match(body.downloadUrl, /\/api\/download\/Cool%20Video\.mp4$/);
  });
});

test('POST /api/download reports downloadUrl/platform/contentType/title/quality/fileSize on the finished download, each field present once', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') {
      return makeFakeProbeProcess({ streams: [{ codec_type: 'video', width: 1280, height: 720 }] });
    }
    return makeFakeProcess({
      stdout: '[Merger] Merging formats into "Cool Dance.mp4"',
      exitCode: 0
    });
  };

  await withServer(async (baseUrl) => {
    // A known-size stand-in for the file yt-dlp would have actually written,
    // so fileSize can be asserted against a real, exact byte count instead
    // of just checking it's present.
    fs.writeFileSync(path.join(TEST_DOWNLOADS_DIR, 'Cool Dance.mp4'), Buffer.alloc(1024 * 1024));

    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.tiktok.com/@user/video/123', quality: 'best' })
    });
    assert.equal(res.status, 200);
    const info = await res.json();

    assert.match(info.downloadUrl, /\/api\/download\/Cool%20Dance\.mp4$/);
    assert.equal(info.platform, 'tiktok');
    assert.equal(info.contentType, 'video/mp4');
    assert.equal(info.title, 'Cool Dance');
    // A "720p"-style short-edge label (see server/lib/qualities.js) - not a
    // raw {width, height} object.
    assert.equal(info.quality, '720p');
    assert.equal(info.fileSize, 1);

    // Exactly one representation of quality/resolution on the payload -
    // no separate duplicate field like a "resolution" string.
    assert.equal(Object.keys(info).filter((k) => /quality|resolution/i.test(k)).length, 1);
  });
});

test('POST /api/download reports platform: null for a site outside the /link 5-platform allowlist, and the right audio contentType', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: '[download] Destination: Some Song.mp3',
    exitCode: 0
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc', audioOnly: true, format: 'mp3' })
    });
    assert.equal(res.status, 200);
    const info = await res.json();

    assert.equal(info.platform, null);
    assert.equal(info.contentType, 'audio/mpeg');
    assert.equal(info.title, 'Some Song');
    assert.equal(info.quality, null);
  });
});

test('POST /api/download uploads the finished file to B2 and removes the local copy when B2 is configured', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: '[Merger] Merging formats into "Cool Video.mp4"',
    exitCode: 0
  });

  let uploadCall = null;
  let presignCall = null;
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async (localFilePath, key) => {
      uploadCall = { localFilePath, key };
      return { key, size: 123 };
    },
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async () => { throw new Error('not used in this test'); },
    getDownloadUrl: async (key, options) => {
      presignCall = { key, options };
      return `https://example-b2-endpoint.com/presigned/${key}`;
    }
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video', quality: 'best' })
    });
    assert.equal(res.status, 200);
    const info = await res.json();

    assert.equal(info.storage, 'b2');
    assert.equal(info.title, 'Cool Video');
    assert.equal(uploadCall.key, 'Cool Video.mp4');
    assert.ok(uploadCall.localFilePath.endsWith('Cool Video.mp4'));

    // downloadUrl is the real, directly-clickable presigned B2 URL - not a
    // redirect through our own API - valid for the same window the file
    // will actually still exist (AUTO_CLEANUP_DELAY_MS).
    assert.equal(info.downloadUrl, 'https://example-b2-endpoint.com/presigned/Cool Video.mp4');
    assert.equal(presignCall.key, 'Cool Video.mp4');
    assert.equal(presignCall.options.expiresInSeconds, Math.ceil(Number(process.env.AUTO_CLEANUP_DELAY_MS) / 1000));
  });
});

test('POST /api/download returns a 502 when the B2 upload fails, without pretending success', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "Cool Video.mp4"', exitCode: 0 });
  };

  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async () => { throw new Error('network error'); },
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async () => { throw new Error('not used in this test'); }
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video', quality: 'best' })
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.match(body.details, /network error/);
  });
});

test('GET /api/download/list lists from B2 instead of local disk when B2 is configured', async () => {
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async () => { throw new Error('not used in this test'); },
    listFiles: async () => [{ name: 'a.mp4', size: 1, createdAt: new Date(0), modifiedAt: new Date(0) }],
    deleteFile: async () => { throw new Error('not used in this test'); }
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/list`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).map((f) => f.name), ['a.mp4']);
  });
});

test('DELETE /api/download/:filename deletes from B2 instead of local disk when B2 is configured', async () => {
  let deletedKey = null;
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async () => { throw new Error('not used in this test'); },
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async (key) => { deletedKey = key; }
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/${encodeURIComponent('a.mp4')}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(deletedKey, 'a.mp4');
  });
});

test('GET /api/download/:filename serves a local file with the right content and Content-Disposition', async () => {
  await withServer(async (baseUrl) => {
    const filePath = path.join(TEST_DOWNLOADS_DIR, 'sample.mp4');
    fs.writeFileSync(filePath, 'video-bytes');

    try {
      const res = await fetch(`${baseUrl}/api/download/sample.mp4`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') || '', /attachment/);
      assert.match(res.headers.get('content-disposition') || '', /sample\.mp4/);
      assert.equal(await res.text(), 'video-bytes');
    } finally {
      fs.unlinkSync(filePath);
    }
  });
});

test('GET /api/download/:filename returns 404 for a local file that does not exist', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/does-not-exist.mp4`);
    assert.equal(res.status, 404);
  });
});

test('GET /api/download/:filename redirects to a presigned B2 URL when B2 is configured', async () => {
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async () => { throw new Error('not used in this test'); },
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async () => { throw new Error('not used in this test'); },
    getDownloadUrl: async (key) => `https://example.com/presigned/${key}`
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download/a.mp4`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://example.com/presigned/a.mp4');
  });
});

test('POST /api/download automatically deletes the local file after AUTO_CLEANUP_DELAY_MS', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "cleanup-me.mp4"', exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const filePath = path.join(TEST_DOWNLOADS_DIR, 'cleanup-me.mp4');
    fs.writeFileSync(filePath, 'bytes');

    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video', quality: 'best' })
    });
    assert.equal(res.status, 200);
    assert.ok(fs.existsSync(filePath), 'file should still exist right after the response is sent');

    const start = Date.now();
    while (fs.existsSync(filePath) && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(!fs.existsSync(filePath), 'file should be auto-deleted after the cleanup delay');
  });
});

test('POST /api/download automatically deletes the B2 object after AUTO_CLEANUP_DELAY_MS', async () => {
  mockImpl = (command) => {
    if (command === 'ffprobe') return makeFakeProbeProcess({ streams: [] });
    return makeFakeProcess({ stdout: '[Merger] Merging formats into "cleanup-b2.mp4"', exitCode: 0 });
  };

  const deleteCalls = [];
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async (localFilePath, key) => ({ key, size: 1 }),
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async (key) => { deleteCalls.push(key); },
    getDownloadUrl: async (key) => `https://example-b2-endpoint.com/presigned/${key}`
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video', quality: 'best' })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(deleteCalls, [], 'the B2 object should not be deleted immediately');

    const start = Date.now();
    while (deleteCalls.length === 0 && Date.now() - start < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(deleteCalls, ['cleanup-b2.mp4']);
  });
});
