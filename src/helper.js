// helper.js -- runs UI steps through "CapCut Sync Helper.app" (see helper/CapCutSyncHelper.js).
//
// MCP servers are their own responsible process on macOS, so clicking from here would need
// Accessibility for node itself. The helper is launched with `open`, so it alone needs permission.
// The applet can't take arguments from `open --args`, so the request and result go through files.
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const HELPER_NAME = 'CapCut Sync Helper';
export const HELPER_APP = process.env.CAPCUT_SYNC_HELPER || path.join(os.homedir(), 'Applications', `${HELPER_NAME}.app`);
export const HELPER_DIR = path.join(os.homedir(), 'Library', 'Application Support', HELPER_NAME); // fixed in the helper too
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeAtomic = (p, obj) => { const t = `${p}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, p); };

const AX_FIX = `allow "${HELPER_NAME}" under System Settings > Privacy & Security > Accessibility`;
const AUTOMATION_FIX = `allow "${HELPER_NAME}" to control System Events under System Settings > Privacy & Security > Automation`;

// Turn the helper's result into an error message, or null if it succeeded. Pure, for tests.
export function describeHelperFailure(result) {
  if (!result) return 'the helper returned no result';
  if (result.ok) return null;
  const err = result.error || {};
  const where = `step ${(err.step ?? 0) + 1} (${err.op || '?'})`;
  if (err.number === -1743) return `macOS blocked ${HELPER_NAME} from controlling System Events at ${where} -- ${AUTOMATION_FIX}`;
  if (err.number === -1719 || err.number === -25211 || (!result.axTrusted && err.op !== 'delay'))
    return `macOS blocked Accessibility for ${HELPER_NAME} at ${where} -- ${AX_FIX}`;
  return `${HELPER_NAME} failed at ${where}: ${err.message || 'unknown error'}${err.number != null ? ` (${err.number})` : ''}`;
}

// Is a helper instance still running (for example, stuck behind a permission prompt)?
function helperRunning() {
  try { execFileSync('pgrep', ['-f', `${HELPER_NAME}.app/Contents/MacOS/`], { stdio: 'ignore' }); return true; } catch { return false; }
}

// Run steps in the helper and return its per-step results. Throws with a readable message on failure.
// A timed-out request expires inside the helper, so a late permission answer never clicks anything.
export async function runHelper(steps, { timeoutMs = 20000 } = {}) {
  if (!fs.existsSync(HELPER_APP)) throw new Error(`${HELPER_NAME} is not installed at ${HELPER_APP} -- run scripts/install-helper.sh`);
  fs.mkdirSync(HELPER_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const resultPath = path.join(HELPER_DIR, 'result.json');
  const statusPath = path.join(HELPER_DIR, 'status.json');
  fs.rmSync(resultPath, { force: true });
  writeAtomic(path.join(HELPER_DIR, 'request.json'), { id, expiresAt: Date.now() + timeoutMs, steps });
  try { execFileSync('open', ['-n', '-g', HELPER_APP], { stdio: 'pipe', timeout: 10000 }); }
  catch (e) { throw new Error(`couldn't launch ${HELPER_NAME} (${(e.stderr?.length ? e.stderr : e.message).toString().trim()})`); }

  const t0 = Date.now();
  for (;;) {
    const result = readJson(resultPath);
    if (result?.id === id) {
      const failure = describeHelperFailure(result);
      if (failure) throw new Error(failure);
      return result.results;
    }
    if (Date.now() - t0 > timeoutMs + 2000) {
      const status = readJson(statusPath);
      const at = status?.id === id ? ` at step ${status.step + 1} (${status.op})` : '';
      if (helperRunning()) throw new Error(`waiting on a macOS permission prompt${at} -- look for a dialog about ${HELPER_NAME}, or ${AUTOMATION_FIX} and ${AX_FIX}, then sync again`);
      throw new Error(`${HELPER_NAME} didn't answer within ${Math.round(timeoutMs / 1000)}s${at}`);
    }
    await sleep(150);
  }
}
