# YouTube Session Limiter

A minimal, focused browser extension for **Chromium-based browsers (Chrome and Brave)** built on **Manifest V3**. It enforces intentional YouTube consumption by requiring a time budget before browsing, hiding feed videos that exceed the remaining budget, tracking background audio and active engagement, and imposing a mandatory cooldown when time expires.

---

## Features

- **Forced Session Initialization (`IDLE` state)**: Intercepts YouTube upon arrival with a clean modal. Interaction is completely blocked until you declare your intended session duration in minutes (presets or custom input).
- **Duration-Based Feed Hiding**: Dynamically inspects video cards across YouTube feeds (Home, Search, Subscriptions, and Recommendations) and hides videos (`display: none`) that exceed your remaining session time budget.
- **Non-Standard Content Hiding**: Automatically hides livestreams, upcoming premieres, and playlists/mixes from feeds so they cannot bypass session time limits.
- **Flexible Watch-Page Policy**: Videos opened directly (via bookmarks, external links, or feed clicks) can be watched, paused, and resumed freely. Playback is strictly bounded by the active session timer.
- **Smart Engagement & Background Audio Tracking**:
  - The timer counts down when YouTube is visible in any open, non-minimized window—even if you are working in another window, editor, or application (side-by-side or multi-monitor).
  - The timer continues counting down if a YouTube tab is playing audio in the background (`tab.audible`).
  - The timer pauses automatically when you cannot be engaged with YouTube in any way (e.g. silent background tabs, silent minimized windows, or all YouTube tabs closed).
- **Mandatory Wall-Clock Cooldown (`COOLDOWN` state)**: When your session expires, all media halts immediately across all open tabs, and YouTube is locked behind a full-page cooldown countdown screen. Cooldown runs on wall-clock time via `chrome.alarms`.
- **Strict Lockout Rule**: Global cooldown duration cannot be modified or reduced during an active session or cooldown period (inputs are grayed out).
- **Dynamic Toolbar Badge**:
  - 🟦 **Blue (`15m` / `45s`)**: Active session, counting down on YouTube.
  - ⬜ **Gray (`15m`)**: Active session, paused (disengaged).
  - 🟥 **Red (`30m`)**: Cooldown in progress.
  - **Empty**: Idle state (no active session).

---

## Installation & Setup (Chrome / Brave)

1. Open your browser and navigate to the extensions page:
   - **Chrome**: `chrome://extensions`
   - **Brave**: `brave://extensions`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left corner).
4. Select the project directory:
   ```text
   The repository root directory (e.g. ./yt-time-management)
   ```
5. Pin **YouTube Session Limiter** to your browser toolbar for quick visibility of remaining session time.

---

## Configuration

To adjust the mandatory cooldown duration:
1. Right-click the extension icon in the toolbar and select **Options** (or open `chrome://extensions` $\rightarrow$ YouTube Session Limiter $\rightarrow$ **Details** $\rightarrow$ **Extension options**).
2. Set your preferred **Mandatory Cooldown Duration** (in minutes; default is 30 minutes).
3. Click **Save Settings**.
   > *Note: Settings can only be modified while in the `IDLE` state.*

---

## Automated Testing

The project includes an automated unit test suite using Node.js's built-in test runner (`node:test`) and a Chrome API mock:

```bash
npm test
```

All 21 unit tests cover:
- Core 3-state machine transitions (`IDLE`, `ACTIVE`, `COOLDOWN`).
- Timestamp and natural language aria-label duration parsing.
- Focus, multi-monitor, and background audio engagement tracking.
- Multi-tab synchronization and cooldown broadcast interruption.
- Cooldown settings lockout enforcement.

---

## Documentation

- [REQUIREMENTS_AND_DESIGN.md](REQUIREMENTS_AND_DESIGN.md): Detailed functional requirements, design decisions, and architectural rationale.
- [CODE_STRUCTURE.md](CODE_STRUCTURE.md): Component-by-component code structure, messaging schema, and DOM observation strategies.
- [AGENTS.md](AGENTS.md): File structure overview, architectural context, and development guidelines for agents and maintainers.
