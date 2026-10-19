# Control Panel HUD

A local status dashboard for secondary Windows bar displays, designed around 8.8-inch screens at **1920 × 480** or **480 × 1920**. It combines work integrations, upcoming meetings, host resource usage, Wrocław tram departures, and a countdown timer.

The HUD runs in a borderless WinForms/WebView2 window. A separate browser page on your main monitor handles credentials, connection tests, display selection, and a live HUD preview. The timer and tram card have controls directly on the HUD.

## Capabilities

| Card | What it shows |
| --- | --- |
| GitLab | Your non-draft merge requests, approval and reply status, merge blockers, review requests, and pending To-Dos |
| LiteLLM | Reported spend against a budget, with a progress bar and budget alerts |
| Slack | Up to three unread direct/group conversations and unread counts for selected channels |
| Email | Unread and total message counts for an IMAP mailbox |
| Calendar | The next two meetings across corporate and personal Outlook ICS feeds |
| System | CPU, memory, and GPU utilization on the backend host |
| Trams | On-demand journeys accounting for a ten-minute walk and optional transfers |
| Timer | Preset or custom countdowns that survive reloads |

Disabled integrations are hidden, and the remaining cards use the available space. Horizontal and vertical layouts are selectable in Settings. Critical provider notifications appear in a banner that dismisses after ten seconds.

The Express backend polls work integrations and system stats on a **60-second cycle**, then pushes completed dashboard updates over Server-Sent Events (SSE). Saving configuration triggers a refresh. Calendar downloads are cached separately, and transit polls only while its card is awake.

## Quick start

### Requirements

- Windows with Node.js **20.12 or newer** and npm.
- **.NET 10 SDK** to build the native HUD.
- **Microsoft Edge WebView2 Runtime** to run the native HUD.

Run from a Windows terminal in the repository:

```powershell
npm install
npm run build:hud
npm start
```

Open **[Settings](http://localhost:3888/settings)** on your main monitor. The backend automatically opens the native HUD on the third display (index `2`), falling back to the primary display when that display is unavailable. You can also view the dashboard in a browser at **[http://localhost:3888/](http://localhost:3888/)**.

In Settings:

1. Enable the integrations you want to display and enter their connection details.
2. Use **Test Connection** to check credentials or calendar feeds.
3. Click **Save All Changes**.
4. Turn off **Demo Mock Data** to use live integrations.
5. Choose a monitor and click **Launch on Display** to move or reopen the HUD.

Demo mode is enabled on first launch, but integration visibility still follows each integration's enabled switch. GitLab, LiteLLM, Slack, and Email start disabled; Calendar starts enabled. System stats always come from the backend host, and the tram card uses public live data even in demo mode.

This checkout shares `node_modules` with the Windows launcher. **Install dependencies and run builds using Windows Node.js and `npm.cmd`, including from WSL.** A Linux `npm install` replaces native packages such as esbuild and can break Windows startup. Restore them with `npm install` in a Windows terminal, or use a separate checkout for Linux dependencies. Native Windows startup is recommended; WSL startup attempts to launch the HUD through Windows interop.

### Native window controls

- The HUD fills the selected monitor without a title bar and is hidden from the taskbar.
- Its system tray icon offers **Show HUD** and **Exit HUD**; double-clicking brings the HUD forward.
- Closing the HUD leaves the backend running. Reopen it through Settings or `scripts/launch-hud.ps1`.
- Launching again reuses the existing window. Failed page loads retry while the backend is unavailable.
- Native WebView2 zoom is fixed at **133%** and is independent of browser zoom.

For a manual launch:

```powershell
powershell.exe -File scripts/launch-hud.ps1 -MonitorIndex 2 -Url http://localhost:3888/
```

Monitor indices start at zero. The native build is self-contained for .NET and lives in `dist/windows/hud/`; WebView2 Runtime is installed separately. Its browser profile is stored beside the executable in `ControlPanel.Hud.exe.WebView2/`, so this folder must be writable. Close the HUD before rebuilding it after C# changes.

### Packaged Windows backend

```powershell
npm run build:hud
npm run build:exe
powershell.exe -File scripts/start-backend.ps1
```

This produces `dist/windows/ControlPanel.exe`, containing the backend, Node.js runtime, dependencies, and client assets. Keep the `hud/` folder beside it for automatic native HUD launch. Node.js and the .NET SDK are not needed on the target machine; WebView2 Runtime is still required.

The executable stores `config.json` beside itself. **The packaging script copies your source `config/config.json` there if no packaged configuration exists**, so use a sanitized configuration when sharing a packaged build. Existing packaged settings are preserved on rebuild.

`scripts/start.bat` starts the source backend and opens Settings; `scripts/start-backend.ps1` starts the packaged backend minimized.

## Integrations

### GitLab

Configure a GitLab base URL and Personal Access Token with `read_api` access. The connection test verifies the authenticated user through `/api/v4/user`.

Your open, non-draft merge requests show their project and MR number with a status badge:

- ✅ At least one approval.
- ⛔ Merge conflicts, a required rebase, or at least ten commits behind the target.
- 💬 An unresolved inline code discussion needs your reply.
- ❔ Waiting for approval.

Approval takes precedence over the other badges. Your latest reply clears the reply-needed badge even if the discussion remains unresolved. Review requests and pending To-Dos appear as counters.

The provider reads the first 20 entries in each MR/review/To-Do query and up to 100 discussion threads per MR. It preserves the previous GitLab result through up to five consecutive failed polls to reduce display flicker during transient failures.

### LiteLLM Proxy

Configure the proxy URL and one or more API keys, separated by commas or whitespace. An optional User ID supports discovery of additional keys when permissions allow it. The connection test reads key/user information.

The HUD shows aggregate reported spend, the budget limit, and percentage used. The configured budget takes priority over a key's reported budget. Per-key budget notifications start at 80%; critical notifications start at 90%, with an additional aggregate alert at 90%.

Spend follows the accounting/reset period reported by LiteLLM. The HUD does not calculate a separate daily total. The current card displays spend and budget usage; token totals and model endpoint health are not monitored.

### Slack

Use a Bot User Token (`xoxb-...`) or User OAuth Token (`xoxp-...`). The connection test runs `auth.test` and reports the workspace and user.

The HUD lists up to three unread direct or group conversations, ordered by unread count and then activity. Group DMs use up to three participants' first names, excluding the authenticated user. Add comma-separated channel names in **Channels to track** (`#` is optional); channels with unread messages appear below the DM list. The status line also reports unread mentions and incomplete or unavailable data.

Use a User OAuth Token for your personal conversations. Group discovery requires `mpim:read`, alongside `im:read` and `users:read`; add `mpim:history` for unread counting when Slack omits group unread counts. Mention search requires a user token with search access, and tracked channels require the corresponding read/history permissions. Reauthorize the Slack app after changing scopes. Bot tokens can only see conversations available to the bot, and counts depend on token permissions and API limits.

### Email (IMAP)

Configure the IMAP hostname, port, username, and password or app password. TLS defaults to enabled on port `993`; the mailbox defaults to `INBOX`. The HUD displays unread and total message counts. The connection test authenticates and lists available mailboxes.

### Outlook calendars

Add a corporate feed, a personal feed, or both using published **HTTPS links whose path ends in `.ics`**. The connection test reads each configured feed. Saved links are hidden from the configuration response; leave a field blank to retain it, or check **Remove saved link** to clear it.

The card combines both feeds and displays the next two upcoming events, with titles, dates, times, and time-until-start values. Corporate and personal events have distinct styling, as do recurring events and meetings with more than 20 attendees. Recurrence exceptions, cancellations, and all-day events are handled.

Feeds are cached for 15 minutes. A failed download can reuse the previous feed with a warning. The backend uses `Europe/Warsaw` for floating calendar dates; displayed meeting times use the HUD browser's local timezone.

## System stats and timer

System stats report average CPU utilization, used memory percentage, and GPU usage for the machine running the backend. Windows GPU usage comes from 3D engine performance counters. On other platforms, GPU usage uses `nvidia-smi` if available. Unavailable readings show `N/A`.

The timer offers **45, 30, 20, 15, and 5 minute** presets and custom durations of **1–999 whole minutes**. Starting a timer replaces the controls with an `MM:SS` countdown. Click the countdown to cancel/reset it. At zero it stays highlighted until clicked; completion is visual, with no sound.

Click the timer title to collapse or expand it. The deadline and collapsed state are stored locally and survive page reloads. Tabs and the Settings preview synchronize within the same browser profile and origin; the native WebView2 profile is separate from your regular browser.

## Mouse and display setup

Settings includes **Lock Mouse to Main Screen** and **Release Mouse Lock** controls. The lock confines the pointer to the primary monitor rectangle using Windows cursor clipping. You can also run `scripts/lock-mouse.ps1`; `Ctrl+Alt+Del` releases the clipping. The HUD itself displays a normal pointer with text selection disabled, allowing interaction with the timer and transit card when the pointer is unlocked.

For a layout-only alternative, position the bar display diagonally from the primary display in Windows Display Settings so that they meet only at a corner. Select horizontal or vertical layout in the app's Settings to match the display orientation.

## Trams 

The HUD transit card starts asleep, showing icon-only buttons.

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

## Configuration and local data

The server listens on **`127.0.0.1:3888`**. It is a local desktop app with no login screen. Set `PORT` to change the backend port, or `HUD_AUTO_LAUNCH=0` to run without automatically opening the native HUD.

Source runs create `config/config.json` on first launch. Packaged runs use the folder beside the backend executable. Credentials and private calendar URLs are stored in that file; configuration responses mask credentials and omit private calendar URLs. The `config/` folder, `.env` files, generated builds, browser profiles, and logs are excluded from Git.

The backend also writes local diagnostic logs and provider caches. Avoid sharing runtime settings or cache files with the repository. There are `pollIntervalSec` fields in the configuration schema, but the current background poller uses a shared 60-second cycle.

## Development

| Command | Purpose |
| --- | --- |
| `npm start` | Run the source backend and automatically launch the native HUD |
| `npm run dev` | Run with automatic backend restarts |
| `npm run build` | Compile/check TypeScript |
| `npm run build:hud` | Publish the self-contained Windows x64 native HUD |
| `npm run build:exe` | Package the backend and client assets as a Windows executable |
| `npm run launch:windows` | Launch or reposition the native HUD |

There is no configured `npm test` or lint script. Check TypeScript changes with `npm run build` and manually verify affected pages or integrations.

### Project layout

- `src/server/`: Express routes, polling, local configuration, diagnostics, and host utilities.
- `src/server/providers/`: GitLab, LiteLLM, Slack, Email, Calendar, and transit integrations.
- `src/shared/types.ts`: Shared configuration and dashboard types.
- `src/client/`: HUD, Settings, timer, transit UI, and styles.
- `src/native/ControlPanel.Hud/`: WinForms/WebView2 Windows host.
- `scripts/`: Native/backend builds and Windows launch helpers.
- `config/`: Ignored runtime configuration, logs, and caches.


