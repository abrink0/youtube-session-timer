/**
 * YouTube Session Timer - Options Page Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const cooldownInput = document.getElementById('cooldown-input');
  const lockoutWarning = document.getElementById('lockout-warning');
  const feedbackMsg = document.getElementById('feedback-msg');
  const currentStateVal = document.getElementById('current-state-val');
  const remainingTimeVal = document.getElementById('remaining-time-val');
  const cooldownRemainingVal = document.getElementById('cooldown-remaining-val');

  let currentSettings = {
    state: 'IDLE',
    globalCooldownDuration: 30,
    remainingTime: 0,
    cooldownEndTime: null
  };

  /**
   * Format seconds to HH:MM:SS or MM:SS
   */
  function formatSeconds(seconds) {
    if (typeof seconds !== 'number' || seconds <= 0) return '00:00';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) {
      return `${pad(h)}:${pad(m)}:${pad(sec)}`;
    }
    return `${pad(m)}:${pad(sec)}`;
  }

  /**
   * Update the status display in the UI
   */
  function updateStatusDisplay() {
    currentStateVal.textContent = currentSettings.state;
    if (currentSettings.state === 'IDLE') {
      currentStateVal.style.color = '#60a5fa';
      remainingTimeVal.textContent = '--';
      cooldownRemainingVal.textContent = '--';
    } else if (currentSettings.state === 'ACTIVE') {
      currentStateVal.style.color = '#34d399';
      remainingTimeVal.textContent = formatSeconds(currentSettings.remainingTime);
      cooldownRemainingVal.textContent = '--';
    } else if (currentSettings.state === 'COOLDOWN') {
      currentStateVal.style.color = '#f87171';
      remainingTimeVal.textContent = '--';
      const cooldownSec = currentSettings.cooldownEndTime
        ? Math.max(0, Math.ceil((currentSettings.cooldownEndTime - Date.now()) / 1000))
        : 0;
      cooldownRemainingVal.textContent = formatSeconds(cooldownSec);
    }

    // Check if lockout rule applies:
    // FR-5.3: While a session is ACTIVE or while in COOLDOWN, users cannot modify the global cooldown duration
    const isLockedOut = currentSettings.state === 'ACTIVE' || currentSettings.state === 'COOLDOWN';
    if (isLockedOut) {
      cooldownInput.disabled = true;
      document.getElementById('save-btn').disabled = true;
      lockoutWarning.style.display = 'block';
    } else {
      cooldownInput.disabled = false;
      document.getElementById('save-btn').disabled = false;
      lockoutWarning.style.display = 'none';
    }
  }

  /**
   * Load initial state from background
   */
  function loadSettings() {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        return;
      }
      currentSettings = {
        state: response.state,
        globalCooldownDuration: response.globalCooldownDuration,
        remainingTime: response.remainingTime,
        cooldownEndTime: response.cooldownEndTime
      };

      cooldownInput.value = currentSettings.globalCooldownDuration;
      updateStatusDisplay();
    });
  }

  loadSettings();

  // Periodically refresh the status display every 1 second
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (!chrome.runtime.lastError && response && response.success) {
        currentSettings = {
          state: response.state,
          globalCooldownDuration: response.globalCooldownDuration,
          remainingTime: response.remainingTime,
          cooldownEndTime: response.cooldownEndTime
        };
        updateStatusDisplay();
      }
    });
  }, 1000);

  // Handle settings form submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    feedbackMsg.style.display = 'none';

    if (currentSettings.state === 'ACTIVE' || currentSettings.state === 'COOLDOWN') {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = 'Cannot modify cooldown duration while session is Active or in Cooldown.';
      feedbackMsg.style.display = 'block';
      return;
    }

    const newDuration = parseInt(cooldownInput.value, 10);
    if (isNaN(newDuration) || newDuration <= 0) {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = 'Please enter a valid positive duration in minutes.';
      feedbackMsg.style.display = 'block';
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'SET_COOLDOWN_DURATION', durationMinutes: newDuration },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          feedbackMsg.className = 'feedback-msg error';
          feedbackMsg.textContent = response?.error || 'Failed to update settings.';
          feedbackMsg.style.display = 'block';
        } else {
          feedbackMsg.className = 'feedback-msg success';
          feedbackMsg.textContent = 'Settings saved successfully!';
          feedbackMsg.style.display = 'block';
          loadSettings();
        }
      }
    );
  });
});
