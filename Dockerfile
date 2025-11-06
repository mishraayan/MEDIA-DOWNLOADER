FROM node:25

# Install system deps (apt for FFmpeg/Python/pipx)
RUN apt-get update -y && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    pipx && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install yt-dlp via pipx (isolated, no system conflict)
RUN pipx install yt-dlp

# Ensure pipx bin in PATH
ENV PATH="/root/.local/bin:$PATH"

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
