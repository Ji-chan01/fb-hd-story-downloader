document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('search-form');
  const input = document.getElementById('profile-input');
  const pasteBtn = document.getElementById('paste-btn');
  const submitBtn = document.getElementById('submit-btn');
  const btnSpinner = document.getElementById('btn-spinner');
  const errorBox = document.getElementById('error-box');

  const resultsSection = document.getElementById('results-section');
  const profileAvatar = document.getElementById('profile-avatar');
  const profileName = document.getElementById('profile-name');
  const profileHandle = document.getElementById('profile-handle');
  const mediaGrid = document.getElementById('media-grid');

  const modal = document.getElementById('media-modal');
  const downloadBtn = document.getElementById('download-btn');
  const modalClose = document.getElementById('modal-close');
  const modalOverlay = document.getElementById('modal-overlay');

  // Paste from clipboard
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) input.value = text;
    } catch (err) {
      console.warn('Clipboard access denied:', err);
    }
  });

  // Form submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    setLoading(true);
    hideError();
    resultsSection.hidden = true;

    try {
      const response = await fetch('/api/fetch-media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileUrl: query })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch profile media.');
      renderResults(data);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    btnSpinner.hidden = !isLoading;
    const btnText = submitBtn.querySelector('span');
    btnText.textContent = isLoading ? 'Searching...' : 'Search Media';
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }

  function renderResults(data) {
    profileName.textContent = data.profileName;
    profileHandle.textContent = `@${data.username}`;
    profileAvatar.referrerPolicy = 'no-referrer';
    profileAvatar.onerror = function() {
      if (!this.dataset.proxied) {
        this.dataset.proxied = 'true';
        this.src = `/api/proxy-image?url=${encodeURIComponent(data.avatarUrl)}`;
      }
    };
    profileAvatar.src = data.avatarUrl;

    mediaGrid.innerHTML = '';
    data.items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'media-card';

      if (item.type === 'video') {
        // Show best quality tag as badge
        const qualities = item.videoQualities || [];
        const topQuality = qualities[0]?.tag.match(/(\d+p)/)?.[1] || 'HD';
        const hasAudio = !!item.audioUrl;
        card.innerHTML = `
          <div class="video-thumb-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="white" opacity="0.8"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="media-card-overlay">
            <span class="time-tag">🎥 ${item.timestamp}</span>
            <span class="time-tag" style="background:rgba(99,102,241,.8)">${topQuality}${hasAudio ? ' 🔊' : ''}</span>
          </div>`;
      } else {
        card.innerHTML = `
          <img src="${item.thumbnailUrl}" alt="Story Photo" loading="lazy"
            referrerpolicy="no-referrer" crossorigin="anonymous">
          <div class="media-card-overlay">
            <span class="time-tag">🖼️ ${item.timestamp}</span>
          </div>`;

        const imgEl = card.querySelector('img');
        if (imgEl) {
          imgEl.onerror = function() {
            if (!this.dataset.proxied) {
              this.dataset.proxied = 'true';
              this.referrerPolicy = 'origin';
              this.src = `/api/proxy-image?url=${encodeURIComponent(item.thumbnailUrl)}`;
            }
          };
        }
      }

      card.addEventListener('click', () => openModal(item));
      mediaGrid.appendChild(card);
    });

    resultsSection.hidden = false;
  }

  function openModal(item) {
    const wrapper = document.querySelector('.modal-media-wrapper');

    if (item.type === 'video') {
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(item.mediaUrl)}`;
      const qualities = item.videoQualities || [];

      // Build quality selector options
      const qualityOptions = qualities.map((q, i) => {
        const label = q.tag.match(/(\d+p)/)?.[1] || `Q${i}`;
        const kbps = Math.round(q.bitrate / 1000);
        return `<option value="${i}">${label} — ${kbps} kbps</option>`;
      }).join('');

      wrapper.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;width:100%;height:100%;gap:12px;padding:8px 0;">
          <video id="modal-video" src="${proxyUrl}" controls autoplay
            style="flex:1;width:100%;min-height:0;object-fit:contain;border-radius:8px;"></video>

          ${qualities.length > 1 ? `
          <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
            <label style="color:#ccc;font-size:13px;white-space:nowrap;">Quality:</label>
            <select id="quality-select" style="background:#1e2233;color:#fff;border:1px solid #4a5568;border-radius:6px;padding:5px 10px;font-size:13px;cursor:pointer;">
              ${qualityOptions}
            </select>
          </div>` : ''}

          <div style="display:flex;gap:10px;flex-shrink:0;width:100%;max-width:440px;">
            <button id="render-btn" style="flex:1;padding:11px 0;background:linear-gradient(135deg,#6c63ff,#4f46e5);
              color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .2s;">
              ⬇ Download with Audio
            </button>
            <button id="video-only-btn" style="padding:11px 14px;background:#2d3748;
              color:#aaa;border:none;border-radius:8px;font-size:13px;cursor:pointer;">
              Video only
            </button>
          </div>
          <p id="render-status" style="color:#9ca3af;font-size:12px;min-height:18px;text-align:center;"></p>
        </div>`;

      // Download with Audio = server-side FFmpeg merge
      document.getElementById('render-btn').addEventListener('click', async () => {
        const btn = document.getElementById('render-btn');
        const status = document.getElementById('render-status');
        const qSel = document.getElementById('quality-select');
        const selectedIdx = qSel ? parseInt(qSel.value) : 0;
        const selectedVideoUrl = qualities[selectedIdx]?.url || item.mediaUrl;
        const qualityLabel = qualities[selectedIdx]?.tag.match(/(\d+p)/)?.[1] || 'hd';

        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.textContent = '⏳ Rendering…';
        status.textContent = 'Downloading & merging video + audio with FFmpeg. This may take ~30s…';

        try {
          const resp = await fetch('/api/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              videoUrl: selectedVideoUrl,
              audioUrl: item.audioUrl || null,
              filename: `story_${item.videoId || item.id}_${qualityLabel}`
            })
          });

          if (!resp.ok) {
            const errData = await resp.json().catch(() => ({}));
            throw new Error(errData.error || 'Render failed');
          }

          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `story_${qualityLabel}.mp4`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          status.textContent = '✅ Downloaded successfully!';
        } catch (e) {
          status.textContent = '❌ ' + e.message;
        } finally {
          btn.disabled = false;
          btn.style.opacity = '1';
          btn.textContent = '⬇ Download with Audio';
        }
      });

      // Video only (no FFmpeg merge, no audio)
      document.getElementById('video-only-btn').addEventListener('click', () => {
        const qSel = document.getElementById('quality-select');
        const selectedIdx = qSel ? parseInt(qSel.value) : 0;
        const selectedVideoUrl = qualities[selectedIdx]?.url || item.mediaUrl;
        const a = document.createElement('a');
        a.href = `/api/proxy-image?url=${encodeURIComponent(selectedVideoUrl)}`;
        a.download = `story_video_only.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });

      // Hide the old generic download button — replaced by render-btn
      downloadBtn.hidden = true;

    } else {
      // Image
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(item.mediaUrl)}&filename=${item.id}.jpg`;
      wrapper.innerHTML = `<img id="modal-img" src="${proxyUrl}" alt="Story Photo"
        style="width:100%;height:100%;object-fit:contain;border-radius:8px;">`;
      downloadBtn.href = proxyUrl;
      downloadBtn.setAttribute('download', `${item.id}.jpg`);
      downloadBtn.hidden = false;
    }

    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
    downloadBtn.hidden = false;
    const wrapper = document.querySelector('.modal-media-wrapper');
    wrapper.innerHTML = `<img id="modal-img" src="" alt="Media Preview">`;
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', closeModal);
});
