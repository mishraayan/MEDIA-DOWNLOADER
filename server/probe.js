// server/probe.js
import { spawn } from "node:child_process";
import { isYouTubeUrl } from "./validators.js";

export async function ffprobe(url) {
  if (isYouTubeUrl(url)) {
    console.log(`[probe] Handling YouTube: ${url}`);
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 3;
      const retryDelay = 2000;

      const tryProbe = () => {
        attempts++;
        try {
          const binary = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
          const args = [
            url,
            "--dump-json",
            "--no-warnings",
            "--cookies", "/etc/secrets/cookies", // Load cookies
            "--no-save-cookies", // FIXED: Prevent write to read-only file
            "--socket-timeout", "60",
            "--fragment-retries", "5"
          ];
          const p = spawn(binary, args);

          let out = "", err = "";
          p.stdout.on("data", d => out += d.toString());
          p.stderr.on("data", d => err += d.toString());

          p.on('error', (e) => {
            console.error(`[probe] Spawn error (attempt ${attempts}): ${e.message}`);
            if (attempts < maxAttempts) {
              console.log(`[probe] Retrying in ${retryDelay * attempts}ms...`);
              setTimeout(tryProbe, retryDelay * attempts);
            } else {
              reject(new Error("YouTube access failed after retries. Check cookies or try a different URL."));
            }
          });

          p.on("close", code => {
            if (code === 0) {
              try {
                const info = JSON.parse(out);
                const duration = parseFloat(info.duration);
                if (isNaN(duration)) throw new Error("Could not extract duration");

                const bitRateEstimate = info.filesize_approx ? Math.round((info.filesize_approx * 8) / (duration * 1000)) : undefined;

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
                  thumbnail: info.thumbnail
                };
                console.log(`[probe] yt-dlp result:`, { title: result.title, duration });
                resolve(result);
              } catch (e) {
                if (attempts < maxAttempts) {
                  console.log(`[probe] Parse error (attempt ${attempts}), retrying...`);
                  setTimeout(tryProbe, retryDelay * attempts);
                } else {
                  reject(e);
                }
              }
            } else {
              const errorMsg = err.toString();
              console.error(`[probe] yt-dlp exited with ${code} (attempt ${attempts}): ${errorMsg}`);
              if (errorMsg.includes("Sign in to confirm you’re not a bot") || errorMsg.includes("bot")) {
                reject(new Error("YouTube bot detection triggered. Update cookies in Render Secrets and retry."));
              } else if (attempts < maxAttempts) {
                console.log(`[probe] Retrying in ${retryDelay * attempts}ms...`);
                setTimeout(tryProbe, retryDelay * attempts);
              } else {
                reject(new Error(errorMsg || `yt-dlp failed after ${maxAttempts} attempts`));
              }
            }
          });

          const timeout = setTimeout(() => {
            p.kill("SIGTERM");
            if (attempts < maxAttempts) {
              console.log(`[probe] Timeout (attempt ${attempts}), retrying...`);
              clearTimeout(timeout);
              setTimeout(tryProbe, retryDelay * attempts);
            } else {
              reject(new Error("yt-dlp timed out after 60s and retries"));
            }
          }, 60000);
          p.on("close", () => clearTimeout(timeout));
        } catch (e) {
          if (attempts < maxAttempts) {
            console.log(`[probe] Try error (attempt ${attempts}), retrying...`);
            setTimeout(tryProbe, retryDelay * attempts);
          } else {
            reject(new Error(`Spawn failed after retries: ${e.message}`));
          }
        }
      };

      tryProbe();
    });
  }

  // Direct media (ffprobe fallback)
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
    p.on('error', (e) => reject(new Error(`ffprobe spawn failed: ${e.message}`)));
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
          resolve({ ...parsed, title: null, thumbnail: null });
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
