# Seal Web App

A REST API for downloading video/audio via [yt-dlp](https://github.com/yt-dlp/yt-dlp), inspired by the [Seal Android app](https://github.com/JunkFood02/Seal) by JunkFood02. API-only - there is no bundled frontend; consume it from your own client, a tool like curl/Insomnia, or a frontend you build separately.

## Features

- Download videos from 1000+ supported sites including YouTube, Vimeo, TikTok, and more
- Audio-only downloads with format selection (MP3, M4A, FLAC, etc.)
- Video quality selection (4K, 1080p, 720p, etc.)
- `POST /api/download` is synchronous - the request stays open for the download's duration and responds with the finished result directly (downloadUrl, platform, contentType, title, quality, fileSize); no polling or event channel needed
- `GET /api/download/link` resolves a single, direct, progressive (video+audio) HTTPS MP4 URL - no server-side download, no disk storage - for TikTok, Instagram, Facebook, X/Twitter, and LinkedIn
- Download history (`GET /api/download/list`) and deletion (`DELETE /api/download/:filename`)

## Tech Stack

- **Node.js** with Express.js
- **yt-dlp** as the download engine
- **ffprobe** (from ffmpeg) for verifying ambiguous direct-link formats and reading real quality/resolution
- **Helmet**, **CORS**, **Morgan**

## Prerequisites

1. **Node.js** (v20.6+; uses `--env-file-if-exists` and the built-in test runner)
2. **npm**
3. **yt-dlp** installed and available in PATH
4. **ffmpeg/ffprobe** installed and available in PATH

### Installing yt-dlp

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install yt-dlp

# macOS
brew install yt-dlp

# Windows: download from https://github.com/yt-dlp/yt-dlp/releases and add to PATH
```

## Installation

```bash
npm install
```

Or run `./setup.sh`, which also installs yt-dlp if missing, creates the `downloads/` directory, and copies `.env.example` to `.env`.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the API listens on | `5000` |
| `NODE_ENV` | `development` \| `production` - affects logging verbosity | `development` |
| `DOWNLOADS_DIR` | Local-storage fallback: where files are written/read/deleted when B2 (below) isn't configured | `./downloads` |
| `AUTO_CLEANUP_DELAY_MS` | How long a finished download stays fetchable before being auto-deleted | `45000` |

`.env` is gitignored and loaded automatically via Node's `--env-file-if-exists` flag - no extra setup needed. For production, see `.env.production.example` (covers why `PORT` usually shouldn't be set on PaaS hosts, and why local disk storage is risky there).

### Storage: local disk vs. Backblaze B2

By default, `POST /api/download` writes files to `DOWNLOADS_DIR` on local disk. Setting all four B2 variables switches storage to a [Backblaze B2](https://www.backblaze.com/cloud-storage) bucket instead (via its S3-compatible API) - yt-dlp still downloads to local disk first, then the file is uploaded and the local copy deleted. It's an all-or-nothing switch: leave any of the four unset to keep using local disk.

| Variable | Purpose |
|---|---|
| `B2_KEY_ID` | Application Key ID from the B2 dashboard (Account → App Keys) |
| `B2_APPLICATION_KEY` | The matching Application Key secret |
| `B2_BUCKET` | Bucket name |
| `B2_ENDPOINT` | Bucket's S3-compatible endpoint, e.g. `https://s3.us-west-002.backblazeb2.com` |
| `B2_REGION` | Defaults to `us-west-002` if unset |

## Development

```bash
npm run dev
```

Starts the API with `nodemon` on `http://localhost:5000` (or `PORT` if set), auto-restarting on file changes.

## Production

```bash
npm start
```

## API Endpoints

### Direct-link resolution (no disk storage)
- `GET /api/download/link?url=<post_url>&quality=<best|worst|height|heightp>` - Resolves a direct progressive MP4 URL for TikTok, Instagram, Facebook, X/Twitter, or LinkedIn. `quality` accepts the exact `"<n>p"` label `GET /api/info` shows (e.g. `720p`) or a bare height (`720`).
  - `200` → `{ platform, contentType, title, quality, fileSize, note, expiresAt, requestHeaders, downloadUrl }` - `quality` is a `"720p"`-style short-edge label (`null` if no real resolution is available even after an ffprobe fallback), `fileSize` is the real size in MB via a `HEAD` request to the CDN URL (never estimated).
  - `400` → invalid URL or quality (`INVALID_URL` / `INVALID_QUALITY`)
  - `422` → unsupported host (`UNSUPPORTED_DIRECT_LINK_PLATFORM`) or no qualifying format found (`DIRECT_LINK_UNAVAILABLE`)
  - `502` → yt-dlp failed to start or extract (`YTDLP_START_FAILED` / `YTDLP_EXTRACTOR_FAILED`)

### Disk-based download
- `POST /api/download` - Synchronous: downloads `{ url, quality, audioOnly, format }` and responds only once finished.
  - `200` → `{ downloadId, platform, contentType, title, quality, fileSize, storage, downloadUrl }` - `quality`/`fileSize` are read from the actual finished file (`null` quality for audio-only), `downloadUrl` is a relative path to `GET /api/download/:filename` (or a presigned B2 URL if B2 is configured), `platform` is `null` outside the 5 platforms `/link` supports.
  - `400` → missing/invalid URL. `502` → yt-dlp failed, or the B2 upload failed after the download itself succeeded.
  - The finished file is deleted automatically `AUTO_CLEANUP_DELAY_MS` (default 45s) after this response.
- `GET /api/download/:filename` - Fetch a finished download's bytes. `404` once the auto-cleanup window has passed.
- `GET /api/download/list` - List downloaded files
- `DELETE /api/download/:filename` - Delete a downloaded file

### Information Endpoints
- `GET /api/info?url=<video_url>` - Get video information
- `GET /api/info/playlist?url=<playlist_url>` - Get playlist information

### Format Endpoints
- `GET /api/formats?url=<video_url>` - Get available formats
- `GET /api/formats/quality-presets` - Get quality presets

## Testing

```bash
npm test
```

Runs the Node built-in test runner (`node --test`) over `test/*.test.js`.

## Supported Sites

`POST /api/download` and `GET /api/info`/`/api/formats` support the same sites as yt-dlp (1000+). `GET /api/download/link` is scoped to TikTok, Instagram, Facebook, X/Twitter, and LinkedIn only.

Run `yt-dlp --list-extractors` for yt-dlp's full site list.

## Deploying to Railway

Railway's zero-config builders (Nixpacks, and its replacement Railpack) only detect the Node app - neither installs yt-dlp/ffmpeg on its own, and Railway has been observed silently switching which one it uses between builds. `railway.json` pins the builder explicitly to `DOCKERFILE` so that never happens again, and the committed `Dockerfile` installs yt-dlp (the standalone `yt-dlp_linux` binary release - not the plain `yt-dlp` asset, which is a Python script that needs a separate `python3`) and ffmpeg alongside Node.

## Troubleshooting

1. **yt-dlp not found (`spawn yt-dlp ENOENT`) or `python3: No such file or directory`:** ensure yt-dlp (and ffmpeg) is actually installed and in PATH - test with `yt-dlp --version`. On Railway, check the build logs actually say they're building from the `Dockerfile` (not Nixpacks/Railpack) and that the `curl`/`apt-get` steps installing `yt-dlp`/`ffmpeg` ran.
2. **ffprobe not found:** ambiguous direct-link formats will fail verification and fall through to `DIRECT_LINK_UNAVAILABLE` - install ffmpeg and ensure it's in PATH.
3. **Permission errors:** check write permissions for `DOWNLOADS_DIR`.
4. **Download failures:** check if the URL is supported and reachable - some sites require authentication yt-dlp doesn't have.

## License

This project is licensed under the WTFPL - see [LICENSE](LICENSE) for details.

## Acknowledgments

- **[JunkFood02/Seal](https://github.com/JunkFood02/Seal)** - this project's idea and core functionality are based on this Android application
- **yt-dlp** team for the download engine

---

**Note:** For personal use only. Please respect copyright laws and platform terms of service.
