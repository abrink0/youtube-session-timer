const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Mock chrome API environment
let mockStorage = {};
let mockAlarms = {};
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
  tabs: {
    query: (queryInfo, cb) => {
      cb([]);
    },
    sendMessage: async () => {}
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
