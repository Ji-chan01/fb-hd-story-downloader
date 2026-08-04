const puppeteer = require('puppeteer');

function parseFacebookTarget(input) {
  if (!input) return null;
  let raw = input.trim();
  if (raw.startsWith('@')) raw = raw.slice(1);
  let usernameOrId = raw;
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    try {
      const parsedUrl = new URL(raw);
      if (parsedUrl.pathname.includes('profile.php')) {
        const idParam = parsedUrl.searchParams.get('id');
        if (idParam) usernameOrId = idParam;
      } else {
        const parts = parsedUrl.pathname.split('/').filter(Boolean);
        if (parts.length > 0)
          usernameOrId = (parts[0] === 'stories' && parts.length > 1) ? parts[1] : parts[0];
      }
    } catch (e) {}
  }
  return {
    raw: input,
    usernameOrId,
    profileUrl: input.startsWith('http') && !input.includes('/stories/')
      ? input
      : (/^\d+$/.test(usernameOrId)
          ? `https://www.facebook.com/profile.php?id=${usernameOrId}`
          : `https://www.facebook.com/${usernameOrId}`)
  };
}

/**
 * Extracts ALL video quality representations from Facebook's embedded page JSON.
 * Facebook server-renders the full DASH manifest + all quality base_urls in the HTML,
 * inside `all_video_dash_prefetch_representations`. We parse that instead of relying
 * on Puppeteer's DASH player (which only requests 360p by default).
 */
function extractAllQualityRepresentations(html) {
  const results = [];

  // Facebook embeds JSON in <script> tags. We need to find the JSON blob that
  // contains `all_video_dash_prefetch_representations` and parse all representations.
  const marker = '"all_video_dash_prefetch_representations"';
  let searchFrom = 0;

  while (true) {
    const markerIdx = html.indexOf(marker, searchFrom);
    if (markerIdx < 0) break;
    searchFrom = markerIdx + 1;

    // Find the opening [ of the representations array
    const arrStart = html.indexOf('[', markerIdx + marker.length);
    if (arrStart < 0) continue;

    // Find the matching closing ] by counting brackets
    let depth = 0;
    let arrEnd = -1;
    for (let i = arrStart; i < Math.min(arrStart + 50000, html.length); i++) {
      if (html[i] === '[' || html[i] === '{') depth++;
      else if (html[i] === ']' || html[i] === '}') {
        depth--;
        if (depth === 0) { arrEnd = i; break; }
      }
    }
    if (arrEnd < 0) continue;

    const jsonStr = html.slice(arrStart, arrEnd + 1)
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\u003C/gi, '<')
      .replace(/\\u003E/gi, '>')
      .replace(/\\n/g, '\n');

    try {
      const arr = JSON.parse(jsonStr);
      // Each element has { initial_representation_ids, representations: [{...}] }
      for (const group of arr) {
        const reps = group.representations || [];
        for (const rep of reps) {
          if (!rep.base_url || !rep.mime_type) continue;
          const isVideo = rep.mime_type.includes('video');
          const isAudio = rep.mime_type.includes('audio') || (rep.codecs && rep.codecs.startsWith('mp4a'));

          // Determine quality label from codecs and dimensions
          let qualityLabel = '';
          let height = rep.height || 0;
          let bitrate = rep.bandwidth || rep.bitrate_bps || 0;

          // Try to extract height from representation_id (e.g. "17965109496136047v" → use codecs to infer)
          // VP9 codec strings encode profile: vp09.00.40 = Profile 0, Level 4.0 ≈ 1080p
          if (rep.codecs) {
            const levelMatch = rep.codecs.match(/vp09\.00\.(\d+)/);
            if (levelMatch) {
              const level = parseInt(levelMatch[1]);
              if (level >= 40) height = height || 1080;
              else if (level >= 31) height = height || 720;
              else if (level >= 22) height = height || 480;
              else height = height || 360;
            }
          }

          if (height >= 1080) qualityLabel = '1080p';
          else if (height >= 720) qualityLabel = '720p';
          else if (height >= 540) qualityLabel = '540p';
          else if (height >= 480) qualityLabel = '480p';
          else if (height >= 360) qualityLabel = '360p';

          results.push({
            representationId: rep.representation_id || '',
            mimeType: rep.mime_type,
            codecs: rep.codecs || '',
            baseUrl: rep.base_url,
            height,
            width: rep.width || 0,
            bitrate,
            qualityLabel,
            isVideo,
            isAudio
          });
        }
      }
    } catch (e) {
      // JSON parse failed, try next occurrence
    }
  }

  return results;
}

async function scrapeFacebookStoryMedia(targetInput, cUser, xsCookie) {
  const target = parseFacebookTarget(targetInput);
  if (!target || !target.usernameOrId)
    throw new Error('Invalid Facebook username or profile URL.');
  if (!cUser || !xsCookie)
    throw new Error('Facebook session cookies (FB_C_USER and FB_XS) are required.');

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
    await page.setCookie(
      { name: 'c_user', value: String(cUser), domain: '.facebook.com', path: '/' },
      { name: 'xs', value: decodedXs, domain: '.facebook.com', path: '/' }
    );

    const initialNavUrl = targetInput.includes('/stories/') ? targetInput : target.profileUrl;
    await page.goto(initialNavUrl, { waitUntil: 'networkidle2', timeout: 35000 });
    await new Promise(r => setTimeout(r, 2000));

    const currentUrl = page.url();
    console.log(`[Story Scraper] After navigation: ${currentUrl}`);

    if (currentUrl.includes('/login') || currentUrl.includes('login.php'))
      throw new Error('Facebook redirected to login — session cookies expired. Update .env.');

    let storyUrl = currentUrl;
    if (!currentUrl.includes('/stories/')) {
      console.log('[Story Scraper] Looking for story link...');
      const storyHref = await page.evaluate(() => {
        const allLinks = Array.from(document.querySelectorAll('a[href*="/stories/"]'));
        return allLinks.find(l =>
          l.href.includes('/stories/') && !l.href.includes('source=profile_highlight')
        )?.href || null;
      });
      if (!storyHref) throw new Error('No active story found on this profile.');
      console.log(`[Story Scraper] Found story link: ${storyHref.slice(0, 80)}...`);
      storyUrl = storyHref;
    }

    return await captureStoryFromEmbeddedData(page, target, storyUrl);

  } catch (err) {
    console.error('[Story Scraper] Error:', err.message);
    throw err;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Navigates to the story page and extracts ALL quality levels from Facebook's
 * server-rendered embedded JSON — the `all_video_dash_prefetch_representations`
 * field which contains signed CDN base_urls for every quality level.
 *
 * Also captures photos via response listeners.
 * Auto-advances through all story slides to collect all clips.
 */
async function captureStoryFromEmbeddedData(page, target, storyUrl) {
  console.log(`[Story Scraper] Story: ${storyUrl.slice(0, 80)}...`);

  const items = [];
  const capturedPhotoKeys = new Set();
  const capturedVideoKeys = new Set(); // track by representationId prefix

  await page.goto(storyUrl, { waitUntil: 'networkidle2', timeout: 35000 });
  await new Promise(r => setTimeout(r, 3000));

  // Extract first slide (video + photo)
  await extractAndAddVideoItems(page, items, capturedVideoKeys);
  await extractAndAddPhotoItems(page, items, capturedPhotoKeys);

  // Auto-advance through all story slides
  // NOTE: track total items (not just videos) so photo-only stories work correctly
  console.log('[Story Scraper] Auto-advancing through slides...');
  for (let i = 0; i < 15; i++) {
    const prevCount = items.length;
    await page.keyboard.press('ArrowRight');
    await new Promise(r => setTimeout(r, 4000));
    await extractAndAddVideoItems(page, items, capturedVideoKeys);
    await extractAndAddPhotoItems(page, items, capturedPhotoKeys);
    if (i >= 2 && items.length === prevCount) {
      await page.keyboard.press('ArrowRight');
      await new Promise(r => setTimeout(r, 2000));
      await extractAndAddVideoItems(page, items, capturedVideoKeys);
      await extractAndAddPhotoItems(page, items, capturedPhotoKeys);
      if (items.length === prevCount) {
        console.log(`[Story Scraper] End of story at slide ~${i + 1}.`);
        break;
      }
    }
  }

  const videoItemCount = items.filter(i => i.type === 'video').length;
  const pageTitle = await page.title().catch(() => '');
  const displayName = pageTitle ? pageTitle.replace('| Facebook', '').trim() : target.usernameOrId;
  console.log(`[Story Scraper] Done — ${items.length} items (${videoItemCount} videos, ${capturedPhotoKeys.size} photos).`);

  return {
    username: target.usernameOrId,
    profileName: displayName || target.usernameOrId,
    avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${target.usernameOrId}`,
    profileUrl: target.profileUrl,
    isStoryUrl: true,
    items
  };
}

/**
 * Extracts story photos from the DOM and page HTML.
 * Uses two methods:
 *   1. page.evaluate() — reads rendered <img> elements (catches lazy-loaded photos)
 *   2. Regex scan of page HTML — finds CDN URLs embedded in Facebook's JSON data
 */
async function extractAndAddPhotoItems(page, items, capturedPhotoKeys) {
  // Method 1: Extract <img> src from DOM
  const domPhotos = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[src*="fbcdn.net"]'));
    return imgs
      .map(img => img.naturalWidth > 200 ? img.src : null) // only full-size images
      .filter(Boolean);
  }).catch(() => []);

  // Method 2: Extract photo URLs embedded in the page HTML JSON
  const html = await page.content().catch(() => '');
  const htmlPhotos = [];
  // Facebook embeds photo URLs in JSON as escaped strings like:
  // "uri":"https:\/\/scontent...t51.71878-15\/..."
  const photoPatterns = [
    /https?:\/\/scontent[^"\\]*?t51\.71878-15[^"\\]{10,}/g,
    /https?:\/\/scontent[^"\\]*?t51\.2885-15[^"\\]{10,}/g,
    /https?:\/\/scontent[^"\\]*?t15\.5256-10[^"\\]{10,}/g,
    /https?:\/\/scontent[^"\\]*?t51\.39778-[^"\\]{10,}/g,
  ];
  for (const pattern of photoPatterns) {
    const matches = html.match(pattern) || [];
    for (const m of matches) {
      // Facebook JSON-escapes forward slashes as \/ — strip all backslashes to get clean URL
      htmlPhotos.push(m.split('\\').join(''));
    }
  }

  const isExcluded = (url) =>
    url.includes('s40x40') || url.includes('s160x160') ||
    url.includes('/p40x40/') || url.includes('_tt6') ||
    url.includes('rsrc.php') || url.includes('static.xx') ||
    url.endsWith('.webp') || url.includes('t1.30497-1') ||
    url.includes('t39.30808-1') || url.includes('emoji_') ||
    url.includes('/emoji.') || url.includes('s75x75') ||
    url.includes('s320x320') || url.includes('profile');

  for (const rawUrl of [...domPhotos, ...htmlPhotos]) {
    if (!rawUrl || isExcluded(rawUrl)) continue;
    try {
      const key = rawUrl.split('?')[0];
      if (capturedPhotoKeys.has(key)) continue;
      capturedPhotoKeys.add(key);
      items.push({
        id: `story-media-${items.length + 1}`,
        type: 'image',
        mediaUrl: rawUrl,
        thumbnailUrl: rawUrl,
        timestamp: `Story Photo #${capturedPhotoKeys.size}`
      });
      console.log(`[Story Scraper] [image]: ${rawUrl.slice(0, 70)}...`);
    } catch {}
  }
}

async function extractAndAddVideoItems(page, items, capturedVideoKeys) {
  const html = await page.content();
  const reps = extractAllQualityRepresentations(html);

  if (reps.length === 0) return;

  // Group by "clip" — we use the first 80 chars of base_url path as a clip key
  // (same clip has same path prefix across different qualities)
  const clipMap = new Map();
  for (const rep of reps) {
    try {
      const u = new URL(rep.baseUrl);
      // Use the path up to the filename stem as the clip key
      const pathKey = u.pathname.split('/').slice(0, 7).join('/');
      if (!clipMap.has(pathKey)) clipMap.set(pathKey, { videoQualities: [], audioUrl: null });
      const clip = clipMap.get(pathKey);

      if (rep.isVideo) {
        // Avoid duplicating the same representation
        const already = clip.videoQualities.find(q => q.representationId === rep.representationId);
        if (!already) {
          clip.videoQualities.push({
            representationId: rep.representationId,
            tag: `${rep.qualityLabel || rep.height + 'p'} ${rep.codecs.split('.')[0]}`,
            bitrate: rep.bitrate,
            height: rep.height,
            url: rep.baseUrl
          });
        }
      } else if (rep.isAudio && !clip.audioUrl) {
        clip.audioUrl = rep.baseUrl;
      }
    } catch {}
  }

  for (const [pathKey, clip] of clipMap) {
    if (capturedVideoKeys.has(pathKey)) continue;
    if (clip.videoQualities.length === 0) continue;

    capturedVideoKeys.add(pathKey);
    // Sort quality highest first
    clip.videoQualities.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
    const best = clip.videoQualities[0];
    const videoCount = items.filter(i => i.type === 'video').length;

    console.log(`[Story Scraper] [video] clip#${videoCount + 1} — qualities: ${clip.videoQualities.map(q => q.tag).join(', ')}`);
    items.push({
      id: `story-media-${items.length + 1}`,
      type: 'video',
      mediaUrl: best.url,
      audioUrl: clip.audioUrl || null,
      videoQualities: clip.videoQualities,
      thumbnailUrl: '',
      timestamp: `Story Video #${videoCount + 1}`
    });
  }
}

async function scrapeFacebookProfile(targetInput, proxyUrl = null) {
  const cUser = process.env.FB_C_USER;
  const xsCookie = process.env.FB_XS;
  return await scrapeFacebookStoryMedia(targetInput, cUser, xsCookie);
}

module.exports = { parseFacebookTarget, scrapeFacebookProfile };
