# Slack poll diagnostics

## Intent

Record one small JSON Lines entry for every Slack poll so later sessions can see which API methods used the request budget and why a poll returned partial data. The app also keeps a short lived snapshot in `config/slack-discovery.json` (beside `config.json`; beside the EXE in packaged mode). It contains channel IDs/names, DM activity timestamps, pagination cursors, and history fallback metadata (`last_read`, newest message timestamp, unread count). It contains no tokens or message bodies.

Logs are daily files named `slack-polls-YYYY-MM-DD.jsonl` and older files are removed after 30 days. Source mode writes them to `config/logs/`; the Windows executable writes them beside the executable under `logs/` (currently `dist/windows/logs/`).

Each record includes:

- `timestamp`, `status`, and `statusMessage`
- `requestCount` and `requestCounts`, grouped by Slack API endpoint
- `incompleteReasons`, including the endpoint attempted after the 80-request cap or the partial-fetch condition
- `invalidTsOldest` when Slack rejects a history request, with the conversation ID and exact `oldest` timestamp sent
- `historyCacheHits`, the number of history fallback counts updated incrementally
- `discoveryCache`, showing whether DM and channel discovery reused the snapshot or called Slack

## Inspecting a problem

In PowerShell from the repository root, list incomplete or failed polls:

```powershell
Get-Content .\config\logs\slack-polls-*.jsonl |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.statusMessage -match 'incomplete|rate limited|Error' } |
  Select-Object timestamp, statusMessage, requestCount, requestCounts, incompleteReasons |
  Format-List
```

For the EXE, replace `config\logs` with `dist\windows\logs`. Compare `requestCounts` across several records:

- `users.conversations` suggests channel-list pagination or a channel-cache miss.
- `conversations.info` suggests DM or tracked-channel inspection is using most requests.
- `conversations.history` suggests unread-count fallback work for group DMs.
- `incompleteReasons` identifies the branch that set the partial-data warning; a request-cap reason names the next endpoint that was blocked.

Share only these diagnostic fields when asking for help; never share `config.json` or tokens.

## Current polling choices and next-session work

- DM inspection is capped at 10 per poll: five most recently active conversations plus five rotating conversations.
- DM discovery is reused for 90 seconds; channel discovery for five minutes. A changed tracked-channel list misses the channel cache immediately. Pagination and scan cursors survive restarts.
- The log records the latest app behavior; use several consecutive entries before changing limits.
- DM discovery avoids repeated `conversations.list` calls for up to 90 seconds while keeping activity priority reasonably fresh; channel discovery snapshots survive restarts. `conversations.info` still supplies current unread counts.
- History fallback queries fetch only messages newer than the saved newest timestamp while `last_read` is unchanged. A full recount every 15 minutes corrects for edits or deletions; a changed `last_read` starts a fresh count.
- If `conversations.info` remains dominant, reduce or spread out DM inspection. If `conversations.history` dominates, inspect the unread-count fallback and its page limit.
- JSON is enough for this small replaceable cache; SQLite would add a runtime dependency without reducing more Slack requests. Delete `slack-discovery.json` to force a fresh discovery scan.
