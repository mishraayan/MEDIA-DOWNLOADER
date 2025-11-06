// server/probe.js
import { spawn } from "node:child_process";
import { isYouTubeUrl } from "./validators.js";
import ytDlp from "yt-dlp-exec"; // NEW: yt-dlp wrapper

export async function ffprobe(url) {
  if (isYouTubeUrl(url)) {
    console.log(`[probe] Handling YouTube: ${url}`);
    try {
      // NEW: yt-dlp for metadata (dump-json = no download, just info)
      const output = await ytDlp.exec([url, "--dump-json", "--no-warnings"]);
      const jsonStr = output.stdout.toString();
      const info = JSON.parse(jsonStr); // Single video JSON

      const duration = parseFloat(info.duration);
      if (isNaN(duration)) throw new Error("Could not extract duration");

      // Estimate bit_rate from filesize (yt-dlp provides it)
      const bitRateEstimate = info.filesize_approx ? Math.round((info.filesize_approx * 8) / (duration * 1000)) : undefined;

      // Build streams (pick first format with video+audio)
      const format = info.formats.find(f => f.vcodec !== 'none' && f.acodec !== 'none') || info.formats[0];
      const streams = [];
      if (format.vcodec !== 'none') {
        streams.push({
          codec_type: "video",
          codec_name: format.vcodec,
          width: format.width,
          height: format.height
        });
      }
      if (format.acodec !== 'none') {
        streams.push({
          codec_type: "audio",
          codec_name: format.acodec
        });
      }

      const result = {
        format: { duration, bit_rate: bitRateEstimate },
        streams,
        title: info.title,
        thumbnail: info.thumbnail // Largest available
      };
      console.log(`[probe] yt-dlp result:`, { title: result.title, duration });
      return result;
    } catch (e) {
      console.error(`[probe] yt-dlp error for ${url}:`, e.message);
      const msg = e.message?.includes("Private") ? "Video is private or unavailable" :
                  e.message?.includes("deleted") ? "Video removed or age-restricted" :
                  `YouTube probe failed: ${e.message}`;
      throw new Error(msg);
    }
  }

  // Direct media (unchanged)
  console.log(`[probe] Handling direct: ${url}`);
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration,bit_rate:stream=codec_name,codec_type,width,height",
      "-of", "json",
      url
    ];
    const p = spawn("ffprobe", args);
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => {
      if (code === 0) {
        try { 
          const parsed = JSON.parse(out);
          if (parsed.format) {
            parsed.format.duration = parseFloat(parsed.format.duration);
            parsed.format.bit_rate = parseInt(parsed.format.bit_rate, 10);
          }
          parsed.streams?.forEach(s => {
            if (s.width) s.width = parseInt(s.width, 10);
            if (s.height) s.height = parseInt(s.height, 10);
          });
          resolve({ ...parsed, title: null, thumbnail: null }); // Consistent shape
        } catch (e) { reject(e); }
      } else {
        reject(new Error(err || `ffprobe exited with ${code}`));
      }
    });

    const timeout = setTimeout(() => {
      p.kill("SIGTERM");
      reject(new Error("ffprobe timed out after 30s"));
    }, 30000);
    p.on("close", () => clearTimeout(timeout));
  });
}