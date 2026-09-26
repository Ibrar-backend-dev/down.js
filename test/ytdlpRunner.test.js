const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runYtdlpWithRetry, TRANSIENT_PROCESSING_PATTERN, getYtdlpEnv } = require('../server/lib/ytdlpRunner');

function makeFakeProcess({ stdout = '', stderr = '', exitCode = 0, spawnError = null }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
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

test('TRANSIENT_PROCESSING_PATTERN matches Reddit\'s "still processing" message', () => {
  assert.equal(TRANSIENT_PROCESSING_PATTERN.test('ERROR: [Reddit] 1wo4p3z: This video is processing'), true);
  assert.equal(TRANSIENT_PROCESSING_PATTERN.test('ERROR: unsupported url'), false);
});

test('runYtdlpWithRetry returns immediately on success, without sleeping', async () => {
  let spawnCalls = 0;
  let sleptMs = null;
  const result = await runYtdlpWithRetry(['--dump-json', 'https://example.com'], {
    spawnFn: () => { spawnCalls += 1; return makeFakeProcess({ stdout: 'ok', exitCode: 0 }); },
    sleepFn: async (ms) => { sleptMs = ms; }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(spawnCalls, 1);
  assert.equal(sleptMs, null);
});

test('runYtdlpWithRetry does not retry a permanent (non-transient) failure', async () => {
  let spawnCalls = 0;
  const result = await runYtdlpWithRetry(['x'], {
    spawnFn: () => { spawnCalls += 1; return makeFakeProcess({ stderr: 'ERROR: unsupported url', exitCode: 1 }); },
    sleepFn: async () => {}
  });

  assert.equal(result.exitCode, 1);
  assert.equal(spawnCalls, 1);
});

test('runYtdlpWithRetry retries a transient "is processing" failure until it succeeds', async () => {
  let spawnCalls = 0;
  const sleeps = [];
  const result = await runYtdlpWithRetry(['x'], {
    spawnFn: () => {
      spawnCalls += 1;
      if (spawnCalls < 3) {
        return makeFakeProcess({ stderr: 'ERROR: [Reddit] abc: This video is processing', exitCode: 1 });
      }
      return makeFakeProcess({ stdout: 'done', exitCode: 0 });
    },
    sleepFn: async (ms) => { sleeps.push(ms); },
    retryDelayMs: 1234,
    maxWaitMs: 60000
  });

  assert.equal(result.exitCode, 0);
  assert.equal(spawnCalls, 3);
  assert.deepEqual(sleeps, [1234, 1234]);
});

test('runYtdlpWithRetry gives up once maxWaitMs elapses and returns the last (still-transient) result', async () => {
  let spawnCalls = 0;
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;

  try {
    const result = await runYtdlpWithRetry(['x'], {
      spawnFn: () => { spawnCalls += 1; return makeFakeProcess({ stderr: 'This video is processing', exitCode: 1 }); },
      sleepFn: async (ms) => { now += ms; },
      retryDelayMs: 10000,
      maxWaitMs: 25000
    });

    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /processing/);
    // start(0) -> attempt1 fail -> sleep to 10000 -> attempt2 fail -> sleep to
    // 20000 -> attempt3 fail -> elapsed(20000) < max(25000) -> sleep to 30000
    // -> attempt4 fail -> elapsed(30000) >= max(25000) -> stop.
    assert.equal(spawnCalls, 4);
  } finally {
    Date.now = originalNow;
  }
});

test('runYtdlpWithRetry does not retry when yt-dlp fails to start', async () => {
  let spawnCalls = 0;
  const result = await runYtdlpWithRetry(['x'], {
    spawnFn: () => { spawnCalls += 1; return makeFakeProcess({ spawnError: new Error('spawn yt-dlp ENOENT') }); },
    sleepFn: async () => {}
  });

  assert.equal(result.exitCode, null);
  assert.ok(result.spawnError);
  assert.equal(spawnCalls, 1);
});

test('runYtdlpWithRetry calls onStdoutChunk and onAttempt as attempts happen', async () => {
  const chunks = [];
  const attempts = [];
  let spawnCalls = 0;

  await runYtdlpWithRetry(['x'], {
    spawnFn: () => {
      spawnCalls += 1;
      if (spawnCalls === 1) return makeFakeProcess({ stdout: 'partial', stderr: 'This video is processing', exitCode: 1 });
      return makeFakeProcess({ stdout: 'final', exitCode: 0 });
    },
    sleepFn: async () => {},
    onStdoutChunk: (chunk) => chunks.push(chunk),
    onAttempt: (attempt, result, isTransient) => attempts.push({ attempt, exitCode: result.exitCode, isTransient })
  });

  assert.deepEqual(chunks, ['partial', 'final']);
  assert.deepEqual(attempts, [
    { attempt: 1, exitCode: 1, isTransient: true },
    { attempt: 2, exitCode: 0, isTransient: false }
  ]);
});

test('getYtdlpEnv forces Python into UTF-8 mode without dropping the rest of process.env', () => {
  const env = getYtdlpEnv();
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PATH, process.env.PATH);
});

test('runYtdlpWithRetry always spawns yt-dlp with the UTF-8-forcing env, so console output matches the real file on disk', async () => {
  // Regression test for a real bug: on Windows, yt-dlp's default console
  // encoding (e.g. cp1252) can't represent characters like emoji or
  // fullwidth punctuation, so titles containing them get silently
  // blanked/mismatched in "[download] Destination: ..." lines even though
  // the actual file written to disk keeps them - causing a later
  // fs.stat/upload on the (wrongly) parsed filename to fail with ENOENT.
  let seenOptions = null;
  await runYtdlpWithRetry(['x'], {
    spawnFn: (command, args, options) => {
      seenOptions = options;
      return makeFakeProcess({ exitCode: 0 });
    },
    sleepFn: async () => {}
  });

  assert.equal(seenOptions.env.PYTHONUTF8, '1');
  assert.equal(seenOptions.env.PYTHONIOENCODING, 'utf-8');
});
