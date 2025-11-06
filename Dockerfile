# Use official Node.js runtime as base (matches Render's Node 25)
FROM node:25-alpine

# Install system deps (Alpine for lighter image; apt-like with apk)
RUN apk add --no-cache ffmpeg python3 py3-pip

# Install yt-dlp via pip
RUN pip3 install --upgrade yt-dlp

# Set working dir
WORKDIR /app

# Copy package.json & lock (from server/) first for caching
COPY server/package*.json ./

# Install Node deps
RUN npm ci --only=production

# Copy app code (server/ + public/)
COPY server/ ./server/
COPY public/ ./public/

# Expose port (Render uses $PORT env)
EXPOSE $PORT

# Start command
CMD ["npm", "start"]