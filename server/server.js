// server/server.js
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import { pipeline } from "node:stream";
import { request as httpRequest } from "node:https";
import { request as httpRequestInsecure } from "node:http";
import { PassThrough } from "node:stream";
import { URL } from "node:url";
import pLimit from "p-limit";
// REMOVED: ytdl import (no longer needed)
import {
  isValidUrl, isAllowedHost,
  isLikelyImage, isLikelyVideo, isLikelyAudio, isYouTubeUrl
} from "./validators.js";
import { transcodeVideo, extractAudio } from "./ffmpegService.js";
import { ffprobe } from "./probe.js"; // Handles YouTube/direct metadata

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5050;
const MAX_IMAGE_MB = parseInt(process.env.MAX_IMAGE_MB || "100", 10);
const MAX_VIDEO_MB = parseInt(process.env.MAX_VIDEO_MB || "2048", 10);
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

const limit = pLimit(4);

// ---------- helpers ----------
function fetchHead(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const libReq = (u.protocol === "https:") ? httpRequest : httpRequestInsecure;
    const req = libReq({ method: "HEAD", hostname: u.hostname, path: u.pathname + u.search, protocol: u.protocol, port: u.port, headers: { "User-Agent": "MediaDownloader/1.0" }}, res => {
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
}

export function fetchGetStream(url) {
  const u = new URL(url);
  const libReq = (u.protocol === "https:") ? httpRequest : httpRequestInsecure;
  const pt = new PassThrough();
  const req = libReq({
    method: "GET",
    hostname: u.hostname,
    path: u.pathname + u.search,
    protocol: u.protocol,
    port: u.port,
    headers: { "User-Agent": "MediaDownloader/1.0" }
  }, res => {
    if ((res.statusCode || 0) >= 400) {
      pt.destroy(new Error(`Upstream returned ${res.statusCode}`));
      return;
    }
    res.pipe(pt);
  });
  req.on("error", (e) => pt.destroy(e));
  req.end();
  return pt;
}

// ===== Progress (SSE) registry =====
const jobs = new Map();

function sseHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/progress", (req, res) => {
  const { jobId } = req.query;
  if (!jobId) return res.status(400).end("jobId required");
  let job = jobs.get(jobId);
  if (!job) {
    job = { duration: undefined, lastTime: 0, listeners: new Set(), done: false };
    jobs.set(jobId, job);
  }

  sseHeaders(res);
  job.listeners.add(res);

  sseSend(res, "snapshot", {
    duration: job.duration ?? null,
    timeSeconds: job.lastTime ?? 0,
    progress: job.duration ? Math.min(100, Math.round((job.lastTime / job.duration) * 100)) : null,
    done: job.done
  });

  req.on("close", () => {
    job.listeners.delete(res);
  });
});

function notify(jobId, event, payload) {
  const job = jobs.get(jobId);
  if (!job) return;
  for (const r of job.listeners) sseSend(r, event, payload);
}

// ===== API endpoints =====

app.get("/api/probe", async (req, res) => {
  const { url } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  if (!isAllowedHost(url, ALLOWED_HOSTS)) return res.status(403).json({ error: "Host not allowed." });

  try {
    const meta = await ffprobe(url);
    res.json(meta);
  } catch (e) {
    res.status(500).json({ error: e.message || "Probe failed" });
  }
});

app.get("/api/image", async (req, res) => {
  const { url } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  if (!isAllowedHost(url, ALLOWED_HOSTS)) return res.status(403).json({ error: "Host not allowed." });
  if (isYouTubeUrl(url)) return res.status(415).json({ error: "Use /api/video for YouTube." });

  try {
    const head = await fetchHead(url);
    const size = parseInt(head.headers["content-length"] || "0", 10);
    const type = (head.headers["content-type"] || "").toLowerCase();

    if (!isLikelyImage(type)) return res.status(415).json({ error: "Not an image URL." });
    if (size && size > MAX_IMAGE_MB * 1024 * 1024) return res.status(413).json({ error: "Image too large." });

    res.setHeader("Content-Type", type || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="image${extFromType(type)}"`);
    pipeline(fetchGetStream(url), res, (err) => { if (err) console.error(err); });
  } catch (e) {
    res.status(500).json({ error: e.message || "Image fetch failed" });
  }
});

// UPDATED: Unified via probe (no ytdl; service handles YouTube streams)
app.get("/api/video", async (req, res) => {
  const { url, quality = "1080p", format = "mp4", vcodec, jobId } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  if (!isAllowedHost(url, ALLOWED_HOSTS)) return res.status(403).json({ error: "Host not allowed." });

  const chosenV = (format === "webm")
    ? (vcodec === "av1" ? "av1" : "vp9")
    : "h264";

  const filename = `video_${quality}.${format === "webm" ? "webm" : "mp4"}`;
  res.setHeader("Content-Type", format === "webm" ? "video/webm" : "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  try {
    // UPDATED: Use probe for all metadata (duration, size estimate)
    const meta = await ffprobe(url);
    let durationSec = parseFloat(meta?.format?.duration);
    let sizeMB = undefined;
    if (isYouTubeUrl(url)) {
      // Estimate size for YouTube (bit_rate * duration / 8 / 1024^2)
      const bitRate = meta?.format?.bit_rate || 2500000; // Default 2.5Mbps fallback
      sizeMB = (bitRate * durationSec) / 8 / 1024 / 1024;
    } else {
      // Direct: Use HEAD
      const head = await fetchHead(url);
      sizeMB = parseInt(head.headers["content-length"] || "0", 10) / (1024 * 1024);
      const type = (head.headers["content-type"] || "").toLowerCase();
      if (!(isLikelyVideo(type) || isLikelyAudio(type))) return res.status(415).json({ error: "Not a video URL." });
    }
    if (sizeMB && sizeMB > MAX_VIDEO_MB) return res.status(413).json({ error: "Video too large." });

    // Job setup
    if (jobId) {
      let job = jobs.get(jobId) || { duration: durationSec, lastTime: 0, listeners: new Set(), done: false };
      job.duration = durationSec ?? job.duration;
      jobs.set(jobId, job);
    }

    await limit(() => new Promise((resolve, reject) => {
      const { stream } = transcodeVideo({
        url,
        quality,
        format: format === "webm" ? "webm" : "mp4",
        vcodec: chosenV,
        onProgress: (p) => {
          if (!jobId) return;
          const job = jobs.get(jobId);
          if (!job) return;
          job.lastTime = p.timeSeconds ?? job.lastTime;
          const progress = job.duration ? Math.min(100, Math.round((job.lastTime / job.duration) * 100)) : (p.progress ?? null);
          notify(jobId, "update", { ...p, duration: job.duration ?? null, progress });
        }
      });

      pipeline(stream, res, (err) => {
        if (jobId) {
          const job = jobs.get(jobId);
          if (job) {
            job.done = !err;
            notify(jobId, err ? "error" : "done", err ? { message: String(err) } : { ok: true });
            setTimeout(() => jobs.delete(jobId), 60_000);
          }
        }
        if (err) reject(err); else resolve();
      });
    }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message || "Video failed" });
  }
});

// UPDATED: Unified via probe
app.get("/api/audio", async (req, res) => {
  const { url, kbps = "320", codec = "mp3", jobId } = req.query;
  if (!isValidUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  if (!isAllowedHost(url, ALLOWED_HOSTS)) return res.status(403).json({ error: "Host not allowed." });

  try {
    // UPDATED: Use probe for all
    const meta = await ffprobe(url);
    let durationSec = parseFloat(meta?.format?.duration);
    let sizeMB = undefined;
    if (isYouTubeUrl(url)) {
      const bitRate = meta?.format?.bit_rate || 2500000;
      sizeMB = (bitRate * durationSec) / 8 / 1024 / 1024;
    } else {
      const head = await fetchHead(url);
      sizeMB = parseInt(head.headers["content-length"] || "0", 10) / (1024 * 1024);
      const type = (head.headers["content-type"] || "").toLowerCase();
      if (!(isLikelyVideo(type) || isLikelyAudio(type))) return res.status(415).json({ error: "Not a video/audio URL." });
    }
    if (sizeMB && sizeMB > MAX_VIDEO_MB) return res.status(413).json({ error: "Source too large." });

    const ext = codec === "opus" ? "opus" : "mp3";
    res.setHeader("Content-Type", codec === "opus" ? "audio/ogg" : "audio/mpeg");
    res.setHeader("Content-Disposition", `attachment; filename="audio_${kbps}k.${ext}"`);

    if (jobId) {
      let job = jobs.get(jobId) || { duration: durationSec, lastTime: 0, listeners: new Set(), done: false };
      job.duration = durationSec ?? job.duration;
      jobs.set(jobId, job);
    }

    await limit(() => new Promise((resolve, reject) => {
      const { stream } = extractAudio({
        url,
        kbps: parseInt(kbps, 10),
        codec,
        onProgress: (p) => {
          if (!jobId) return;
          const job = jobs.get(jobId);
          if (!job) return;
          job.lastTime = p.timeSeconds ?? job.lastTime;
          const progress = job.duration ? Math.min(100, Math.round((job.lastTime / job.duration) * 100)) : (p.progress ?? null);
          notify(jobId, "update", { ...p, duration: job.duration ?? null, progress });
        }
      });

      pipeline(stream, res, (err) => {
        if (jobId) {
          const job = jobs.get(jobId);
          if (job) {
            job.done = !err;
            notify(jobId, err ? "error" : "done", err ? { message: String(err) } : { ok: true });
            setTimeout(() => jobs.delete(jobId), 60_000);
          }
        }
        if (err) reject(err); else resolve();
      });
    }));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e.message || "Audio extract failed" });
  }
});

function extFromType(ct) {
  const base = (ct || "").split(";")[0];
  const map = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg"
  };
  return map[base] || "";
}

app.use(express.static(path.join(__dirname, "..", "public")))

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});