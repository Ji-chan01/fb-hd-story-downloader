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
  const modalImg = document.getElementById('modal-img');
  const downloadBtn = document.getElementById('download-btn');
  const modalClose = document.getElementById('modal-close');
  const modalOverlay = document.getElementById('modal-overlay');

  // Paste from clipboard handler
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        input.value = text;
      }
    } catch (err) {
      console.warn('Clipboard access denied or unsupported:', err);
    }
  });

  // Form submission handler
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

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch profile media.');
      }

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
        card.innerHTML = `
          <div class="video-thumb-placeholder">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="white" opacity="0.8"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="media-card-overlay">
            <span class="time-tag">🎥 ${item.timestamp}</span>
          </div>
        `;
      } else {
        // Use direct CDN URL with no-referrer — browser can load Facebook CDN images directly
        card.innerHTML = `
          <img src="${item.thumbnailUrl}" alt="Story Photo" loading="lazy" referrerpolicy="no-referrer" crossorigin="anonymous">
          <div class="media-card-overlay">
            <span class="time-tag">🖼️ ${item.timestamp}</span>
          </div>
        `;

        // Fallback to proxy if direct CDN load fails
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
      // Route through proxy: it forwards Range headers + adds Referer: facebook.com
      // This makes the browser's video player (buffering, seeking) work correctly.
      const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(item.mediaUrl)}`;
      wrapper.innerHTML = `<video src="${proxyUrl}" controls autoplay style="width:100%;height:100%;object-fit:contain;"></video>`;
      downloadBtn.href = proxyUrl;
    } else {
      wrapper.innerHTML = `<img id="modal-img" src="${item.mediaUrl}" alt="Story Photo" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:contain;">`;
      downloadBtn.href = `/api/proxy-image?url=${encodeURIComponent(item.mediaUrl)}`;
    }

    downloadBtn.setAttribute('download', `${item.id}.${item.type === 'video' ? 'mp4' : 'jpg'}`);
    modal.hidden = false;
  }

  function closeModal() {
    modal.hidden = true;
    const wrapper = document.querySelector('.modal-media-wrapper');
    wrapper.innerHTML = `<img id="modal-img" src="" alt="Media Preview">`;
  }

  modalClose.addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', closeModal);
});
