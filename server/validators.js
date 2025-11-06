// validators.js
const URL_PATTERN = /^https?:\/\/[^\s]+$/i; // FIXED: Allow ?# in paths/queries
const IMAGE_TYPES = new Set([
  "image/jpeg","image/png","image/webp","image/gif","image/avif","image/bmp","image/tiff","image/svg+xml"
]);
const VIDEO_TYPES = new Set([
  "video/mp4","video/webm","video/ogg","video/quicktime","video/x-matroska"
]);
const AUDIO_TYPES = new Set([
  "audio/mpeg","audio/webm","audio/ogg","audio/aac","audio/wav","audio/mp4"
]);

export function isValidUrl(u) {
  return URL_PATTERN.test(u);
}

export function isAllowedHost(u, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  try {
    const host = new URL(u).hostname.toLowerCase();
    return allowedHosts.some(h => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()));
  } catch { return false; }
}

export function isLikelyImage(contentType) {
  return contentType && IMAGE_TYPES.has(contentType.split(";")[0].toLowerCase());
}
export function isLikelyVideo(contentType) {
  return contentType && VIDEO_TYPES.has(contentType.split(";")[0].toLowerCase());
}
export function isLikelyAudio(contentType) {
  return contentType && AUDIO_TYPES.has(contentType.split(";")[0].toLowerCase());
}

export function qualityToScale(quality) {
  const map = {
    "2160p": 2160,
    "1440p": 1440,
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
    "360p": 360
  };
  return map[quality] || 1080;
}

export function qualityToYtdlFilter(quality) {
  const map = {
    "2160p": "highest",
    "1440p": "137",
    "1080p": "137",
    "720p": "22",
    "480p": "18",
    "360p": "18"
  };
  return map[quality] || "medium";
}

export function audioKbpsToBitrate(kbps) {
  const allowed = [512, 320, 256, 192, 160, 128];
  const k = parseInt(kbps, 10);
  if (!allowed.includes(k)) {
    console.warn(`Invalid bitrate ${kbps}k; clamping to 320k`);
    return 320;
  }
  return k;
}

export function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host.includes('youtube') || host.includes('youtu.be');
  } catch {
    return false;
  }
}