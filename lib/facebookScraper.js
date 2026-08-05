
function parseFacebookTarget(input) {
  if (!input) return null;
  let raw = input.trim();
  if (raw.startsWith("@")) raw = raw.slice(1);
  let usernameOrId = raw;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const parsedUrl = new URL(raw);
      if (parsedUrl.pathname.includes("profile.php")) {
        const idParam = parsedUrl.searchParams.get("id");
        if (idParam) usernameOrId = idParam;
      } else {
        const parts = parsedUrl.pathname.split("/").filter(Boolean);
        if (parts.length > 0)
          usernameOrId =
            parts[0] === "stories" && parts.length > 1 ? parts[1] : parts[0];
      }
    } catch (e) {}
  }
  return {
    raw: input,
    usernameOrId,
    profileUrl:
      input.startsWith("http") && !input.includes("/stories/")
        ? input
        : /^\d+$/.test(usernameOrId)
          ? `https://www.facebook.com/profile.php?id=${usernameOrId}`
          : `https://www.facebook.com/${usernameOrId}`,
  };
}

/**
 * Extracts video clips from `all_video_dash_prefetch_representations` in the page HTML.
 * Returns an array of clips, each with ALL quality levels pre-grouped.
 * This is the same data source bravedown.com uses to offer 1080p/720p/540p/360p options.
 */
function extractVideoClipsFromHtml(html) {
  const clips = [];
  const seenClipKeys = new Set();

  const marker = '"all_video_dash_prefetch_representations"';
  let searchFrom = 0;

  while (true) {
    const markerIdx = html.indexOf(marker, searchFrom);
    if (markerIdx < 0) break;
    searchFrom = markerIdx + 1;

    // Find the opening [ of the representations array
    const arrStart = html.indexOf("[", markerIdx + marker.length);
    if (arrStart < 0) continue;

    // Match the closing ] by counting brackets
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < Math.min(arrStart + 80000, html.length); i++) {
      if (html[i] === "[" || html[i] === "{") depth++;
      else if (html[i] === "]" || html[i] === "}") {
        depth--;
        if (depth === 0) {
          arrEnd = i;
          break;
        }
      }
    }
    if (arrEnd < 0) continue;

    const raw = html.slice(arrStart, arrEnd + 1);
    // Unescape Facebook's JSON encoding
    const jsonStr = raw
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\u003C/gi, "<")
      .replace(/\\u003E/gi, ">")
      .replace(/\\n/g, "\n");

    let arr;
    try {
      arr = JSON.parse(jsonStr);
    } catch {
      continue;
    }

    // Each element of the outer array is one clip with all its quality representations
    for (const group of arr) {
      const reps = group.representations || [];
      if (reps.length === 0) continue;

      const clip = { videoQualities: [], audioUrl: null };
      let clipKey = null;

      for (const rep of reps) {
        if (!rep.base_url || !rep.mime_type) continue;

        const isAudio =
          rep.mime_type.includes("audio") ||
          (rep.codecs &&
            (rep.codecs.startsWith("mp4a") || rep.codecs.startsWith("ac-3")));
        const isVideo = !isAudio;

        // Infer height from codec profile if not directly provided
        let height = rep.height || 0;
        if (!height && rep.codecs) {
          const m = rep.codecs.match(/vp09\.00\.(\d+)/);
          if (m) {
            const lvl = parseInt(m[1]);
            if (lvl >= 40) height = 1080;
            else if (lvl >= 31) height = 720;
            else if (lvl >= 22) height = 480;
            else height = 360;
          }
        }
        const qualityLabel =
          height >= 1080
            ? "1080p"
            : height >= 720
              ? "720p"
              : height >= 540
                ? "540p"
                : height >= 480
                  ? "480p"
                  : height >= 360
                    ? "360p"
                    : height
                      ? `${height}p`
                      : "unknown";

        const bitrate = rep.bandwidth || rep.bitrate_bps || 0;

        if (isVideo) {
          if (!clipKey) {
            // Use the first video representation's path as the clip deduplication key
            try {
              clipKey = new URL(rep.base_url).pathname
                .split("/")
                .slice(0, 8)
                .join("/");
            } catch {
              clipKey = rep.base_url.slice(0, 60);
            }
          }
          clip.videoQualities.push({
            tag: qualityLabel,
            bitrate,
            height,
            url: rep.base_url,
          });
        } else if (isAudio && !clip.audioUrl) {
          clip.audioUrl = rep.base_url;
        }
      }

      if (
        clip.videoQualities.length > 0 &&
        clipKey &&
        !seenClipKeys.has(clipKey)
      ) {
        seenClipKeys.add(clipKey);
        // Sort highest quality first
        clip.videoQualities.sort(
          (a, b) => b.height - a.height || b.bitrate - a.bitrate,
        );
        clips.push({ clipKey, ...clip });
      }
    }
  }

  return clips;
}

/**
 * Extracts story photo URLs from the page DOM and HTML JSON.
 * Facebook JSON-escapes forward slashes (\/) — patterns must allow backslashes.
 */
async function extractPhotoUrlsFromPage(page) {
  // Method 1: Read rendered <img> elements from DOM (no naturalWidth filter — headless
  // doesn't render img dimensions for story viewer elements)
  const domPhotos = await page
    .evaluate(() => {
      return Array.from(document.querySelectorAll('img[src*="fbcdn.net"]')).map(
        (img) => img.src,
      );
    })
    .catch(() => []);

  // Method 2: Regex scan of raw HTML (catches URLs in Facebook's embedded JSON)
  // IMPORTANT: use [^"] not [^"\\] because Facebook escapes / as \/ in JSON
  // so the URL contains backslashes that would break [^\\] patterns
  const html = await page.content().catch(() => "");
  const htmlPhotos = [];
  const photoPatterns = [
    /https?:[^"]*?t51\.71878-15[^"]{10,}/g, // Story photos (standard)
    /https?:[^"]*?t51\.2885-15[^"]{10,}/g, // Post photos
    /https?:[^"]*?t51\.39778-\d+[^"]{10,}/g, // Newer photo format
    /https?:[^"]*?t45\.5432-\d+[^"]{10,}/g, // Alternative photo format
    /https?:[^"]*?t39\.30808-6[^"]{10,}/g, // Story photo content (key pattern!)
  ];
  for (const pattern of photoPatterns) {
    const matches = html.match(pattern) || [];
    for (const m of matches) {
      // Strip all backslashes (Facebook JSON-escapes \/ → we want /) and unescape &amp; -> &
      const cleanUrl = m.split("\\").join("").replace(/&amp;/g, "&");
      htmlPhotos.push(cleanUrl);
    }
  }

  const isExcluded = (url) =>
    !url.includes("fbcdn.net") ||
    url.includes("s40x40") ||
    url.includes("s75x75") ||
    url.includes("s160x160") ||
    url.includes("s320x320") ||
    url.includes("s235x350") ||
    url.includes("s480x270") ||
    url.includes("/p40x40/") ||
    url.includes("/p160x160/") ||
    url.includes("rsrc.php") ||
    url.includes("static.xx") ||
    url.endsWith(".webp") ||
    url.includes("t1.30497-1") || // Profile pic thumbnails
    url.includes("t39.30808-1") || // Story creator avatar
    url.includes("t15.5256-10") || // Video frame preview thumbnails (NOT photos!)
    url.includes("/emoji") ||
    url.includes("sticker");

  const allPhotos = [...domPhotos, ...htmlPhotos].filter(
    (u) => u && !isExcluded(u),
  );
  return allPhotos;
}

async function scrapeFacebookStoryMedia(targetInput, cUser, xsCookie) {
  const puppeteer = (await import("puppeteer-core")).default;
  const target = parseFacebookTarget(targetInput);
  if (!target || !target.usernameOrId)
    throw new Error("Invalid Facebook username or profile URL.");
  if (!cUser || !xsCookie)
    throw new Error(
      "Facebook session cookies (FB_C_USER and FB_XS) are required.",
    );

  const decodedXs = decodeURIComponent(xsCookie);
  console.log(`[Story Scraper] Target: "${target.usernameOrId}"`);
  console.log(`[Story Scraper] Navigating to: ${target.profileUrl}`);

  let browser;
  try {
    const wsUrl = process.env.BROWSER_WS_URL;
    if (wsUrl) {
      console.log("[Story Scraper] Connecting to remote browser...");
      browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
      });
    } else {
      console.log("[Story Scraper] Launching local Chrome...");
      browser = await puppeteer.launch({
        executablePath:
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--lang=en-US"],
      });
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    );
    await page.setCookie(
      {
        name: "c_user",
        value: String(cUser),
        domain: ".facebook.com",
        path: "/",
      },
      { name: "xs", value: decodedXs, domain: ".facebook.com", path: "/" },
    );

    const initialNavUrl = targetInput.includes("/stories/")
      ? targetInput
      : target.profileUrl;
    await page.goto(initialNavUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await new Promise((r) => setTimeout(r, 1000));

    const currentUrl = page.url();
    console.log(`[Story Scraper] After navigation: ${currentUrl}`);

    if (currentUrl.includes("/login") || currentUrl.includes("login.php"))
      throw new Error(
        "Facebook redirected to login — session cookies expired. Update .env.",
      );

    let storyUrl = currentUrl;
    if (!currentUrl.includes("/stories/")) {
      console.log("[Story Scraper] Looking for story link...");
      const storyHref = await page.evaluate(() => {
        const allLinks = Array.from(
          document.querySelectorAll('a[href*="/stories/"]'),
        );
        return (
          allLinks.find(
            (l) =>
              l.href.includes("/stories/") &&
              !l.href.includes("source=profile_highlight"),
          )?.href || null
        );
      });
      if (!storyHref) throw new Error("No active story found on this profile.");
      console.log(
        `[Story Scraper] Found story link: ${storyHref.slice(0, 80)}...`,
      );
      storyUrl = storyHref;
    }

    return await captureStoryFromEmbeddedData(page, target, storyUrl);
  } catch (err) {
    console.error("[Story Scraper] Error:", err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

function getPhotoFilenameKey(url) {
  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").pop();
    if (filename && filename.includes("_")) {
      return filename; // e.g. "762156890_122115043119379606_7816923322621612827_n.jpg"
    }
  } catch {}
  return url.split("?")[0];
}

function getPhotoQualityScore(url) {
  let score = 100;
  if (url.includes("mx1440") || url.includes("mx2048")) score += 50;
  else if (url.includes("mx720") || url.includes("mx1080")) score += 40;
  else if (url.includes("sh0.2") || url.includes("sh0.5")) score += 20;

  if (url.includes("s235x350") || url.includes("s480x270")) score -= 30;
  if (url.includes("s160x160") || url.includes("s75x75")) score -= 50;
  return score;
}

async function captureStoryFromEmbeddedData(page, target, storyUrl) {
  console.log(`[Story Scraper] Story: ${storyUrl.slice(0, 80)}...`);

  const items = [];
  const capturedVideoKeys = new Set();
  const capturedPhotoMap = new Map(); // filenameKey -> item

  // Navigate and wait for initial page render
  await page.goto(storyUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  // Extract first slide
  await extractSlideMedia(page, items, capturedVideoKeys, capturedPhotoMap);

  // Auto-advance through all story slides with robust navigation
  console.log("[Story Scraper] Auto-advancing through slides...");
  let emptyChecks = 0;
  for (let i = 0; i < 15; i++) {
    const prevCount = items.length;

    // Advance slide via DOM event dispatch + Next button click + mouse click + Puppeteer keypress
    await page
      .evaluate(() => {
        // Dispatch ArrowRight event directly into window & dialog
        const evt = new KeyboardEvent("keydown", {
          key: "ArrowRight",
          code: "ArrowRight",
          keyCode: 39,
          which: 39,
          bubbles: true,
          cancelable: true,
        });
        document.dispatchEvent(evt);
        window.dispatchEvent(evt);
        (
          document.querySelector('div[role="dialog"]') || document.body
        ).dispatchEvent(evt);

        // Also click any Next button if present
        const nextBtn = Array.from(
          document.querySelectorAll('div[role="button"], button'),
        ).find((el) => {
          const label = (el.getAttribute("aria-label") || "").toLowerCase();
          return label.includes("next") || label.includes("forward");
        });
        if (nextBtn) nextBtn.click();
      })
      .catch(() => {});

    await page.mouse.click(850, 400).catch(() => {});
    await page.keyboard.press("ArrowRight").catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));

    await extractSlideMedia(page, items, capturedVideoKeys, capturedPhotoMap);

    if (items.length === prevCount) {
      emptyChecks++;
      if (emptyChecks >= 2) {
        console.log(`[Story Scraper] End of story at slide ~${i + 1}.`);
        break;
      }
    } else {
      emptyChecks = 0; // reset if new media was captured
    }
  }

  // Clean internal score property
  items.forEach((item) => delete item._score);

  // Extract display name and avatar URL from page DOM
  const profileDetails = await page
    .evaluate(() => {
      let name = "";
      let avatar = "";

      // 1. Find user's display name
      // Profile links inside the story viewer header usually contain the display name
      const links = Array.from(document.querySelectorAll("a"));
      for (const link of links) {
        const href = link.href || "";
        if (
          href &&
          !href.includes("/stories/") &&
          !href.includes("/sharer/") &&
          !href.includes("/pages/") &&
          link.innerText
        ) {
          const text = link.innerText.trim();
          if (
            text &&
            !text.includes("\n") &&
            text.length > 1 &&
            text.length < 50
          ) {
            const lower = text.toLowerCase();
            if (
              lower !== "home" &&
              lower !== "stories" &&
              lower !== "create story" &&
              lower !== "facebook" &&
              lower !== "watch"
            ) {
              name = text;
              break;
            }
          }
        }
      }

      if (!name) {
        const heading =
          document.querySelector("h2") ||
          document.querySelector("h1") ||
          document.querySelector("strong");
        if (heading) name = heading.innerText.trim();
      }

      // 2. Find profile avatar
      const imgs = Array.from(document.querySelectorAll("img"));
      for (const img of imgs) {
        if (
          img.src &&
          (img.src.includes("fbcdn.net") || img.src.includes("scontent"))
        ) {
          const alt = (img.alt || "").toLowerCase();
          if (
            alt.includes("profile") ||
            alt.includes("avatar") ||
            img.width === 32 ||
            img.width === 40 ||
            img.height === 32 ||
            img.height === 40
          ) {
            avatar = img.src;
            break;
          }
        }
      }

      if (!avatar && imgs.length > 0) {
        const smallImg = imgs.find(
          (img) =>
            img.src &&
            (img.src.includes("fbcdn") || img.src.includes("scontent")) &&
            img.width < 100 &&
            img.width > 20,
        );
        if (smallImg) avatar = smallImg.src;
      }

      return { name, avatar };
    })
    .catch(() => null);

  const pageTitle = await page.title().catch(() => "");
  const displayName = pageTitle
    ? pageTitle.replace("| Facebook", "").trim()
    : target.usernameOrId;

  let finalName =
    (profileDetails && profileDetails.name) ||
    displayName ||
    target.usernameOrId;
  if (
    !finalName ||
    finalName.toLowerCase() === "create stories" ||
    finalName.toLowerCase() === "create story" ||
    finalName.toLowerCase() === "stories"
  ) {
    finalName = target.usernameOrId;
  }

  const finalAvatar =
    (profileDetails && profileDetails.avatar) ||
    `https://api.dicebear.com/7.x/identicon/svg?seed=${target.usernameOrId}`;

  const videoCount = items.filter((i) => i.type === "video").length;
  const photoCount = items.filter((i) => i.type === "image").length;
  console.log(
    `[Story Scraper] Done — ${items.length} items (${videoCount} videos, ${photoCount} photos).`,
  );

  return {
    username: target.usernameOrId,
    profileName: finalName,
    avatarUrl: finalAvatar,
    profileUrl: target.profileUrl,
    isStoryUrl: true,
    items,
  };
}

/**
 * Extracts both video clips AND photos from the current page state.
 */
async function extractSlideMedia(
  page,
  items,
  capturedVideoKeys,
  capturedPhotoMap,
) {
  const html = await page.content();

  // --- Videos (from embedded JSON) ---
  const clips = extractVideoClipsFromHtml(html);
  for (const clip of clips) {
    if (capturedVideoKeys.has(clip.clipKey)) continue;
    capturedVideoKeys.add(clip.clipKey);
    const best = clip.videoQualities[0];
    const videoCount = items.filter((i) => i.type === "video").length;
    console.log(
      `[Story Scraper] [video] clip#${videoCount + 1} — ${clip.videoQualities.map((q) => q.tag).join(", ")}`,
    );
    items.push({
      id: `story-media-${items.length + 1}`,
      type: "video",
      mediaUrl: best.url,
      audioUrl: clip.audioUrl || null,
      videoQualities: clip.videoQualities,
      thumbnailUrl: "",
      timestamp: `Story Video #${videoCount + 1}`,
    });
  }

  // --- Photos (from DOM + HTML scan) ---
  const photoUrls = await extractPhotoUrlsFromPage(page);
  for (const url of photoUrls) {
    const filenameKey = getPhotoFilenameKey(url);
    const score = getPhotoQualityScore(url);

    // Deduplicate by filename: if already captured, update URL if new one is higher quality
    if (capturedPhotoMap.has(filenameKey)) {
      const existing = capturedPhotoMap.get(filenameKey);
      if (score > existing._score) {
        existing.mediaUrl = url;
        existing.thumbnailUrl = url;
        existing._score = score;
      }
      continue;
    }

    const photoCount = items.filter((i) => i.type === "image").length;
    console.log(`[Story Scraper] [image]: ${url.slice(0, 70)}...`);
    const newItem = {
      id: `story-media-${items.length + 1}`,
      type: "image",
      mediaUrl: url,
      thumbnailUrl: url,
      _score: score,
      timestamp: `Story Photo #${photoCount + 1}`,
    };
    capturedPhotoMap.set(filenameKey, newItem);
    items.push(newItem);
  }
}

async function scrapeFacebookProfile(targetInput, proxyUrl = null) {
  const cUser = process.env.FB_C_USER;
  const xsCookie = process.env.FB_XS;
  return await scrapeFacebookStoryMedia(targetInput, cUser, xsCookie);
}

module.exports = { parseFacebookTarget, scrapeFacebookProfile };
