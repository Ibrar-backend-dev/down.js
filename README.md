# Seal Web App

A REST API for downloading video/audio via [yt-dlp](https://github.com/yt-dlp/yt-dlp), inspired by the [Seal Android app](https://github.com/JunkFood02/Seal) by JunkFood02. API-only - there is no bundled frontend; consume it from your own client, a tool like curl/Insomnia, or a frontend you build separately.

## Features

### 🎥 Video/Audio Downloading
- Download videos from 1000+ supported sites including YouTube, Vimeo, TikTok, and more
- Audio-only downloads with format selection (MP3, M4A, FLAC, etc.)
- Video quality selection (4K, 1080p, 720p, etc.)
- Real-time download progress over Socket.IO

### 🔗 Direct-link resolution
- `GET /api/download/link` resolves a single, direct, progressive (video+audio) HTTPS MP4 URL - no server-side download, no disk storage - for TikTok, Instagram, Facebook, X/Twitter, and LinkedIn
- Ambiguous formats (missing codec metadata) are verified with a live `ffprobe` check before being trusted
- TikTok responses include `requestHeaders` (Cookie + Referer) - TikTok's CDN requires them on the follow-up request or it returns 403

### 📁 File Management
- Download history with file details (`GET /api/download/list`)
- File size and creation date tracking
- Easy file deletion (`DELETE /api/download/:filename`)

## Tech Stack

- **Node.js** with Express.js
- **Socket.IO** for real-time download progress
- **yt-dlp** as the download engine
- **ffprobe** (from ffmpeg) for verifying ambiguous direct-link formats
- **Helmet** for security headers
- **CORS** for cross-origin requests
- **Morgan** for logging

## Prerequisites

1. **Node.js** (v20.6+ recommended; the app uses `--env-file-if-exists` and the built-in test runner)
2. **npm**
3. **yt-dlp** installed and available in PATH
4. **ffmpeg/ffprobe** installed and available in PATH (used for audio extraction/merging and direct-link format verification)

### Installing yt-dlp

#### On Ubuntu/Debian:
```bash
sudo apt update
sudo apt install yt-dlp
```

#### On macOS:
```bash
brew install yt-dlp
```

#### On Windows:
Download from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases) and add to PATH.

## Installation

```bash
npm install
```

Or run `./setup.sh`, which also installs yt-dlp if missing, creates the `downloads/` directory, and copies `.env.example` to `.env`.

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```env
PORT=5000
NODE_ENV=development
DOWNLOADS_DIR=./downloads
SOCKET_CORS_ORIGIN=*
```

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port the API listens on | `5000` |
| `NODE_ENV` | `development` \| `production` - affects logging verbosity | `development` |
| `DOWNLOADS_DIR` | Local-storage fallback: where files are written/read/deleted when B2 (below) isn't configured | `./downloads` |
| `SOCKET_CORS_ORIGIN` | Allowed origin for the Socket.IO progress channel | `*` |

`.env` is gitignored - it's loaded automatically via Node's `--env-file-if-exists` flag (see the `dev`/`start` scripts), no extra setup needed beyond creating the file.

For production, see `.env.production.example` instead - it covers the same variables with production-appropriate values (real `SOCKET_CORS_ORIGIN`, a note on why `PORT` usually shouldn't be set on PaaS hosts, and why local `DOWNLOADS_DIR` storage is risky wherever the filesystem is ephemeral).

### Storage: local disk vs. Backblaze B2

By default, `POST /api/download` writes files to `DOWNLOADS_DIR` on local disk, and `GET /list`/`DELETE` read from and delete there too. Setting all four B2 variables switches storage to a [Backblaze B2](https://www.backblaze.com/cloud-storage) bucket instead, via its S3-compatible API - B2 becomes the only place finished files live (yt-dlp always downloads to local disk first since it has no B2-aware output mode, but the file is uploaded and the local copy deleted as soon as the download completes):

| Variable | Purpose |
|---|---|
| `B2_KEY_ID` | Application Key ID from the B2 dashboard (Account → App Keys) |
| `B2_APPLICATION_KEY` | The matching Application Key secret |
| `B2_BUCKET` | Bucket name |
| `B2_ENDPOINT` | Bucket's S3-compatible endpoint, e.g. `https://s3.us-west-002.backblazeb2.com` (shown on the bucket's details page) |
| `B2_REGION` | Defaults to `us-west-002` if unset - set to match your bucket's actual region if different |

Leave any of these unset to keep using local disk storage - it's an all-or-nothing switch, not a supplement.

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
- `GET /api/download/link?url=<post_url>&quality=<best|worst|height>` - Resolves a direct progressive MP4 URL for TikTok, Instagram, Facebook, X/Twitter, or LinkedIn.
  - `200` → `{ downloadUrl, filename, contentType, platform, quality, expiresAt, requestHeaders, note }`
  - `400` → invalid URL or quality (`INVALID_URL` / `INVALID_QUALITY`)
  - `422` → unsupported host (`UNSUPPORTED_DIRECT_LINK_PLATFORM`) or no qualifying format found (`DIRECT_LINK_UNAVAILABLE`)
  - `502` → yt-dlp failed to start or extract (`YTDLP_START_FAILED` / `YTDLP_EXTRACTOR_FAILED`)

### Disk-based download
- `POST /api/download` - Start a download (`{ url, quality, audioOnly, format }`); progress is reported over Socket.IO (`download-start`/`download-progress`/`download-complete`/`download-error`), the file lands in `DOWNLOADS_DIR`
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

`POST /api/download` and `GET /api/info`/`/api/formats` support the same sites as yt-dlp (1000+, including YouTube, Vimeo, TikTok, Instagram, Twitter/X, Facebook, Twitch). `GET /api/download/link` is intentionally scoped to TikTok, Instagram, Facebook, X/Twitter, and LinkedIn only.

For yt-dlp's full site list, run: `yt-dlp --list-extractors`

## Security Considerations

- Input validation for URLs and quality values
- File path sanitization (`DELETE /api/download/:filename` is confined to `DOWNLOADS_DIR`)
- CORS configuration
- Helmet security headers
- No arbitrary command execution

## Troubleshooting

1. **yt-dlp not found:** ensure it's installed and in your PATH - test with `yt-dlp --version`.
2. **ffprobe not found:** ambiguous direct-link formats will fail verification and fall through to `DIRECT_LINK_UNAVAILABLE` - install ffmpeg (which bundles ffprobe) and ensure it's in PATH.
3. **Permission errors:** check write permissions for `DOWNLOADS_DIR`.
4. **Download failures:** check if the URL is supported, verify internet connectivity - some sites require authentication yt-dlp doesn't have.

## License

This project is licensed under the WTFPL - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- **[JunkFood02/Seal](https://github.com/JunkFood02/Seal)** - this project's idea and core functionality are based on this excellent Android application
- **yt-dlp** team for the powerful download engine

---

**Note:** This application is for personal use only. Please respect copyright laws and terms of service of the platforms you download content from.
