// Live-sync tests with a FAKE CapCut: safe to run anytime, never touches your real drafts.
//   npm test
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { makeDraft, NESTED_ID } from './make-draft.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-live-test-'));
process.env.CAPCUT_DRAFTS_DIR = ROOT; // must be set before core.js loads
delete process.env.CAPCUT_SYNC_MODE; // tests choose the mode explicitly
const { JournaledSession, liveSync } = await import('../src/live.js');
const { CapCutDraft, listDrafts, cloneDraft, findDraftById } = await import('../src/core.js');
const { homeTileIndex } = await import('../src/mac-app.js');
const { describeHelperFailure } = await import('../src/helper.js');
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
// ---- close mode: CapCut leaves just the project (on its home screen) instead of quitting ----
// project open <=> .locked exists, like the real app. onClose runs while CapCut flushes its copy.
function fakeCloseApp(dir, { onClose, closeFails, openWorks = true } = {}) {
  const lock = path.join(dir, '.locked'); fs.writeFileSync(lock, '');
  const app = fakeApp(); app.log = [];
  app.isProjectOpen = d => fs.existsSync(path.join(d, '.locked'));
  app.closeProject = async () => { app.log.push('close'); if (closeFails) throw new Error('menu item missing'); onClose?.(); fs.rmSync(lock); };
  app.openProject = async n => { app.log.push('open'); if (!openWorks) return { reopened: false, hint: 'click ' + n }; fs.writeFileSync(lock, ''); return { reopened: true }; };
  const quit = app.quit; app.quit = async function () { await quit.call(this); fs.rmSync(lock, { force: true }); };
  return app;
}

// ---- 9. close mode happy path: hand edit flushed on close is kept, CapCut never quits ----
{
  const dir = makeDraft(ROOT, 'p9');
  const sess = new JournaledSession('p9');
  sess.api.setProps('SEG1', { scale: 1.3 }); await tick();
  await sleep(20);
  const app = fakeCloseApp(dir, { onClose: () => { const c = read(dir); segs(c).find(s => s.id === 'SEG2').clip.rotation = 30; fs.writeFileSync(path.join(dir, 'draft_content.json'), JSON.stringify(c)); } });
  const r = await liveSync(sess, app, { mode: 'close' });
  assert.ok(r.synced && r.rebased && r.reopened, 'synced, rebased, reopened');
  assert.equal(r.via, 'close');
  assert.deepEqual(app.log, ['close', 'settle', 'open'], 'no quit, no launch');
  assert.ok(app.isRunning(), 'CapCut still running');
  const byId = Object.fromEntries(segs(read(dir)).map(s => [s.id, s]));
  assert.equal(byId.SEG1.clip.scale.x, 1.3); assert.equal(byId.SEG2.clip.rotation, 30);
  console.log('PASS 9 close mode:', r.steps.join(' | '));
}

// ---- 10. close mode, leaving the project fails -> falls back to quit + relaunch ----
{
  const dir = makeDraft(ROOT, 'p10');
  const sess = new JournaledSession('p10');
  sess.api.setProps('SEG1', { scale: 1.4 }); await tick();
  const app = fakeCloseApp(dir, { closeFails: true });
  const r = await liveSync(sess, app, { mode: 'close' });
  assert.ok(r.synced && r.fellBack); assert.equal(r.via, 'quit');
  assert.deepEqual(app.log, ['close', 'quit', 'settle', 'launch', 'reopen']);
  assert.equal(segs(read(dir))[0].clip.scale.x, 1.4);
  console.log('PASS 10 close-mode fallback to quit');
}

// ---- 11. close mode, CapCut running but this project not open -> CapCut left alone ----
{
  const dir = makeDraft(ROOT, 'p11');
  const sess = new JournaledSession('p11');
  sess.api.setProps('SEG1', { scale: 1.1 }); await tick();
  const app = fakeCloseApp(dir); fs.rmSync(path.join(dir, '.locked'));
  const r = await liveSync(sess, app, { mode: 'close' });
  assert.ok(r.synced); assert.equal(r.via, 'none');
  assert.deepEqual(app.log, ['settle']);
  console.log('PASS 11 close mode, project not open');
}

// ---- 12. close mode conflict -> nothing written, project reopened (no relaunch) ----
{
  const dir = makeDraft(ROOT, 'p12');
  const sess = new JournaledSession('p12');
  sess.api.setProps('SEG2', { opacity: 0.3 }); await tick();
  await sleep(20);
  let flushed;
  const app = fakeCloseApp(dir, { onClose: () => { const c = read(dir); c.tracks[0].segments = c.tracks[0].segments.filter(s => s.id !== 'SEG2'); flushed = JSON.stringify(c); fs.writeFileSync(path.join(dir, 'draft_content.json'), flushed); } });
  await assert.rejects(liveSync(sess, app, { mode: 'close' }), e => /nothing was written/.test(e.message) && e.conflict?.method === 'setProps');
  assert.equal(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8'), flushed, 'file untouched');
  assert.deepEqual(app.log, ['close', 'settle', 'open']);
  console.log('PASS 12 close-mode conflict reopens the project');
}

// ---- 13. close mode: user reopens the project mid-sync -> nothing written ----
{
  const dir = makeDraft(ROOT, 'p13');
  const sess = new JournaledSession('p13');
  sess.api.setProps('SEG1', { scale: 1.6 }); await tick();
  const orig = fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8');
  const app = fakeCloseApp(dir);
  app.waitForSettle = async () => { app.log.push('settle'); fs.writeFileSync(path.join(dir, '.locked'), ''); return { staleLock: false }; };
  await assert.rejects(liveSync(sess, app, { mode: 'close' }), /opened in CapCut during the sync/);
  assert.equal(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8'), orig);
  assert.equal(sess.pending, 1, 'journal kept');
  console.log('PASS 13 reopened-during-sync guard');
}

// ---- 14. mode validation + home-screen tile order ----
{
  makeDraft(ROOT, 'p14'); const sess = new JournaledSession('p14');
  sess.api.setProps('SEG1', { scale: 1.2 }); await tick();
  await assert.rejects(liveSync(sess, fakeApp(), { mode: 'bogus' }), /unknown sync mode/);
  const meta = { all_draft_store: [
    { draft_fold_path: '/p/old', tm_draft_modified: 1 },
    { draft_fold_path: '/p/hidden', tm_draft_modified: 9, draft_is_invisible: true },
    { draft_fold_path: '/p/trashed', tm_draft_modified: 8, tm_draft_removed: 5 },
    { draft_fold_path: '/p/new', tm_draft_modified: 3 },
    { draft_fold_path: '/p/mid', tm_draft_modified: 2 },
  ] };
  assert.equal(homeTileIndex(meta, '/p/new'), 0); assert.equal(homeTileIndex(meta, '/p/mid'), 1); assert.equal(homeTileIndex(meta, '/p/old'), 2);
  assert.equal(homeTileIndex(meta, '/p/hidden'), -1); assert.equal(homeTileIndex(meta, '/p/missing'), -1); assert.equal(homeTileIndex(null, '/p/new'), -1);
  console.log('PASS 14 mode validation + tile order');
}
// ---- 15. helper failures read as the permission to grant, never as a blank message ----
{
  assert.equal(describeHelperFailure({ ok: true, axTrusted: true, results: [] }), null);
  assert.match(describeHelperFailure(null), /no result/);
  const fail = (error, axTrusted = true) => describeHelperFailure({ ok: false, axTrusted, results: [], error });
  assert.match(fail({ step: 1, op: 'clickMenu', number: -1743, message: 'Not authorized' }), /step 2 \(clickMenu\).*Automation/);
  assert.match(fail({ step: 1, op: 'clickMenu', number: -25211, message: 'assistive access' }), /Accessibility/);
  assert.match(fail({ step: 0, op: 'mouseClick', message: 'x' }, false), /Accessibility/);
  assert.match(fail({ step: 1, op: 'clickMenu', number: -1728, message: "Can't get menu item" }), /failed at step 2 \(clickMenu\): Can't get menu item \(-1728\)/);
  assert.match(fail({ step: 0, op: 'delay', message: 'request expired' }, false), /request expired/);
  console.log('PASS 15 helper failure messages');
}
// ---- 16. CapCut renames the project folder while it closes -> sync follows it by draft id ----
// (CapCut defers a rename made in its UI -- draft_need_rename_folder -- and moves the folder when the project closes)
const withMeta = (dir, id) => { fs.writeFileSync(path.join(dir, 'draft_meta_info.json'), JSON.stringify({ draft_id: id, draft_name: path.basename(dir), draft_fold_path: dir, draft_need_rename_folder: true })); return dir; };
const capcutRename = (from, to) => { fs.renameSync(from, to); const m = path.join(to, 'draft_meta_info.json'), j = JSON.parse(fs.readFileSync(m, 'utf8')); Object.assign(j, { draft_name: path.basename(to), draft_fold_path: to, draft_need_rename_folder: false }); fs.writeFileSync(m, JSON.stringify(j)); };
{
  const dir = withMeta(makeDraft(ROOT, 'p16', 'nested'), 'ID-16');
  const to = path.join(ROOT, 'p16-renamed');
  const sess = new JournaledSession('p16');
  assert.equal(sess.draft.draftId, 'ID-16');
  sess.api.setProps('SEG1', { scale: 1.7 }); await tick();
  const app = fakeCloseApp(dir);
  app.closeProject = async () => { app.log.push('close'); fs.rmSync(path.join(dir, '.locked')); capcutRename(dir, to); }; // lock released, then the folder moves
  const opened = []; app.openProject = async (n, d) => { app.log.push('open'); opened.push([n, d]); fs.writeFileSync(path.join(d, '.locked'), ''); return { reopened: true }; };
  const settled = []; app.waitForSettle = async (...a) => { settled.push(a); return { staleLock: false }; };
  const r = await liveSync(sess, app, { mode: 'close' });
  assert.ok(r.synced && r.rebased, 'synced via a reload of the renamed folder');
  assert.deepEqual(r.renamed, { from: 'p16', to: 'p16-renamed' }); assert.equal(r.draft, 'p16-renamed'); assert.equal(sess.name, 'p16-renamed');
  assert.ok(!fs.existsSync(dir), 'old folder not recreated');
  const nested = path.join(to, 'Timelines', NESTED_ID, 'draft_info.json');
  assert.deepEqual(settled[1], [nested, to], 'waited on the new folder after the move');
  assert.equal(JSON.parse(fs.readFileSync(nested, 'utf8')).tracks[0].segments[0].clip.scale.x, 1.7, 'edit written to the renamed project');
  for (const p of [path.join(to, 'draft_info.json'), path.join(to, 'template-2.tmp')]) assert.equal(fs.readFileSync(p, 'utf8'), fs.readFileSync(nested, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(to, 'draft_meta_info.json'), 'utf8'));
  assert.equal(meta.draft_name, 'p16-renamed', "CapCut's rename not reverted by the stale meta");
  assert.equal(meta.draft_fold_path, to);
  assert.deepEqual(opened, [['p16-renamed', to]], 'reopened under the new name');
  assert.equal(r.via, 'close'); assert.ok(!r.fellBack);
  assert.equal(findDraftById('ID-16'), 'p16-renamed'); assert.equal(findDraftById('nope'), null); assert.equal(findDraftById(null), null);
  console.log('PASS 16 follows a rename by draft id:', r.steps.join(' | '));
}

// ---- 17. rename in quit mode, plus a user edit flushed into the renamed folder -> both kept ----
{
  const dir = withMeta(makeDraft(ROOT, 'p17'), 'ID-17');
  const to = path.join(ROOT, 'p17 (renamed)');
  const sess = new JournaledSession('p17');
  sess.api.setProps('SEG1', { opacity: 0.4 }); await tick();
  const app = fakeApp(() => { capcutRename(dir, to); const f = path.join(to, 'draft_content.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); segs(c).find(x => x.id === 'SEG2').clip.rotation = 12; fs.writeFileSync(f, JSON.stringify(c)); });
  const r = await liveSync(sess, app, {});
  assert.ok(r.synced); assert.equal(r.renamed.to, 'p17 (renamed)');
  const byId = Object.fromEntries(segs(read(to)).map(x => [x.id, x]));
  assert.equal(byId.SEG1.clip.alpha, 0.4); assert.equal(byId.SEG2.clip.rotation, 12);
  console.log('PASS 17 rename in quit mode keeps both edits');
}

// ---- 18. project folder deleted (no draft with that id) -> clear error, nothing written, journal kept ----
{
  const dir = withMeta(makeDraft(ROOT, 'p18'), 'ID-18');
  const sess = new JournaledSession('p18');
  sess.api.setProps('SEG1', { scale: 2 }); await tick();
  const app = fakeApp(() => fs.rmSync(dir, { recursive: true }));
  await assert.rejects(liveSync(sess, app, {}), /nothing was written.*"p18" is gone.*ID-18/);
  assert.ok(!fs.existsSync(dir), 'nothing recreated'); assert.equal(sess.pending, 1);
  assert.ok(app.log.includes('launch'), 'CapCut relaunched');
  console.log('PASS 18 deleted project');
}
console.log('\nALL LIVE-SYNC TESTS PASSED');
