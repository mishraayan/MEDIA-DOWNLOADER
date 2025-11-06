FROM node:25-alpine

# Install system deps (Alpine for speed; includes FFmpeg/Python)
RUN apk add --no-cache ffmpeg python3 py3-pip

# Install yt-dlp
RUN pip3 install --upgrade yt-dlp

# Set working dir
WORKDIR /app

# Copy package.json (caches npm install)
COPY server/package*.json ./

# Install Node deps
RUN npm ci --only=production

# Copy app code
COPY server/ ./server/
COPY public/ ./public/

# Expose dynamic port
EXPOSE $PORT

# Start server
CMD ["npm", "start"]