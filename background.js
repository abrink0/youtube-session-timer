/**
 * YouTube Session Timer - Background Service Worker
 * Manages the core 3-state machine: IDLE, ACTIVE, COOLDOWN.
 * Enforces focus-based countdown (FR-2.1, FR-2.2) and toolbar badge visibility (FR-2.4).
 */

const DEFAULT_GLOBAL_COOLDOWN_MINUTES = 30;
const COOLDOWN_ALARM_NAME = 'cooldown_expiry_alarm';

// In-memory ticker interval reference
let activeTimerInterval = null;

/**
 * Get current state object from storage.
 */
async function getStoredState() {
  const data = await chrome.storage.local.get([
    'state',
    'remainingTime',
    'cooldownEndTime',
    'globalCooldownDuration'
  ]);

  return {
    state: data.state || 'IDLE',
    remainingTime: typeof data.remainingTime === 'number' ? data.remainingTime : 0,
    cooldownEndTime: typeof data.cooldownEndTime === 'number' ? data.cooldownEndTime : null,
    globalCooldownDuration: typeof data.globalCooldownDuration === 'number'
      ? data.globalCooldownDuration
      : DEFAULT_GLOBAL_COOLDOWN_MINUTES
  };
}

/**
 * Initialize default settings if missing.
 */
async function initializeDefaults() {
  const data = await chrome.storage.local.get([
    'state',
    'remainingTime',
    'cooldownEndTime',
    'globalCooldownDuration'
  ]);

  const updates = {};
  if (!data.state) {
    updates.state = 'IDLE';
  }
  if (typeof data.remainingTime !== 'number') {
    updates.remainingTime = 0;
  }
  if (typeof data.cooldownEndTime === 'undefined') {
    updates.cooldownEndTime = null;
  }
  if (typeof data.globalCooldownDuration !== 'number') {
    updates.globalCooldownDuration = DEFAULT_GLOBAL_COOLDOWN_MINUTES;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

/**
 * Check whether a given URL is a YouTube page.
 */
function isYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'www.youtube.com' ||
      hostname === 'youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
  }
}

/**
 * Evaluate whether the user is engaged with YouTube content in any way (FR-2.1, FR-2.2):
 * 1. Audio is playing in any YouTube tab (background audio tracking via tab.audible).
 * 2. A YouTube tab is the active tab in an open, non-minimized browser window
 *    (supporting watching while working in another window/app, side-by-side, or multi-monitor).
 * Returns true if the user can be engaged; false only if it is not possible to be engaged.
 */
async function isUserEngagedWithYouTube() {
  try {
    if (!chrome.tabs || !chrome.tabs.query) return false;

    // Query all open YouTube tabs
    const allTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    if (!allTabs || allTabs.length === 0) return false;
    const ytTabs = allTabs.filter((tab) => isYouTubeUrl(tab.url));
    if (ytTabs.length === 0) return false;

    // 1. Background audio check: If any YouTube tab is playing audio, the timer must tick
    const isPlayingAudio = ytTabs.some((tab) => Boolean(tab.audible));
    if (isPlayingAudio) {
      return true;
    }

    // 2. Visible tab check: If a YouTube tab is the active tab in an open, non-minimized window,
    // the user can see and watch the content (even if input focus is in another window/app).
    if (chrome.windows && chrome.windows.getAll) {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal', 'popup'] });
      const windowMap = new Map();
      for (const w of windows) {
        windowMap.set(w.id, w);
      }

      for (const tab of ytTabs) {
        if (tab.active) {
          const win = windowMap.get(tab.windowId);
          // If window is open and not minimized, the user can see YouTube
          if (win && win.state !== 'minimized') {
            return true;
          }
        }
      }
    } else {
      // Fallback: check if any YouTube tab is active
      const isAnyActive = ytTabs.some((tab) => Boolean(tab.active));
      if (isAnyActive) return true;
    }

    // Neither playing audio nor visible in an active, non-minimized window
    return false;
  } catch {
    return false;
  }
}

// Alias for backwards compatibility
const isYouTubeActiveAndFocused = isUserEngagedWithYouTube;

/**
 * Update the extension toolbar action badge (FR-2.4).
 */
async function updateBadge(stateData) {
  if (!chrome.action || !chrome.action.setBadgeText) return;

  const data = stateData || await getStoredState();
  const state = data.state || 'IDLE';

  if (state === 'IDLE') {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  if (state === 'COOLDOWN') {
    const remainingSec = data.cooldownEndTime
      ? Math.max(0, Math.ceil((data.cooldownEndTime - Date.now()) / 1000))
      : 0;
    const text = remainingSec >= 60 ? `${Math.ceil(remainingSec / 60)}m` : `${remainingSec}s`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // Red
    return;
  }

  if (state === 'ACTIVE') {
    const remainingSec = data.remainingTime || 0;
    const isFocused = await isYouTubeActiveAndFocused();
    const text = remainingSec >= 60 ? `${Math.ceil(remainingSec / 60)}m` : `${remainingSec}s`;
    await chrome.action.setBadgeText({ text });
    // Blue when active & counting down on YouTube; Gray when paused
    await chrome.action.setBadgeBackgroundColor({ color: isFocused ? '#2563eb' : '#6b7280' });
  }
}

/**
 * Evaluate if current cooldown has expired.
 */
async function checkCooldownStatus() {
  const current = await getStoredState();
  if (current.state === 'COOLDOWN') {
    const now = Date.now();
    if (current.cooldownEndTime && now >= current.cooldownEndTime) {
      await transitionToIdle();
      return true;
    }
  }
  return false;
}

/**
 * Transition state machine to IDLE.
 */
async function transitionToIdle() {
  stopCountdownTimer();
  await chrome.alarms.clear(COOLDOWN_ALARM_NAME);

  const updates = {
    state: 'IDLE',
    remainingTime: 0,
    cooldownEndTime: null
  };

  await chrome.storage.local.set(updates);
  await updateBadge(updates);
  notifyTabsStateChanged('IDLE', updates);
}

/**
 * Transition state machine to ACTIVE.
 */
async function transitionToActive(durationMinutes) {
  const durationSeconds = Math.round(durationMinutes * 60);
  const updates = {
    state: 'ACTIVE',
    remainingTime: durationSeconds,
    cooldownEndTime: null
  };

  await chrome.storage.local.set(updates);
  startCountdownTimer();
  await updateBadge(updates);
  notifyTabsStateChanged('ACTIVE', updates);
}

/**
 * Transition state machine to COOLDOWN.
 */
async function transitionToCooldown() {
  stopCountdownTimer();

  const current = await getStoredState();
  const cooldownDurationMinutes = current.globalCooldownDuration || DEFAULT_GLOBAL_COOLDOWN_MINUTES;
  const cooldownMs = cooldownDurationMinutes * 60 * 1000;
  const cooldownEndTime = Date.now() + cooldownMs;

  const updates = {
    state: 'COOLDOWN',
    remainingTime: 0,
    cooldownEndTime: cooldownEndTime
  };

  await chrome.storage.local.set(updates);

  // Set persistent alarm to fire at wall-clock cooldown end
  await chrome.alarms.create(COOLDOWN_ALARM_NAME, {
    when: cooldownEndTime
  });

  await updateBadge(updates);
  notifyTabsStateChanged('COOLDOWN', updates);
}

/**
 * Starts focus-aware 1-second countdown ticker for ACTIVE state (FR-2.1, FR-2.2).
 */
function startCountdownTimer() {
  stopCountdownTimer();
  activeTimerInterval = setInterval(async () => {
    const current = await getStoredState();
    if (current.state !== 'ACTIVE') {
      stopCountdownTimer();
      await updateBadge(current);
      return;
    }

    // FR-2.1: Count down ONLY when a browser window is focused AND active tab is YouTube
    const isFocused = await isYouTubeActiveAndFocused();
    await updateBadge(current);

    if (!isFocused) {
      // Automatic pause (FR-2.2): switching tabs, apps, minimizing, or no YouTube tabs
      return;
    }

    const nextRemaining = current.remainingTime - 1;
    if (nextRemaining <= 0) {
      await transitionToCooldown();
    } else {
      await chrome.storage.local.set({ remainingTime: nextRemaining });
    }
  }, 1000);
}

/**
 * Stops countdown ticker.
 */
function stopCountdownTimer() {
  if (activeTimerInterval !== null) {
    clearInterval(activeTimerInterval);
    activeTimerInterval = null;
  }
}

/**
 * Notify all open tabs about a state change.
 */
function notifyTabsStateChanged(state, data) {
  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ url: '*://*.youtube.com/*' }, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'STATE_CHANGED',
            state: state,
            data: data
          }).catch(() => {
            // Tab may not have content script ready or is inactive
          });
        }
      }
    });
  }
}

/**
 * Focus and tab change handler to immediately update paused/active badge visual.
 */
async function onFocusOrTabChanged() {
  const current = await getStoredState();
  if (current.state === 'ACTIVE') {
    await updateBadge(current);
  }
}

// Tab & Window Focus Event Listeners (FR-2.1, FR-2.2)
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(onFocusOrTabChanged);
}

if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete' || typeof changeInfo.audible === 'boolean') {
      onFocusOrTabChanged();
    }
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(onFocusOrTabChanged);
}

if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(onFocusOrTabChanged);
}

// Handle keepalive port connection from active YouTube tabs (TC-1)
if (chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'yt_active_keepalive') {
      port.onDisconnect.addListener(() => {
        // Handled automatically by focus checks
      });
    }
  });
}

// Extension Lifecycle Listeners
chrome.runtime.onInstalled.addListener(async () => {
  await initializeDefaults();
  await checkCooldownStatus();
  const current = await getStoredState();
  if (current.state === 'ACTIVE' && current.remainingTime > 0) {
    startCountdownTimer();
  }
  await updateBadge(current);
});

chrome.runtime.onStartup.addListener(async () => {
  await checkCooldownStatus();
  const current = await getStoredState();
  if (current.state === 'ACTIVE' && current.remainingTime > 0) {
    startCountdownTimer();
  }
  await updateBadge(current);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === COOLDOWN_ALARM_NAME) {
    const current = await getStoredState();
    if (current.state === 'COOLDOWN') {
      await transitionToIdle();
    }
  }
});

// Runtime Message Handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'GET_STATE') {
    (async () => {
      await checkCooldownStatus();
      const state = await getStoredState();
      sendResponse({ success: true, ...state });
    })();
    return true; // Keep message channel open for async response
  }

  if (message.type === 'START_SESSION') {
    (async () => {
      await checkCooldownStatus();
      const current = await getStoredState();

      if (current.state !== 'IDLE') {
        sendResponse({
          success: false,
          error: `Cannot start session while in state: ${current.state}`
        });
        return;
      }

      const durationMinutes = Number(message.durationMinutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        sendResponse({
          success: false,
          error: 'Session duration must be a positive number of minutes.'
        });
        return;
      }

      await transitionToActive(durationMinutes);
      const updated = await getStoredState();
      sendResponse({ success: true, ...updated });
    })();
    return true;
  }

  if (message.type === 'SET_COOLDOWN_DURATION') {
    (async () => {
      const minutes = Number(message.durationMinutes);
      if (!Number.isInteger(minutes) || minutes <= 0) {
        sendResponse({
          success: false,
          error: 'Cooldown duration must be a positive integer.'
        });
        return;
      }

      const current = await getStoredState();

      // FR-5.3: Users cannot modify the global cooldown duration while a session is ACTIVE or in COOLDOWN
      if (current.state === 'ACTIVE' || current.state === 'COOLDOWN') {
        sendResponse({
          success: false,
          error: 'Cannot modify cooldown duration while session is ACTIVE or in COOLDOWN.'
        });
        return;
      }

      await chrome.storage.local.set({
        globalCooldownDuration: minutes
      });

      sendResponse({
        success: true,
        globalCooldownDuration: minutes
      });
    })();
    return true;
  }
});

// Export helper methods for testing environments if available
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_GLOBAL_COOLDOWN_MINUTES,
    COOLDOWN_ALARM_NAME,
    getStoredState,
    initializeDefaults,
    checkCooldownStatus,
    transitionToIdle,
    transitionToActive,
    transitionToCooldown,
    startCountdownTimer,
    stopCountdownTimer,
    isYouTubeUrl,
    isYouTubeActiveAndFocused,
    isUserEngagedWithYouTube,
    updateBadge
  };
}
