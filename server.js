// server.js — Link to Video Downloader backend
// Requires: yt-dlp on PATH (and ffmpeg for merging video-only + audio streams)

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const INFO_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/", rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false }));

// ---------- helpers ----------

function isValidUrl(input) {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// yt-dlp format ids are short alphanumerics like "18", "137", "hls-720p", "dash-1"
const FORMAT_ID_RE = /^[A-Za-z0-9_\-.]{1,40}$/;

function safeFilename(name, ext) {
  const base = (name || "video")
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "video";
  return `${base}.${ext}`;
}

// Run yt-dlp and collect stdout (used for metadata). Args are passed as an
// array, never through a shell, so the URL can't inject commands.
function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, ["-J", "--no-playlist", "--no-warnings", "--", url]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Timed out while reading video info"));
    }, INFO_TIMEOUT_MS);

    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start yt-dlp: ${e.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.split("\n").find((l) => l.includes("ERROR")) || "yt-dlp failed"));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("Unexpected response from yt-dlp"));
      }
    });
  });
}

// Reduce yt-dlp's long format list to one clean option per resolution,
// plus a single best audio-only option.
function simplifyFormats(formats = []) {
  const byHeight = new Map();
  let bestAudio = null;

  for (const f of formats) {
    const hasVideo = f.vcodec && f.vcodec !== "none";
    const hasAudio = f.acodec && f.acodec !== "none";
    if (f.protocol && f.protocol.startsWith("mhtml")) continue; // storyboards

    if (hasVideo && f.height) {
      const current = byHeight.get(f.height);
      const score = (hasAudio ? 1e9 : 0) + (f.ext === "mp4" ? 1e8 : 0) + (f.tbr || 0);
      if (!current || score > current.score) {
        byHeight.set(f.height, { f, hasAudio, score });
      }
    } else if (!hasVideo && hasAudio) {
      if (!bestAudio || (f.abr || 0) > (bestAudio.abr || 0)) bestAudio = f;
    }
  }

  const video = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([height, { f, hasAudio }]) => ({
      format_id: f.format_id,
      label: `${height}p`,
      ext: hasAudio ? f.ext : "mp4",
      type: "video",
      needs_merge: !hasAudio,
      filesize: f.filesize || f.filesize_approx || null,
    }));

  if (bestAudio) {
    video.push({
      format_id: bestAudio.format_id,
      label: `Audio only${bestAudio.abr ? ` (${Math.round(bestAudio.abr)} kbps)` : ""}`,
      ext: bestAudio.ext,
      type: "audio",
      needs_merge: false,
      filesize: bestAudio.filesize || bestAudio.filesize_approx || null,
    });
  }
  return video;
}

// ---------- routes ----------

// POST /api/info  { "url": "https://..." }
app.post("/api/info", async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Enter a full link starting with http:// or https://" });
  }

  try {
    const info = await runYtDlpJson(url);
    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration || null,
      uploader: info.uploader || info.channel || null,
      platform: info.extractor_key || null,
      formats: simplifyFormats(info.formats),
    });
  } catch (e) {
    res.status(422).json({ error: e.message.replace(/^ERROR:\s*/, "") });
  }
});

// GET /api/download?url=...&format_id=...&title=...
// GET (not POST) so the browser handles the file save natively.
app.get("/api/download", async (req, res) => {
  const { url, format_id, title } = req.query;

  if (!url || !isValidUrl(url)) return res.status(400).send("Invalid URL");
  if (!format_id || !FORMAT_ID_RE.test(format_id)) return res.status(400).send("Invalid format");

  let info;
  try {
    info = await runYtDlpJson(url);
  } catch (e) {
    return res.status(422).send(e.message);
  }

  const chosen = (info.formats || []).find((f) => f.format_id === format_id);
  if (!chosen) return res.status(404).send("That format is no longer available");

  const hasVideo = chosen.vcodec && chosen.vcodec !== "none";
  const hasAudio = chosen.acodec && chosen.acodec !== "none";
  const displayTitle = typeof title === "string" && title ? title : info.title;

  // Case 1: format already contains everything → stream straight to the client.
  if (!hasVideo || hasAudio) {
    return streamDirect(req, res, url, format_id, safeFilename(displayTitle, chosen.ext || "mp4"));
  }

  // Case 2: video-only (common for YouTube 720p+) → merge with best audio via
  // ffmpeg into a temp file, send it, then delete it.
  return mergeAndSend(req, res, url, format_id, safeFilename(displayTitle, "mp4"));
});

function streamDirect(req, res, url, formatId, filename) {
  const proc = spawn(YTDLP, ["-f", formatId, "-o", "-", "--no-playlist", "--no-warnings", "--", url]);
  const timer = setTimeout(() => proc.kill("SIGKILL"), DOWNLOAD_TIMEOUT_MS);

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

  proc.stdout.pipe(res);
  proc.stderr.on("data", () => {}); // drain
  proc.on("error", () => !res.headersSent && res.status(500).end());
  proc.on("close", () => {
    clearTimeout(timer);
    res.end();
  });
  req.on("close", () => proc.kill("SIGKILL")); // user cancelled
}

function mergeAndSend(req, res, url, formatId, filename) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vdl-"));
  const outPath = path.join(tmpDir, `${crypto.randomUUID()}.mp4`);
  const cleanup = () => fs.rm(tmpDir, { recursive: true, force: true }, () => {});

  const proc = spawn(YTDLP, [
    "-f", `${formatId}+bestaudio[ext=m4a]/${formatId}+bestaudio`,
    "--merge-output-format", "mp4",
    "-o", outPath,
    "--no-playlist", "--no-warnings",
    "--", url,
  ]);
  const timer = setTimeout(() => proc.kill("SIGKILL"), DOWNLOAD_TIMEOUT_MS);
  let aborted = false;

  req.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      proc.kill("SIGKILL");
      cleanup();
    }
  });

  proc.on("error", () => {
    clearTimeout(timer);
    cleanup();
    if (!res.headersSent) res.status(500).send("Could not start yt-dlp");
  });

  proc.on("close", (code) => {
    clearTimeout(timer);
    if (aborted) return;
    if (code !== 0 || !fs.existsSync(outPath)) {
      cleanup();
      return res.status(500).send("Download failed (is ffmpeg installed?)");
    }
    res.download(outPath, filename, cleanup);
  });
}

app.listen(PORT, () => console.log(`Video downloader running on http://localhost:${PORT}`));

