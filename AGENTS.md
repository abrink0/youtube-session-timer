# AGENTS.md

A guide for AI agents and maintainers working on the **YouTube Session Limiter** codebase.

---

## Repository Map

```text
yt-time-management/
├── manifest.json            # Chrome Manifest V3 configuration & permissions
├── background.js            # Background Service Worker: state machine, engagement tracking, alarms
├── content.js               # Content script: Shadow DOM overlays, feed filtering, media interception
├── options.html             # Extension configuration page UI
├── options.js               # Options page logic & lockout handling
├── options.css              # Options page dark-mode styling
├── package.json             # NPM package definition & test runner scripts
├── tests/
│   └── state_machine.test.js # Automated unit tests (Node.js built-in test runner)
├── README.md                # Project overview, features, and setup
├── REQUIREMENTS_AND_DESIGN.md # Detailed requirements, design decisions, and state diagrams
├── CODE_STRUCTURE.md        # Architectural breakdown, functions, and messaging schema
└── AGENTS.md                # (This file) Guidelines, rules, and workflows for agents
```

---

## Critical Architectural Invariants

When modifying or extending this extension, you **must** preserve these invariants:

1. **State Persistence**:
   - Background service workers in MV3 terminate after ~30 seconds of inactivity.
   - **Never** rely on in-memory variables as the single source of truth for `state`, `remainingTime`, or `cooldownEndTime`. All state must be read from and written to `chrome.storage.local`.
   - Cooldown wakeups must use `chrome.alarms` (`when: cooldownEndTime`).

2. **DOM Safety (No Element Deletions)**:
   - When filtering videos out of YouTube feeds, **never** call `element.remove()`.
   - YouTube's Polymer virtualized renderer relies on DOM node presence for layout recycling. Removing nodes breaks infinite scroll and causes layout crashes.
   - Always hide cards using `card.style.display = 'none'` and tag them with `data-yt-limiter-hidden="true"`.

3. **Isolated Shadow DOM**:
   - All extension UI overlays injected into YouTube pages must live inside `#yt-session-limiter-host` under a closed Shadow DOM (`attachShadow({ mode: 'closed' })`).
   - Keep overlay styles self-contained inside `getOverlayStyles()`. Never inject unscoped global CSS into YouTube's DOM.

4. **Engagement Rule (FR-2.1 / FR-2.2)**:
   - The countdown decrements when:
     - Any YouTube tab is active in an open, non-minimized window (including multi-monitor and side-by-side work where another application has focus).
     - Any YouTube tab is playing audio (`tab.audible === true`).
   - The countdown pauses **only** when the user cannot be engaged in any way (no audio playing and no visible YouTube tab).

5. **Strict Lockout Rule (FR-5.3)**:
   - Users cannot modify or reduce the cooldown duration while in `ACTIVE` or `COOLDOWN`.
   - Form inputs on `options.html` must remain grayed out (`disabled = true`) and background message handlers must reject changes during these states.

---

## Development & Testing Workflow

### Running Automated Tests
The repository uses the Node.js built-in test runner. No external testing dependencies are required:

```bash
npm test
```

When adding new features or modifying behavior:
1. Update `tests/state_machine.test.js` to cover the new logic.
2. Run `npm test` and verify all tests pass.

### Browser Testing
1. Open `chrome://extensions` (or `brave://extensions`).
2. Ensure **Developer mode** is toggled ON.
3. Click **Load unpacked** and select the repository root directory (`yt-time-management`).
4. After making code edits, click the 🔄 **Reload** icon on the extension card.

### Quick DevTools Debugging Shortcuts
Open the DevTools Console on `chrome://extensions` by clicking **Inspect views: service worker**:

```javascript
// Check current stored state
await chrome.storage.local.get(null);

// Reset immediately to IDLE state
await chrome.storage.local.set({ state: 'IDLE', remainingTime: 0, cooldownEndTime: null });

// Fast-forward cooldown (expire immediately)
await chrome.storage.local.set({ cooldownEndTime: Date.now() - 1000 });
```
