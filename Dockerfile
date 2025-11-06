# Dockerfile (put at repo root)
FROM node:20-bookworm-slim

# Install FFmpeg for transcoding
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# App root
WORKDIR /app

# Install server deps (where your package.json lives)
COPY server/package.json server/package-lock.json* ./server/
WORKDIR /app/server
RUN npm ci --omit=dev || npm i --omit=dev

# Copy source
WORKDIR /app
COPY server ./server
COPY public ./public

# Runtime config
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Start server
WORKDIR /app/server
CMD ["node", "server.js"]
