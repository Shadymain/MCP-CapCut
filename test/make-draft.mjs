import fs from 'fs'; import path from 'path';
export function makeDraft(root, name) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const media = path.join(root, 'clip.mp4'); fs.writeFileSync(media, 'x');
  const seg = (id, mat, sp, start, ri) => ({ id, material_id: mat, extra_material_refs: [sp], render_index: ri, track_render_index: 0,
    target_timerange: { start, duration: 4e6 }, source_timerange: { start: 0, duration: 4e6 }, speed: 1, volume: 1, visible: true,
    clip: { alpha: 1, flip: { horizontal: false, vertical: false }, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } } });
  const content = {
    duration: 8e6, fps: 30, canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    materials: { videos: [{ id: 'MAT1', type: 'video', path: media, material_name: 'clip.mp4' }],
                 speeds: [{ id: 'SP1', type: 'speed', speed: 1 }, { id: 'SP2', type: 'speed', speed: 1 }] },
    tracks: [{ id: 'TRK1', type: 'video', name: 'main', attribute: 0, segments: [seg('SEG1', 'MAT1', 'SP1', 0, 0), seg('SEG2', 'MAT1', 'SP2', 4e6, 1)] }],
  };
  fs.writeFileSync(path.join(dir, 'draft_content.json'), JSON.stringify(content));
  return dir;
}
