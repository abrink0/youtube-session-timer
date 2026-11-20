/**
 * YouTube Session Timer - Options Page Logic
 */

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('settings-form');
  const cooldownInput = document.getElementById('cooldown-input');
  const lockoutWarning = document.getElementById('lockout-warning');
  const feedbackMsg = document.getElementById('feedback-msg');
  const saveBtn = document.getElementById('save-btn');

  const decreaseForm = document.getElementById('decrease-time-form');
  const decreaseInput = document.getElementById('decrease-time-input');
  const decreaseBtn = document.getElementById('decrease-time-btn');
  const decreaseHint = document.getElementById('decrease-hint');
  const currentRemainingMins = document.getElementById('current-remaining-mins');
  const decreaseLockoutWarning = document.getElementById('decrease-lockout-warning');
  const decreaseFeedbackMsg = document.getElementById('decrease-feedback-msg');

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
   * Update the status display and control states in the UI
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

    // Cooldown duration rule:
    // Can be increased at any time (IDLE, ACTIVE, COOLDOWN), but only decreased in IDLE mode.
    cooldownInput.disabled = false;
    saveBtn.disabled = false;
    if (currentSettings.state === 'ACTIVE' || currentSettings.state === 'COOLDOWN') {
      cooldownInput.min = String(currentSettings.globalCooldownDuration);
      lockoutWarning.style.display = 'block';
      lockoutWarning.innerHTML = `<strong>Notice:</strong> Cooldown duration can be increased at any time, but only decreased in Idle mode (current: ${currentSettings.globalCooldownDuration} min${currentSettings.globalCooldownDuration === 1 ? '' : 's'}).`;
    } else {
      cooldownInput.min = '1';
      lockoutWarning.style.display = 'none';
    }

    // Active session controls rule:
    // Only available when state === 'ACTIVE'. Zero (0) is allowed for immediate cooldown.
    if (currentSettings.state === 'ACTIVE') {
      decreaseInput.disabled = false;
      decreaseBtn.disabled = false;
      decreaseLockoutWarning.style.display = 'none';
      decreaseHint.style.display = 'block';
      const remainingMins = Math.ceil(currentSettings.remainingTime / 60);
      currentRemainingMins.textContent = `${formatSeconds(currentSettings.remainingTime)} (~${remainingMins} min${remainingMins === 1 ? '' : 's'})`;
    } else {
      decreaseInput.disabled = true;
      decreaseBtn.disabled = true;
      decreaseLockoutWarning.style.display = 'block';
      decreaseHint.style.display = 'none';
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

      if (document.activeElement !== cooldownInput) {
        cooldownInput.value = currentSettings.globalCooldownDuration;
      }
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

  // Handle settings form submit (cooldown duration)
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    feedbackMsg.style.display = 'none';

    const newDuration = parseInt(cooldownInput.value, 10);
    if (isNaN(newDuration) || newDuration <= 0) {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = 'Please enter a valid positive duration in minutes.';
      feedbackMsg.style.display = 'block';
      return;
    }

    if (currentSettings.state !== 'IDLE' && newDuration < currentSettings.globalCooldownDuration) {
      feedbackMsg.className = 'feedback-msg error';
      feedbackMsg.textContent = `Cooldown duration cannot be decreased while session is ${currentSettings.state} (minimum allowed: ${currentSettings.globalCooldownDuration} mins).`;
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
          feedbackMsg.textContent = 'Cooldown settings saved successfully!';
          feedbackMsg.style.display = 'block';
          loadSettings();
        }
      }
    );
  });

  // Handle decrease remaining time submit
  decreaseForm.addEventListener('submit', (e) => {
    e.preventDefault();
    decreaseFeedbackMsg.style.display = 'none';

    if (currentSettings.state !== 'ACTIVE') {
      decreaseFeedbackMsg.className = 'feedback-msg error';
      decreaseFeedbackMsg.textContent = 'Cannot adjust remaining time: session is not Active.';
      decreaseFeedbackMsg.style.display = 'block';
      return;
    }

    const newMinutes = parseFloat(decreaseInput.value);
    if (isNaN(newMinutes) || newMinutes < 0) {
      decreaseFeedbackMsg.className = 'feedback-msg error';
      decreaseFeedbackMsg.textContent = 'Please enter a valid non-negative number of minutes (enter 0 for immediate cooldown).';
      decreaseFeedbackMsg.style.display = 'block';
      return;
    }

    const newSeconds = Math.round(newMinutes * 60);
    if (newSeconds >= currentSettings.remainingTime) {
      decreaseFeedbackMsg.className = 'feedback-msg error';
      decreaseFeedbackMsg.textContent = `New remaining time must be strictly less than the current remaining time (${formatSeconds(currentSettings.remainingTime)}).`;
      decreaseFeedbackMsg.style.display = 'block';
      return;
    }

    chrome.runtime.sendMessage(
      { type: 'DECREASE_REMAINING_TIME', durationMinutes: newMinutes },
      (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          decreaseFeedbackMsg.className = 'feedback-msg error';
          decreaseFeedbackMsg.textContent = response?.error || 'Failed to decrease session time.';
          decreaseFeedbackMsg.style.display = 'block';
        } else {
          decreaseFeedbackMsg.className = 'feedback-msg success';
          if (newMinutes === 0 || response.state === 'COOLDOWN') {
            decreaseFeedbackMsg.textContent = 'Session ended early. Immediate cooldown initiated!';
          } else {
            decreaseFeedbackMsg.textContent = `Remaining time decreased to ${newMinutes} minute${newMinutes === 1 ? '' : 's'}!`;
          }
          decreaseFeedbackMsg.style.display = 'block';
          decreaseInput.value = '';
          loadSettings();
        }
      }
    );
  });
});
