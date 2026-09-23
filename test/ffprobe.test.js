const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const childProcess = require('child_process');
let mockImpl = null;
childProcess.spawn = (...args) => {
  if (!mockImpl) {
    throw new Error('No ffprobe mock configured for this test');
  }
  return mockImpl(...args);
};

const { probeHasVideoAndAudio } = require('../server/lib/ffprobe');

function makeFakeProbe({ stdout = '', exitCode = 0, spawnError = null, hang = false }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.kill = () => { proc.killed = true; };
  if (!hang) {
    setImmediate(() => {
      if (spawnError) {
        proc.emit('error', spawnError);
        return;
      }
      if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    });
  }
  return proc;
}

test('probeHasVideoAndAudio resolves true when ffprobe reports both a video and audio stream', async () => {
  mockImpl = () => makeFakeProbe({
    stdout: JSON.stringify({ streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }),
    exitCode: 0
  });
  assert.equal(await probeHasVideoAndAudio('https://cdn.example.com/video.mp4'), true);
  mockImpl = null;
});

test('probeHasVideoAndAudio resolves false when only a video stream is present', async () => {
  mockImpl = () => makeFakeProbe({
    stdout: JSON.stringify({ streams: [{ codec_type: 'video' }] }),
    exitCode: 0
  });
  assert.equal(await probeHasVideoAndAudio('https://cdn.example.com/video-only.mp4'), false);
  mockImpl = null;
});

test('probeHasVideoAndAudio resolves false when ffprobe exits non-zero', async () => {
  mockImpl = () => makeFakeProbe({ exitCode: 1 });
  assert.equal(await probeHasVideoAndAudio('https://cdn.example.com/broken.mp4'), false);
  mockImpl = null;
});

test('probeHasVideoAndAudio resolves false when ffprobe fails to start', async () => {
  mockImpl = () => makeFakeProbe({ spawnError: new Error('spawn ffprobe ENOENT') });
  assert.equal(await probeHasVideoAndAudio('https://cdn.example.com/video.mp4'), false);
  mockImpl = null;
});

test('probeHasVideoAndAudio resolves false on malformed JSON output', async () => {
  mockImpl = () => makeFakeProbe({ stdout: 'not json', exitCode: 0 });
  assert.equal(await probeHasVideoAndAudio('https://cdn.example.com/video.mp4'), false);
  mockImpl = null;
});

test('probeHasVideoAndAudio resolves false and does not hang when ffprobe never responds', async () => {
  mockImpl = () => makeFakeProbe({ hang: true });
  const result = await probeHasVideoAndAudio('https://cdn.example.com/video.mp4', { timeoutMs: 50 });
  assert.equal(result, false);
  mockImpl = null;
});
