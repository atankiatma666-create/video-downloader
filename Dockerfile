# Node 22 on Debian slim: small, glibc-based, and new enough for yt-dlp's
# JavaScript challenge solver (which runs on Node).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000

# System dependencies in one layer:
#   ffmpeg          -> merges video-only + audio streams
#   python3         -> runs the yt-dlp release (zipapp, works on amd64 and arm64)
#   ca-certificates -> HTTPS to video sites
#   curl            -> only to fetch yt-dlp, removed afterwards
# /etc/yt-dlp.conf tells yt-dlp to use Node for YouTube's JS challenges.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && echo "--js-runtimes node --remote-components ejs:github" > /etc/yt-dlp.conf \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so this layer is cached between code changes.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

COPY --chown=node:node . .

# Run as the unprivileged user that ships with the Node image.
USER node

EXPOSE 8000
CMD ["node", "server.js"]

