// Text style cloning, letter spacing and solid-colour lines. Uses a temp drafts dir; never touches real drafts.
import fs from 'fs'; import os from 'os'; import path from 'path'; import assert from 'assert';
import { makeDraft } from './make-draft.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'capcut-text-test-'));
process.env.CAPCUT_DRAFTS_DIR = ROOT; // must be set before core.js loads
process.env.CAPCUT_ASSETS_DIR = path.join(ROOT, 'assets');
delete process.env.CAPCUT_SYNC_MODE;
const { CapCutDraft, solidPng } = await import('../src/core.js');
const { JournaledSession, liveSync } = await import('../src/live.js');
const tick = () => new Promise(r => setTimeout(r, 0));
const segs = c => c.tracks.flatMap(t => t.segments);

// a 16:9 draft with a styled text layer: custom font, stroke, two style runs, a text animation and a keyframe
function makeTextDraft(name) {
  const dir = makeDraft(ROOT, name);
  const file = path.join(dir, 'draft_content.json'), c = JSON.parse(fs.readFileSync(file, 'utf8'));
  c.canvas_config = { width: 1920, height: 1080, ratio: '16:9' };
  const font = { id: 'F1', path: '/fonts/Serif-Bold.ttf' };
  c.materials.texts = [{ id: 'TXTMAT', type: 'text', font_path: font.path, border_color: '#000000', border_width: 0.1, letter_spacing: 0, text_color: '#FFFFFF', font_size: 15,
    content: JSON.stringify({ text: 'Hello world', styles: [
      { range: [0, 5], size: 15, font, strokes: [{ width: 0.1 }], fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: [1, 1, 1] } } } },
      { range: [5, 11], size: 15, font, fill: { alpha: 1, content: { render_type: 'solid', solid: { alpha: 1, color: [1, 0, 0] } } } }] }) }];
  c.materials.material_animations = [{ id: 'ANIM1', type: 'sticker_animation' }];
  c.materials.speeds.push({ id: 'SP3', type: 'speed', speed: 1 });
  c.tracks.push({ id: 'TRK2', type: 'text', name: '', attribute: 0, segments: [{ id: 'TXT1', material_id: 'TXTMAT', extra_material_refs: ['SP3', 'ANIM1'], render_index: 14000, track_render_index: 1,
    target_timerange: { start: 0, duration: 3e6 }, source_timerange: { start: 0, duration: 3e6 }, visible: true,
    common_keyframes: [{ property_type: 'KFTypeAlpha', keyframe_list: [{ time_offset: 0, values: [0] }] }],
    clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1.3, y: 1.3 }, transform: { x: 0, y: 0 } } }] });
  fs.writeFileSync(file, JSON.stringify(c));
  return dir;
}
const textOf = (d, segId) => { const s = segs(d.content).find(x => x.id === segId); const m = d.content.materials.texts.find(t => t.id === s.material_id); return { s, m, content: JSON.parse(m.content) }; };

// ---- 1. styleFrom clones that layer: font/stroke kept, only words/colour/size/position/spacing change ----
{
  makeTextDraft('t1');
  const d = new CapCutDraft('t1');
  const r = d.addText('AFTERGLOW', { styleFrom: 'TXT1', color: '#e8a33d', fontSize: 40, letterSpacing: 0.2, posY: -0.2, atUs: 0, trackIndex: d.addTrack('text', 'title') });
  const { s, m, content } = textOf(d, r.segmentId);
  assert.equal(content.text, 'AFTERGLOW');
  assert.equal(content.styles.length, 1, 'one style run over the new text');
  assert.deepEqual(content.styles[0].range, [0, 9]);
  assert.deepEqual(content.styles[0].font, { id: 'F1', path: '/fonts/Serif-Bold.ttf' }, 'font kept');
  assert.deepEqual(content.styles[0].strokes, [{ width: 0.1 }], 'stroke kept');
  assert.equal(content.styles[0].size, 40);
  assert.deepEqual(content.styles[0].fill.content.solid.color.map(v => Math.round(v * 255)), [0xe8, 0xa3, 0x3d]);
  assert.equal(content.styles[0].fill.content.render_type, 'solid');
  assert.equal(m.font_path, '/fonts/Serif-Bold.ttf'); assert.equal(m.border_width, 0.1, 'material-level style kept');
  assert.equal(m.text_color, '#E8A33D'); assert.equal(m.font_size, 40); assert.equal(m.letter_spacing, 0.2);
  assert.notEqual(m.id, 'TXTMAT'); assert.notEqual(s.id, 'TXT1');
  assert.equal(s.clip.scale.x, 1.3, 'source transform kept'); assert.equal(s.clip.transform.y, -0.2, 'position applied');
  assert.equal(s.target_timerange.duration, 3e6, "defaults to the source layer's duration");
  assert.ok(!s.common_keyframes, 'source animation keyframes not copied');
  const refKinds = s.extra_material_refs.map(id => Object.keys(d.content.materials).find(k => d.content.materials[k].some?.(x => x.id === id)));
  assert.deepEqual(refKinds, ['speeds'], 'boilerplate refs cloned, text animation not');
  assert.ok(!s.extra_material_refs.includes('SP3'), 'refs are fresh copies');
  const src = textOf(d, 'TXT1');
  assert.equal(src.content.text, 'Hello world'); assert.equal(src.content.styles.length, 2, 'source layer untouched');
  assert.equal(src.m.letter_spacing, 0);
  const v = d.validate(); assert.ok(v.ok, v.issues.join('; '));
  console.log('PASS 1 styleFrom clone');
}

// ---- 2. bad styleFrom / empty text fail cleanly; letterSpacing works without styleFrom ----
{
  makeTextDraft('t2');
  const d = new CapCutDraft('t2');
  assert.throws(() => d.addText('x', { styleFrom: 'NOPE' }), /segment not found/);
  assert.throws(() => d.addText('x', { styleFrom: 'SEG1' }), /not a text layer/);
  assert.throws(() => d.addText('', { styleFrom: 'TXT1' }), /must not be empty/);
  const r = d.addText('wide', { letterSpacing: 0.3, atUs: 3e6 }); // harvested template path (this draft's own text layer)
  assert.equal(textOf(d, r.segmentId).m.letter_spacing, 0.3);
  console.log('PASS 2 styleFrom errors + letterSpacing');
}

// ---- 3. solidPng is a valid PNG of the right size and colour ----
{
  const buf = solidPng('#E8A33D', 7, 3);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
  assert.equal(buf.readUInt32BE(16), 7); assert.equal(buf.readUInt32BE(20), 3);
  const idatLen = buf.readUInt32BE(33);
  const raw = (await import('zlib')).inflateSync(buf.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 3 * (1 + 7 * 4));
  assert.deepEqual([...raw.subarray(1, 5)], [0xe8, 0xa3, 0x3d, 255]);
  assert.throws(() => solidPng('orange', 2, 2), /invalid colour/);
  assert.throws(() => solidPng('#ffffff', 0, 2), /invalid line size/);
  console.log('PASS 3 solid PNG');
}

// ---- 4. addLine: own "lines" track, exact pixel size via scale, reused track for the next line ----
{
  makeTextDraft('t4');
  const d = new CapCutDraft('t4');
  const a = d.addLine({ color: '#e8a33d', lengthPx: 480, thicknessPx: 2, posY: 0.1, atUs: 0 });
  assert.ok(fs.existsSync(a.file) && a.file.startsWith(process.env.CAPCUT_ASSETS_DIR));
  const tr = d.content.tracks.find(t => t.name === 'lines');
  assert.ok(tr && tr.type === 'video'); assert.equal(tr.segments.length, 1);
  assert.equal(d.content.tracks[0].segments.length, 2, 'main clip track untouched');
  const s = tr.segments[0], m = d.content.materials.videos.find(x => x.id === s.material_id);
  assert.equal(m.type, 'photo'); assert.equal(m.width, 480); assert.equal(m.height, 2);
  assert.equal(s.clip.scale.x, 0.25, '480px on a 1920-wide canvas'); assert.equal(s.clip.transform.y, 0.1);
  assert.equal(s.target_timerange.duration, 5e6);
  const b = d.addLine({ color: '#e8a33d', lengthPx: 300, thicknessPx: 2, vertical: true, atUs: 5e6 });
  assert.equal(tr.segments.length, 2, 'second line reuses the lines track');
  const sb = tr.segments[1];
  assert.equal(sb.clip.scale.x, +(300 / 1080).toFixed(6), 'vertical line fits by height');
  assert.equal(b.widthPx, 2); assert.equal(b.heightPx, 300);
  const v = d.validate(); assert.ok(v.ok, v.issues.join('; '));
  console.log('PASS 4 addLine');
}

// ---- 5. both survive a live-sync rebase with the same ids (journal replay) ----
{
  const dir = makeTextDraft('t5');
  const sess = new JournaledSession('t5'); const api = sess.api;
  const t = api.addText('A SHORT FILM', { styleFrom: 'TXT1', letterSpacing: 0.25, atUs: 3e6 }); await tick();
  const l = api.addLine({ color: '#ffffff', lengthPx: 200, atUs: 0 }); await tick();
  await new Promise(r => setTimeout(r, 20));
  let running = true;
  const app = { log: [], isRunning: () => running, async quit() { // user nudges the source layer while CapCut flushes
      const f = path.join(dir, 'draft_content.json'), c = JSON.parse(fs.readFileSync(f, 'utf8')); segs(c).find(s => s.id === 'TXT1').clip.rotation = 5; fs.writeFileSync(f, JSON.stringify(c)); running = false; },
    async waitForSettle() { return { staleLock: false }; }, async launch() { running = true; }, async reopenProject() { return { reopened: false }; } };
  const r = await liveSync(sess, app, {});
  assert.ok(r.synced && r.rebased);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'draft_content.json'), 'utf8')), byId = Object.fromEntries(segs(c).map(s => [s.id, s]));
  assert.ok(byId[t.segmentId] && byId[l.segmentId], 'same ids after replay');
  assert.equal(byId.TXT1.clip.rotation, 5, "user's edit kept");
  assert.equal(c.materials.texts.find(m => m.id === byId[t.segmentId].material_id).letter_spacing, 0.25);
  console.log('PASS 5 live-sync replay');
}
console.log('\nALL TEXT/LINE TESTS PASSED');
