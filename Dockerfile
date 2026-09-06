# DynamicTV: HDHomeRun -> HLS web player with synchronized playback.
# Debian-based so the stock ffmpeg has libx264, aac, VAAPI and (on most builds) NVENC.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    HLS_ROOT=/tmp/hls

EXPOSE 8080
CMD ["node", "server/index.js"]
