const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const path = require("path");
const os = require("os");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
ffmpeg.setFfmpegPath(ffmpegPath);

// Force Vercel (NFT) to trace and bundle the ffmpeg binary
if (process.env.VERCEL) {
  const traceFfmpeg = path.join(__dirname, "node_modules", "ffmpeg-static", "ffmpeg");
  fs.existsSync(traceFfmpeg);
}

require("dotenv").config();

const { scrapeFacebookProfile } = require("./lib/facebookScraper");

const app = express();

// Increase server timeout to 5 minutes for long story scraping operations
app.use((req, res, next) => {
  res.setTimeout(5 * 60 * 1000);
  next();
});
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON body parsing
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 1. Rate Limiting Strategy for High-Traffic Protection
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests from this IP, please try again later." },
});

app.use("/api/", apiLimiter);

// Disable caching so every user request performs a fresh live scrape
const cache = new Map();
const CACHE_TTL_MS = 0;

// 2. Media Proxy Endpoint — forwards Range headers so video streaming and seeking work
app.get("/api/proxy-image", async (req, res) => {
  let imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send("Missing URL");
  }

  // Clean &amp; HTML entity unescaping if present
  imageUrl = imageUrl.replace(/&amp;/g, "&");

  try {
    // Forward Range header if the browser sent one (needed for video seeking/buffering)
    const proxyHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Referer": "https://www.facebook.com/",
    };
    if (req.headers.range) {
      proxyHeaders["Range"] = req.headers.range;
    }

    const response = await axios.get(imageUrl, {
      responseType: "stream",
      headers: proxyHeaders,
      timeout: 30000,
      // Don't throw on 206 Partial Content
      validateStatus: (s) => s < 400,
    });

    // Forward status and headers back to browser
    res.status(response.status);
    const forwardHeaders = ["content-type", "content-length", "content-range", "accept-ranges"];
    for (const h of forwardHeaders) {
      if (response.headers[h]) res.setHeader(h, response.headers[h]);
    }

    if (req.query.filename || req.query.dl === "1") {
      const rawName = req.query.filename || "story-photo.jpg";
      // Allow alphanumeric, dashes, underscores, dots (for extension)
      const filename = rawName.replace(/[^a-z0-9_.()-]/gi, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }

    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    console.error("[Proxy Image Error]:", err.message);
    res.status(404).send("Media unavailable");
  }
});

// Cache clear endpoint (useful during development)
app.post("/api/clear-cache", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache cleared" });
});

// Render endpoint — downloads video + audio from Facebook CDN and merges with FFmpeg
// This is the same "Render" step that sites like bravedown.com do to combine DASH streams
app.post("/api/render", async (req, res) => {
  const { videoUrl, audioUrl, filename } = req.body;
  if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });

  const tmpDir = os.tmpdir();
  const videoFile = path.join(tmpDir, `fb_video_${Date.now()}.mp4`);
  const audioFile = audioUrl ? path.join(tmpDir, `fb_audio_${Date.now()}.aac`) : null;
  const outFile = path.join(tmpDir, `fb_merged_${Date.now()}.mp4`);

  const fbHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": "https://www.facebook.com/",
  };

  // Helper: download a URL to a local temp file
  async function downloadToFile(url, dest) {
    const resp = await axios.get(url, { responseType: "stream", headers: fbHeaders, timeout: 60000 });
    return new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(dest);
      resp.data.pipe(stream);
      stream.on("finish", resolve);
      stream.on("error", reject);
    });
  }

  try {
    console.log(`[Render] Downloading video: ${videoUrl.slice(0, 70)}...`);
    await downloadToFile(videoUrl, videoFile);

    if (audioUrl && audioFile) {
      console.log(`[Render] Downloading audio: ${audioUrl.slice(0, 70)}...`);
      await downloadToFile(audioUrl, audioFile);
    }

    console.log("[Render] Merging with FFmpeg...");

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(videoFile);
      if (audioFile && fs.existsSync(audioFile)) cmd.input(audioFile);
      cmd
        .outputOptions(["-c:v copy", "-c:a aac", "-shortest", "-movflags +faststart"])
        .output(outFile)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    console.log("[Render] Done. Streaming merged MP4...");
    const safeName = (filename || "story").replace(/[^a-z0-9_-]/gi, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}.mp4"`);
    res.setHeader("Content-Type", "video/mp4");
    const readStream = fs.createReadStream(outFile);
    readStream.pipe(res);
    readStream.on("end", () => {
      // Cleanup temp files
      [videoFile, audioFile, outFile].forEach(f => f && fs.unlink(f, () => {}));
    });
  } catch (err) {
    console.error("[Render] Error:", err.message);
    [videoFile, audioFile, outFile].forEach(f => f && fs.unlink(f, () => {}));
    res.status(500).json({ error: "Render failed: " + err.message });
  }
});

// 3. API Endpoint for Facebook Public Media Extraction
app.post("/api/fetch-media", async (req, res) => {
  const { profileUrl } = req.body;

  if (!profileUrl || !profileUrl.trim()) {
    return res
      .status(400)
      .json({
        error: "Please provide a valid Facebook username or profile URL.",
      });
  }

  const cleanQuery = profileUrl.trim().toLowerCase();
  const cacheKey = `fb:${cleanQuery}`;
  const cachedData = cache.get(cacheKey);

  if (cachedData && Date.now() - cachedData.timestamp < CACHE_TTL_MS) {
    return res.json({ ...cachedData.data, cached: true });
  }

  try {
    const proxyUrl = process.env.ROTATING_PROXY_URL || null;
    const resultData = await scrapeFacebookProfile(profileUrl, proxyUrl);

    // Store in cache
    cache.set(cacheKey, { timestamp: Date.now(), data: resultData });

    return res.json({ ...resultData, cached: false });
  } catch (error) {
    console.error("Fetch error:", error.message);
    return res.status(500).json({
      error:
        error.message ||
        "Failed to fetch public Facebook profile. Ensure the profile is public.",
    });
  }
});

// Start Server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Run this to free it:  npx kill-port ${PORT}`);
    console.error(
      `   Or kill node:          Get-Process node | Stop-Process -Force\n`,
    );
    process.exit(1);
  } else {
    throw err;
  }
});
