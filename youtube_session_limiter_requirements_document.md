# Product Requirements Document (PRD): YouTube Session Limiter (V1 Scope)

## 1. Overview & Scope

A minimal viable browser extension for **Chromium-based browsers (Chrome and Brave)** designed to enforce intentional YouTube consumption. Upon visiting YouTube, the user must declare a strict time budget for their session. The extension dynamically filters YouTube's interface to only display and play standard videos that fit within the remaining time budget, blocks access once the timer expires, and enforces a globally configured cooldown period before a new session can begin.

### 1.1 Explicit V1 Exclusions (Out of Scope)
To keep V1 minimal and shippable, the following are explicitly excluded from this phase:
* **Cross-Browser Support:** Firefox and Safari support are deferred to future versions. V1 targets Chrome and Brave (Manifest V3) only.
* **YouTube Shorts:** Shorts feeds, shelves, and `/shorts/` URLs are ignored in V1 (neither filtered by duration nor specifically handled).
* **Playback Speed Math:** Remaining session time is tracked strictly in real-world active seconds, independent of video playback speed (e.g., `1.5x` or `2x`).

---

## 2. Core User Flows & Functional Requirements

### 2.1 Session Initialization
* **FR-1.1 Forced Prompt:** Navigating to any YouTube URL (`*://*.youtube.com/*`) while in the `IDLE` state must immediately intercept the page and block interaction until the user submits a session duration.
* **FR-1.2 Time Limit Selection:** The user must specify a valid positive duration (in minutes) to start a session. Zero, negative, or non-numeric inputs must be rejected.
* **FR-1.3 Session Activation:** Upon submitting a valid duration, the state transitions to `ACTIVE`, `remainingTime` is set to the chosen duration (in seconds), and the YouTube interface becomes accessible.

### 2.2 Active Session & Timer Behavior
* **FR-2.1 Engagement-Based Countdown:** During an `ACTIVE` session, `remainingTime` counts down in 1-second intervals whenever the user can be engaged with YouTube content in any way:
  * A YouTube tab is the active tab in any open, non-minimized browser window (even when another window or application currently has focus, supporting side-by-side work and multi-monitor setups), **OR**
  * Any YouTube tab is actively playing audio in the background (`tab.audible === true`).
* **FR-2.2 Automatic Pause:** The countdown pauses only when it is not possible to be engaged with YouTube content in any way:
  * No YouTube tab is producing audio, **AND**
  * No YouTube tab is visible as an active tab in a non-minimized window (i.e. YouTube tabs are silent background tabs in a tab strip, silent minimized windows, or all YouTube tabs are closed).
* **FR-2.3 Multi-Tab Synchronization:** All open YouTube tabs share the single global session state. Opening additional YouTube tabs during an `ACTIVE` session must not trigger a new setup prompt or cause the timer to count down faster.
* **FR-2.4 Remaining Time Visibility:** The user must be able to view their remaining session time during an active session (e.g., via the extension toolbar badge/popup or an unobtrusive on-page indicator).

### 2.3 Content Filtering & Playback Enforcement
* **FR-3.1 Duration-Based Feed Hiding:** While `ACTIVE`, the extension must evaluate video cards across YouTube feeds (Home, Search results, Subscriptions, Watch page recommendations). Any video whose parsed duration exceeds the current `remainingTime` must be hidden via CSS (`display: none`) rather than removed from the DOM (to prevent breaking YouTube's layout recycling).
* **FR-3.2 Dynamic Re-evaluation:** As `remainingTime` decreases, visible video cards in feeds must be periodically re-evaluated and hidden once their duration exceeds the updated `remainingTime`.
* **FR-3.3 Non-Standard Content Handling:** Livestreams, upcoming premieres, and playlists/mixes lack standard fixed durations and must be hidden during an `ACTIVE` session so they cannot bypass the time limit.
* **FR-3.4 Direct URL & Watch Page Policy:** Videos opened directly via URL, bookmarks, or external links are permitted to play during an `ACTIVE` session regardless of video length (allowing users to watch portions of longer videos or pause and resume freely). Playback is strictly bounded by the active session timer, which halts and pauses all media once `remainingTime` reaches `0` (FR-4.1).

### 2.4 Session Expiration & Blocking
* **FR-4.1 Expiration Trigger:** When `remainingTime` reaches `0`, the session state immediately transitions to `COOLDOWN`.
* **FR-4.2 Immediate Interruption:** Any active `<video>` or `<audio>` element on open YouTube tabs must be immediately paused/muted upon expiration.
* **FR-4.3 Full-Page Blocking:** All open and newly opened YouTube tabs must immediately block interaction and display the cooldown state, including a live countdown of the remaining cooldown time.

### 2.5 Global Cooldown Management
* **FR-5.1 Global Cooldown Setting:** A global configuration setting (accessible via the extension's Options page) allows the user to set the mandatory cooldown duration (in minutes).
* **FR-5.2 Wall-Clock Cooldown Tracking:** When entering `COOLDOWN`, the extension calculates and stores an absolute timestamp (`cooldownEndTime = now + globalCooldownDuration`). Cooldown expiration is evaluated against real-world wall-clock time, regardless of whether YouTube or the browser remains open.
* **FR-5.3 Setting Lockout:** While a session is `ACTIVE` or while in `COOLDOWN`, users cannot modify the global cooldown duration at all (no queuing or reductions allowed). The input is disabled/grayed out in the options UI until the state returns to `IDLE`.
* **FR-5.4 Cooldown Completion:** Once `now >= cooldownEndTime`, the state resets to `IDLE`. Visiting or refreshing YouTube will once again trigger the Session Initialization prompt (FR-1.1).

---

## 3. State Machine Summary

| State | Trigger to Enter | Behavior on YouTube | Exit Condition |
| :--- | :--- | :--- | :--- |
| **`IDLE`** | Initial install, or `COOLDOWN` timestamp expires. | Page blocked by Session Setup Prompt. | User submits a valid session time limit $\rightarrow$ **`ACTIVE`**. |
| **`ACTIVE`** | User submits time limit in `IDLE`. | Timer ticks when YouTube tab is focused; videos longer than `remainingTime` are hidden/blocked. | `remainingTime <= 0` $\rightarrow$ **`COOLDOWN`**. |
| **`COOLDOWN`** | `ACTIVE` timer reaches `0`. | Page completely blocked; displays remaining cooldown timer. | Current wall-clock time $\ge$ `cooldownEndTime` $\rightarrow$ **`IDLE`**. |

---

## 4. Technical Constraints & Edge Cases

* **TC-1 Manifest V3 Service Worker Lifecycle:** Chrome/Brave background service workers terminate after ~30 seconds of inactivity. All critical state (`state`, `remainingTime`, `cooldownEndTime`, `globalCooldownDuration`) must be persisted in `chrome.storage.local` rather than relying solely on in-memory variables, using `chrome.alarms` to ensure reliable cooldown expiration.
* **TC-2 YouTube SPA Navigation:** Because YouTube operates as a Single Page Application, content scripts cannot rely solely on full page loads. Filtering and watch-page checks must hook into YouTube's internal navigation events (e.g., `yt-navigate-finish`) and observe dynamic DOM additions via `MutationObserver`.
* **TC-3 Tamper Resistance (Basic):** Reloading the page, using Back/Forward navigation, or opening new tabs must not bypass the `IDLE` prompt, CSS feed filters, or `COOLDOWN` block.

---

## 5. Phased Implementation Plan

### Phase 1: Extension Skeleton & State Machine
* **Deliverables:** `manifest.json` (MV3), `background.js` (service worker), `content.js`, and `options.html`.
* **Tasks:**
  * Implement the 3-state machine (`IDLE`, `ACTIVE`, `COOLDOWN`) persisted in `chrome.storage.local`.
  * Build the basic `options.html` page to configure `globalCooldownDuration`.
  * Implement basic blocking overlays in `content.js` for `IDLE` (session duration input) and `COOLDOWN` (remaining cooldown countdown).
* **Milestone:** Opening YouTube prompts for a session duration; submitting starts a basic countdown; hitting `0` locks YouTube until the global cooldown expires.

### Phase 2: Engagement & Background Audio-Aware Active Timer
* **Deliverables:** Active tab and background audio tracking in `background.js`.
* **Tasks:**
  * Track active YouTube tabs across windows and monitor background audio (`tab.audible`).
  * Ensure timer continues when another window/application is focused or when audio plays in the background.
  * Pause only when the user cannot be engaged with YouTube content in any way (no audio playing and no visible YouTube tab).
* **Milestone:** Watching side-by-side or listening to background audio reliably decrements the timer; pausing audio and hiding/minimizing YouTube pauses the countdown.

### Phase 3: Feed Hiding & Content Filtering
* **Deliverables:** DOM observer and duration parser in `content.js`.
* **Tasks:**
  * Use `MutationObserver` to scan video card elements (`ytd-rich-item-renderer`, `ytd-video-renderer`, `ytd-compact-video-renderer`), parse `HH:MM:SS` duration badges into seconds, and apply `display: none` to videos exceeding `remainingTime` (as well as livestreams/playlists).
  * Run a periodic check as `remainingTime` ticks down to hide newly ineligible videos.
* **Milestone:** Over-limit videos disappear from feeds; playback strictly halts once the session timer reaches zero.

### Phase 4: SPA Navigation & Edge-Case Hardening
* **Deliverables:** SPA lifecycle hooks and cleanup routines in `content.js`.
* **Tasks:**
  * Hook into `yt-navigate-finish` so feed filtering executes cleanly across soft navigations.
  * Verify video playback pauses immediately across all open tabs when transitioning from `ACTIVE` to `COOLDOWN`.
* **Milestone:** Navigating anywhere within YouTube seamlessly enforces all session rules without requiring manual page refreshes.