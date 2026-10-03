// mac-app.js -- controls the CapCut app on macOS for live sync.
// Needs one macOS permission the first time: "Claude wants to control CapCut" -> OK
// (System Settings > Privacy & Security > Automation). If CapCut refuses the quit request (-128), the
// Cmd+Q fallback also needs Automation for System Events plus Accessibility permission. Reopening a
// project automatically is optional and also needs Accessibility -- see scripts/reopen-project.applescript.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const APP = (process.env.CAPCUT_APP_NAME || 'CapCut').replace(/["\\]/g, '');
const PROC = process.env.CAPCUT_PROCESS_NAME || 'CapCut';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const osa = script => execFileSync('osascript', ['-e', script], { stdio: 'pipe', timeout: 15000 });
const osaMsg = e => (e.stderr || e.message || '').toString().trim();
const osaCode = e => { const m = osaMsg(e).match(/\((-?\d+)\)\s*$/); return m ? Number(m[1]) : null; };
const fileSig = p => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };

export const macApp = {
  isRunning() {
    try { execFileSync('pgrep', ['-x', PROC], { stdio: 'ignore' }); return true; } catch { return false; }
  },

  // Polite quit (same as Cmd+Q), so CapCut writes its own copy of the project before exiting.
  // If CapCut refuses the quit Apple Event (-128), fall back to pressing Cmd+Q through System Events.
  async quit({ timeoutMs = 30000 } = {}) {
    try { osa(`tell application "${APP}" to quit`); }
    catch (e) {
      const code = osaCode(e);
      if (code === -1743) throw new Error(`macOS didn't let Claude control CapCut (${osaMsg(e)}). Allow it in System Settings > Privacy & Security > Automation, then sync again.`);
      if (this.isRunning()) {
        if (code !== -128) throw new Error(`couldn't ask CapCut to quit (${osaMsg(e)}). Nothing was written. Close CapCut yourself and sync again.`);
        try { osa(`tell application "System Events" to tell process "${PROC}"\nset frontmost to true\nkeystroke "q" using command down\nend tell`); }
        catch (e2) {
          const why = osaCode(e2) === -1743 ? 'macOS didn\'t let Claude control System Events (Privacy & Security > Automation)'
            : /assistive|not allowed to send keystrokes|-1719|-25211|1002/.test(osaMsg(e2)) ? 'pressing Cmd+Q needs Accessibility permission for Claude (Privacy & Security > Accessibility)'
            : `the Cmd+Q fallback failed too (${osaMsg(e2)})`;
          throw new Error(`CapCut refused the quit request (${osaMsg(e)}), and ${why}. Nothing was written. Close CapCut yourself and sync again.`);
        }
      } // else: CapCut exited on its own while we asked (e.g. it was already closing)
    }
    const t0 = Date.now();
    while (this.isRunning()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`CapCut didn't close within ${timeoutMs / 1000}s -- it may be exporting or showing a dialog. Nothing was written. Close it yourself and sync again.`);
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
