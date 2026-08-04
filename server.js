const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const { HttpsProxyAgent } = require("https-proxy-agent");
const path = require("path");
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

// Simple In-Memory Cache (In production, replace with Redis)
const cache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes — story CDN URLs expire quickly

// 2. Media Proxy Endpoint — forwards Range headers so video streaming and seeking work
app.get("/api/proxy-image", async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send("Missing URL");
  }

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
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    res.status(404).send("Media unavailable");
  }
});

// Cache clear endpoint (useful during development)
app.post("/api/clear-cache", (req, res) => {
  cache.clear();
  res.json({ ok: true, message: "Cache cleared" });
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
