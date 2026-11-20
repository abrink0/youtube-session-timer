/**
 * YouTube Session Limiter - Background Service Worker
 * Manages the core 3-state machine: IDLE, ACTIVE, COOLDOWN.
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

  notifyTabsStateChanged('COOLDOWN', updates);
}

/**
 * Starts 1-second countdown ticker for ACTIVE state.
 */
function startCountdownTimer() {
  stopCountdownTimer();
  activeTimerInterval = setInterval(async () => {
    const current = await getStoredState();
    if (current.state !== 'ACTIVE') {
      stopCountdownTimer();
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

// Extension Lifecycle Listeners
chrome.runtime.onInstalled.addListener(async () => {
  await initializeDefaults();
  await checkCooldownStatus();
  const current = await getStoredState();
  if (current.state === 'ACTIVE' && current.remainingTime > 0) {
    startCountdownTimer();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await checkCooldownStatus();
  const current = await getStoredState();
  if (current.state === 'ACTIVE' && current.remainingTime > 0) {
    startCountdownTimer();
  }
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
    stopCountdownTimer
  };
}
