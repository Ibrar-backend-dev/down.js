const { spawn } = require('child_process');

// Some platforms' progressive MP4 formats don't populate vcodec/acodec in
// yt-dlp's metadata (Facebook hd/sd, Twitter http-*, Vimeo http-*), so a
// format with missing codec fields can't be trusted either way from
// metadata alone - it needs to be verified against the real file. This
// probes the remote URL's actual stream layout via a fast, low-cost
// `ffprobe` call (reads just enough of the container to list streams; does
// not download or store the media) and reports whether it has both a video
// and an audio stream.
function probeHasVideoAndAudio(url, { userAgent, referer, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
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

    let proc;
    try {
      proc = spawn('ffprobe', args);
    } catch {
      resolve(false);
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

    const timer = setTimeout(() => finish(false), timeoutMs);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.on('error', () => finish(false));

    proc.on('close', (code) => {
      if (code !== 0) {
        finish(false);
        return;
      }
      try {
        const parsed = JSON.parse(output);
        const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const hasVideo = streams.some((s) => s.codec_type === 'video');
        const hasAudio = streams.some((s) => s.codec_type === 'audio');
        finish(hasVideo && hasAudio);
      } catch {
        finish(false);
      }
    });
  });
}

module.exports = { probeHasVideoAndAudio };
