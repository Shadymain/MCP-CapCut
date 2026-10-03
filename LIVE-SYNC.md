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

4. The first time you sync, macOS asks whether node may control CapCut. Click **OK**. If you missed it, allow it in System Settings → Privacy & Security → Automation.

## Tools added

- **`capcut_live_sync`** `{ draft, relaunch?, reopen?, mode? }`: pushes pending edits into the app. `mode` is `quit` or `close` (see below) and overrides `CAPCUT_SYNC_MODE`.
- **`capcut_live_status`** `{ draft }`: shows whether CapCut is running, whether the draft is open in it, and how many edits are pending.

## Close mode: keep CapCut open (experimental)

Set `CAPCUT_SYNC_MODE=close` (or pass `mode: "close"`) to swap the quit and relaunch for closing just the project:

1. Clicks **CapCut > Back to home page**. CapCut saves its own copy and removes `.locked`, usually within a second, and stays open on its home screen.
2. Waits for the timeline file to settle, re-applies Claude's edits on top of yours, validates and saves, as in quit mode.
3. Double-clicks the project's tile on the home screen and confirms it opened by watching `.locked` come back.

CapCut reads the project from disk when it opens it, so the saved edits show up. This was checked on CapCut 9.5.0 for Mac: a text layer moved on disk while CapCut sat on its home screen appeared in its new spot on reopen.

CapCut only exposes its window to Accessibility while it is the frontmost app, so the sync brings it to the front.

### The sync helper (permissions)

Claude starts MCP servers as their own "responsible process", so macOS checks permissions against `/usr/local/bin/node` itself, not Claude. Granting node Accessibility would cover every Node script on the Mac. Instead, close mode does its clicks through a small applet, **CapCut Sync Helper**, and only the helper needs permission.

1. Install it (skipped when the source hasn't changed, so its permissions survive):
   ```bash
   scripts/install-helper.sh
   ```
   It goes to `~/Applications/CapCut Sync Helper.app` (override with `CAPCUT_SYNC_HELPER`).
2. In System Settings > Privacy & Security:
   - **Accessibility:** turn on **CapCut Sync Helper**.
   - **Automation:** under **CapCut Sync Helper**, turn on **System Events** (macOS asks the first time).

The server talks to the helper through files in `~/Library/Application Support/CapCut Sync Helper/`: it writes `request.json` (a list of generic steps such as `clickMenu` and `mouseClick`), launches the helper with `open`, and waits for `result.json`. Everything CapCut-specific lives in the request, so the helper rarely needs rebuilding; a rebuild changes its signature and macOS asks for permission again. The old Accessibility entry stays in the list, switched on but no longer matching (the sync reports "macOS blocked Accessibility"): remove **CapCut Sync Helper** there with **–** and add `~/Applications/CapCut Sync Helper.app` again with **+**. A request that times out expires inside the helper, so answering a permission prompt late never clicks anything. If the helper is still waiting when the sync gives up, the sync reports "waiting on a macOS permission prompt" and falls back to quitting.

**Fallbacks.** If Back to home page fails or CapCut keeps `.locked`, the sync quits CapCut instead, like quit mode, and says so (`fellBack: true`). If the reopen fails, the edits are already saved and you're asked to click the project. If CapCut is running without this project open, it's left alone. If the project gets opened again while the sync is writing, nothing is written.

**How the tile is found.** The home screen's project tiles carry no names for Accessibility, so the project is located by its place in CapCut's newest-first order, read from `root_meta_info.json`. If a different project opens, the sync goes back to the home screen and asks you to click. A tile scrolled out of view, or a different sort order on the home screen, ends the same way.

Quit mode stays the default until close mode has had more real runs.

## Auto-reopening the project after a relaunch (experimental)

After a relaunch, CapCut opens on its home screen and you click the project. To try automating that click:

1. Set `CAPCUT_REOPEN_SCRIPT` to the full path of `scripts/reopen-project.applescript`.
2. Allow Claude under Privacy & Security → Accessibility.

The script is untested against CapCut's real interface. If it reports "not found", ask Claude Code to inspect CapCut's accessibility tree on your Mac and adapt the script.

## Other changes in this fork

- `capcut_save` now detects a running CapCut on macOS. Before, that check only worked on Windows, so on a Mac a save could be silently overwritten.
- The local Whisper venv path now works on macOS (`vendor/whisper-env/bin/python`).

## Known limits

- **Replay addresses tracks by index.** If you add or reorder tracks in CapCut between syncs, an edit that targeted a track by index can land on the wrong track. Check after syncing.
- **Each sync costs a few seconds.** In quit mode CapCut quits and relaunches. Close mode is quicker (about 3 s on CapCut 9.5) but still brings CapCut to the front. Either way, sync after a meaningful batch of edits, not after every single one.
- **CapCut updates can change the draft format.** Keep the backups, and consider pausing auto-updates.

## Which file holds the timeline (macOS)

Each draft resolves one authoritative timeline file, in this order:

1. `Timelines/<main_timeline_id>/draft_info.json` (id read from `Timelines/project.json`)
2. root `draft_content.json` (Windows and older builds)
3. root `draft_info.json`

On save, that file is backed up to `.mcpbak` and written atomically, then every other copy that exists (root `draft_info.json`, `draft_content.json`, and both `template-2.tmp` files) gets the same content. CapCut's own `.bak` files are left alone.

Verified on CapCut 9.5.0 for Mac: the server scaled a clip to 150% with CapCut closed, and CapCut opened the project showing 150%. On open, CapCut moved the saved bytes into its own `draft_info.json.bak` and rewrote all four timeline copies with its own formatting, keeping the edit. On quit, it rewrote all four copies again (still 150%), updated its `.bak` files, and removed `.locked`. It never touched the server's `.mcpbak` backups.

## Registering the server

Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
"mcpServers": {
  "capcut": {
    "command": "/usr/local/bin/node",
    "args": ["/absolute/path/to/MCP-CapCut/src/server.js"],
    "env": { "CAPCUT_TEMPLATE_DRAFT": "sandbox" }
  }
}
```

Claude Code:

```bash
claude mcp add --scope user capcut -e CAPCUT_TEMPLATE_DRAFT=sandbox -- "$(which node)" /absolute/path/to/MCP-CapCut/src/server.js
```

`CAPCUT_TEMPLATE_DRAFT` names a project folder with at least a video clip and a text layer; the server copies clip and track structure from it when the draft being edited lacks one.
