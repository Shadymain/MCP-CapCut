// Project-local media: CapCut is sandboxed, so every file the server adds must live inside the project folder.
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { makeDraft } from './make-draft.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-media-test-'));
process.env.CAPCUT_DRAFTS_DIR = ROOT; // must be set before core.js loads
delete process.env.CAPCUT_SYNC_MODE;
const { CapCutDraft } = await import('../src/core.js');
const { JournaledSession, liveSync } = await import('../src/live.js');
const tick = () => new Promise(r => setTimeout(r, 0));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-media-outside-')); // stands in for ~/Desktop, Figma exports, ...
const write = (dir, name, data) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, name); fs.writeFileSync(p, data); return p; };
const matOf = (d, segId) => { const s = d.content.tracks.flatMap(t => t.segments).find(x => x.id === segId); return d.content.materials.videos.find(m => m.id === s.material_id) || d.content.materials.audios.find(m => m.id === s.material_id); };
const withMeta = (dir, id) => { fs.writeFileSync(path.join(dir, 'draft_meta_info.json'), JSON.stringify({ draft_id: id, draft_name: path.basename(dir), draft_fold_path: dir })); return dir; };

// ---- 1. added files are copied into <project>/mcp_media, reused when identical, renamed when a different file has the name ----
{
  const dir = makeDraft(ROOT, 'm1');
  const d = new CapCutDraft('m1');
  const src = write(OUTSIDE, 'figma-export.png', 'PNG-A');
  const a = d.addImage(src, { atUs: 8e6, durUs: 2e6 });
  const ma = matOf(d, a.segmentId);
  assert.equal(ma.path, path.join(dir, 'mcp_media', 'figma-export.png'), 'image copied into the project');
  assert.equal(fs.readFileSync(ma.path, 'utf8'), 'PNG-A'); assert.equal(fs.readFileSync(src, 'utf8'), 'PNG-A', 'original untouched');
  const b = d.addImage(src, { atUs: 10e6, durUs: 2e6 });
  assert.equal(matOf(d, b.segmentId).path, ma.path, 'same file reused, not copied twice');
  const other = write(path.join(OUTSIDE, 'v2'), 'figma-export.png', 'PNG-B');
  const c = d.addImage(other, { atUs: 12e6, durUs: 2e6 });
  const mc = matOf(d, c.segmentId);
  assert.match(path.basename(mc.path), /^figma-export_[0-9a-f]{8}\.png$/, 'name clash with different content gets a hash suffix');
  assert.equal(fs.readFileSync(mc.path, 'utf8'), 'PNG-B'); assert.equal(fs.readFileSync(ma.path, 'utf8'), 'PNG-A', 'first copy not overwritten');
  const au = d.addAudio(write(OUTSIDE, 'music.m4a', 'AUDIO'), { atUs: 0, durUs: 1e6 });
  assert.equal(matOf(d, au.segmentId).path, path.join(dir, 'mcp_media', 'music.m4a'), 'audio copied too');
  const inside = write(path.join(dir, 'mcp_media'), 'already-here.png', 'IN');
  assert.equal(matOf(d, d.addImage(inside, { atUs: 14e6, durUs: 1e6 }).segmentId).path, inside, 'file already inside the project used as is');
  assert.ok(!fs.readdirSync(path.join(dir, 'mcp_media')).some(f => f.endsWith('.part')), 'no partial copies left');
  console.log('PASS 1 media copied into the project');
}

// ---- 2. localizeMedia repoints existing outside media (all, or just some segments), skips missing files ----
{
  const dir = makeDraft(ROOT, 'm2'); // its clip.mp4 lives OUTSIDE the project, like a file added before this fix
  const d = new CapCutDraft('m2');
  const outside = d.content.materials.videos[0].path;
  assert.ok(!outside.startsWith(dir));
  assert.throws(() => d.localizeMedia(['NOPE']), /segment not found/);
  const r = d.localizeMedia(['SEG1']);
  assert.deepEqual(r.moved, [{ from: outside, to: path.join(dir, 'mcp_media', 'clip.mp4') }]);
  assert.equal(d.content.materials.videos[0].path, path.join(dir, 'mcp_media', 'clip.mp4'));
  assert.ok(fs.existsSync(outside), 'original left in place');
  assert.deepEqual(d.localizeMedia().moved, [], 'nothing left outside -> nothing to do');
  d.content.materials.videos.push({ id: 'GONE', type: 'video', path: path.join(OUTSIDE, 'deleted.mp4') });
  assert.deepEqual(d.localizeMedia().skipped, [{ path: path.join(OUTSIDE, 'deleted.mp4'), reason: 'file not found' }]);
  console.log('PASS 2 localizeMedia');
}

// ---- 3. CapCut renames the project folder: paths into the old mcp_media are repaired on load ----
{
  const dir = withMeta(makeDraft(ROOT, 'm3'), 'ID-M3');
  const d = new CapCutDraft('m3');
  const r = d.addImage(write(OUTSIDE, 'logo.png', 'LOGO'), { atUs: 8e6, durUs: 1e6 });
  d.save({ trusted: true });
  const to = path.join(ROOT, 'm3 renamed'); fs.renameSync(dir, to);
  const d2 = new CapCutDraft('m3 renamed');
  assert.equal(matOf(d2, r.segmentId).path, path.join(to, 'mcp_media', 'logo.png'), 'repointed into the renamed folder');
  assert.ok(!d2.content.materials.videos[0].path.startsWith(to), 'media outside any project left alone');
  const v = d2.validate(); assert.ok(v.ok, v.issues.join('; '));
  console.log('PASS 3 paths repaired after a rename');
}

// ---- 4. live sync where CapCut renames mid-sync: replayed adds land in the NEW folder ----
{
  const dir = withMeta(makeDraft(ROOT, 'm4'), 'ID-M4');
  const to = path.join(ROOT, 'm4-renamed');
  const sess = new JournaledSession('m4');
  const r = sess.api.addImage(write(OUTSIDE, 'still.png', 'STILL'), { atUs: 8e6, durUs: 1e6 }); await tick();
  const l = sess.api.addLine({ color: '#ffffff', lengthPx: 100, atUs: 0 }); await tick();
  let running = true;
  const app = { log: [], isRunning: () => running, async quit() { fs.renameSync(dir, to); running = false; },
    async waitForSettle() { return { staleLock: false }; }, async launch() { running = true; }, async reopenProject() { return { reopened: false }; } };
  const res = await liveSync(sess, app, {});
  assert.ok(res.synced); assert.equal(res.renamed.to, 'm4-renamed');
  const c = JSON.parse(fs.readFileSync(path.join(to, 'draft_content.json'), 'utf8'));
  const pathOf = id => { const s = c.tracks.flatMap(t => t.segments).find(x => x.id === id); return c.materials.videos.find(m => m.id === s.material_id).path; };
  assert.equal(pathOf(r.segmentId), path.join(to, 'mcp_media', 'still.png'));
  assert.ok(pathOf(l.segmentId).startsWith(path.join(to, 'mcp_media') + path.sep), 'generated line in the new folder');
  assert.ok(fs.existsSync(pathOf(r.segmentId)) && fs.existsSync(pathOf(l.segmentId)));
  console.log('PASS 4 media follows a mid-sync rename');
}
console.log('\nALL MEDIA TESTS PASSED');
