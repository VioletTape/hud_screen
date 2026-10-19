# 🖥️ Control Panel HUD

> **High-contrast, non-interactive status HUD & notification center designed specifically for secondary 8.8" bar screens (1920×480 / 480×1920) on Windows.**

---

## 🎯 Architecture & Core Concept

When running a dedicated 8.8" display (such as a Waveshare, Wisecoco, or Turing secondary monitor mounted on your desk or inside a PC case), you face two fundamental UX challenges:
1. **Mouse cursor distraction**: If the secondary screen is an extended desktop in Windows, mouse clicks and cursor drift into the stats screen interrupt workflow, steal focus, or get lost.
2. **Authentication convenience**: Setting up GitLab tokens, LiteLLM master keys, Slack OAuth, and IMAP credentials on a non-interactive 8.8" screen with no mouse or keyboard is frustrating.

### The Dual-Surface Solution:

```
┌──────────────────────────────────────┐       ┌──────────────────────────────────────────────────────────────┐
│           PRIMARY MONITOR            │       │               8.8" SECONDARY DISPLAY (HUD)                   │
│      (Full Mouse & Keyboard)         │       │          (Zero-Interaction, Pitch-Black OLED)                │
├──────────────────────────────────────┤       ├──────────────────────────────────────────────────────────────┤
│  http://localhost:3888/settings      │       │  http://localhost:3888/                                      │
│                                      │       │                                                              │
│  • Paste API keys & tokens           │───────▶  [GITLAB]     [LITELLM]    [SLACK]     [EMAIL]               │
│  • Test connections (GitLab/Slack...)│ (Live │  3 Open MRs   $4.82 Today  2 DMs       3 Unread              │
│  • 1-Click Launch on 8.8" screen     │  SSE  │  1 Failed CI  14 Models    4 Mentions  1 Urgent              │
│  • Toggle Mouse Lock to Main Screen  │ Push) │  ──────────────────────────────────────────────────────────  │
│  • Real-time Live Mini Preview       │       │  ALERTS TICKER: Pipeline failed on core-service#main         │
└──────────────────────────────────────┘       └──────────────────────────────────────────────────────────────┘
```

---

## ⚡ Quick Start

### 1. Build the Native HUD and Start the Server
Install the .NET 10 SDK and Microsoft Edge WebView2 Runtime on Windows. From a Windows terminal in this repository:
```bash
npm install
npm run build:hud
npm start
```

The backend opens the WinForms/WebView2 HUD after it starts listening. The borderless window fills `Screen.AllScreens[2]` (the third display), falling back to the primary display when fewer than three displays are connected. Browser zoom and browser profiles are separate from the native HUD; HUD zoom is fixed at 133%. The existing display scale setting still controls the HUD layout.

The self-contained native build, including its .NET dependencies, lives in `dist/windows/hud/`. WebView2 stores its profile beside `ControlPanel.Hud.exe` in `ControlPanel.Hud.exe.WebView2/`. Rebuild with `npm run build:hud` after changing C# code; close the HUD first so its executable is not locked. The WebView2 Runtime is installed separately on Windows.

`npm run dev` also opens the native HUD and reuses the existing window after backend restarts. To run only the backend, set `HUD_AUTO_LAUNCH=0` before starting it. WSL startup also attempts to launch the Windows executable through WSL interop; native Windows startup is recommended.

Keep dependency installs on Windows for this shared checkout. Running Linux `npm install`
from WSL replaces esbuild's Windows binary and breaks `npm start` on Windows. If that
happens, run `npm install` from a Windows terminal in this repository to restore the
correct package. Use a separate checkout when installing dependencies for Linux.

For the packaged backend, run `npm run build:hud` and `npm run build:exe`, then use `scripts/start-backend.ps1` or run `dist/windows/ControlPanel.exe`. Keep the `hud` folder beside the backend executable; it launches automatically too. `scripts/start.bat` starts the source backend and opens Settings.

### 2. Configure Credentials (on your main screen)
Open your browser on your main monitor:
```
http://localhost:3888/settings
```
- **Demo Mode**: Enabled by default so you can immediately see realistic animations, counters, and alerts before entering credentials.
- **Test Connections**: Click "Test Connection" next to GitLab, LiteLLM, Slack, or Email to verify credentials instantly.

### 3. Move or Reopen the Native HUD
- In Settings, select a monitor and click **"🚀 Launch on Display"** to open or move the existing native window.
- To launch manually, run `powershell.exe -File scripts/launch-hud.ps1`. Use `-MonitorIndex 2` for the third display (indices start at zero) and optionally `-Url http://localhost:3888/` for another backend port.
- The HUD is hidden from the Windows taskbar and provides a system tray icon: double-click it or choose **Show HUD** to bring the window forward; choose **Exit HUD** to close it. Closing the HUD leaves the backend running. Reopen it through Settings or the launch script. If the backend is temporarily unavailable, the HUD retries loading it.

---

## 🔌 Integrated Services

### Countdown timer

The Timer widget offers **45, 30, 20, 15, and 5 minute** presets and a custom
duration of 1–999 whole minutes. Starting a timer hides the controls and shows
only the `MM:SS` countdown. Click the countdown to cancel and choose another
duration. At zero it stays highlighted until clicked. The timer survives page
reloads and stays synchronized between tabs in the same browser profile.

### 1. Self-Hosted GitLab
- **Monitors**:
  - Your open, non-draft merge requests: 💬 code comments needing your reply, ✅ at least one approval, ❔ otherwise.
  - Review requests pending your approval.
  - Unresolved To-Dos / mentions.
- **Auth**: Personal Access Token (`read_api` scope).
- **Test Button**: Calls `/api/v4/user` to verify your username and server status.

### 2. Self-Hosted LiteLLM Proxy
- **Monitors**:
  - Daily spend ($) and progress towards your daily budget limit.
  - Total tokens consumed today.
  - Active model count and unhealthy/degraded endpoint alerts.
- **Auth**: LiteLLM Master API Key (Bearer token).
- **Test Button**: Checks `/health` and `/model/info`.

### 3. Slack Workspace
- **Monitors**:
  - Direct message (DM) unread counts (highlighted in glowing amber/rose).
  - Group DMs in the direct messages area, labeled with up to three participants' first names, excluding the authenticated user.
  - Unread channel mentions.
  - Active conversation counts.
- **Auth**: Slack Bot User Token (`xoxb-...`) or User OAuth Token (`xoxp-...`).
- **Group DMs**: Use your User OAuth Token to monitor your conversations. Enable `mpim:read` alongside `im:read` and `users:read`; add `mpim:history` for unread counting when Slack omits group unread counts. Reinstall/reauthorize the Slack app to apply added scopes. Bot tokens can only access conversations available to the bot.
- **Test Button**: Runs `auth.test` and verifies workspace name.

### 4. Work Email (IMAP)
- **Monitors**:
  - Unread inbox count.
  - Previews latest unread subject lines and sender names in the ticker.
- **Auth**: IMAP host, port (993), SSL/TLS, username, and app password.
- **Test Button**: Handshakes with the IMAP server and lists accessible mailboxes.

---

## 🔒 Mouse Exclusion & Screen Setup on Windows

### Method 1: Software Cursor Clip (Included)
In the Settings panel, click **"🔒 Lock Mouse to Main Screen"** (or run `powershell.exe -File scripts/lock-mouse.ps1`).
- Uses the Win32 `[System.Windows.Forms.Cursor]::Clip` API to lock the mouse coordinates strictly to your primary monitor.
- The cursor is physically prevented from crossing the screen boundary onto the 8.8" screen.
- Click **"🔓 Release Mouse Lock"** or press `Ctrl+Alt+Del` at any time to restore normal multi-monitor mouse movement.

### Method 2: Diagonal Display Alignment (Zero-Software Trick)
In Windows **Settings → System → Display**:
- Drag the 8.8" display so it only touches the primary monitor by a single corner diagonally.
- Because monitors only touch at 1 pixel, your cursor will virtually never cross over accidentally during normal desktop usage.

### HUD Mouse Pointer
The HUD displays the normal mouse pointer. Text selection remains disabled with:
```css
user-select: none;
```
Use the mouse lock controls above if you want to keep the pointer on your primary display.

---

## 📐 Display Modes & Resolution Handling

Standard 8.8" displays typically use:
- **Horizontal**: `1920 × 480` (ultrawide 4:1 aspect ratio)
- **Vertical**: `480 × 1920` (tower 1:4 aspect ratio)

You can toggle between **Horizontal** and **Vertical** modes at any time in the Settings dashboard. The layout immediately re-flows across all 4 service cards and adjusts the alert ticker.

---

## Trams from Kolista

The HUD transit card starts asleep, showing icon-only buttons: **⚓** for Port
Popowice, **🏬** for Niedźwiedzia, and **🚅** for Dworzec Główny. Destination names
remain available as tooltips and accessible labels. Click a destination to show the next three reachable
trams from Kolista's city-bound platform **12602**, boarding lines **12, 21, 18,
or 19**. Each countdown subtracts the **10-minute walk** from the tram's departure
time. Trams whose walking deadline has passed disappear from the list. Beneath
each departure time, the HUD shows only the destination arrival time.

Settings → **Tram destinations** lists the saved destinations. Edit the stop name,
icon, and **Direct only** preference, or add/remove destinations, then click
**Save All Changes**. Saved changes appear immediately on the HUD. Stop names
should match the Wrocław timetable. Port Popowice and Niedźwiedzia default to
direct-only journeys; Dworzec Główny allows a transfer. New destinations start
with Direct only enabled.

When Direct only is off, journeys can include one tram transfer at the same named stop, with
at least three minutes to change platforms (longer when platform distance requires
it). Each first tram appears once, using its earliest-arriving direct or connecting
journey. The search extends to the next 24 hours when fewer than three departures
are available in the next three hours.

Data comes from the [official Wrocław GTFS timetable](https://open-data.cui.wroclaw.pl/hdb/ft/6/)
and [city vehicle positions](https://open-data.cui.wroclaw.pl/hdb/db/14?download=json).
**≈ GPS** denotes an estimate from a fresh vehicle position matched to a trip by
line, brigade, and location; it is not an operator-provided arrival prediction.
Ambiguous matches, fixes over 90 seconds old, and unavailable GPS data use explicitly
labelled **scheduled** times. Transfer connections remain estimates and can change
with delays. Times use Europe/Warsaw, including service calendars and overnight trips.

While awake, the card refreshes every 30 seconds and updates countdowns every second.
Click **Offline** to stop polling and return to destination buttons. Reloading the HUD
also starts asleep. Transit uses real public data even when other cards use mock mode.
No API key or settings change is required. The first request downloads the current
timetable; a local cache in `config/transit-gtfs.zip` allows up to 24 hours of fallback
when the portal is unavailable. An expired display response is removed after 90 seconds.

## 🛠️ Extensibility: Adding a New Service

All providers implement the `IProvider` interface in [`src/server/providers/base.ts`](src/server/providers/base.ts):

```typescript
export interface IProvider {
  name: string;
  displayName: string;
  isEnabled(): boolean;
  testConnection(): Promise<{ success: boolean; message: string }>;
  fetchData(): Promise<ProviderResult>;
}
```

To add another service (e.g., GitHub, Home Assistant, Pi-hole, Proxmox, Grafana alerts):
1. Create `src/server/providers/myservice.ts` implementing `IProvider`.
2. Register it in [`src/server/index.ts`](src/server/index.ts).
3. The HUD and Settings panel will automatically pick up the new metrics and notifications!
