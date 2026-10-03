// Live-sync tests with a FAKE CapCut: safe to run anytime, never touches your real drafts.
//   npm test
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { makeDraft, NESTED_ID } from './make-draft.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-live-test-'));
process.env.CAPCUT_DRAFTS_DIR = ROOT; // must be set before core.js loads
const { JournaledSession, liveSync } = await import('../src/live.js');
const { CapCutDraft, listDrafts, cloneDraft } = await import('../src/core.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = dir => JSON.parse(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8'));
const segs = c => c.tracks.flatMap(t => t.segments);
const tick = () => new Promise(r => setTimeout(r, 0)); // separate "tool calls" (undo groups reset per microtask)
function fakeApp(onQuit) { let running = true; return { log: [], isRunning: () => running,
  async quit() { this.log.push('quit'); onQuit?.(); running = false; }, async waitForSettle() { this.log.push('settle'); return { staleLock: false }; },
  async launch() { this.log.push('launch'); running = true; }, async reopenProject(n) { this.log.push('reopen'); return { reopened: false, hint: 'click ' + n }; } }; }

// ---- 1. happy path: user edits in CapCut while Claude works; both survive ----
{
  const dir = makeDraft(ROOT, 'p1');
  const sess = new JournaledSession('p1'); const api = sess.api;
  api.setProps('SEG1', { scale: 1.2 }); await tick();
  const { right } = api.splitSegment('SEG1', 2e6); await tick();
  api.setProps(right, { opacity: 0.5 }); await tick();
  assert.equal(sess.pending, 3);
  await sleep(20);
  // CapCut flushes the user's own edit (SEG2 rotated) when it quits
  const app = fakeApp(() => { const c = read(dir); segs(c).find(s => s.id === 'SEG2').clip.rotation = 90; fs.writeFileSync(path.join(dir, 'draft_content.json'), JSON.stringify(c)); });
  const r = await liveSync(sess, app, {});
  const c = read(dir), byId = Object.fromEntries(segs(c).map(s => [s.id, s]));
  assert.ok(r.synced && r.rebased, 'synced+rebased');
  assert.equal(byId.SEG2.clip.rotation, 90, "user's CapCut edit kept");
  assert.equal(byId.SEG1.clip.scale.x, 1.2, "Claude's scale kept");
  assert.ok(byId[right], 'split half has the SAME id after replay');
  assert.equal(byId[right].clip.alpha, 0.5, 'edit on split half applied');
  assert.equal(byId.SEG1.target_timerange.duration, 2e6);
  assert.deepEqual(app.log, ['quit', 'settle', 'launch', 'reopen']);
  assert.ok(fs.existsSync(path.join(dir, 'draft_content.json.mcpbak')), 'backup written');
  console.log('PASS 1 happy path:', r.steps.join(' | '));
}

// ---- 2. conflict: user deleted the clip Claude edited -> nothing written ----
{
  const dir = makeDraft(ROOT, 'p2');
  const sess = new JournaledSession('p2');
  sess.api.setProps('SEG2', { opacity: 0.3 }); await tick();
  await sleep(20);
  let flushed;
  const app = fakeApp(() => { const c = read(dir); c.tracks[0].segments = c.tracks[0].segments.filter(s => s.id !== 'SEG2'); flushed = JSON.stringify(c); fs.writeFileSync(path.join(dir, 'draft_content.json'), flushed); });
  await assert.rejects(liveSync(sess, app, {}), e => { console.log('PASS 2 conflict ->', e.message); return /nothing was written/.test(e.message) && e.conflict?.method === 'setProps'; });
  assert.equal(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8'), flushed, 'file untouched');
  assert.ok(app.log.includes('launch'), 'CapCut relaunched even after conflict');
  assert.equal(sess.pending, 1, 'journal kept so Claude can retry/discard');
}

// ---- 3. undo keeps journal in step (incl. two edits in one tool call, like captions' clear+add) ----
{
  makeDraft(ROOT, 'p3');
  const sess = new JournaledSession('p3'); const api = sess.api;
  api.setProps('SEG1', { scale: 2 }); await tick();
  api.setTrackMute(0, true); api.setProps('SEG2', { volume: 0 }); await tick(); // one tool call, two mutations
  assert.equal(sess.pending, 3);
  api.undo();
  assert.equal(sess.pending, 1, 'undo removed both edits of the grouped call');
  assert.equal(sess.draft.content.tracks[0].attribute, 0);
  console.log('PASS 3 undo/journal grouping');
}

// ---- 4. failed edit rolls back cleanly and is not journaled ----
{
  makeDraft(ROOT, 'p4');
  const sess = new JournaledSession('p4'); const api = sess.api;
  api.setProps('SEG1', { scale: 3 }); await tick();
  const before = JSON.stringify(sess.draft.content);
  assert.throws(() => api.splitSegment('SEG1', 99e6), /inside the segment/);
  assert.equal(JSON.stringify(sess.draft.content), before, 'state unchanged');
  assert.equal(sess.pending, 1);
  api.undo(); assert.equal(sess.pending, 0); assert.equal(sess.draft.content.tracks[0].segments[0].clip.scale.x, 1);
  console.log('PASS 4 failed edit rollback');
}

// ---- 5. no external change -> no rebase; nothing pending -> CapCut untouched ----
{
  makeDraft(ROOT, 'p5');
  const sess = new JournaledSession('p5');
  const app0 = fakeApp(); const r0 = await liveSync(sess, app0, {});
  assert.equal(r0.synced, false); assert.deepEqual(app0.log, []);
  sess.api.setProps('SEG1', { posX: 0.25 }); await tick();
  const app = fakeApp(); const r = await liveSync(sess, app, { reopen: false });
  assert.ok(r.synced && !r.rebased); assert.deepEqual(app.log, ['quit', 'settle', 'launch']);
  console.log('PASS 5 no-op + no-rebase paths');
}

// ---- 6. validation failure -> nothing written, CapCut relaunched ----
{
  const dir = makeDraft(ROOT, 'p6');
  const sess = new JournaledSession('p6');
  sess.api.moveSegment('SEG2', 1e6); await tick(); // overlaps SEG1 on the same track
  const orig = fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8');
  const app = fakeApp();
  await assert.rejects(liveSync(sess, app, {}), e => /nothing was written.*overlapping/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8'), orig);
  assert.ok(app.log.includes('launch'));
  console.log('PASS 6 validation guard');
}
// ---- 7. Mac root draft_info.json layout (no draft_content.json) ----
{
  const dir = makeDraft(ROOT, 'p7', 'info');
  assert.ok(listDrafts().some(d => d.name === 'p7' && d.durationSec === 8), 'listed via draft_info.json');
  const d = new CapCutDraft('p7');
  assert.equal(d.contentPath, path.join(dir, 'draft_info.json'));
  d.setProps('SEG1', { scale: 1.5 }); await tick();
  await sleep(20); d.save({ trusted: true });
  const info = fs.readFileSync(path.join(dir, 'draft_info.json'), 'utf8');
  assert.equal(JSON.parse(info).tracks[0].segments[0].clip.scale.x, 1.5, 'edit saved to draft_info.json');
  assert.equal(fs.readFileSync(path.join(dir, 'template-2.tmp'), 'utf8'), info, 'template-2.tmp mirror updated');
  assert.ok(!fs.existsSync(path.join(dir, 'draft_content.json')), 'no stray draft_content.json created');
  assert.ok(fs.existsSync(path.join(dir, 'draft_info.json.mcpbak')), 'backup written');
  assert.equal(fs.readFileSync(path.join(dir, 'draft_info.json.bak'), 'utf8'), '{"capcut":"own backup"}', "CapCut's own .bak untouched");
  console.log('PASS 7 root draft_info.json layout');
}

// ---- 8. Mac CapCut 9.x nested Timelines layout: nested file is authoritative, every copy rewritten ----
{
  const dir = makeDraft(ROOT, 'p8', 'nested');
  const nested = path.join(dir, 'Timelines', NESTED_ID, 'draft_info.json');
  const copies = [nested, path.join(dir, 'draft_info.json'), path.join(dir, 'template-2.tmp'), path.join(dir, 'Timelines', NESTED_ID, 'template-2.tmp')];
  const sess = new JournaledSession('p8');
  assert.equal(sess.draft.contentPath, nested, 'nested file is authoritative');
  sess.api.setProps('SEG1', { scale: 1.5 }); await tick();
  await sleep(20);
  // CapCut flushes a hand edit into the NESTED file only on quit -> must be detected and rebased onto
  const app = fakeApp(() => { const c = JSON.parse(fs.readFileSync(nested, 'utf8')); segs(c).find(s => s.id === 'SEG2').clip.rotation = 45; fs.writeFileSync(nested, JSON.stringify(c)); });
  const settleArgs = []; const origSettle = app.waitForSettle; app.waitForSettle = async (...a) => { settleArgs.push(a); return origSettle.call(app); };
  const r = await liveSync(sess, app, {});
  assert.ok(r.synced && r.rebased, 'nested change detected + rebased');
  assert.deepEqual(settleArgs[0], [nested, dir], 'waitForSettle watches the authoritative file');
  const want = fs.readFileSync(nested, 'utf8'), c = JSON.parse(want), byId = Object.fromEntries(segs(c).map(s => [s.id, s]));
  assert.equal(byId.SEG1.clip.scale.x, 1.5); assert.equal(byId.SEG2.clip.rotation, 45);
  for (const p of copies) assert.equal(fs.readFileSync(p, 'utf8'), want, `copy in sync: ${path.relative(dir, p)}`);
  // clone carries the nested layout along
  cloneDraft('p8', 'p8-clone');
  assert.equal(new CapCutDraft('p8-clone').contentPath, path.join(ROOT, 'p8-clone', 'Timelines', NESTED_ID, 'draft_info.json'));
  console.log('PASS 8 nested Timelines layout:', r.steps.join(' | '));
}
console.log('\nALL LIVE-SYNC TESTS PASSED');
