# Live sync (macOS)

Watch Claude's edits show up in the CapCut app, without closing CapCut yourself.

CapCut has no plugin API, so this can't be true live editing the way Figma does it. Instead, Claude works in batches. After each batch it calls `capcut_live_sync`, which:

1. Politely quits CapCut (like Cmd+Q). CapCut saves its own copy first, including anything you changed by hand.
2. Waits for the project file to settle.
3. If you changed the project in CapCut, reloads the file and re-applies Claude's edits on top. The edits keep the same clip ids, so they still line up.
4. Validates, then saves atomically, keeping a backup at `draft_content.json.mcpbak`.
5. Relaunches CapCut.

If one of Claude's edits no longer applies (for example, you deleted the clip it was editing), **nothing is written**. Claude gets told which edit failed and why.

## Setup

1. Check that your CapCut stores projects as plain JSON:
   ```
   head -c 300 ~/Movies/CapCut/User\ Data/Projects/com.lveditor.draft/*/draft_content.json
   ```
   - If you see readable `{"...` text, you're good.
   - If you see gibberish, your CapCut version encrypts drafts and this approach won't work on it.

2. Check the process name with `pgrep -lx CapCut` while CapCut is open. If it prints nothing, find the real name with `pgrep -il capcut` and set `CAPCUT_PROCESS_NAME` to it.

3. Run `npm test`. This runs the live-sync tests against a fake CapCut and never touches your projects.

4. The first time you sync, macOS asks whether Claude may control CapCut. Click **OK**. If you missed it, allow it in System Settings → Privacy & Security → Automation.

## Tools added

- **`capcut_live_sync`** `{ draft, relaunch?, reopen? }`: pushes pending edits into the app.
- **`capcut_live_status`** `{ draft }`: shows whether CapCut is running, whether the draft is open in it, and how many edits are pending.

## Auto-reopening the project (experimental)

After a relaunch, CapCut opens on its home screen and you click the project. To try automating that click:

1. Set `CAPCUT_REOPEN_SCRIPT` to the full path of `scripts/reopen-project.applescript`.
2. Allow Claude under Privacy & Security → Accessibility.

The script is untested against CapCut's real interface. If it reports "not found", ask Claude Code to inspect CapCut's accessibility tree on your Mac and adapt the script.

## Other changes in this fork

- `capcut_save` now detects a running CapCut on macOS. Before, that check only worked on Windows, so on a Mac a save could be silently overwritten.
- The local Whisper venv path now works on macOS (`vendor/whisper-env/bin/python`).

## Known limits

- **Replay addresses tracks by index.** If you add or reorder tracks in CapCut between syncs, an edit that targeted a track by index can land on the wrong track. Check after syncing.
- **Each sync costs a few seconds.** CapCut quits and relaunches, so sync after a meaningful batch of edits, not after every single one.
- **CapCut updates can change the draft format.** Keep the backups, and consider pausing auto-updates.
