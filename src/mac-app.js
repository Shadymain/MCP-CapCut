// mac-app.js -- controls the CapCut app on macOS for live sync.
// Needs one macOS permission the first time: "Claude wants to control CapCut" -> OK
// (System Settings > Privacy & Security > Automation). Close mode (CAPCUT_SYNC_MODE=close) and
// reopening a project automatically also need Accessibility permission for Claude.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const APP = (process.env.CAPCUT_APP_NAME || 'CapCut').replace(/["\\]/g, '');
const PROC = process.env.CAPCUT_PROCESS_NAME || 'CapCut';
const PROC_AS = PROC.replace(/["\\]/g, ''); // safe to embed in AppleScript
const sleep = ms => new Promise(r => setTimeout(r, ms));
const osa = script => execFileSync('osascript', ['-e', script], { stdio: 'pipe', timeout: 15000 });
const osaMsg = e => (e.stderr || e.message || '').toString().trim();
const osaCode = e => { const m = osaMsg(e).match(/\((-?\d+)\)\s*$/); return m ? Number(m[1]) : null; };
const fileSig = p => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };
const lockOf = dir => path.join(dir, '.locked');
const axHint = e => osaCode(e) === -1719 || osaCode(e) === -25211
  ? 'macOS blocked Accessibility -- allow Claude under System Settings > Privacy & Security > Accessibility'
  : osaMsg(e);

// CapCut's home screen shows drafts newest-first and exposes the tiles to Accessibility only as
// unnamed "HomePageDraft" elements, so a project is found by its position in that order.
// rootMeta: parsed root_meta_info.json from the drafts folder. Returns -1 if the draft isn't listed.
export function homeTileIndex(rootMeta, dir) {
  const want = path.resolve(dir);
  const shown = (rootMeta?.all_draft_store || [])
    .filter(d => !d.draft_is_invisible && !d.tm_draft_removed && !d.draft_is_cloud_temp_draft)
    .sort((a, b) => (b.tm_draft_modified || 0) - (a.tm_draft_modified || 0));
  return shown.findIndex(d => d.draft_fold_path && path.resolve(d.draft_fold_path) === want);
}

// Real mouse events (move, pause, double-click). CapCut ignores System Events' synthetic "click at".
const DOUBLE_CLICK_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  const pt = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  const post = (type, state) => { const e = $.CGEventCreateMouseEvent(null, type, pt, $.kCGMouseButtonLeft);
    if (state) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, state); $.CGEventPost($.kCGHIDEventTap, e); };
  post($.kCGEventMouseMoved, 0); delay(0.4);
  post($.kCGEventLeftMouseDown, 1); delay(0.03); post($.kCGEventLeftMouseUp, 1); delay(0.08);
  post($.kCGEventLeftMouseDown, 2); delay(0.03); post($.kCGEventLeftMouseUp, 2);
}`;

// Frames of the home screen's draft tiles plus the main window's bottom edge, as "x,y,w,h" lines.
// CapCut only exposes its window contents while it is frontmost, so activate first.
const TILES_SCRIPT = `tell application "${APP}" to activate
delay 0.5
tell application "System Events" to tell process "${PROC_AS}"
  set out to ""
  repeat with w in windows
    if subrole of w is "AXStandardWindow" then
      set wp to position of w
      set ws to size of w
      set out to out & "W," & (item 1 of wp) & "," & (item 2 of wp) & "," & (item 1 of ws) & "," & (item 2 of ws) & linefeed
      set els to entire contents of w -- snapshot it: looping over the live reference finds nothing
      repeat with el in els
        set d to ""
        try
          set d to description of el as text
        end try
        if d is "HomePageDraft" then
          set p to position of el
          set s to size of el
          set out to out & "T," & (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s) & linefeed
        end if
      end repeat
    end if
  end repeat
  return out
end tell`;

export const macApp = {
  isRunning() {
    try { execFileSync('pgrep', ['-x', PROC], { stdio: 'ignore' }); return true; } catch { return false; }
  },

  // Polite quit (same as Cmd+Q), so CapCut writes its own copy of the project before exiting.
  // CapCut sometimes answers the quit request with -128 ("User canceled") and then quits anyway,
  // so -128 is not fatal: keep waiting and only fail if it's still open at the timeout.
  async quit({ timeoutMs = 30000 } = {}) {
    let refused = false;
    try { osa(`tell application "${APP}" to quit`); }
    catch (e) {
      const code = osaCode(e);
      if (code === -1743) throw new Error(`macOS didn't let Claude control CapCut (${osaMsg(e)}). Allow it in System Settings > Privacy & Security > Automation, then sync again.`);
      if (code === -128) refused = true;
      else if (this.isRunning()) throw new Error(`couldn't ask CapCut to quit (${osaMsg(e)}). Nothing was written. Close CapCut yourself and sync again.`);
    }
    const t0 = Date.now();
    while (this.isRunning()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(refused
        ? `CapCut refused the quit request (-128) and was still open after ${timeoutMs / 1000}s -- it may be showing a dialog or exporting. Nothing was written. Close it yourself and sync again.`
        : `CapCut didn't close within ${timeoutMs / 1000}s -- it may be exporting or showing a dialog. Nothing was written. Close it yourself and sync again.`);
      await sleep(250);
    }
  },

  // Wait until the draft's authoritative timeline file stops changing and CapCut's .locked file is gone.
  // contentPath: the session's resolved timeline file (may be nested under Timelines/); lockDir: the project folder.
  async waitForSettle(contentPath, lockDir, { quietMs = 1000, timeoutMs = 15000 } = {}) {
    const content = contentPath;
    const lock = path.join(lockDir, '.locked');
    let last = fileSig(content), stableSince = Date.now();
    const t0 = Date.now();
    for (;;) {
      await sleep(200);
      const sig = fileSig(content);
      if (sig !== last) { last = sig; stableSince = Date.now(); }
      const quiet = Date.now() - stableSince >= quietMs;
      if (quiet && !fs.existsSync(lock)) return { staleLock: false };
      if (quiet && !this.isRunning() && Date.now() - t0 > quietMs * 2) return { staleLock: true }; // app is gone, so the lock is stale
      if (Date.now() - t0 > timeoutMs) throw new Error('the project file kept changing after CapCut closed. Nothing was written. Try syncing again in a few seconds.');
    }
  },

  isProjectOpen(dir) { return fs.existsSync(lockOf(dir)); },

  // Close mode: leave the editor (CapCut > Back to home page) without quitting. CapCut saves its own
  // copy and removes .locked within about a second. Throws if that doesn't happen, so the caller can
  // fall back to quitting.
  async closeProject(dir, { timeoutMs = 20000 } = {}) {
    try {
      osa(`tell application "${APP}" to activate
delay 0.5
tell application "System Events" to tell process "${PROC_AS}" to click menu item "Back to home page" of menu 1 of menu bar item "${APP}" of menu bar 1`);
    } catch (e) { throw new Error(`couldn't click CapCut > Back to home page (${axHint(e)})`); }
    const t0 = Date.now();
    while (fs.existsSync(lockOf(dir))) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`CapCut still had the project open ${timeoutMs / 1000}s after Back to home page -- it may be showing a dialog`);
      await sleep(200);
    }
  },

  // Close mode: double-click the project's tile on the home screen, then confirm by .locked
  // reappearing. If a different project opens instead, go back home and report it.
  async openProject(name, dir, { timeoutMs = 15000 } = {}) {
    const fail = why => ({ reopened: false, hint: `couldn't reopen "${name}" automatically (${why}) -- click it on CapCut's home screen.` });
    const root = path.dirname(dir);
    let index;
    try { index = homeTileIndex(JSON.parse(fs.readFileSync(path.join(root, 'root_meta_info.json'), 'utf8')), dir); }
    catch (e) { return fail(`couldn't read root_meta_info.json: ${e.message}`); }
    if (index < 0) return fail('it is not in CapCut\'s project list');

    let win, tiles = [];
    const t0 = Date.now();
    while (tiles.length <= index && Date.now() - t0 < 5000) { // the home screen fills in shortly after leaving the editor
      let out;
      try { out = execFileSync('osascript', ['-e', TILES_SCRIPT], { encoding: 'utf8', timeout: 20000 }); }
      catch (e) { return fail(axHint(e)); }
      const rows = out.trim().split('\n').filter(Boolean).map(l => { const [k, ...n] = l.split(','); return { k, f: n.map(Number) }; });
      win = rows.find(r => r.k === 'W')?.f;
      tiles = rows.filter(r => r.k === 'T').map(r => r.f).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      if (tiles.length <= index) await sleep(500);
    }
    if (tiles.length <= index) return fail(`CapCut shows ${tiles.length} project tile(s) and this is #${index + 1}`);
    const [x, y, w, h] = tiles[index];
    const visibleH = win ? Math.min(h, win[1] + win[3] - y - 4) : h;
    if (visibleH < 20) return fail('its tile is scrolled out of view');

    const siblings = () => { try { return fs.readdirSync(root).filter(n => fs.existsSync(path.join(root, n, '.locked'))); } catch { return []; } };
    const lockedBefore = new Set(siblings());
    try { execFileSync('osascript', ['-l', 'JavaScript', '-e', DOUBLE_CLICK_JXA, String(Math.round(x + w / 2)), String(Math.round(y + visibleH / 2))], { stdio: 'pipe', timeout: 10000 }); }
    catch (e) { return fail(axHint(e)); }

    const t1 = Date.now();
    while (Date.now() - t1 < timeoutMs) {
      if (fs.existsSync(lockOf(dir))) return { reopened: true };
      const other = siblings().find(n => !lockedBefore.has(n) && path.join(root, n) !== path.resolve(dir));
      if (other) {
        try { await this.closeProject(path.join(root, other)); } catch { /* leave it to the user */ }
        return fail(`the tile opened "${other}" instead; went back to the home screen`);
      }
      await sleep(250);
    }
    return fail('it did not open within ' + timeoutMs / 1000 + 's');
  },

  async launch() {
    execFileSync('open', ['-a', APP], { stdio: 'pipe' });
    const t0 = Date.now();
    while (!this.isRunning() && Date.now() - t0 < 20000) await sleep(250);
  },

  // Optional: point CAPCUT_REOPEN_SCRIPT at an AppleScript that opens a project by name.
  async reopenProject(name) {
    const script = process.env.CAPCUT_REOPEN_SCRIPT;
    if (!script) return { reopened: false, hint: `CapCut is back on its home screen -- click "${name}" to see the changes. (Auto-reopen is the next step; see scripts/reopen-project.applescript.)` };
    try {
      const out = execFileSync('osascript', [script, name], { encoding: 'utf8', timeout: 30000 }).trim();
      return out === 'opened' ? { reopened: true } : { reopened: false, hint: `auto-reopen couldn't find "${name}" (${out}) -- click it in CapCut.` };
    } catch (e) {
      return { reopened: false, hint: `auto-reopen failed (${(e.stderr || e.message || '').toString().trim()}) -- click "${name}" in CapCut. If this is a permissions error, allow Claude under Privacy & Security > Accessibility.` };
    }
  },
};
