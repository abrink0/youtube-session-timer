/**
 * YouTube Session Timer - Content Script
 * 
 * Responsibilities:
 * 1. Blocking overlays for IDLE (session prompt) and COOLDOWN states.
 * 2. Active session feed filtering (hiding videos exceeding remainingTime).
 * 3. Hiding non-standard content (livestreams, premieres, playlists).
 * 4. Immediate media interruption upon session expiration.
 * 5. Dynamic re-evaluation across SPA navigations and scrolling.
 */

(() => {
  // Prevent duplicate injection in the same frame
  if (window.__yt_session_limiter_injected) return;
  window.__yt_session_limiter_injected = true;

  // State cache
  let currentState = 'IDLE';
  let currentRemainingTime = 0;
  let currentCooldownEndTime = null;

  // Keepalive port to prevent Service Worker sleep during active YouTube sessions (TC-1)
  let keepAlivePort = null;

  // DOM Elements & References
  let overlayContainer = null;
  let shadowRoot = null;
  let currentOverlayView = null; // 'IDLE' | 'COOLDOWN' | null
  let cooldownTimerInterval = null;
  let activeReevalInterval = null;
  let mutationObserver = null;
  let isMutationPending = false;

  // Target selectors for YouTube video cards
  const CARD_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'yt-lockup-view-model',
    'ytd-playlist-renderer',
    'ytd-radio-renderer',
    'ytd-compact-playlist-renderer',
    'ytd-compact-radio-renderer'
  ].join(', ');

  /**
   * Helper: Parse string duration like "1:23:45", "12:34", "0:45" into total seconds.
   */
  function parseTimestampToSeconds(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.trim();

    const parts = clean.split(':').map((p) => p.trim());
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseInt(parts[1], 10);
      if (!isNaN(m) && !isNaN(s)) {
        return m * 60 + s;
      }
    } else if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const s = parseInt(parts[2], 10);
      if (!isNaN(h) && !isNaN(m) && !isNaN(s)) {
        return h * 3600 + m * 60 + s;
      }
    }
    return null;
  }

  /**
   * Helper: Parse natural language duration from aria-label
   * Example: "14 minutes, 20 seconds" or "1 hour, 5 minutes"
   */
  function parseAriaLabelToSeconds(ariaText) {
    if (!ariaText || typeof ariaText !== 'string') return null;

    const hourMatch = ariaText.match(/(\d+)\s+hours?/i);
    const minMatch = ariaText.match(/(\d+)\s+minutes?/i);
    const secMatch = ariaText.match(/(\d+)\s+seconds?/i);

    if (hourMatch || minMatch || secMatch) {
      const h = hourMatch ? parseInt(hourMatch[1], 10) : 0;
      const m = minMatch ? parseInt(minMatch[1], 10) : 0;
      const s = secMatch ? parseInt(secMatch[1], 10) : 0;
      return h * 3600 + m * 60 + s;
    }

    return null;
  }

  /**
   * Extract video duration info from a card DOM element.
   * Returns:
   *  - { isNonStandard: true } if livestream, premiere, playlist, or mix.
   *  - { seconds: number } if standard video duration is found.
   *  - null if duration metadata is not yet rendered.
   */
  function getVideoCardInfo(card) {
    const tagName = card.tagName.toLowerCase();

    // Playlists and Mixes
    if (
      tagName === 'ytd-playlist-renderer' ||
      tagName === 'ytd-radio-renderer' ||
      tagName === 'ytd-compact-playlist-renderer' ||
      tagName === 'ytd-compact-radio-renderer' ||
      card.querySelector('ytd-thumbnail-overlay-bottom-panel-renderer') ||
      card.querySelector('yt-formatted-string[aria-label*="videos"]')
    ) {
      return { isNonStandard: true, reason: 'playlist' };
    }

    // Check overlay-style attributes on badge elements
    const styleOverlay = card.querySelector('[overlay-style]');
    if (styleOverlay) {
      const style = styleOverlay.getAttribute('overlay-style');
      if (style === 'LIVE' || style === 'UPCOMING') {
        return { isNonStandard: true, reason: style.toLowerCase() };
      }
    }

    // Check badges for time status or LIVE/PREMIERE
    const badges = card.querySelectorAll(
      'ytd-thumbnail-overlay-time-status-renderer, badge-shape, yt-badge-shape, .badge-shape-wiz__text, #time-status, .badge-shape-wiz--thumbnail-badge'
    );

    for (const badge of badges) {
      const text = (badge.textContent || '').trim().toUpperCase();
      if (text.includes('LIVE') || text.includes('UPCOMING') || text.includes('PREMIERE')) {
        return { isNonStandard: true, reason: 'live_or_premiere' };
      }

      const parsedSec = parseTimestampToSeconds(text);
      if (parsedSec !== null) {
        return { seconds: parsedSec };
      }
    }

    // Fallback: Check aria-labels on thumbnail or title anchors
    const anchor = card.querySelector('a#thumbnail, a#video-title-link, a#video-title, a[href*="/watch"]');
    if (anchor) {
      const aria = anchor.getAttribute('aria-label') || '';
      if (aria.toUpperCase().includes('LIVE') || aria.toUpperCase().includes('PREMIERE')) {
        return { isNonStandard: true, reason: 'aria_live' };
      }

      const parsedAria = parseAriaLabelToSeconds(aria);
      if (parsedAria !== null) {
        return { seconds: parsedAria };
      }
    }

    return null;
  }

  /**
   * Filter a single card against remainingTime.
   */
  function filterCard(card, remainingTime) {
    if (!card || !card.style) return;

    const info = getVideoCardInfo(card);
    if (!info) {
      return;
    }

    if (info.isNonStandard || info.seconds > remainingTime) {
      if (card.style.display !== 'none') {
        card.style.display = 'none';
        card.setAttribute('data-yt-limiter-hidden', 'true');
      }
    } else {
      if (card.getAttribute('data-yt-limiter-hidden') === 'true') {
        card.style.display = '';
        card.removeAttribute('data-yt-limiter-hidden');
      }
    }
  }

  /**
   * Scan and filter all video cards in the DOM.
   */
  function filterAllCards(remainingTime) {
    if (currentState !== 'ACTIVE') return;

    const cards = document.querySelectorAll(CARD_SELECTORS);
    for (let i = 0; i < cards.length; i++) {
      filterCard(cards[i], remainingTime);
    }
  }

  /**
   * Restore all previously hidden video cards.
   */
  function unhideAllCards() {
    const hidden = document.querySelectorAll('[data-yt-limiter-hidden="true"]');
    for (let i = 0; i < hidden.length; i++) {
      hidden[i].style.display = '';
      hidden[i].removeAttribute('data-yt-limiter-hidden');
    }
  }

  /**
   * Pause and mute active media on YouTube.
   */
  function pauseMedia() {
    const mediaElements = document.querySelectorAll('video, audio');
    mediaElements.forEach((el) => {
      try {
        if (!el.paused) el.pause();
      } catch (e) {}
    });
  }

  /**
   * Block keyboard shortcuts that could control YouTube when overlay is showing.
   */
  function handleKeyDownBlocker(e) {
    if (currentOverlayView === 'IDLE' || currentOverlayView === 'COOLDOWN') {
      const path = e.composedPath();
      if (path.length > 0 && (path[0].tagName === 'INPUT' || path[0].tagName === 'BUTTON')) {
        return;
      }
      e.stopImmediatePropagation();
    }
  }

  /**
   * Initialize or retrieve overlay Shadow DOM host.
   */
  function getOrCreateOverlay() {
    if (!overlayContainer) {
      overlayContainer = document.createElement('div');
      overlayContainer.id = 'yt-session-limiter-host';
      overlayContainer.style.all = 'initial';
      overlayContainer.style.position = 'fixed';
      overlayContainer.style.top = '0';
      overlayContainer.style.left = '0';
      overlayContainer.style.width = '100vw';
      overlayContainer.style.height = '100vh';
      overlayContainer.style.zIndex = '2147483647';
      overlayContainer.style.display = 'none';

      shadowRoot = overlayContainer.attachShadow({ mode: 'closed' });

      const mount = () => {
        const target = document.body || document.documentElement;
        if (target && !overlayContainer.parentElement) {
          target.appendChild(overlayContainer);
        }
      };

      mount();
      document.addEventListener('DOMContentLoaded', mount);
      window.addEventListener('keydown', handleKeyDownBlocker, true);
    }

    if (!overlayContainer.parentElement) {
      const target = document.body || document.documentElement;
      if (target) target.appendChild(overlayContainer);
    }

    return { overlayContainer, shadowRoot };
  }

  /**
   * Format seconds into MM:SS or HH:MM:SS string.
   */
  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const pad = (n) => String(n).padStart(2, '0');

    if (hours > 0) {
      return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
    }
    return `${pad(minutes)}:${pad(secs)}`;
  }

  /**
   * Overlay stylesheet.
   */
  function getOverlayStyles() {
    return `
      :host {
        all: initial;
      }
      .backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(10, 10, 15, 0.96);
        backdrop-filter: blur(12px);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        color: #f1f1f1;
        box-sizing: border-box;
      }
      .card {
        background: #18181f;
        border: 1px solid #2e2e38;
        border-radius: 16px;
        padding: 36px 40px;
        max-width: 480px;
        width: 90%;
        text-align: center;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.6);
        animation: fadeIn 0.25s ease-out;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: scale(0.96); }
        to { opacity: 1; transform: scale(1); }
      }
      .icon-circle {
        width: 68px;
        height: 68px;
        border-radius: 50%;
        margin: 0 auto 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
      }
      .icon-idle {
        background: rgba(59, 130, 246, 0.15);
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.3);
      }
      .icon-cooldown {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
        border: 1px solid rgba(239, 68, 68, 0.3);
      }
      h2 {
        margin: 0 0 10px 0;
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.02em;
        color: #ffffff;
      }
      p.subtitle {
        margin: 0 0 24px 0;
        font-size: 14px;
        line-height: 1.5;
        color: #9ca3af;
      }
      .quick-buttons {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 8px;
        margin-bottom: 18px;
      }
      .preset-btn {
        background: #272732;
        border: 1px solid #3b3b48;
        border-radius: 8px;
        color: #e5e7eb;
        padding: 10px 0;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .preset-btn:hover {
        background: #3b3b48;
        border-color: #60a5fa;
        color: #ffffff;
      }
      .custom-input-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
        text-align: left;
        margin-bottom: 22px;
      }
      label {
        font-size: 13px;
        font-weight: 500;
        color: #d1d5db;
      }
      .input-wrapper {
        position: relative;
        display: flex;
        align-items: center;
      }
      input[type="number"] {
        width: 100%;
        background: #0f0f14;
        border: 1px solid #374151;
        border-radius: 8px;
        color: #ffffff;
        font-size: 16px;
        padding: 12px 64px 12px 14px;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.15s ease;
      }
      input[type="number"]:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
      }
      .unit-label {
        position: absolute;
        right: 14px;
        font-size: 13px;
        color: #6b7280;
        pointer-events: none;
      }
      .error-msg {
        color: #f87171;
        font-size: 13px;
        margin-top: 6px;
        display: none;
      }
      .primary-btn {
        width: 100%;
        background: #2563eb;
        border: none;
        border-radius: 8px;
        color: #ffffff;
        font-size: 15px;
        font-weight: 600;
        padding: 14px;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .primary-btn:hover {
        background: #1d4ed8;
      }
      .primary-btn:disabled {
        background: #4b5563;
        cursor: not-allowed;
      }
      .timer-display {
        font-size: 48px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
        color: #ef4444;
        margin: 16px 0 20px;
      }
      .cooldown-note {
        font-size: 13px;
        color: #6b7280;
        border-top: 1px solid #2e2e38;
        padding-top: 16px;
        margin-top: 20px;
      }
    `;
  }

  /**
   * Render IDLE overlay.
   */
  function showIdleOverlay() {
    currentOverlayView = 'IDLE';
    if (cooldownTimerInterval) {
      clearInterval(cooldownTimerInterval);
      cooldownTimerInterval = null;
    }

    const { overlayContainer, shadowRoot } = getOrCreateOverlay();
    overlayContainer.style.display = 'block';
    if (document.documentElement) {
      document.documentElement.style.overflow = 'hidden';
    }
    pauseMedia();

    shadowRoot.innerHTML = `
      <style>${getOverlayStyles()}</style>
      <div class="backdrop">
        <div class="card">
          <div class="icon-circle icon-idle">⏱</div>
          <h2>Set Session Duration</h2>
          <p class="subtitle">YouTube is paused. Choose how many minutes you want to spend in this session.</p>
          
          <div class="quick-buttons">
            <button class="preset-btn" data-min="5">5m</button>
            <button class="preset-btn" data-min="15">15m</button>
            <button class="preset-btn" data-min="30">30m</button>
            <button class="preset-btn" data-min="45">45m</button>
          </div>

          <form id="session-form">
            <div class="custom-input-group">
              <label for="duration-input">Or enter custom minutes</label>
              <div class="input-wrapper">
                <input type="number" id="duration-input" min="1" max="480" step="1" placeholder="e.g. 20" required autofocus />
                <span class="unit-label">mins</span>
              </div>
              <div id="error-text" class="error-msg"></div>
            </div>

            <button type="submit" id="start-btn" class="primary-btn">Start Session</button>
          </form>
        </div>
      </div>
    `;

    const form = shadowRoot.getElementById('session-form');
    const input = shadowRoot.getElementById('duration-input');
    const errorText = shadowRoot.getElementById('error-text');
    const startBtn = shadowRoot.getElementById('start-btn');
    const presetBtns = shadowRoot.querySelectorAll('.preset-btn');

    presetBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.getAttribute('data-min');
        errorText.style.display = 'none';
        input.focus();
      });
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawVal = input.value.trim();
      const minutes = parseFloat(rawVal);

      if (isNaN(minutes) || minutes <= 0) {
        errorText.textContent = 'Please enter a valid positive duration in minutes.';
        errorText.style.display = 'block';
        return;
      }

      startBtn.disabled = true;
      startBtn.textContent = 'Starting...';

      chrome.runtime.sendMessage(
        { type: 'START_SESSION', durationMinutes: minutes },
        (response) => {
          startBtn.disabled = false;
          startBtn.textContent = 'Start Session';

          if (chrome.runtime.lastError || !response || !response.success) {
            errorText.textContent = response?.error || 'Failed to start session. Please try again.';
            errorText.style.display = 'block';
          } else {
            hideOverlay();
            applyState(response);
          }
        }
      );
    });
  }

  /**
   * Render COOLDOWN overlay.
   */
  function showCooldownOverlay(cooldownEndTime) {
    currentOverlayView = 'COOLDOWN';
    if (cooldownTimerInterval) {
      clearInterval(cooldownTimerInterval);
      cooldownTimerInterval = null;
    }

    const { overlayContainer, shadowRoot } = getOrCreateOverlay();
    overlayContainer.style.display = 'block';
    if (document.documentElement) {
      document.documentElement.style.overflow = 'hidden';
    }
    pauseMedia();

    const endTime = typeof cooldownEndTime === 'number' ? cooldownEndTime : Date.now();

    shadowRoot.innerHTML = `
      <style>${getOverlayStyles()}</style>
      <div class="backdrop">
        <div class="card">
          <div class="icon-circle icon-cooldown">🛑</div>
          <h2>Session Expired</h2>
          <p class="subtitle">You have reached your session limit. YouTube is locked during the mandatory cooldown period.</p>
          
          <div class="timer-display" id="cooldown-timer">--:--</div>
          
          <p class="subtitle" style="margin-bottom: 0;">Step away, stretch, or focus on other priorities.</p>

          <div class="cooldown-note">
            YouTube unlocks automatically when the countdown completes.
          </div>
        </div>
      </div>
    `;

    const timerEl = shadowRoot.getElementById('cooldown-timer');

    function updateCooldownCountdown() {
      const remainingSeconds = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
      if (timerEl) {
        timerEl.textContent = formatTime(remainingSeconds);
      }
      pauseMedia();

      if (remainingSeconds <= 0) {
        if (cooldownTimerInterval) {
          clearInterval(cooldownTimerInterval);
          cooldownTimerInterval = null;
        }
        fetchAndApplyState();
      }
    }

    updateCooldownCountdown();
    cooldownTimerInterval = setInterval(updateCooldownCountdown, 1000);
  }

  /**
   * Hide the overlay.
   */
  function hideOverlay() {
    currentOverlayView = null;
    if (document.documentElement) {
      document.documentElement.style.overflow = '';
    }
    if (cooldownTimerInterval) {
      clearInterval(cooldownTimerInterval);
      cooldownTimerInterval = null;
    }
    if (overlayContainer) {
      overlayContainer.style.display = 'none';
    }
  }

  /**
   * Start DOM observer for dynamically loaded cards in feeds.
   */
  function startFeedObserver() {
    if (!mutationObserver) {
      mutationObserver = new MutationObserver(() => {
        if (currentState !== 'ACTIVE') return;
        if (!isMutationPending) {
          isMutationPending = true;
          requestAnimationFrame(() => {
            isMutationPending = false;
            filterAllCards(currentRemainingTime);
          });
        }
      });

      const root = document.body || document.documentElement;
      if (root) {
        mutationObserver.observe(root, { childList: true, subtree: true });
      }
    }

    // Periodic check as active remainingTime decreases
    if (!activeReevalInterval) {
      activeReevalInterval = setInterval(() => {
        if (currentState === 'ACTIVE') {
          filterAllCards(currentRemainingTime);
        }
      }, 1000);
    }
  }

  /**
   * Stop DOM observer.
   */
  function stopFeedObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (activeReevalInterval) {
      clearInterval(activeReevalInterval);
      activeReevalInterval = null;
    }
  }

  /**
   * Keepalive port connection to prevent service worker idling during active sessions (TC-1).
   */
  function setupKeepAlivePort() {
    if (currentState === 'ACTIVE') {
      if (!keepAlivePort && chrome.runtime && chrome.runtime.connect) {
        try {
          keepAlivePort = chrome.runtime.connect({ name: 'yt_active_keepalive' });
          keepAlivePort.onDisconnect.addListener(() => {
            keepAlivePort = null;
            if (currentState === 'ACTIVE') {
              setTimeout(setupKeepAlivePort, 1000);
            }
          });
        } catch {
          keepAlivePort = null;
        }
      }
    } else {
      if (keepAlivePort) {
        try {
          keepAlivePort.disconnect();
        } catch {}
        keepAlivePort = null;
      }
    }
  }

  /**
   * Anti-tamper DOM check: re-mount overlay if it is detached while in IDLE or COOLDOWN (TC-3).
   */
  function ensureOverlayMounted() {
    if (currentState === 'IDLE' || currentState === 'COOLDOWN') {
      if (overlayContainer && !overlayContainer.parentElement) {
        const target = document.body || document.documentElement;
        if (target) {
          target.appendChild(overlayContainer);
        }
      }
    }
  }

  /**
   * Apply incoming state machine data to the UI.
   */
  function applyState(data) {
    if (!data) return;

    currentState = data.state || 'IDLE';
    currentRemainingTime = typeof data.remainingTime === 'number' ? data.remainingTime : 0;
    currentCooldownEndTime = data.cooldownEndTime || null;

    setupKeepAlivePort();

    if (currentState === 'IDLE') {
      stopFeedObserver();
      unhideAllCards();
      showIdleOverlay();
    } else if (currentState === 'COOLDOWN') {
      stopFeedObserver();
      showCooldownOverlay(currentCooldownEndTime);
    } else if (currentState === 'ACTIVE') {
      hideOverlay();
      startFeedObserver();
      filterAllCards(currentRemainingTime);
    }
  }

  /**
   * Fetch current state from background service worker.
   */
  function fetchAndApplyState() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        return;
      }
      applyState(response);
    });
  }

  // Listen for storage changes from background worker
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.state || changes.cooldownEndTime || changes.remainingTime) {
      chrome.storage.local.get(['state', 'cooldownEndTime', 'remainingTime'], (data) => {
        applyState(data);
      });
    }
  });

  // Listen for direct runtime notifications from background worker
  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === 'STATE_CHANGED') {
      applyState({
        state: message.state,
        cooldownEndTime: message.data?.cooldownEndTime,
        remainingTime: message.data?.remainingTime
      });
    }
  });

  // Capture-phase media playback guard: immediately halt any video/audio attempt in IDLE or COOLDOWN (FR-4.2)
  window.addEventListener('play', (e) => {
    if (currentState === 'IDLE' || currentState === 'COOLDOWN') {
      try {
        if (e.target && typeof e.target.pause === 'function') {
          e.target.pause();
        }
      } catch {}
    }
  }, true);

  window.addEventListener('playing', (e) => {
    if (currentState === 'IDLE' || currentState === 'COOLDOWN') {
      try {
        if (e.target && typeof e.target.pause === 'function') {
          e.target.pause();
        }
      } catch {}
    }
  }, true);

  // YouTube SPA navigation lifecycle hooks (TC-2)
  function handleSpaNavigation() {
    if (currentState === 'ACTIVE') {
      filterAllCards(currentRemainingTime);
    } else {
      ensureOverlayMounted();
      pauseMedia();
    }
  }

  document.addEventListener('yt-navigate-finish', handleSpaNavigation);
  window.addEventListener('yt-navigate-finish', handleSpaNavigation);
  document.addEventListener('yt-page-data-updated', handleSpaNavigation);
  window.addEventListener('popstate', handleSpaNavigation);

  // Initial state fetch
  fetchAndApplyState();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseTimestampToSeconds,
      parseAriaLabelToSeconds,
      getVideoCardInfo
    };
  }
})();
