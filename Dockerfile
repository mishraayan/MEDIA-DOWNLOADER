FROM node:25

# Install system deps (Debian apt)
RUN apt-get update -y && apt-get install -y ffmpeg python3 python3-pip

# Install yt-dlp with no cache (avoids fetch issues)
RUN pip3 install --no-cache-dir --upgrade yt-dlp

# Set working dir
WORKDIR /app

# Copy package.json
COPY server/package*.json ./

# Install Node deps
RUN npm ci --only=production

# Copy app code
COPY server/ ./server/
COPY public/ ./public/

# Expose port
EXPOSE $PORT

# Start server
CMD ["npm", "start"]
