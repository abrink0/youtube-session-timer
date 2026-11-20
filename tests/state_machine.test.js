const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Mock chrome API environment
let mockStorage = {};
let mockAlarms = {};
let mockBadge = { text: '', color: '' };
let mockWindows = [{ id: 1, focused: true }];
let mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/' }];
let messageListeners = [];
let alarmListeners = [];

global.chrome = {
  storage: {
    local: {
      get: async (keys) => {
        if (!keys) return { ...mockStorage };
        if (typeof keys === 'string') return { [keys]: mockStorage[keys] };
        if (Array.isArray(keys)) {
          const res = {};
          for (const k of keys) {
            if (k in mockStorage) res[k] = mockStorage[k];
          }
          return res;
        }
        return { ...mockStorage };
      },
      set: async (items) => {
        Object.assign(mockStorage, items);
      },
      clear: async () => {
        mockStorage = {};
      }
    },
    onChanged: {
      addListener: () => {}
    }
  },
  alarms: {
    create: async (name, alarmInfo) => {
      mockAlarms[name] = alarmInfo;
    },
    clear: async (name) => {
      delete mockAlarms[name];
    },
    onAlarm: {
      addListener: (fn) => alarmListeners.push(fn)
    }
  },
  runtime: {
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: {
      addListener: (fn) => messageListeners.push(fn)
    },
    sendMessage: (msg, cb) => {
      if (typeof cb === 'function') cb({ success: true, state: 'IDLE' });
    }
  },
  action: {
    setBadgeText: async ({ text }) => {
      mockBadge.text = text;
    },
    setBadgeBackgroundColor: async ({ color }) => {
      mockBadge.color = color;
    }
  },
  windows: {
    getAll: async () => mockWindows,
    onFocusChanged: { addListener: () => {} }
  },
  tabs: {
    query: async (queryInfo, cb) => {
      let results = [...mockTabs];
      if (queryInfo) {
        if (typeof queryInfo.active === 'boolean') {
          results = results.filter((t) => t.active === queryInfo.active);
        }
        if (queryInfo.windowId) {
          results = results.filter((t) => t.windowId === queryInfo.windowId);
        }
        if (queryInfo.url && queryInfo.url.includes('youtube.com')) {
          results = results.filter((t) => t.url && t.url.includes('youtube.com'));
        }
      }
      if (typeof cb === 'function') {
        cb(results);
      }
      return results;
    },
    sendMessage: async () => {},
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} }
  }
};

const bg = require('../background.js');

function sendMessage(msg) {
  return new Promise((resolve) => {
    let handled = false;
    for (const listener of messageListeners) {
      const isAsync = listener(msg, {}, (response) => {
        handled = true;
        resolve(response);
      });
      if (isAsync) return;
    }
    if (!handled) resolve(null);
  });
}

describe('YouTube Session Limiter - State Machine', () => {
  beforeEach(async () => {
    mockStorage = {};
    mockAlarms = {};
    mockBadge = { text: '', color: '' };
    mockWindows = [{ id: 1, focused: true }];
    mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/' }];
    bg.stopCountdownTimer();
  });

  it('initializes default state as IDLE with 30m cooldown', async () => {
    await bg.initializeDefaults();
    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'IDLE');
    assert.strictEqual(state.remainingTime, 0);
    assert.strictEqual(state.cooldownEndTime, null);
    assert.strictEqual(state.globalCooldownDuration, 30);
  });

  it('rejects starting session with zero, negative, or invalid duration', async () => {
    await bg.initializeDefaults();

    const res0 = await sendMessage({ type: 'START_SESSION', durationMinutes: 0 });
    assert.strictEqual(res0.success, false);

    const resNeg = await sendMessage({ type: 'START_SESSION', durationMinutes: -5 });
    assert.strictEqual(resNeg.success, false);

    const resNaN = await sendMessage({ type: 'START_SESSION', durationMinutes: 'abc' });
    assert.strictEqual(resNaN.success, false);

    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'IDLE');
  });

  it('transitions from IDLE to ACTIVE on valid session start', async () => {
    await bg.initializeDefaults();

    const res = await sendMessage({ type: 'START_SESSION', durationMinutes: 15 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'ACTIVE');
    assert.strictEqual(res.remainingTime, 900); // 15 mins * 60s

    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'ACTIVE');
    assert.strictEqual(state.remainingTime, 900);
  });

  it('rejects starting session when already ACTIVE or COOLDOWN', async () => {
    await bg.initializeDefaults();
    await sendMessage({ type: 'START_SESSION', durationMinutes: 10 });

    const duplicateRes = await sendMessage({ type: 'START_SESSION', durationMinutes: 20 });
    assert.strictEqual(duplicateRes.success, false);
    assert.match(duplicateRes.error, /Cannot start session while in state: ACTIVE/);
  });

  it('transitions from ACTIVE to COOLDOWN when time expires', async () => {
    await bg.initializeDefaults();
    await bg.transitionToActive(1); // 60s

    await bg.transitionToCooldown();

    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'COOLDOWN');
    assert.strictEqual(state.remainingTime, 0);
    assert.ok(state.cooldownEndTime > Date.now());
    assert.ok(mockAlarms[bg.COOLDOWN_ALARM_NAME]);
  });

  it('transitions from COOLDOWN to IDLE when wall-clock time expires', async () => {
    await bg.initializeDefaults();
    await bg.transitionToCooldown();

    // Fast-forward cooldownEndTime to the past
    await chrome.storage.local.set({ cooldownEndTime: Date.now() - 1000 });

    const expired = await bg.checkCooldownStatus();
    assert.strictEqual(expired, true);

    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'IDLE');
    assert.strictEqual(state.cooldownEndTime, null);
    assert.strictEqual(mockAlarms[bg.COOLDOWN_ALARM_NAME], undefined);
  });

  it('enforces lockout rule (FR-5.3): cannot modify cooldown while ACTIVE or COOLDOWN (no queueing)', async () => {
    await bg.initializeDefaults();
    await bg.transitionToActive(10);

    // Attempting to change cooldown while ACTIVE must be rejected
    const resActive = await sendMessage({ type: 'SET_COOLDOWN_DURATION', durationMinutes: 10 });
    assert.strictEqual(resActive.success, false);
    assert.match(resActive.error, /Cannot modify cooldown duration while session is ACTIVE or in COOLDOWN/);

    let state = await bg.getStoredState();
    assert.strictEqual(state.globalCooldownDuration, 30);

    // Transition to COOLDOWN
    await bg.transitionToCooldown();

    // Attempting to change cooldown while in COOLDOWN must also be rejected
    const resCooldown = await sendMessage({ type: 'SET_COOLDOWN_DURATION', durationMinutes: 45 });
    assert.strictEqual(resCooldown.success, false);
    assert.match(resCooldown.error, /Cannot modify cooldown duration while session is ACTIVE or in COOLDOWN/);

    state = await bg.getStoredState();
    assert.strictEqual(state.globalCooldownDuration, 30);
  });

  it('allows modifying cooldown duration when in IDLE', async () => {
    await bg.initializeDefaults();
    const stateBefore = await bg.getStoredState();
    assert.strictEqual(stateBefore.state, 'IDLE');

    const res = await sendMessage({ type: 'SET_COOLDOWN_DURATION', durationMinutes: 45 });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.globalCooldownDuration, 45);

    const stateAfter = await bg.getStoredState();
    assert.strictEqual(stateAfter.globalCooldownDuration, 45);
  });
});

describe('Phase 2: Engagement & Background Audio-Aware Timer (FR-2.1, FR-2.2, FR-2.4)', () => {
  beforeEach(async () => {
    mockStorage = {};
    mockBadge = { text: '', color: '' };
    mockWindows = [{ id: 1, focused: true, state: 'normal' }];
    mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: false }];
    bg.stopCountdownTimer();
  });

  it('correctly identifies valid and invalid YouTube URLs', () => {
    assert.strictEqual(bg.isYouTubeUrl('https://www.youtube.com/'), true);
    assert.strictEqual(bg.isYouTubeUrl('https://youtube.com/watch?v=123'), true);
    assert.strictEqual(bg.isYouTubeUrl('https://m.youtube.com/feed/subscriptions'), true);
    assert.strictEqual(bg.isYouTubeUrl('https://music.youtube.com/'), true);

    assert.strictEqual(bg.isYouTubeUrl('https://google.com'), false);
    assert.strictEqual(bg.isYouTubeUrl('chrome://extensions'), false);
    assert.strictEqual(bg.isYouTubeUrl('about:blank'), false);
    assert.strictEqual(bg.isYouTubeUrl(''), false);
    assert.strictEqual(bg.isYouTubeUrl(null), false);
  });

  it('continues counting down when another window is selected (side-by-side or multi-monitor)', async () => {
    // Window 1 has YouTube active, but Window 2 (e.g. text editor or other browser) is focused
    mockWindows = [
      { id: 1, focused: false, state: 'normal' },
      { id: 2, focused: true, state: 'normal' }
    ];
    mockTabs = [
      { id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: false },
      { id: 201, windowId: 2, active: true, url: 'https://github.com/', audible: false }
    ];

    assert.strictEqual(await bg.isUserEngagedWithYouTube(), true);
  });

  it('continues counting down when YouTube is playing audio in the background', async () => {
    // YouTube tab is inactive (user viewing another tab) but audible is true
    mockWindows = [{ id: 1, focused: true, state: 'normal' }];
    mockTabs = [
      { id: 101, windowId: 1, active: false, url: 'https://www.youtube.com/watch?v=podcast', audible: true },
      { id: 102, windowId: 1, active: true, url: 'https://en.wikipedia.org/', audible: false }
    ];

    assert.strictEqual(await bg.isUserEngagedWithYouTube(), true);

    // YouTube tab is in a minimized window, but audio is playing
    mockWindows = [{ id: 1, focused: false, state: 'minimized' }];
    mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: true }];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), true);
  });

  it('pauses countdown only when not engaged in any way (silent & no visible tab)', async () => {
    // Case A: YouTube is an inactive tab in the strip and silent
    mockWindows = [{ id: 1, focused: true, state: 'normal' }];
    mockTabs = [
      { id: 101, windowId: 1, active: false, url: 'https://www.youtube.com/', audible: false },
      { id: 102, windowId: 1, active: true, url: 'https://en.wikipedia.org/', audible: false }
    ];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), false);

    // Case B: Window is minimized and silent
    mockWindows = [{ id: 1, focused: false, state: 'minimized' }];
    mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: false }];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), false);

    // Case C: All YouTube tabs closed
    mockTabs = [{ id: 102, windowId: 1, active: true, url: 'https://google.com', audible: false }];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), false);
  });

  it('updates toolbar badge reflecting active vs paused states', async () => {
    // IDLE state -> badge is empty
    await bg.updateBadge({ state: 'IDLE', remainingTime: 0 });
    assert.strictEqual(mockBadge.text, '');

    // ACTIVE state & engaged with YouTube -> blue badge
    mockWindows = [{ id: 1, focused: true, state: 'normal' }];
    mockTabs = [{ id: 101, windowId: 1, active: true, url: 'https://www.youtube.com/', audible: false }];
    await bg.updateBadge({ state: 'ACTIVE', remainingTime: 900 });
    assert.strictEqual(mockBadge.text, '15m');
    assert.strictEqual(mockBadge.color, '#2563eb'); // Blue

    // ACTIVE state but not engaged (silent background tab) -> gray badge
    mockTabs = [{ id: 101, windowId: 1, active: false, url: 'https://www.youtube.com/', audible: false }];
    await bg.updateBadge({ state: 'ACTIVE', remainingTime: 900 });
    assert.strictEqual(mockBadge.text, '15m');
    assert.strictEqual(mockBadge.color, '#6b7280'); // Gray (paused)

    // COOLDOWN state -> red badge
    await bg.updateBadge({ state: 'COOLDOWN', cooldownEndTime: Date.now() + 1800 * 1000 });
    assert.strictEqual(mockBadge.text, '30m');
    assert.strictEqual(mockBadge.color, '#ef4444'); // Red
  });

  it('pauses timer automatically when user cannot be engaged with YouTube', async () => {
    await bg.initializeDefaults();
    await bg.transitionToActive(10); // 600 seconds

    let state = await bg.getStoredState();
    assert.strictEqual(state.remainingTime, 600);

    // Silent background tab -> not engaged
    mockTabs = [
      { id: 101, windowId: 1, active: false, url: 'https://www.youtube.com/', audible: false },
      { id: 102, windowId: 1, active: true, url: 'https://en.wikipedia.org/', audible: false }
    ];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), false);

    // Wait 1.1s with ticker running: remainingTime should NOT decrement
    await new Promise((resolve) => setTimeout(resolve, 1100));

    state = await bg.getStoredState();
    assert.strictEqual(state.remainingTime, 600); // Remained paused!

    bg.stopCountdownTimer();
  });

  it('resumes timer countdown when background audio starts or YouTube becomes visible', async () => {
    await bg.initializeDefaults();
    await bg.transitionToActive(10); // 600 seconds

    // Audio starts playing in background YouTube tab
    mockWindows = [{ id: 1, focused: true, state: 'normal' }];
    mockTabs = [
      { id: 101, windowId: 1, active: false, url: 'https://www.youtube.com/', audible: true },
      { id: 102, windowId: 1, active: true, url: 'https://en.wikipedia.org/', audible: false }
    ];
    assert.strictEqual(await bg.isUserEngagedWithYouTube(), true);

    // Wait 1.1s with ticker running: remainingTime should decrement by 1
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const state = await bg.getStoredState();
    assert.strictEqual(state.remainingTime, 599); // Decremented!

    bg.stopCountdownTimer();
  });
});

describe('Phase 4: Multi-Tab Synchronization & Edge Cases (TC-1, TC-2, TC-3, FR-4.2)', () => {
  it('broadcasts state change to all open YouTube tabs when transitioning to COOLDOWN', async () => {
    const sentMessages = [];
    chrome.tabs.sendMessage = async (tabId, msg) => {
      sentMessages.push({ tabId, msg });
    };

    mockTabs = [
      { id: 201, windowId: 1, active: true, url: 'https://www.youtube.com/' },
      { id: 202, windowId: 1, active: false, url: 'https://www.youtube.com/watch?v=abc' }
    ];

    await bg.transitionToCooldown();

    // Verify messages were sent to both YouTube tabs
    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[0].tabId, 201);
    assert.strictEqual(sentMessages[0].msg.type, 'STATE_CHANGED');
    assert.strictEqual(sentMessages[0].msg.state, 'COOLDOWN');
    assert.strictEqual(sentMessages[1].tabId, 202);
    assert.strictEqual(sentMessages[1].msg.state, 'COOLDOWN');
  });

  it('shares single global session state across multiple open YouTube tabs', async () => {
    await bg.initializeDefaults();
    await bg.transitionToActive(15);

    mockTabs = [
      { id: 301, windowId: 1, active: true, url: 'https://www.youtube.com/' },
      { id: 302, windowId: 1, active: false, url: 'https://www.youtube.com/feed/subscriptions' }
    ];

    const state = await bg.getStoredState();
    assert.strictEqual(state.state, 'ACTIVE');
    assert.strictEqual(state.remainingTime, 900);

    bg.stopCountdownTimer();
  });
});

describe('YouTube Duration Parsing Helpers', () => {
  // Mock window/document before loading content.js in node
  global.window = global.window || {};
  global.window.location = { pathname: '/', href: 'https://www.youtube.com/' };
  global.window.addEventListener = () => {};
  global.document = global.document || {};
  global.document.querySelector = () => null;
  global.document.querySelectorAll = () => [];
  global.document.addEventListener = () => {};
  global.document.createElement = () => ({
    style: {},
    attachShadow: () => ({
      innerHTML: '',
      getElementById: () => ({ addEventListener: () => {}, value: '', style: {} }),
      querySelectorAll: () => []
    }),
    appendChild: () => {}
  });

  const content = require('../content.js');

  it('parses MM:SS timestamps correctly', () => {
    assert.strictEqual(content.parseTimestampToSeconds('12:34'), 754);
    assert.strictEqual(content.parseTimestampToSeconds('0:45'), 45);
    assert.strictEqual(content.parseTimestampToSeconds('00:00'), 0);
  });

  it('parses HH:MM:SS timestamps correctly', () => {
    assert.strictEqual(content.parseTimestampToSeconds('1:02:03'), 3723);
    assert.strictEqual(content.parseTimestampToSeconds('2:30:00'), 9000);
  });

  it('parses aria-label natural language durations correctly', () => {
    assert.strictEqual(content.parseAriaLabelToSeconds('14 minutes, 20 seconds'), 860);
    assert.strictEqual(content.parseAriaLabelToSeconds('1 hour, 2 minutes, 3 seconds'), 3723);
    assert.strictEqual(content.parseAriaLabelToSeconds('45 seconds'), 45);
    assert.strictEqual(content.parseAriaLabelToSeconds('2 hours'), 7200);
  });

  it('returns null for invalid duration strings', () => {
    assert.strictEqual(content.parseTimestampToSeconds('LIVE'), null);
    assert.strictEqual(content.parseTimestampToSeconds('abc'), null);
    assert.strictEqual(content.parseAriaLabelToSeconds('Random text without time'), null);
  });
});
