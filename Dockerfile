FROM node:25

# Install system deps + pipx
RUN apt-get update -y && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    pip3 install --break-system-packages pipx  # pipx needs this once

# Install yt-dlp via pipx
RUN pipx install yt-dlp && pipx ensurepath

# FIXED: Ensure PATH includes pipx bin (runtime)
ENV PATH="/root/.local/bin:$PATH"

# Set working dir
WORKDIR /app

# Copy package.json
COPY server/package*.json ./

# Install Node deps
RUN npm ci --only=production --ignore-scripts

# Copy app code
COPY server/ ./server/
COPY public/ ./public/

# Expose port
EXPOSE $PORT

# Start server
CMD ["npm", "start"]
