# Requirements and Design Decisions

This document details the complete functional requirements, technical constraints, and design decisions for the **YouTube Session Timer** extension.

---

## 1. Core Requirements Summary

### State Machine Lifecycle
The extension operates on a strict 3-state state machine:

```
          [ Install / Cooldown Expiry ]
                       │
                       ▼
                 ┌───────────┐
                 │   IDLE    │  <─── Page blocked by Session Setup Prompt
                 └─────┬─────┘
                       │ User inputs valid duration (>0 mins)
                       ▼
                 ┌───────────┐
                 │  ACTIVE   │  <─── Videos > remainingTime hidden from feeds
                 └─────┬─────┘       Timer counts down when user is engaged
                       │ remainingTime reaches 0
                       ▼
                 ┌───────────┐
                 │ COOLDOWN  │  <─── Page locked by countdown overlay;
                 └─────┬─────┘       Audio/video paused immediately
                       │ Wall-clock time >= cooldownEndTime
                       ▼
                 [ Back to IDLE ]
```

### Detailed Functional Requirements

| ID | Requirement | Specification |
| :--- | :--- | :--- |
| **FR-1.1** | **Forced Prompt** | Navigating to any YouTube URL while in `IDLE` immediately blocks interaction and displays the Session Duration Prompt. |
| **FR-1.2** | **Duration Validation** | User must provide a positive number of minutes ($>0$). Zero, negative, and non-numeric inputs are rejected. |
| **FR-1.3** | **Session Activation** | On submission, `state` becomes `ACTIVE`, `remainingTime` is set to `duration * 60` seconds, and the overlay disappears. |
| **FR-2.1** | **Engagement-Based Countdown** | Timer decrements in 1-second intervals whenever the user is engaged: (1) a YouTube tab is active in any open, non-minimized window, OR (2) any YouTube tab is playing audio (`tab.audible === true`). |
| **FR-2.2** | **Automatic Pause** | Countdown pauses only when it is not possible to be engaged: no YouTube tab is playing audio, AND no YouTube tab is an active tab in an open, non-minimized window. |
| **FR-2.3** | **Multi-Tab Sync** | All open YouTube tabs share the single global session state. Opening additional tabs does not double-count or trigger setup prompts. |
| **FR-2.4** | **Time Visibility** | Remaining time is visible via the toolbar action badge (`15m` / `45s`), colored Blue when counting down, Gray when paused, and Red in cooldown. |
| **FR-3.1** | **Duration Feed Hiding** | Cards across Home, Search, Subscriptions, and Recommendations exceeding `remainingTime` are hidden via `display: none`. |
| **FR-3.2** | **Dynamic Re-evaluation** | As `remainingTime` ticks down, visible cards in feeds are re-evaluated and hidden once their duration exceeds the updated time. |
| **FR-3.3** | **Non-Standard Content** | Livestreams, premieres, and playlists/mixes are hidden from feeds during `ACTIVE` sessions. |
| **FR-3.4** | **Watch Page Policy** | Videos navigated to directly via URL/bookmarks can be watched, paused, and resumed freely. Playback is bounded strictly by the global session timer. |
| **FR-4.1** | **Expiration Trigger** | When `remainingTime <= 0`, state transitions immediately to `COOLDOWN`. |
| **FR-4.2** | **Immediate Interruption** | All active `<video>` and `<audio>` elements across all open YouTube tabs are immediately paused upon expiration. Autoplay is blocked. |
| **FR-4.3** | **Full-Page Blocking** | All open and new YouTube tabs are locked by a full-page cooldown countdown screen. |
| **FR-5.1** | **Global Cooldown Config** | Options page allows configuring `globalCooldownDuration` (in minutes). |
| **FR-5.2** | **Wall-Clock Cooldown** | Cooldown calculates `cooldownEndTime = Date.now() + durationMs`. Expiration is tracked via `chrome.alarms` against real-world wall-clock time. |
| **FR-5.3** | **Setting Lockout** | While in `ACTIVE` or `COOLDOWN`, cooldown settings cannot be modified (inputs are disabled/grayed out in options). |
| **FR-5.4** | **Cooldown Completion** | Once wall-clock time passes `cooldownEndTime`, state transitions to `IDLE`. |

---

## 2. Key Design Decisions & Rationale

### Decision 1: Engagement & Background Audio Tracking over Strict Window Focus
- **Context**: Initially, the timer required the browser window containing YouTube to have active OS focus (`window.focused === true`).
- **Problem**: Users frequently watch videos on a second monitor, in a side-by-side window while coding or taking notes, or listen to video audio in the background while browsing other tabs. Under strict window focus, the timer paused even though the user was actively consuming YouTube content.
- **Solution**: The timer now tracks **engagement**:
  1. A YouTube tab is the active tab in any non-minimized window (`win.state !== 'minimized'`), allowing multi-monitor and side-by-side viewing.
  2. Any YouTube tab has `tab.audible === true`, allowing background listening.
  3. Pauses **only** when the user cannot be engaged in any way (YouTube is silent and minimized or hidden behind another tab).

### Decision 2: Feed Hiding via CSS `display: none` vs DOM Node Removal
- **Context**: Feed filtering requires removing ineligible videos from view.
- **Problem**: YouTube uses a Polymer-based virtualized grid/list renderer (`ytd-rich-grid-renderer`, `iron-list`). Deleting DOM nodes (`element.remove()`) breaks YouTube's internal layout recalculation, causes blank infinite scroll loops, and triggers runtime JavaScript exceptions in YouTube's code.
- **Solution**: Cards are hidden strictly using `card.style.display = 'none'` and tagged with `data-yt-limiter-hidden="true"`. This leaves YouTube's DOM tree intact while completely hiding ineligible videos from the user.

### Decision 3: Flexible Watch Page Policy vs Direct URL Guard
- **Context**: Early iterations used an aggressive watch-page guard that checked video duration upon loading `/watch` pages and blocked videos exceeding the limit.
- **Problem**: If a user had 10 minutes left and wanted to watch the first 10 minutes of a 30-minute podcast or video, or paused a video and resumed later, the watch-page guard abruptly interrupted them. Furthermore, page-load latency and ad prerolls caused "just allowed" videos to be blocked immediately upon arrival.
- **Solution**: Relaxed the watch-page blocker. Users can open direct links or watch portions of longer videos freely. Enforcement is handled cleanly by the global session timer: once `remainingTime` reaches 0, the session expires, pauses media, and locks the page.

### Decision 4: Strict Setting Lockout vs Queued Modifications
- **Context**: The options page allows changing the mandatory cooldown duration.
- **Problem**: Permitting cooldown reductions during an active session or during cooldown defeats the commitment device of the extension. Allowing "queued reductions" introduced ambiguity for users.
- **Solution**: When in `ACTIVE` or `COOLDOWN`, the input and save buttons in `options.html` are completely disabled/grayed out, and background message handlers reject modification attempts. Cooldown can only be configured in the `IDLE` state.

### Decision 5: Isolated Shadow DOM for Blocking Overlays
- **Context**: Content scripts inject blocking screens for `IDLE` and `COOLDOWN` directly into YouTube pages.
- **Problem**: YouTube has hundreds of global CSS rules, dark/light theme classes, and high z-index headers/overlays (e.g. theater mode, masthead) that conflict with extension styling.
- **Solution**: The extension mounts a single container `<div id="yt-session-limiter-host">` with `all: initial` and `z-index: 2147483647`, attaching a closed Shadow DOM (`attachShadow({ mode: 'closed' })`). All styles are encapsulated within the shadow root, guaranteeing consistent dark-mode styling immune to YouTube CSS updates.

### Decision 6: Multi-Event SPA Navigation Lifecycle Hooks
- **Context**: YouTube is a Single Page Application (SPA). Navigating between Home, Search, Channels, and Watch pages does not trigger browser document reloads.
- **Problem**: Standard `window.onload` or `DOMContentLoaded` only fire once per session.
- **Solution**: Content scripts attach to `yt-navigate-finish`, `yt-page-data-updated`, and `popstate` on both `document` and `window`. Whenever a soft navigation completes, feed re-filtering executes automatically.

### Decision 7: MV3 Service Worker Keepalive & Alarm Architecture
- **Context**: Chromium Manifest V3 service workers terminate after ~30 seconds of inactivity.
- **Problem**: A naive in-memory `setInterval` in the background worker dies when the worker sleeps, stopping the timer and missing cooldown expirations.
- **Solution**:
  - Cooldown expiration uses `chrome.alarms` with `when: cooldownEndTime`, which Chrome reliably wakes the service worker for.
  - Active session countdown uses a long-lived port (`yt_active_keepalive`) connected from open YouTube tabs, keeping the background worker alive during active YouTube sessions.
  - State is always persisted to `chrome.storage.local`.
