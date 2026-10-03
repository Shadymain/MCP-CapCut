// mac-app.js -- controls the CapCut app on macOS for live sync.
// Needs one macOS permission the first time: "Claude wants to control CapCut" -> OK
// (System Settings > Privacy & Security > Automation). Reopening a project automatically
// is optional and also needs Accessibility permission -- see scripts/reopen-project.applescript.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const APP = (process.env.CAPCUT_APP_NAME || 'CapCut').replace(/["\\]/g, '');
const PROC = process.env.CAPCUT_PROCESS_NAME || 'CapCut';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fileSig = p => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return 'missing'; } };

export const macApp = {
  isRunning() {
    try { execFileSync('pgrep', ['-x', PROC], { stdio: 'ignore' }); return true; } catch { return false; }
  },

  // Polite quit (same as Cmd+Q), so CapCut writes its own copy of the project before exiting.
  async quit({ timeoutMs = 30000 } = {}) {
    try { execFileSync('osascript', ['-e', `tell application "${APP}" to quit`], { stdio: 'pipe', timeout: 15000 }); }
    catch (e) {
      throw new Error(`couldn't ask CapCut to quit (${(e.stderr || e.message || '').toString().trim()}). If macOS asked whether Claude may control CapCut, allow it in System Settings > Privacy & Security > Automation, then sync again.`);
    }
    const t0 = Date.now();
    while (this.isRunning()) {
      if (Date.now() - t0 > timeoutMs) throw new Error(`CapCut didn't close within ${timeoutMs / 1000}s -- it may be exporting or showing a dialog. Nothing was written. Close it yourself and sync again.`);
      await sleep(250);
    }
  },

  // Wait until draft_content.json stops changing and CapCut's .locked file is gone.
  async waitForSettle(dir, { quietMs = 1000, timeoutMs = 15000 } = {}) {
    const content = path.join(dir, 'draft_content.json');
    const lock = path.join(dir, '.locked');
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
