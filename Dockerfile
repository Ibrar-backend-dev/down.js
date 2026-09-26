# --- deps: install node dependencies (node-pty needs python3/build tools to compile its native addon) ---
FROM node:20-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# --- runtime: slim image with ffmpeg/yt-dlp and the already-built node_modules, no compilers ---
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp_linux (not the plain "yt-dlp" asset - that one is a Python zipapp
# that still needs a system python3 to run) is the actual standalone
# PyInstaller build with its own embedded Python - nothing else needed here.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV DOWNLOADS_DIR=/app/downloads
RUN mkdir -p /app/downloads

EXPOSE 5000

CMD ["node", "server/index.js"]
