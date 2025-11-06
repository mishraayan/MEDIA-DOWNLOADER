FROM node:25

# Install system deps
RUN apt-get update -y && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && \
    ln -s /usr/bin/python3 /usr/bin/python  # Symlink for legacy 'python' binary
    && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pip (isolated)
RUN pip3 install --no-cache-dir --upgrade yt-dlp

# Set working dir
WORKDIR /app

# Copy package.json
COPY server/package*.json ./

# Install Node deps (ignore scripts to skip Python check if symlink fails)
RUN npm ci --only=production --ignore-scripts

# Copy app code
COPY server/ ./server/
COPY public/ ./public/

# Expose port
EXPOSE $PORT

# Start server
CMD ["npm", "start"]
