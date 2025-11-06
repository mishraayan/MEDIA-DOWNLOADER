const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const urlInput = $("#urlInput");
const analyzeBtn = $("#analyzeBtn");
const result = $("#result");
const detected = $("#detected");
const imageActions = $("#imageActions");
const imageOriginal = $("#imageOriginal");
const videoActions = $("#videoActions");
const audioActions = $("#audioActions");
const preview = $("#preview");

const progressWrap = $("#progressWrap");
const progressText = $("#progressText");
const progressBar = $("#progressBar");
const progressMeta = $("#progressMeta");

function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }

async function probe(url){
  const r = await fetch(`/api/probe?url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function head(url){
  try { return await probe(url); } catch (e) { throw e; } // UPDATED: Don't swallow; rethrow for handling
}

function looksLikeImage(u){
  return /\.(png|jpe?g|gif|webp|avif|bmp|tiff|svg)(\?.*)?$/i.test(u);
}
function looksLikeVideo(u){
  return /\.(mp4|webm|mov|mkv|ogg|m4v)(\?.*)?$/i.test(u);
}

// NEW: YouTube check (mirror backend for UI hints)
function isYouTubeUrl(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return host.includes('youtube') || host.includes('youtu.be');
  } catch { return false; }
}

function buildDownloadUrl(kind, params){
  const qs = new URLSearchParams(params).toString();
  return `/api/${kind}?${qs}`;
}

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11)
    .replace(/[018]/g, c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
}

let currentSSE;

function startProgress(jobId) {
  if (currentSSE) { currentSSE.close(); currentSSE = null; }
  show(progressWrap);
  progressBar.style.width = "0%";
  progressText.textContent = "Preparing…"; // UPDATED: Initial text
  progressMeta.textContent = "";

  const es = new EventSource(`/api/progress?jobId=${encodeURIComponent(jobId)}`);
  currentSSE = es;

  const update = (payload) => {
    const { progress, duration, timeSeconds, phase, fps, speed, bitrate } = payload;
    if (progress != null) {
      progressBar.style.width = `${progress}%`;
      progressText.textContent = `${progress}%`;
    }
    // UPDATED: Use phase for text (from ffmpegService)
    if (phase) {
      progressText.textContent = phase === 'download' ? 'Downloading…' : 
                                 phase === 'transcode' ? 'Transcoding…' : `${progress ?? 0}%`;
    }
    const parts = [];
    if (timeSeconds != null && duration) {
      const pct = Math.min(100, Math.round((timeSeconds/duration)*100));
      if (progress == null) {
        progressBar.style.width = `${pct}%`;
        progressText.textContent = `${pct}%`;
      }
    }
    if (fps) parts.push(`fps ${fps}`);
    if (speed) parts.push(`speed ${speed}x`);
    if (bitrate) parts.push(`bitrate ${bitrate}`);
    progressMeta.textContent = parts.join(" • ");
  };

  es.addEventListener("snapshot", (e) => update(JSON.parse(e.data)));
  es.addEventListener("update", (e) => update(JSON.parse(e.data)));
  es.addEventListener("done", (e) => {
    const data = JSON.parse(e.data);
    progressText.textContent = data.ok ? "Complete!" : "Error occurred.";
    progressBar.style.width = "100%";
    setTimeout(() => hide(progressWrap), 1200);
    es.close();
  });
  es.addEventListener("error", (e) => {
    progressMeta.textContent = "Connection lost. Retrying..."; // UPDATED: Friendlier
    // NEW: Simple reconnect (up to 3x)
    let retries = 0;
    const reconnect = () => {
      if (retries++ < 3) {
        setTimeout(() => startProgress(jobId), 1000);
      } else {
        progressText.textContent = "Failed to connect.";
        setTimeout(() => hide(progressWrap), 1600);
      }
    };
    es.onerror = reconnect;
    es.close();
  });
}

async function analyze(){
  const url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    alert("Please enter a valid http(s) direct URL.");
    return;
  }
  hide(imageActions); hide(videoActions); hide(audioActions); hide(preview);
  show(result);
  detected.textContent = isYouTubeUrl(url) ? "Analyzing YouTube video…" : "Detecting media type…"; // NEW: Hint

  let isImage = looksLikeImage(url);
  let isVideo = looksLikeVideo(url);
  let meta = null;
  let probeError = null;
  try { 
    meta = await head(url); 
  } catch (e) { 
    probeError = e.message; // NEW: Capture for display
  }

  if (isImage || (!isVideo && meta && meta.streams?.some(s => s.codec_type === "image" || s.codec_type === "video" && s.width < 50))) { // UPDATED: Tweak for small thumbs
    isImage = true; isVideo = false;
  } else if (isVideo || (meta && meta.streams?.some(s => s.codec_type === "video"))) {
    isVideo = true; isImage = false;
  }

  if (isImage) {
    detected.innerHTML = "Detected: <b>Image</b>";
    imageOriginal.href = buildDownloadUrl("image", { url });
    show(imageActions);

    const img = new Image();
    img.src = url; img.alt = "Preview image"; // NEW: Alt
    img.onload = () => { preview.innerHTML = ""; preview.appendChild(img); show(preview); };
    img.onerror = () => { preview.innerHTML = ""; hide(preview); };
  } else if (isVideo) {
    detected.innerHTML = `Detected: <b>Video</b>${meta?.title ? ` - ${meta.title}` : ''}`; // NEW: Show title from probe
    show(videoActions); show(audioActions);

    // Video buttons (unchanged)
    $$("#videoActions .btn").forEach(btn => {
      btn.onclick = () => {
        const quality = btn.getAttribute("data-quality");
        const format = btn.getAttribute("data-format");
        const vcodec = btn.getAttribute("data-vcodec");
        const jobId = uuid();
        startProgress(jobId);
        const dl = buildDownloadUrl("video", { url, quality, format, vcodec, jobId });
        window.open(dl, "_blank");
      };
    });

    // Audio buttons (unchanged)
    $$("#audioActions .btn").forEach(btn => {
      btn.onclick = () => {
        const kbps = btn.getAttribute("data-kbps");
        const acodec = btn.getAttribute("data-acodec");
        const jobId = uuid();
        startProgress(jobId);
        const dl = buildDownloadUrl("audio", { url, kbps, codec: acodec, jobId });
        window.open(dl, "_blank");
      };
    });

    // UPDATED: Preview with thumbnail fallback for YouTube/direct
    const v = document.createElement("video");
    if (meta?.thumbnail || isYouTubeUrl(url)) {
      // NEW: Use thumbnail as poster
      const thumb = meta?.thumbnail || `${url.split('/watch?v=')[0]}/vi/${url.split('v=')[1].split('&')[0]}/maxresdefault.jpg`;
      v.poster = thumb;
      v.src = url; // Still try video, but poster shows if fails
      v.controls = true; v.playsInline = true; v.preload = "metadata";
      v.onloadedmetadata = () => { 
        preview.innerHTML = ""; 
        preview.appendChild(v); 
        show(preview); 
      };
      v.onerror = () => {
        // NEW: Fallback to static img if video fails (common for YouTube)
        const img = new Image();
        img.src = v.poster; img.alt = "Video thumbnail";
        img.onload = () => { preview.innerHTML = ""; preview.appendChild(img); show(preview); };
        img.onerror = () => { preview.innerHTML = ""; hide(preview); };
      };
    } else {
      // Direct video as before
      v.src = url; v.controls = true; v.playsInline = true; v.preload = "metadata";
      v.onloadedmetadata = () => { preview.innerHTML = ""; preview.appendChild(v); show(preview); };
      v.onerror = () => { preview.innerHTML = ""; hide(preview); };
    }
  } else if (probeError) {
    // NEW: Specific error display
    detected.innerHTML = `Error: <b>${probeError}</b> (e.g., private video or invalid URL). Try another.`;
  } else {
    detected.innerHTML = "Could not determine media type. Make sure it’s a <b>direct</b> image/video URL.";
  }
}

analyzeBtn.addEventListener("click", analyze);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") analyze(); });

window.addEventListener("load", () => {
  document.body.style.opacity = 0;
  requestAnimationFrame(() => {
    document.body.style.transition = "opacity 500ms ease";
    document.body.style.opacity = 1;
  });
});