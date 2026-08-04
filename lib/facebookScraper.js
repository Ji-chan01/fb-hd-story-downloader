const puppeteer = require('puppeteer');

/**
 * Normalizes input into a clean Facebook handle or profile URL object
 */
function parseFacebookTarget(input) {
  if (!input) return null;
  let raw = input.trim();

  if (raw.startsWith('@')) {
    raw = raw.slice(1);
  }

  let usernameOrId = raw;

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const parsedUrl = new URL(raw);
      if (parsedUrl.pathname.includes('profile.php')) {
        const idParam = parsedUrl.searchParams.get('id');
        if (idParam) usernameOrId = idParam;
      } else {
        const parts = parsedUrl.pathname.split('/').filter(Boolean);
        if (parts.length > 0) {
          if (parts[0] === 'stories' && parts.length > 1) {
            usernameOrId = parts[1];
          } else {
            usernameOrId = parts[0];
          }
        }
      }
    } catch (e) {}
  }

  return {
    raw: input,
    usernameOrId: usernameOrId,
    profileUrl: input.startsWith('http') && !input.includes('/stories/')
      ? input
      : (/^\d+$/.test(usernameOrId)
          ? `https://www.facebook.com/profile.php?id=${usernameOrId}`
          : `https://www.facebook.com/${usernameOrId}`)
  };
}

/**
 * Scrapes ONLY active 24-hour Facebook Stories using Puppeteer and session cookies.
 *
 * Strategy:
 * 1. Navigate to profile URL with session cookies
 * 2. Verify login was successful (NOT redirected to login.php)
 * 3. Click the story ring / "View Story" link
 * 4. Wait for navigation to /stories/ URL
 * 5. ONLY THEN start capturing story media responses
 */
async function scrapeFacebookStoryMedia(targetInput, cUser, xsCookie) {
  const target = parseFacebookTarget(targetInput);
  if (!target || !target.usernameOrId) {
    throw new Error('Invalid Facebook username or profile URL.');
  }

  if (!cUser || !xsCookie) {
    throw new Error('Facebook session cookies (FB_C_USER and FB_XS) in .env are required to view active stories.');
  }

  // Decode URL-encoded cookie values (e.g. %3A -> :)
  const decodedXs = decodeURIComponent(xsCookie);

  console.log(`[Story Scraper] Target: "${target.usernameOrId}"`);
  console.log(`[Story Scraper] Navigating to: ${target.profileUrl}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Set cookies with DECODED xs value
    await page.setCookie(
      { name: 'c_user', value: String(cUser), domain: '.facebook.com', path: '/' },
      { name: 'xs', value: decodedXs, domain: '.facebook.com', path: '/' }
    );

    // ── Step 1: Navigate to the profile page ──────────────────────────────────
    const initialNavUrl = targetInput.includes('/stories/') ? targetInput : target.profileUrl;
    await page.goto(initialNavUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await new Promise(r => setTimeout(r, 2000));

    const currentUrl = page.url();
    console.log(`[Story Scraper] After navigation: ${currentUrl}`);

    // ── Step 2: Check for login redirect (invalid/expired cookies) ────────────
    if (currentUrl.includes('/login') || currentUrl.includes('login.php')) {
      throw new Error(
        'Facebook redirected to login page — your session cookies (FB_C_USER / FB_XS) are expired or invalid. ' +
        'Please refresh them from your browser and update .env. Also make sure the xs value is NOT URL-encoded.'
      );
    }

    // If already on stories URL, go straight to media capture
    if (currentUrl.includes('/stories/')) {
      return await captureStoryMediaOnPage(page, target, currentUrl);
    }

    // ── Step 3: Find story link on profile page ───────────────────────────────
    console.log('[Story Scraper] Looking for story ring on profile page...');

    // Look for the "View story" anchor link - this is the most reliable approach
    const storyHref = await page.evaluate(() => {
      // Priority 1: anchor with text "View story" 
      const allLinks = Array.from(document.querySelectorAll('a[href*="/stories/"]'));
      // Find the "View story" link (the active story ring on the profile avatar)
      const viewStoryLink = allLinks.find(el => {
        const text = (el.textContent || '').toLowerCase().trim();
        return text === 'view story' || text.includes('view story');
      });
      if (viewStoryLink) return viewStoryLink.href;
      
      // Priority 2: first /stories/ link that has a story ID (not profile_highlight which are archived)
      // Active story links look like: /stories/403026143438391/UzpfSVND.../
      const activeStoryLink = allLinks.find(el => {
        const href = el.href || '';
        // Active story links have the long UzpfSVND... base64 ID
        return href.includes('/stories/') && href.includes('UzpfSVND');
      });
      if (activeStoryLink) return activeStoryLink.href;

      // Priority 3: any story link (not profile_highlight archive)
      const anyStoryLink = allLinks.find(el => {
        const href = el.href || '';
        return href.includes('/stories/') && !href.includes('source=profile_highlight');
      });
      return anyStoryLink ? anyStoryLink.href : null;
    });

    if (!storyHref) {
      throw new Error(
        'No active story found on this profile. The user may not have an active 24-hour story right now, ' +
        'or their story is not visible to you.'
      );
    }

    console.log(`[Story Scraper] Found story link: ${storyHref.slice(0, 80)}...`);

    // ── Step 4: Navigate directly to the story URL ────────────────────────────
    return await captureStoryMediaOnPage(page, target, storyHref);

  } catch (err) {
    console.error('[Story Scraper] Error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Captures ONLY story media at original quality.
 * - Photos: strips `stp=` resize parameters to serve full-resolution originals
 * - Videos: intercepts GraphQL API JSON to get `browser_native_hd_url` (combined audio+video MP4)
 *   instead of DASH-only segments (/o1/v/t2/ which are video-only streams without audio)
 */
async function captureStoryMediaOnPage(page, target, storyUrl) {
  console.log(`[Story Scraper] Navigating to story: ${storyUrl.slice(0, 80)}...`);

  const items = [];
  const capturedPhotoKeys = new Set();
  const capturedVideoKeys = new Set();

  // Decode efg base64 param to get video quality metadata (vencode_tag, video_id, bitrate)
  function decodeEfg(efgParam) {
    try {
      return JSON.parse(Buffer.from(efgParam, 'base64').toString('utf8'));
    } catch { return null; }
  }

  // ── Phase 1: Collect video_ids from story DASH segments ─────────────────────
  // We capture the video_id embedded in the signed efg param of each /o1/v/t2/ request.
  // These IDs are then used in Phase 2 to fetch HD quality via the watch page.
  const videoIds = new Set();     // Facebook video IDs to fetch in HD
  const audioUrls = new Map();    // video_id -> best audio URL
  const storyVideoUrls = new Map(); // video_id -> best story segment URL (fallback)

  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('fbcdn.net') || !url.includes('/o1/v/t2/')) return;

    try {
      const u = new URL(url);
      const efgRaw = u.searchParams.get('efg');
      if (!efgRaw) return;

      const efg = decodeEfg(efgRaw);
      if (!efg) return;

      const tag = efg.vencode_tag || '';
      const videoId = efg.video_id ? String(efg.video_id) : null;
      const bitrate = efg.bitrate || 0;

      // Strip bytestart/byteend for a clean full-file URL
      u.searchParams.delete('bytestart');
      u.searchParams.delete('byteend');
      const cleanUrl = u.toString();

      const isAudio = tag.includes('audio');
      const isVideo = tag.includes('vp9') || tag.includes('avc') || tag.includes('hevc') ||
                      (!isAudio && videoId);

      if (isVideo && videoId) {
        // Track story-level video URL as fallback
        const existingBitrate = storyVideoUrls.get(videoId)?.bitrate || 0;
        if (bitrate > existingBitrate) {
          storyVideoUrls.set(videoId, { url: cleanUrl, bitrate, tag });
        }
        videoIds.add(videoId);
        console.log(`[Story Scraper] Found video clip: id=${videoId} quality=${tag} bitrate=${bitrate}`);
      }

      // Story image frames
    } catch {}
  });

  // Story image listener (runs alongside)
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('fbcdn.net')) return;
    const isStoryImage =
      url.includes('t51.71878-15') ||
      url.includes('t51.2885-15') ||
      (url.includes('t15.5256-10') && !url.includes('_tt6'));
    const isExcluded =
      url.includes('t1.30497-1') || url.includes('t39.30808-1') ||
      url.includes('s40x40') || url.includes('s160x160') || url.includes('/p40x40/') ||
      url.includes('rsrc.php') || url.includes('static.xx') || url.endsWith('.webp');
    if (isExcluded || !isStoryImage) return;
    const key = url.split('?')[0];
    if (!capturedPhotoKeys.has(key)) {
      capturedPhotoKeys.add(key);
      items.push({
        id: `story-media-${items.length + 1}`,
        type: 'image',
        mediaUrl: url,
        thumbnailUrl: url,
        timestamp: `Story Photo #${capturedPhotoKeys.size}`
      });
      console.log(`[Story Scraper] Captured [image]: ${url.slice(0, 80)}...`);
    }
  });

  // Navigate to story and advance through all slides
  await page.goto(storyUrl, { waitUntil: 'networkidle2', timeout: 35000 });
  await new Promise(r => setTimeout(r, 4000));

  console.log('[Story Scraper] Auto-advancing through story slides...');
  for (let i = 0; i < 15; i++) {
    const prevCount = videoIds.size;
    await page.keyboard.press('ArrowRight');
    await new Promise(r => setTimeout(r, 4000));
    if (i >= 2 && videoIds.size === prevCount) {
      await page.keyboard.press('ArrowRight');
      await new Promise(r => setTimeout(r, 2000));
      if (videoIds.size === prevCount) {
        console.log(`[Story Scraper] Reached end of story at slide ~${i + 1}.`);
        break;
      }
    }
  }

  // ── Phase 2: Navigate to watch page for each video_id to get HD quality ─────
  // facebook.com/watch/?v={id} loads the full video player which chooses HD quality.
  console.log(`[Story Scraper] Fetching HD quality for ${videoIds.size} video clips...`);

  for (const videoId of videoIds) {
    if (capturedVideoKeys.has(videoId)) continue;

    const hdUrls = [];
    const hdListener = (response) => {
      const url = response.url();
      if (!url.includes('fbcdn.net') || !url.includes('/o1/v/t2/')) return;
      try {
        const u = new URL(url);
        const efgRaw = u.searchParams.get('efg');
        const efg = decodeEfg(efgRaw);
        if (!efg) return;

        // ── KEY FIX: only accept segments for THIS specific video_id ──────────
        // The watch page loads related/recommended videos too; without this filter
        // we'd pick up basketball games, car videos, etc. from the sidebar.
        const segmentVideoId = efg.video_id ? String(efg.video_id) : null;
        if (segmentVideoId !== videoId) return;

        const tag = efg.vencode_tag || '';
        const isAudio = tag.includes('audio');
        const bitrate = efg.bitrate || 0;
        u.searchParams.delete('bytestart');
        u.searchParams.delete('byteend');
        const cleanUrl = u.toString();
        if (!isAudio) {
          hdUrls.push({ url: cleanUrl, bitrate, tag });
        }
      } catch {}
    };

    page.on('response', hdListener);

    try {
      console.log(`[Story Scraper] Loading watch page for video_id=${videoId}...`);
      await page.goto(`https://www.facebook.com/watch/?v=${videoId}`, {
        waitUntil: 'networkidle2', timeout: 25000
      });
      await new Promise(r => setTimeout(r, 5000)); // Let HD segments load
    } catch (e) {
      console.log(`[Story Scraper] Watch page failed for ${videoId}: ${e.message.slice(0, 60)}`);
    }

    page.off('response', hdListener);

    if (hdUrls.length > 0) {
      // Pick the highest bitrate video URL captured from the watch page
      hdUrls.sort((a, b) => b.bitrate - a.bitrate);
      const best = hdUrls[0];
      console.log(`[Story Scraper] HD video: ${best.tag} bitrate=${best.bitrate} — ${best.url.slice(0, 70)}...`);
      capturedVideoKeys.add(videoId);
      items.push({
        id: `story-media-${items.length + 1}`,
        type: 'video',
        mediaUrl: best.url,
        thumbnailUrl: '',
        timestamp: `Story Video #${capturedVideoKeys.size}`
      });
    } else {
      // Fallback to story-level URL if watch page gave nothing new
      const fallback = storyVideoUrls.get(videoId);
      if (fallback && !capturedVideoKeys.has(videoId)) {
        console.log(`[Story Scraper] Using story fallback for ${videoId}: ${fallback.tag} bitrate=${fallback.bitrate}`);
        capturedVideoKeys.add(videoId);
        items.push({
          id: `story-media-${items.length + 1}`,
          type: 'video',
          mediaUrl: fallback.url,
          thumbnailUrl: '',
          timestamp: `Story Video #${capturedVideoKeys.size}`
        });
      }
    }
  }

  const pageTitle = await page.title().catch(() => '');
  const displayName = pageTitle ? pageTitle.replace('| Facebook', '').trim() : target.usernameOrId;

  console.log(`[Story Scraper] Done — ${items.length} story media items (${capturedVideoKeys.size} videos, ${capturedPhotoKeys.size} photos).`);

  return {
    username: target.usernameOrId,
    profileName: displayName || target.usernameOrId,
    avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${target.usernameOrId}`,
    profileUrl: target.profileUrl,
    isStoryUrl: true,
    items
  };
}

async function scrapeFacebookProfile(targetInput, proxyUrl = null) {
  const cUser = process.env.FB_C_USER;
  const xsCookie = process.env.FB_XS;
  return await scrapeFacebookStoryMedia(targetInput, cUser, xsCookie);
}

module.exports = {
  parseFacebookTarget,
  scrapeFacebookProfile
};


