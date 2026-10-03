// live.js -- "auto-reload" sync between this MCP's editing session and the CapCut app.
//
// The problem: CapCut keeps the open project in memory and writes it back when it closes,
// silently overwriting anything written to draft_content.json underneath it.
//
// The fix: every editing tool call is journaled (method + args + the ids it generated). To sync:
//   1. ask CapCut to quit (it flushes ITS copy -- including anything you changed by hand)
//   2. wait for the file to settle
//   3. if the file changed since we loaded it, reload it and REPLAY the journal on top
//      (same ids, so later edits that refer to clips created earlier still line up)
//   4. validate + save atomically (backup first)
//   5. relaunch CapCut (and optionally reopen the project)
// If a replayed edit no longer applies (e.g. you deleted the clip it targets), nothing is written.
import fs from 'fs';
import { CapCutDraft, withIdCapture, withIdReplay } from './core.js';

// CapCutDraft methods that change the draft. Everything else passes straight through unjournaled.
export const MUTATING = new Set([
  'setTrackMute', 'addTrack', 'addVideo', 'addImage', 'addAudio', 'addText',
  'moveSegment', 'trimSegment', 'splitSegment', 'deleteSegment', 'setProps', 'rawPatch',
  'addKeyframe', 'removeKeyframes', 'addAudioFade', 'addFilter', 'addTransition', 'addMask',
  'addSticker', 'addCaptions', 'clearCaptionTrack',
]);

const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class JournaledSession {
  constructor(name) {
    this.name = name;
    this.draft = new CapCutDraft(name);
    this.journal = []; // { method, args, ids, seq }  seq = undo group the edit belongs to
    // `api` is what tools call. It always forwards to the CURRENT draft, so a rebase can swap it.
    this.api = new Proxy({}, {
      get: (_, prop) => this._forward(prop),
      set: (_, prop, val) => { this.draft[prop] = val; return true; },
    });
  }

  _forward(prop) {
    const d = this.draft;
    const v = d[prop];
    if (typeof v !== 'function') return v;
    if (prop === 'undo') return (...a) => {
      const r = v.apply(d, a);
      const seq = d._lastUndoneSeq;
      while (this.journal.length && this.journal[this.journal.length - 1].seq >= seq) this.journal.pop();
      return r;
    };
    if (prop === 'save') return (...a) => { const r = v.apply(d, a); this.journal = []; return r; };
    if (!MUTATING.has(prop)) return (...a) => v.apply(d, a);
    return (...args) => {
      const before = d._undoSeq || 0;
      const snapshot = plain(args);
      try {
        const { result, ids } = withIdCapture(() => v.apply(d, args));
        this.journal.push({ method: prop, args: snapshot, ids, seq: d._undoSeq || 0 });
        return result;
      } catch (e) {
        // the edit failed part-way: if it opened a new undo group, roll back to the state before it
        if ((d._undoSeq || 0) > before && d._undoStack?.length && d._undoStack[d._undoStack.length - 1].seq === d._undoSeq) {
          try { d.undo(); } catch { /* nothing to roll back */ }
        }
        throw e;
      }
    };
  }

  get pending() { return this.journal.length; }

  // Reload the draft from disk and re-apply every journaled edit on top of it.
  rebase() {
    const fresh = new CapCutDraft(this.name);
    const newJournal = [];
    let prevSeq = null;
    for (const [i, op] of this.journal.entries()) {
      if (op.seq !== prevSeq) fresh._inUndoScope = false; // keep the original undo grouping
      prevSeq = op.seq;
      const fn = fresh[op.method];
      try {
        withIdReplay(op.ids, () => fn.apply(fresh, plain(op.args)));
      } catch (e) {
        const err = new Error(`edit #${i + 1} of ${this.journal.length} (${op.method}) no longer applies after your changes in CapCut: ${e.message}`);
        err.conflict = { index: i, method: op.method, reason: e.message };
        throw err;
      }
      newJournal.push({ ...op, seq: fresh._undoSeq || 0 });
    }
    this.draft = fresh;
    this.journal = newJournal;
  }
}

// app: { isRunning(), quit(), waitForSettle(dir), launch(), reopenProject(name) } -- see mac-app.js
export async function liveSync(session, app, { relaunch, reopen = true } = {}) {
  const result = { draft: session.name, pendingEdits: session.pending, steps: [] };
  if (!session.pending) return { ...result, synced: false, note: 'no pending edits to sync' };

  const wasRunning = app.isRunning();
  const shouldRelaunch = relaunch ?? wasRunning;
  const relaunchApp = async () => {
    if (!shouldRelaunch) return;
    await app.launch(); result.steps.push('relaunched CapCut');
    if (reopen) { const r = await app.reopenProject(session.name); result.reopened = r.reopened; if (r.hint) result.hint = r.hint; }
  };

  if (wasRunning) { await app.quit(); result.steps.push('closed CapCut (it saved its own copy first)'); }
  const settle = await app.waitForSettle(session.draft.dir);
  if (settle?.staleLock) result.steps.push('note: a stale .locked file is left over from CapCut; ignored because CapCut is not running');

  const onDisk = fs.statSync(session.draft.contentPath).mtimeMs;
  if (onDisk !== session.draft._loadedMtimeMs) {
    try { session.rebase(); result.rebased = true; result.steps.push(`project changed in CapCut -- reloaded it and re-applied ${session.pending} edit(s) on top`); }
    catch (e) { await relaunchApp(); e.message = `nothing was written. ${e.message} Use capcut_discard and redo the edit, or undo your change in CapCut and sync again.`; throw e; }
  }

  let saved;
  try { saved = session.api.save({ trusted: true }); }
  catch (e) { await relaunchApp(); e.message = `nothing was written. ${e.message}`; throw e; }
  result.steps.push('validated and saved (backup at draft_content.json.mcpbak)');
  result.synced = true; result.saved = saved;
  await relaunchApp();
  return result;
}
