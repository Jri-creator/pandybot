// PandyBot Content Script
// Injects into Pandora and provides Discord webhook sharing

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────
  let currentSong = { title: null, artist: null, album: null, art: null };
  let lastSharedSong = null;
  let config = {
    webhookUrl: '',
  };
  let pollInterval = null;
  let panelOpen = false;

  // ─── Load config from storage ─────────────────────────────────────────────
  chrome.storage.sync.get(['pandybot_config'], (result) => {
    if (result.pandybot_config) {
      config = { ...config, ...result.pandybot_config };
    }
    init();
  });

  function saveConfig() {
    chrome.storage.sync.set({ pandybot_config: config });
  }

  // Keep the in-memory config in sync if it's changed from the popup or another context
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.pandybot_config) {
      config = { ...config, ...changes.pandybot_config.newValue };
      loadConfigIntoUI();
      updateFabPulse();
    }
  });

  // ─── Song Scraping ────────────────────────────────────────────────────────
  function scrapeArt() {
    // Strategy 1: <img> inside the active image container (only if fully loaded)
    const imgEl = document.querySelector('[data-qa="album_active_image"] img');
    if (imgEl?.src && !imgEl.src.endsWith('/') && imgEl.naturalWidth > 0) {
      return upgradeArtUrl(imgEl.src);
    }

    // Strategy 2: Walk the art container divs — active track has an <img>,
    // history tracks use background-image style
    const artContainer = document.querySelector('.nowPlayingTopInfo__artContainer');
    if (artContainer) {
      const artDivs = artContainer.querySelectorAll('.nowPlayingTopInfo__artContainer__art');
      for (const div of artDivs) {
        const childImg = div.querySelector('img');
        if (childImg?.src && childImg.naturalWidth > 0) {
          return upgradeArtUrl(childImg.src);
        }
        const bg = div.style.backgroundImage;
        if (bg && bg !== 'none') {
          const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
          if (match) return upgradeArtUrl(match[1]);
        }
      }
    }

    // Strategy 3: Tuner bar mini thumbnail (always reflects the current song)
    const miniImg = document.querySelector('[data-qa="mini_track_image"]');
    if (miniImg?.src && miniImg.naturalWidth > 0) {
      return upgradeArtUrl(miniImg.src);
    }

    return null;
  }

  function upgradeArtUrl(url) {
    if (!url) return null;
    return url.replace(/\d+W_\d+H/, '500W_500H');
  }

  // Pandora's Marquee component duplicates text for its scroll animation.
  // The structure has changed over time — try each variant and take the first match.
  function scrapeText(el) {
    if (!el) return null;
    // New structure: animated wrapper with __child divs (grab just the first)
    const child = el.querySelector('.Marquee__wrapper__content__child');
    if (child) return child.textContent.trim() || null;
    // Old structure: single .Marquee__wrapper__content element
    const legacy = el.querySelector('.Marquee__wrapper__content');
    if (legacy) return legacy.textContent.trim() || null;
    // Hidden sizer element Pandora uses to measure text width — also reliable
    const sizer = el.querySelector('.Marquee__hiddenSizer');
    if (sizer) return sizer.textContent.trim() || null;
    // No marquee at all — short titles render as plain text
    return el.textContent.trim() || null;
  }

  function scrapeSong() {
    const titleEl =
      document.querySelector('[data-qa="playing_track_title"]') ||
      document.querySelector('.nowPlayingTopInfo__current__trackName') ||
      document.querySelector('.Tuner__Audio__TrackDetail__title');
    const artistEl =
      document.querySelector('[data-qa="playing_artist_name"]') ||
      document.querySelector('.NowPlayingTopInfo__current__artistName') ||
      document.querySelector('.Tuner__Audio__TrackDetail__artist');
    const albumEl =
      document.querySelector('[data-qa="playing_album_name"]') ||
      document.querySelector('.nowPlayingTopInfo__current__albumName');

    const title = scrapeText(titleEl);
    const artist = scrapeText(artistEl);
    const album = scrapeText(albumEl);
    const art = scrapeArt();

    return { title, artist, album, art };
  }

  function songChanged(a, b) {
    return a.title !== b.title || a.artist !== b.artist;
  }

  function artChanged(a, b) {
    return a.art !== b.art && b.art !== null;
  }

  function isValidSong(song) {
    return song.title && song.artist;
  }

  // ─── Discord Webhook ──────────────────────────────────────────────────────
  async function sendToDiscord(song) {
    if (!config.webhookUrl) {
      showToast('No webhook URL set!', 'error');
      return false;
    }

    const embed = {
      title: song.title,
      description: `by **${song.artist}**${song.album ? `\nfrom *${song.album}*` : ''}`,
      color: 0x00a0ee,
      footer: {
        text: '🎵 Shared via PandyBot',
      },
      timestamp: new Date().toISOString(),
    };

    if (song.art) {
      embed.thumbnail = { url: song.art };
    }

    try {
      const res = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'PandyBot',
          avatar_url: 'https://web-cdn.pandora.com/web-client-assets/images/pandora-p.png',
          embeds: [embed],
        }),
      });

      if (res.ok || res.status === 204) {
        lastSharedSong = { ...song };
        showToast(`Shared "${song.title}"!`, 'success');
        updateShareButton();
        return true;
      } else {
        showToast(`Webhook error: ${res.status}`, 'error');
        return false;
      }
    } catch (err) {
      showToast('Failed to reach Discord', 'error');
      return false;
    }
  }

  function alreadyShared(song) {
    return lastSharedSong && lastSharedSong.title === song.title && lastSharedSong.artist === song.artist;
  }

  // ─── Polling Loop ─────────────────────────────────────────────────────────
  function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      const song = scrapeSong();

      if (!isValidSong(song)) return;

      const trackChanged = songChanged(song, currentSong);
      const imageChanged = artChanged(currentSong, song);

      if (trackChanged) {
        currentSong = song;
        updateUI();
      } else if (imageChanged) {
        // Art arrived late (lazy load) — silently update art only, no re-share
        currentSong = { ...currentSong, art: song.art };
        updateArtOnly();
      }
    }, 1500);
  }

  // ─── UI ───────────────────────────────────────────────────────────────────
  function buildUI() {
    document.getElementById('pandybot-root')?.remove();

    const root = document.createElement('div');
    root.id = 'pandybot-root';
    root.innerHTML = `
      <div id="pandybot-fab" title="PandyBot">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" fill="currentColor" opacity="0.3"/>
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none"/>
          <path d="M8 9.5C8 8.67 8.67 8 9.5 8S11 8.67 11 9.5 10.33 11 9.5 11 8 10.33 8 9.5zM13 9.5C13 8.67 13.67 8 14.5 8S16 8.67 16 9.5 15.33 11 14.5 11 13 10.33 13 9.5z" fill="currentColor"/>
          <path d="M8.5 14.5s.8 1.5 3.5 1.5 3.5-1.5 3.5-1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M5 8c-.5-1-1-2 0-3M19 8c.5-1 1-2 0-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </div>

      <div id="pandybot-panel" class="pandybot-hidden">
        <div id="pandybot-header">
          <span id="pandybot-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" fill="none"/>
              <path d="M8 9.5C8 8.67 8.67 8 9.5 8S11 8.67 11 9.5 10.33 11 9.5 11 8 10.33 8 9.5zM13 9.5C13 8.67 13.67 8 14.5 8S16 8.67 16 9.5 15.33 11 14.5 11 13 10.33 13 9.5z" fill="currentColor"/>
              <path d="M8.5 14.5s.8 1.5 3.5 1.5 3.5-1.5 3.5-1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            PandyBot
          </span>
          <button id="pandybot-close" title="Close">✕</button>
        </div>

        <div id="pandybot-now-playing">
          <div id="pandybot-art-wrap">
            <img id="pandybot-art" src="" alt="Album Art" />
            <div id="pandybot-art-placeholder">♪</div>
          </div>
          <div id="pandybot-song-info">
            <div id="pandybot-title">—</div>
            <div id="pandybot-artist">Nothing playing</div>
            <div id="pandybot-album"></div>
          </div>
        </div>

        <div id="pandybot-actions">
          <button id="pandybot-share-btn" class="pandybot-btn pandybot-btn-primary" title="Share to Discord">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.078.112 18.1.13 18.11a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
            </svg>
            Share Now
          </button>
        </div>

        <div id="pandybot-divider"></div>

        <div id="pandybot-settings">
          <div class="pandybot-setting-row">
            <label for="pandybot-webhook">Discord Webhook URL</label>
            <input type="url" id="pandybot-webhook" placeholder="https://discord.com/api/webhooks/..." spellcheck="false" />
          </div>
          <div class="pandybot-setting-row">
            <button id="pandybot-save-btn" class="pandybot-btn pandybot-btn-secondary">Save Settings</button>
          </div>
        </div>

        <div id="pandybot-toast"></div>
      </div>
    `;

    document.body.appendChild(root);
    bindEvents();
    loadConfigIntoUI();
    updateUI();
  }

  function bindEvents() {
    document.getElementById('pandybot-fab').addEventListener('click', togglePanel);
    document.getElementById('pandybot-close').addEventListener('click', togglePanel);
    document.getElementById('pandybot-share-btn').addEventListener('click', () => {
      if (isValidSong(currentSong)) sendToDiscord(currentSong);
      else showToast('No song detected yet!', 'error');
    });
    document.getElementById('pandybot-save-btn').addEventListener('click', saveSettings);
    document.getElementById('pandybot-webhook').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveSettings();
    });
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    const panel = document.getElementById('pandybot-panel');
    const fab = document.getElementById('pandybot-fab');
    if (panelOpen) {
      panel.classList.remove('pandybot-hidden');
      panel.classList.add('pandybot-visible');
      fab.classList.add('pandybot-fab-active');
    } else {
      panel.classList.remove('pandybot-visible');
      panel.classList.add('pandybot-hidden');
      fab.classList.remove('pandybot-fab-active');
    }
  }

  function loadConfigIntoUI() {
    const webhookInput = document.getElementById('pandybot-webhook');
    if (webhookInput) webhookInput.value = config.webhookUrl || '';
  }

  function saveSettings() {
    const webhookInput = document.getElementById('pandybot-webhook');
    config.webhookUrl = webhookInput?.value?.trim() || '';
    saveConfig();
    showToast('Settings saved!', 'success');
  }

  function updateUI() {
    const song = currentSong;

    const titleEl = document.getElementById('pandybot-title');
    const artistEl = document.getElementById('pandybot-artist');
    const albumEl = document.getElementById('pandybot-album');
    const artEl = document.getElementById('pandybot-art');
    const artPlaceholder = document.getElementById('pandybot-art-placeholder');

    if (titleEl) titleEl.textContent = song.title || '—';
    if (artistEl) artistEl.textContent = song.artist || 'Nothing playing';
    if (albumEl) albumEl.textContent = song.album || '';

    if (artEl && song.art) {
      artEl.src = song.art;
      artEl.style.display = 'block';
      if (artPlaceholder) artPlaceholder.style.display = 'none';
    } else if (artEl) {
      artEl.style.display = 'none';
      if (artPlaceholder) artPlaceholder.style.display = 'flex';
    }

    updateShareButton();
    updateFabPulse();
  }

  function updateArtOnly() {
    const artEl = document.getElementById('pandybot-art');
    const artPlaceholder = document.getElementById('pandybot-art-placeholder');
    const art = currentSong.art;

    if (artEl && art) {
      artEl.src = art;
      artEl.style.display = 'block';
      if (artPlaceholder) artPlaceholder.style.display = 'none';
    }
  }

  function updateShareButton() {
    const btn = document.getElementById('pandybot-share-btn');
    if (!btn) return;
    if (alreadyShared(currentSong) && isValidSong(currentSong)) {
      btn.classList.add('pandybot-btn-shared');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
        </svg>
        Shared!
      `;
    } else {
      btn.classList.remove('pandybot-btn-shared');
      btn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057.1 18.078.112 18.1.13 18.11a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
        </svg>
        Share Now
      `;
    }
  }

  function updateFabPulse() {
    const fab = document.getElementById('pandybot-fab');
    if (!fab) return;
    if (isValidSong(currentSong) && !alreadyShared(currentSong) && config.webhookUrl) {
      fab.classList.add('pandybot-fab-pulse');
    } else {
      fab.classList.remove('pandybot-fab-pulse');
    }
  }

  let toastTimeout = null;
  function showToast(msg, type = 'info') {
    const toast = document.getElementById('pandybot-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `pandybot-toast-${type} pandybot-toast-visible`;
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
      toast.className = '';
      toast.textContent = '';
    }, 3000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    setTimeout(() => {
      buildUI();
      const song = scrapeSong();
      if (isValidSong(song)) currentSong = song;
      updateUI();
      startPolling();
    }, 1500);
  }

})();
