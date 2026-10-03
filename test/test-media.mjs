// Project-local media: CapCut is sandboxed, so every file the server adds must live inside the project folder.
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { makeDraft } from './make-draft.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-media-test-'));
process.env.CAPCUT_DRAFTS_DIR = ROOT; // must be set before core.js loads
delete process.env.CAPCUT_SYNC_MODE;
process.env.CAPCUT_EFFECT_CACHE = path.join(ROOT, '.effect-cache');
const { CapCutDraft, resolveMediaPath, isPlaceholderPath, cloneDraft, findDraftById } = await import('../src/core.js');
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
// ---- 5. CapCut's "##_draftpath_placeholder_<id>_##/..." paths are files inside the project ----
// (CapCut rewrites our absolute mcp_media paths to this form once it has the project open)
{
  const dir = withMeta(makeDraft(ROOT, 'm5'), 'ID-M5');
  const PH = '##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##';
  assert.equal(resolveMediaPath(`${PH}/mcp_media/line.png`, dir), path.join(dir, 'mcp_media', 'line.png'));
  assert.equal(resolveMediaPath('/abs/file.png', dir), '/abs/file.png', 'normal paths unchanged');
  assert.ok(!isPlaceholderPath('##_draftpath_placeholder_x_##evil') && !isPlaceholderPath(null), 'prefix must end at a path boundary');
  write(path.join(dir, 'mcp_media'), 'line.png', 'LINE');
  const f = path.join(dir, 'draft_content.json'), c = JSON.parse(fs.readFileSync(f, 'utf8'));
  c.materials.videos.push({ id: 'PHMAT', type: 'photo', path: `${PH}/mcp_media/line.png`, material_name: 'line.png' });
  c.materials.audios = [{ id: 'PHAUD', type: 'extract_music', path: `${PH}/mcp_media/gone.m4a` }];
  fs.writeFileSync(f, JSON.stringify(c));
  const d = new CapCutDraft('m5');
  let v = d.validate();
  assert.deepEqual(v.issues, [`missing media file: ${PH}/mcp_media/gone.m4a`], 'existing placeholder file passes, missing one is still caught');
  d.content.materials.audios = [];
  v = d.validate(); assert.ok(v.ok, v.issues.join('; '));
  const before = d.content.materials.videos.find(m => m.id === 'PHMAT').path;
  const r = d.localizeMedia();
  assert.ok(!r.moved.some(x => x.from === before), 'localize leaves placeholder paths alone (already inside)');
  assert.equal(d.content.materials.videos.find(m => m.id === 'PHMAT').path, before);
  // rename: the placeholder stands for the project folder, so it keeps working untouched
  d.save({ trusted: true });
  const to = path.join(ROOT, 'm5 renamed'); fs.renameSync(path.join(ROOT, 'm5'), to);
  const d2 = new CapCutDraft('m5 renamed');
  assert.equal(d2.content.materials.videos.find(m => m.id === 'PHMAT').path, before, 'rename repair leaves it as is');
  v = d2.validate(); assert.ok(v.ok, v.issues.join('; '));
  console.log('PASS 5 placeholder paths');
}
// ---- 6. masks are written as the full record CapCut writes, pointing at the downloaded effect ----
// (CapCut silently drops a mask record without these fields the next time it saves the project)
{
  makeDraft(ROOT, 'm6');
  const REAL_KEYS = ['id', 'type', 'category', 'category_name', 'category_id', 'panel', 'is_old_version', 'resource_id', 'constant_material_id', 'name', 'resource_type', 'path', 'position_info', 'config', 'text_config', 'platform', 'loader_work_space', 'track_segment', 'contour_path', 'source_platform']; // from a Rectangle mask made in CapCut 9.x
  const REAL_CONFIG = ['width', 'height', 'centerX', 'centerY', 'rotation', 'feather', 'expansion', 'roundCorner', 'invert', 'aspectRatio'];
  const d = new CapCutDraft('m6');
  const miss = d.addMask('SEG1', 'Rectangle', { width: 1, height: 0.3, centerY: 0.2 });
  assert.match(miss.warning, /isn't in CapCut's effect cache/, 'warns when the effect was never downloaded');
  const effect = path.join(process.env.CAPCUT_EFFECT_CACHE, '794455095', '02b8999168d121538a98ea59127483ef'); fs.mkdirSync(effect, { recursive: true });
  const r = d.addMask('SEG1', 'Rectangle', { width: 1, height: 0.3, centerY: 0.2, feather: 0.05 });
  assert.ok(!r.warning);
  const s1 = d.content.tracks[0].segments[0];
  const masks = d.content.materials.common_mask.filter(m => s1.extra_material_refs.includes(m.id));
  assert.equal(masks.length, 1, 'replaces the earlier mask on the segment');
  const m = masks[0];
  assert.deepEqual(Object.keys(m).sort(), [...REAL_KEYS].sort(), 'same fields as a CapCut-made mask');
  assert.deepEqual(Object.keys(m.config).sort(), [...REAL_CONFIG].sort());
  assert.equal(m.path, effect); assert.equal(m.resource_id, '7374021450748924432'); assert.equal(m.category, 'video');
  assert.deepEqual([m.config.width, m.config.height, m.config.centerY, m.config.feather], [1, 0.3, 0.2, 0.05]);
  assert.notEqual(m.constant_material_id, m.id);
  console.log('PASS 6 full mask record');
}
// ---- 7. a cloned project gets its own identity, not a copy of the base's ----
{
  const base = withMeta(makeDraft(ROOT, 'm7-base'), 'ID-M7');
  cloneDraft('m7-base', 'm7-copy');
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'm7-copy', 'draft_meta_info.json'), 'utf8'));
  assert.notEqual(meta.draft_id, 'ID-M7', 'new draft_id');
  assert.equal(meta.draft_name, 'm7-copy'); assert.equal(meta.draft_fold_path, path.join(ROOT, 'm7-copy'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'draft_meta_info.json'), 'utf8')).draft_id, 'ID-M7', 'base untouched');
  assert.equal(findDraftById('ID-M7'), 'm7-base'); assert.equal(findDraftById(meta.draft_id), 'm7-copy');
  console.log('PASS 7 clone gets its own identity');
}
// ---- 8. speed: CapCut plays source = timeline x speed (6s on the timeline at 1.5x uses 9s of footage) ----
{
  makeDraft(ROOT, 'm8');
  const d = new CapCutDraft('m8');
  const src = write(OUTSIDE, 'cursor-hero.mp4', 'V');
  const r = d.addVideo(src, { atUs: 8e6, durUs: 6e6, srcStartUs: 1e6, speed: 1.5 });
  const seg = () => d.content.tracks.flatMap(t => t.segments).find(x => x.id === r.segmentId);
  let s = seg();
  assert.equal(s.speed, 1.5); assert.deepEqual(s.target_timerange, { start: 8e6, duration: 6e6 });
  assert.deepEqual(s.source_timerange, { start: 1e6, duration: 9e6 }, 'source span = 6s x 1.5');
  const sp = d.content.materials.speeds.find(m => s.extra_material_refs.includes(m.id));
  assert.equal(sp.speed, 1.5, 'speed material matches');
  assert.ok(!d.validate().warnings.some(w => w.includes(r.segmentId)));
  // trim keeps the ratio
  d.trimSegment(r.segmentId, { durUs: 4e6 }); s = seg();
  assert.equal(s.source_timerange.duration, 6e6, 'trim to 4s at 1.5x uses 6s of footage');
  // split keeps the ratio on both halves and the footage contiguous
  const { right } = d.splitSegment(r.segmentId, 10e6);
  const L = seg(), R = d.content.tracks.flatMap(t => t.segments).find(x => x.id === right);
  assert.deepEqual([L.target_timerange.duration, L.source_timerange], [2e6, { start: 1e6, duration: 3e6 }]);
  assert.deepEqual([R.target_timerange, R.source_timerange], [{ start: 10e6, duration: 2e6 }, { start: 4e6, duration: 3e6 }]);
  // changing speed afterwards keeps the footage and changes the timeline length
  d.setProps(right, { speed: 1 });
  assert.deepEqual([R.target_timerange.duration, R.source_timerange.duration], [3e6, 3e6]);
  assert.throws(() => d.setProps(right, { speed: 0 }), /speed must be > 0/);
  // a mismatched segment (e.g. written by an older version) is flagged
  R.source_timerange.duration = 1e6;
  assert.ok(d.validate().warnings.some(w => w.includes(right) && /source span/.test(w)));
  console.log('PASS 8 speed-aware source spans');
}
console.log('\nALL MEDIA TESTS PASSED');
