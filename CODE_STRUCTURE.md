# Code Structure & Architecture

This document describes the architectural layout, modules, data flows, and internal mechanisms of the **YouTube Session Timer** extension.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Chromium Browser (Chrome / Brave)                     │
│                                                                             │
│  ┌────────────────────────┐                  ┌───────────────────────────┐  │
│  │ YouTube Tab Content    │                  │ Extension Options Page    │  │
│  │ (content.js)           │                  │ (options.html / .js)      │  │
│  │                        │                  │                           │  │
│  │ • Shadow DOM Host      │                  │ • Cooldown duration form  │  │
│  │ • Feed Card Filter     │                  │ • Lockout visual state    │  │
│  │ • Media Interceptor    │                  │ • Real-time status sync   │  │
│  └───────────┬────────────┘                  └─────────────┬─────────────┘  │
│              │ Port: yt_active_keepalive                   │                │
│              │ Runtime Messages: GET_STATE / START_SESSION │ Messages:      │
│              │ Storage changes (onChanged)                 │ GET_STATE      │
│              ▼                                             │ SET_COOLDOWN   │
│  ┌─────────────────────────────────────────────────────────┴─────────────┐  │
│  │ Background Service Worker (background.js)                             │  │
│  │                                                                       │  │
│  │ • 3-State Machine: IDLE ──> ACTIVE ──> COOLDOWN                       │  │
│  │ • Engagement Tracking: isUserEngagedWithYouTube()                     │  │
│  │   - Visible tab in non-minimized window                               │  │
│  │   - Background audio playback (tab.audible)                           │  │
│  │ • Action Toolbar Badge Engine (updateBadge)                           │  │
│  │ • Alarm Manager (COOLDOWN_ALARM_NAME via chrome.alarms)               │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      │                                      │
│                                      ▼                                      │
│                        ┌───────────────────────────┐                        │
│                        │ chrome.storage.local      │                        │
│                        │ • state                   │                        │
│                        │ • remainingTime           │                        │
│                        │ • cooldownEndTime         │                        │
│                        │ • globalCooldownDuration  │                        │
│                        └───────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Breakdown

### 1. `manifest.json`
- **Specification**: Manifest V3.
- **Permissions**:
  - `storage`: Persisting state machine properties across restarts.
  - `alarms`: Scheduling wall-clock cooldown wakeups.
  - `tabs`: Querying active tab URLs, windows, and `tab.audible` status for engagement tracking.
- **Host Permissions**: Scoped to `*://*.youtube.com/*`.
- **Background**: Service worker registered at `background.js`.
- **Content Scripts**: Injected at `*://*.youtube.com/*` with `run_at: "document_start"`.
- **Options UI**: Registered at `options.html` (`open_in_tab: true`).

---

### 2. `background.js` (Service Worker)
The central orchestrator and single source of truth for session time and state.

#### Key Functions
- `getStoredState()`: Retrieves `{ state, remainingTime, cooldownEndTime, globalCooldownDuration }` from `chrome.storage.local`.
- `initializeDefaults()`: Ensures initial install defaults exist (`state: 'IDLE'`, `globalCooldownDuration: 30`).
- `isYouTubeUrl(url)`: Validates if a URL belongs to YouTube (`www.youtube.com`, `youtube.com`, `m.youtube.com`, `music.youtube.com`).
- `isUserEngagedWithYouTube()`: Evaluates if:
  1. Any YouTube tab has `tab.audible === true` (background audio), OR
  2. Any YouTube tab is active in a non-minimized browser window (`win.state !== 'minimized'`).
- `updateBadge(stateData)`: Formats and colors the toolbar badge:
  - `IDLE`: Text `""`.
  - `ACTIVE`: Text `${mins}m` or `${secs}s`; Blue (`#2563eb`) if engaged, Gray (`#6b7280`) if disengaged.
  - `COOLDOWN`: Text `${mins}m` or `${secs}s`; Red (`#ef4444`).
- `transitionToIdle()`: Clears alarms, stops ticker, resets state to `IDLE`, clears badge, and notifies open tabs.
- `transitionToActive(durationMinutes)`: Sets `remainingTime = durationMinutes * 60`, starts 1-second countdown ticker, updates badge, and notifies open tabs.
- `transitionToCooldown()`: Stops countdown, sets `cooldownEndTime = Date.now() + cooldownMs`, schedules `chrome.alarms` alarm, and notifies open tabs.
- `startCountdownTimer()`: Runs a 1-second interval while in `ACTIVE`. Decrements `remainingTime` only when `isUserEngagedWithYouTube()` is true.
- `notifyTabsStateChanged(state, data)`: Broadcasts `{ type: 'STATE_CHANGED', state, data }` to all open YouTube tabs.

#### Event Listeners
- `chrome.windows.onFocusChanged`: Updates badge engagement status when switching windows.
- `chrome.tabs.onActivated`: Updates badge engagement status when switching tabs.
- `chrome.tabs.onUpdated`: Listens for `changeInfo.audible` (audio start/stop) and URL changes.
- `chrome.tabs.onRemoved`: Updates badge engagement when tabs close.
- `chrome.alarms.onAlarm`: Wakes the service worker on cooldown expiration and calls `transitionToIdle()`.
- `chrome.runtime.onConnect`: Accepts keepalive port (`yt_active_keepalive`) from active YouTube tabs.
- `chrome.runtime.onMessage`: Handles `GET_STATE`, `START_SESSION`, and `SET_COOLDOWN_DURATION`.

---

### 3. `content.js` (Content Script)
Injected into all YouTube pages. Manages the DOM overlays, card filtering, and media interruption.

#### Key Functions
- `getOrCreateOverlay()`: Lazily creates or returns `#yt-session-limiter-host` with an isolated closed Shadow DOM.
- `showIdleOverlay()`: Mounts the session duration setup modal with preset buttons (5m, 15m, 30m, 45m), custom input, validation, and disables page scrolling.
- `showCooldownOverlay(endTime)`: Mounts the full-page cooldown blocking screen with a live countdown timer updating every second.
- `hideOverlay()`: Hides the Shadow DOM host and restores page scrolling.
- `parseTimestampToSeconds(text)`: Parses strings like `12:34` (754s) or `1:02:03` (3723s).
- `parseAriaLabelToSeconds(text)`: Parses natural language accessibility labels like `14 minutes, 20 seconds`.
- `getVideoCardInfo(card)`: Inspects badges, overlay styles, and metadata. Returns `{ isNonStandard: true }` for livestreams, premieres, and playlists, or `{ seconds: number }` for standard videos.
- `filterCard(card, remainingTime)`: Sets `card.style.display = 'none'` and tags `data-yt-limiter-hidden="true"` if duration exceeds remaining time.
- `filterAllCards(remainingTime)`: Scans all elements matching `CARD_SELECTORS` across the page.
- `unhideAllCards()`: Restores `display = ''` on previously hidden cards when entering `IDLE`.
- `pauseMedia()`: Halts and pauses all `<video>` and `<audio>` elements.
- `setupKeepAlivePort()`: Opens a `chrome.runtime.connect` port to keep the background worker alive while in `ACTIVE`.
- `ensureOverlayMounted()`: Re-attaches `#yt-session-limiter-host` if it is removed by YouTube's SPA router.

#### Event Listeners
- Capture-phase `window.addEventListener('play', ..., true)`: Halts unauthorized media playback in `IDLE` or `COOLDOWN`.
- `yt-navigate-finish`, `yt-page-data-updated`, and `popstate`: Triggers feed re-filtering on SPA navigations.
- `chrome.storage.onChanged`: Reacts immediately to state and remaining time updates from background.
- `chrome.runtime.onMessage`: Reacts to direct `STATE_CHANGED` notifications.

---

### 4. `options.html`, `options.js`, `options.css`
The user configuration interface.
- **Form Controls**: Allows configuring `globalCooldownDuration` (in minutes).
- **Lockout Enforcement**: If state is `ACTIVE` or `COOLDOWN`, the input and save button are grayed out (`disabled = true`) and a lockout explanation banner is displayed.
- **Live Status Monitor**: Queries `GET_STATE` every second to display real-time session remaining and cooldown remaining values.

---

### 5. `tests/state_machine.test.js`
Unit tests executed using Node.js's built-in test runner (`node --test`).
- **Mock Environment**: Emulates `chrome.storage`, `chrome.alarms`, `chrome.runtime`, `chrome.action`, `chrome.windows`, and `chrome.tabs`.
- **Test Suites**:
  1. **State Machine Transitions**: Default initialization, input validation, `IDLE` $\rightarrow$ `ACTIVE` $\rightarrow$ `COOLDOWN` $\rightarrow$ `IDLE`, and cooldown lockout.
  2. **Phase 2 Engagement Tracking**: Multi-monitor window selection, background audio (`tab.audible`), disengaged pause, and toolbar badge updates.
  3. **Phase 4 Multi-Tab Synchronization & Edge Cases**: Multi-tab message broadcasting, shared session state.
  4. **Duration Parsing Helpers**: Timestamp parsing (`MM:SS`, `HH:MM:SS`), aria-label natural language parsing, and invalid input handling.

---

## Messaging & Storage Schema

### Storage Keys (`chrome.storage.local`)
| Key | Type | Description |
| :--- | :--- | :--- |
| `state` | `string` | `'IDLE'`, `'ACTIVE'`, or `'COOLDOWN'`. |
| `remainingTime` | `number` | Remaining active session duration in seconds. |
| `cooldownEndTime` | `number \| null` | Unix timestamp in ms when cooldown expires. |
| `globalCooldownDuration` | `number` | Cooldown length in minutes (default: 30). |

### Runtime Messages (`chrome.runtime.sendMessage`)
| Type | Sender | Recipient | Payload | Response |
| :--- | :--- | :--- | :--- | :--- |
| `GET_STATE` | Options / Content | Background | `{}` | `{ success: true, state, remainingTime, cooldownEndTime, globalCooldownDuration }` |
| `START_SESSION` | Content Script | Background | `{ durationMinutes }` | `{ success: true, state: 'ACTIVE', remainingTime }` or `{ success: false, error }` |
| `SET_COOLDOWN_DURATION` | Options Page | Background | `{ durationMinutes }` | `{ success: true, globalCooldownDuration }` or `{ success: false, error }` |
| `STATE_CHANGED` | Background | Content Tabs | `{ state, data }` | Broadcast notification to open tabs. |
