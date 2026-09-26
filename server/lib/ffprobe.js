const { spawn } = require('child_process');

// Runs ffprobe with the given args and returns its parsed JSON stdout, or
// null on any failure (missing binary, timeout, non-zero exit, bad JSON).
function runFfprobe(args, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('ffprobe', args);
    } catch {
      resolve(null);
      return;
    }

    let output = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) {
        proc.kill('SIGKILL');
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.on('error', () => finish(null));

    proc.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(output));
      } catch {
        finish(null);
      }
    });
  });
}

// Some platforms' progressive MP4 formats don't populate vcodec/acodec in
// yt-dlp's metadata (Facebook hd/sd, Twitter http-*, Vimeo http-*), so a
// format with missing codec fields can't be trusted either way from
// metadata alone - it needs to be verified against the real file. This
// probes the remote URL's actual stream layout via a fast, low-cost
// `ffprobe` call (reads just enough of the container to list streams; does
// not download or store the media) and reports whether it has both a video
// and an audio stream.
async function probeHasVideoAndAudio(url, { userAgent, referer, timeoutMs = 8000 } = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-analyzeduration', '2000000',
    '-probesize', '2000000'
  ];

  if (userAgent) {
    args.push('-user_agent', userAgent);
  }
  if (referer) {
    args.push('-headers', `Referer: ${referer}\r\n`);
  }
  args.push(url);

  const parsed = await runFfprobe(args, timeoutMs);
  if (!parsed) return false;
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const hasVideo = streams.some((s) => s.codec_type === 'video');
  const hasAudio = streams.some((s) => s.codec_type === 'audio');
  return hasVideo && hasAudio;
}

// Reads the actual pixel dimensions of a *remote* URL's first video stream,
// the same way probeHasVideoAndAudio verifies an ambiguous format - some
// platforms (Instagram, Facebook hd/sd) omit width/height from yt-dlp's own
// metadata entirely, so this is the only way to get a real resolution for
// those formats instead of reporting quality: null. Returns null if there's
// no video stream or ffprobe fails.
async function probeRemoteVideoResolution(url, { userAgent, referer, timeoutMs = 8000 } = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-analyzeduration', '2000000',
    '-probesize', '2000000'
  ];

  if (userAgent) {
    args.push('-user_agent', userAgent);
  }
  if (referer) {
    args.push('-headers', `Referer: ${referer}\r\n`);
  }
  args.push(url);

  const parsed = await runFfprobe(args, timeoutMs);
  if (!parsed) return null;
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
  if (!videoStream) return null;
  return { width: videoStream.width, height: videoStream.height };
}

// Reads the actual pixel dimensions of a local video file's first video
// stream (used to report the real, final quality of a completed
// POST /api/download job, rather than just echoing back the requested
// quality string). Returns null if there's no video stream or ffprobe fails.
async function probeLocalVideoResolution(filePath, { timeoutMs = 8000 } = {}) {
  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', filePath];
  const parsed = await runFfprobe(args, timeoutMs);
  if (!parsed) return null;
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const videoStream = streams.find((s) => s.codec_type === 'video' && s.width && s.height);
  if (!videoStream) return null;
  return { width: videoStream.width, height: videoStream.height };
}

module.exports = { probeHasVideoAndAudio, probeRemoteVideoResolution, probeLocalVideoResolution };
