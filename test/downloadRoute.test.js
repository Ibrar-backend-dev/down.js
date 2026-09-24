const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const express = require('express');

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

let socketEvents = [];

async function startServer() {
  const app = express();
  app.use(express.json());
  app.set('socketio', { emit: (event, info) => socketEvents.push({ event, info }) });
  app.use('/api/download', downloadRouter);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function withServer(fn) {
  socketEvents = [];
  const { server, baseUrl } = await startServer();
  try {
    await fn(baseUrl);
  } finally {
    mockImpl = null;
    storageMock = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

async function waitForSocketEvent(eventName, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = socketEvents.find((e) => e.event === eventName);
    if (found) return found.info;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for socket event "${eventName}". Seen: ${socketEvents.map((e) => e.event).join(', ')}`);
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
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}&quality=1234`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'INVALID_QUALITY');
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

  await withServer(async (baseUrl) => {
    const url = encodeURIComponent('https://www.tiktok.com/@user/video/123');
    const res = await fetch(`${baseUrl}/api/download/link?url=${url}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.downloadUrl, 'https://cdn.example.com/tiktok.mp4');
    assert.equal(body.platform, 'tiktok');
    assert.equal(body.contentType, 'video/mp4');
    assert.equal(body.filename, 'Cool Video.mp4');
    assert.deepEqual(body.quality, { width: 720, height: 1280 });
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
    assert.equal(body.note, 'Provider URLs may expire.');
    assert.equal(body.requestHeaders, null);
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
    assert.equal(body.note, 'Provider URLs may expire.');
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

test('POST /api/download merges best video+audio instead of a single-format selector, and forces an mp4 container', async () => {
  // Sites that only ever serve split video-only/audio-only tracks (e.g.
  // Reddit) have no genuine pre-merged format, so a bare 'b'/'best[height<=Q]'
  // selector can fail outright with "Requested format is not available".
  let seenArgs = null;
  mockImpl = (command, args) => {
    seenArgs = args;
    return makeFakeProcess({ exitCode: 0 });
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', quality: 'best' })
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    assert.deepEqual(seenArgs.slice(seenArgs.indexOf('-f'), seenArgs.indexOf('-f') + 2), ['-f', 'bestvideo+bestaudio/best']);
    assert.ok(seenArgs.includes('--merge-output-format'));
    assert.equal(seenArgs[seenArgs.indexOf('--merge-output-format') + 1], 'mp4');
    assert.ok(!seenArgs.includes('b'), 'should not use the fragile single-format "b" selector');
  });
});

test('POST /api/download applies the height cap to both sides of the video+audio merge selector', async () => {
  let seenArgs = null;
  mockImpl = (command, args) => {
    seenArgs = args;
    return makeFakeProcess({ exitCode: 0 });
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
    return makeFakeProcess({ exitCode: 0 });
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
  mockImpl = () => makeFakeProcess({
    stdout: [
      '[download] Destination: This is a robbery.fhls-451.mp4',
      '[download] Destination: This is a robbery.fdash-9.m4a',
      '[Merger] Merging formats into "This is a robbery.mp4"',
      'Deleting original file This is a robbery.fhls-451.mp4 (pass -k to keep)',
      'Deleting original file This is a robbery.fdash-9.m4a (pass -k to keep)'
    ].join('\n'),
    exitCode: 0
  });

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.reddit.com/r/funny/comments/1t5drxy/this_is_a_robbery/', quality: 'best' })
    });
    assert.equal(res.status, 200);

    const info = await waitForSocketEvent('download-complete');
    assert.equal(info.filename, 'This is a robbery.mp4');
    assert.equal(info.storage, 'local');
  });
});

test('POST /api/download uploads the finished file to B2 and removes the local copy when B2 is configured', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: '[Merger] Merging formats into "Cool Video.mp4"',
    exitCode: 0
  });

  let uploadCall = null;
  storageMock = {
    isB2Enabled: () => true,
    uploadFile: async (localFilePath, key) => {
      uploadCall = { localFilePath, key };
      return { key, size: 123 };
    },
    listFiles: async () => { throw new Error('not used in this test'); },
    deleteFile: async () => { throw new Error('not used in this test'); }
  };

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/video', quality: 'best' })
    });
    assert.equal(res.status, 200);

    const info = await waitForSocketEvent('download-complete');
    assert.equal(info.storage, 'b2');
    assert.equal(info.filename, 'Cool Video.mp4');
    assert.equal(uploadCall.key, 'Cool Video.mp4');
    assert.ok(uploadCall.localFilePath.endsWith('Cool Video.mp4'));
  });
});

test('POST /api/download reports a download-error when the B2 upload fails, without pretending success', async () => {
  mockImpl = () => makeFakeProcess({
    stdout: '[Merger] Merging formats into "Cool Video.mp4"',
    exitCode: 0
  });

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
    assert.equal(res.status, 200);

    const info = await waitForSocketEvent('download-error');
    assert.equal(info.status, 'error');
    assert.match(info.error, /failed to upload to B2/);
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
