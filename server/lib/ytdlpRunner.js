const { spawn: defaultSpawn } = require('child_process');

// Some platforms (confirmed: Reddit, "This video is processing") report
// this when content was just uploaded and the platform's own transcoding
// pipeline hasn't finished yet - it's not a permanent failure, the video
// simply isn't ready. Worth waiting out instead of failing immediately.
const TRANSIENT_PROCESSING_PATTERN = /is processing/i;

// On Windows, yt-dlp's underlying Python process encodes console output
// (progress/status lines - NOT its --dump-json output, which is ASCII-safe
// either way) using the system's ANSI codepage by default, e.g. cp1252.
// That codepage can't represent many Unicode characters - emoji, fullwidth
// punctuation, etc - so they're silently dropped/blanked in what we read
// from stdout, even though the *file actually written to disk* keeps them
// correctly (that path uses the OS's real filesystem encoding, a separate
// thing). The result: parsing a title like "Pakistan Zindabad...🇵🇰｜..."
// from a "[download] Destination:" line yields a filename that doesn't
// match the real file, and a later fs.stat/upload on it 404s. Forcing
// Python into UTF-8 mode makes console output match the real file exactly.
function getYtdlpEnv() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function runYtdlpOnce(args, spawnFn, onStdoutChunk) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawnFn('yt-dlp', args, { env: getYtdlpEnv() });
    } catch (spawnError) {
      resolve({ exitCode: null, stdout: '', stderr: '', spawnError });
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (onStdoutChunk) onStdoutChunk(chunk);
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (spawnError) => {
      resolve({ exitCode: null, stdout, stderr, spawnError });
    });
    proc.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr, spawnError: null });
    });
  });
}

// Runs yt-dlp, retrying the *entire* invocation while the platform reports
// the content is still processing (TRANSIENT_PROCESSING_PATTERN), up to
// maxWaitMs total wall-clock time, waiting retryDelayMs between attempts.
// Returns the final attempt's result either way - success, a permanent
// failure (different error), or still-processing once the wait budget is
// exhausted (caller sees that as a normal failed attempt with the same
// stderr, just after having waited).
async function runYtdlpWithRetry(args, options = {}) {
  const {
    spawnFn = defaultSpawn,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    retryDelayMs = 5000,
    maxWaitMs = 120000,
    onStdoutChunk,
    onAttempt
  } = options;

  const start = Date.now();
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const result = await runYtdlpOnce(args, spawnFn, onStdoutChunk);
    const isTransient = !result.spawnError
      && result.exitCode !== 0
      && TRANSIENT_PROCESSING_PATTERN.test(result.stderr);

    if (onAttempt) onAttempt(attempt, result, isTransient);

    if (!isTransient || Date.now() - start >= maxWaitMs) {
      return result;
    }

    await sleepFn(retryDelayMs);
  }
}

module.exports = { runYtdlpWithRetry, TRANSIENT_PROCESSING_PATTERN, getYtdlpEnv };
