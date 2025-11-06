// server/ffmpegService.js
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { qualityToScale, qualityToYtdlFilter, audioKbpsToBitrate } from "./validators.js";
import { fetchGetStream } from "./server.js";
import { isYouTubeUrl } from "./validators.js";

/**
 * Build FFmpeg args for different video formats/codecs.
 * Assumes input via pipe:0 (stdin).
 */
function videoArgs({ height, format = "mp4", vcodec = "h264" }) {
  const common = [
    "-hide_banner",
    "-y",
    "-i", "pipe:0",
    "-map", "0:v:0?",
    "-map", "0:a:0?",
    "-pix_fmt", "yuv420p",
    "-vf", `scale='trunc(oh*a/2)*2':${height}`,
    "-max_muxing_queue_size", "9999",
  ];

  if (format === "mp4" && vcodec === "h264") {
    return [
      ...common,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-profile:v", "high",
      "-level", "4.2",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+frag_keyframe+empty_moov",
      "-f", "mp4",
      "pipe:1"
    ];
  }

  if (format === "webm" && vcodec === "vp9") {
    return [
      ...common,
      "-c:v", "libvpx-vp9",
      "-b:v", "0",
      "-crf", "32",
      "-row-mt", "1",
      "-cpu-used", "4",
      "-c:a", "libopus",
      "-b:a", "160k",
      "-f", "webm",
      "pipe:1"
    ];
  }

  if (format === "webm" && vcodec === "av1") {
    return [
      ...common,
      "-c:v", "libaom-av1",
      "-b:v", "0",
      "-crf", "30",
      "-cpu-used", "6",
      "-c:a", "libopus",
      "-b:a", "160k",
      "-f", "webm",
      "pipe:1"
    ];
  }

  throw new Error(`Unsupported format/vcodec: ${format}/${vcodec}`);
}

export function transcodeVideo({ url, quality, format = "mp4", vcodec = "h264", onProgress }) {
  const height = qualityToScale(quality);
  const pt = new PassThrough();
  const args = videoArgs({ height, format, vcodec });

  // Resolve input stream
  let inputStream;
  let ytdlpProc;
  if (isYouTubeUrl(url)) {
    const filter = qualityToYtdlFilter(quality);
    const ytdlpArgs = [
      url,
      `-f`, `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/${filter}`,
      `-o`, `-`, // Pipe to stdout
      `--no-warnings`,
      `--quiet`,
      `--cookies`, `/etc/secrets/cookies`  // FIXED: Add cookies for bot bypass
    ];
    // FIXED: Native spawn for streaming (yt-dlp CLI)
    const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    ytdlpProc = spawn(binary, ytdlpArgs);
    inputStream = ytdlpProc.stdout;

    // Progress: Parse stderr for download %
    ytdlpProc.stderr.setEncoding("utf8");
    ytdlpProc.stderr.on("data", (chunk) => {
      if (!onProgress) return;
      const progressMatch = chunk.match(/\[download\]\s*(\d+(?:\.\d+)?)%/);
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        onProgress({
          phase: 'download',
          progress: Math.round(percent)
        });
      }
    });

    ytdlpProc.on('error', (e) => pt.destroy(e));
  } else {
    inputStream = fetchGetStream(url);
  }

  const ff = spawn("ffmpeg", args);
  inputStream.pipe(ff.stdin);
  ff.stdout.pipe(pt);

  // Progress parsing (transcode)
  let progressPhase = isYouTubeUrl(url) ? 'transcode' : 'stream';
  ff.stderr.setEncoding("utf8");
  ff.stderr.on("data", (chunk) => {
    if (!onProgress) return;
    const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
    const fpsMatch = chunk.match(/fps=\s*([\d.]+)/);
    const speedMatch = chunk.match(/speed=\s*([\d.]+)x/);
    const bitrateMatch = chunk.match(/bitrate=\s*([\d.]+\s*\w?bits\/s)/i);

    if (timeMatch) {
      const [ , hh, mm, ss ] = timeMatch;
      const seconds = (parseInt(hh) * 3600) + (parseInt(mm) * 60) + parseFloat(ss);
      onProgress({
        phase: progressPhase,
        timeSeconds: seconds,
        fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
        speed: speedMatch ? parseFloat(speedMatch[1]) : undefined,
        bitrate: bitrateMatch ? bitrateMatch[1] : undefined
      });
    }
  });

  ff.on("error", (e) => pt.destroy(e));
  ff.on("close", (code) => {
    if (code !== 0) pt.destroy(new Error(`ffmpeg exited with code ${code}`));
    pt.end();
  });

  // Cleanup
  inputStream.on('end', () => ff.stdin.end());
  inputStream.on('error', (e) => { ff.stdin.end(); pt.destroy(e); });
  if (ytdlpProc) ytdlpProc.on('close', () => inputStream.destroy());

  return { stream: pt, proc: ff };
}

export function extractAudio({ url, kbps = 320, codec = "mp3", onProgress }) {
  const pt = new PassThrough();
  const bitrate = audioKbpsToBitrate(kbps);
  let args;

  if (codec === "mp3") {
    args = [
      "-hide_banner", "-y",
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libmp3lame",
      "-b:a", `${bitrate}k`,
      "-movflags", "+faststart",
      "-f", "mp3",
      "pipe:1"
    ];
  } else if (codec === "opus") {
    args = [
      "-hide_banner", "-y",
      "-i", "pipe:0",
      "-vn",
      "-c:a", "libopus",
      "-b:a", `${bitrate}k`,
      "-f", "opus",
      "pipe:1"
    ];
  } else {
    throw new Error(`Unsupported audio codec: ${codec}`);
  }

  // Resolve input stream
  let inputStream;
  let ytdlpProc;
  if (isYouTubeUrl(url)) {
    const ytdlpArgs = [
      url,
      `-f`, `bestaudio[ext=m4a]/bestaudio/best`,
      `-o`, `-`,
      `--no-warnings`,
      `--quiet`,
      `--cookies`, `/etc/secrets/cookies`  // FIXED: Add cookies for bot bypass
    ];
    // FIXED: Native spawn
    const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    ytdlpProc = spawn(binary, ytdlpArgs);
    inputStream = ytdlpProc.stdout;

    ytdlpProc.stderr.setEncoding("utf8");
    ytdlpProc.stderr.on("data", (chunk) => {
      if (!onProgress) return;
      const progressMatch = chunk.match(/\[download\]\s*(\d+(?:\.\d+)?)%/);
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        onProgress({
          phase: 'download',
          progress: Math.round(percent)
        });
      }
    });

    ytdlpProc.on('error', (e) => pt.destroy(e));
  } else {
    inputStream = fetchGetStream(url);
  }

  const ff = spawn("ffmpeg", args);
  inputStream.pipe(ff.stdin);
  ff.stdout.pipe(pt);

  let progressPhase = isYouTubeUrl(url) ? 'transcode' : 'stream';
  ff.stderr.setEncoding("utf8");
  ff.stderr.on("data", (chunk) => {
    if (!onProgress) return;
    const timeMatch = chunk.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
    if (timeMatch) {
      const [ , hh, mm, ss ] = timeMatch;
      const seconds = (parseInt(hh) * 3600) + (parseInt(mm) * 60) + parseFloat(ss);
      onProgress({ phase: progressPhase, timeSeconds: seconds });
    }
  });

  ff.on("error", (e) => pt.destroy(e));
  ff.on("close", (code) => {
    if (code !== 0) pt.destroy(new Error(`ffmpeg exited with code ${code}`));
    pt.end();
  });

  inputStream.on('end', () => ff.stdin.end());
  inputStream.on('error', (e) => { ff.stdin.end(); pt.destroy(e); });
  if (ytdlpProc) ytdlpProc.on('close', () => inputStream.destroy());

  return { stream: pt, proc: ff };
}
