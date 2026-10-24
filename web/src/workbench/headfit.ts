// Automatic head fit: tune interpretable head/hair "knobs" (cranium proportions, jaw, chin,
// cheekbones, nose, forehead, neck, hair volume/lengths) until the character's front and side
// silhouettes match reference images. Runs in the workbench (needs WebGL for silhouettes)
// and yields between evaluations so progress is visible live.
import * as THREE from 'three';
import type { CharacterDef } from '../character/builder';
import { buildCharacter } from '../character/builder';
import type { SkeletonDef, VolumeDef } from '../anim/skeleton';
import type { RefView } from './reference';

export interface Knob { name: string; label: string; min: number; max: number; step: number; apply: (d: CharacterDef, v: number) => void; }

const vol = (d: CharacterDef, name: string) => (d.volumes ?? []).filter(v => v.name === name || v.name === `${name} L` || v.name === `${name} R`);
const each = (d: CharacterDef, name: string, f: (v: VolumeDef) => void) => vol(d, name).forEach(f);
const headVols = (d: CharacterDef) => (d.volumes ?? []).filter(v => v.bone === 'head');

/** Knobs act on named volumes (see ranger.json). Values are offsets from the current design (0 = unchanged). */
export const HEAD_KNOBS: Knob[] = [
  { name: 'headScale', label: 'head size', min: -0.15, max: 0.15, step: 0.04, apply: (d, v) => headVols(d).forEach(h => { for (const p of [h.a, h.b]) for (let i = 0; i < 3; i++) p[i] *= 1 + v; h.r0 *= 1 + v; h.r1 *= 1 + v; }) },
  { name: 'craniumW', label: 'skull width', min: -0.25, max: 0.25, step: 0.06, apply: (d, v) => each(d, 'cranium', h => { h.scale = [(h.scale?.[0] ?? 1) * (1 + v), h.scale?.[1] ?? 1, h.scale?.[2] ?? 1]; }) },
  { name: 'craniumH', label: 'skull height', min: -0.25, max: 0.25, step: 0.06, apply: (d, v) => each(d, 'cranium', h => { h.scale = [h.scale?.[0] ?? 1, (h.scale?.[1] ?? 1) * (1 + v), h.scale?.[2] ?? 1]; }) },
  { name: 'craniumD', label: 'skull depth', min: -0.25, max: 0.25, step: 0.06, apply: (d, v) => each(d, 'cranium', h => { h.scale = [h.scale?.[0] ?? 1, h.scale?.[1] ?? 1, (h.scale?.[2] ?? 1) * (1 + v)]; }) },
  { name: 'jawWidth', label: 'jaw width', min: -0.35, max: 0.35, step: 0.08, apply: (d, v) => { each(d, 'jaw', h => { h.a[0] *= 1 + v; h.b[0] *= 1 + v * 0.6; }); each(d, 'chin', h => { h.scale = [(h.scale?.[0] ?? 1) * (1 + v), h.scale?.[1] ?? 1, h.scale?.[2] ?? 1]; }); } },
  { name: 'chinDrop', label: 'chin height', min: -0.025, max: 0.025, step: 0.006, apply: (d, v) => { each(d, 'chin', h => { h.a[1] -= v; h.b[1] -= v; }); each(d, 'jaw', h => { h.b[1] -= v; }); each(d, 'mouth', h => { h.a[1] -= v * 0.5; h.b[1] -= v * 0.5; }); } },
  { name: 'chinForward', label: 'chin projection', min: -0.02, max: 0.02, step: 0.005, apply: (d, v) => { each(d, 'chin', h => { h.a[2] -= v; h.b[2] -= v; }); each(d, 'jaw', h => { h.b[2] -= v; }); } },
  { name: 'jawThick', label: 'jaw fullness', min: -0.35, max: 0.35, step: 0.08, apply: (d, v) => each(d, 'jaw', h => { h.r0 *= 1 + v; h.r1 *= 1 + v; }) },
  { name: 'cheeks', label: 'cheekbones', min: -0.4, max: 0.4, step: 0.1, apply: (d, v) => each(d, 'cheekbone', h => { h.r0 *= 1 + v; h.r1 *= 1 + v; h.a[0] *= 1 + v * 0.3; h.b[0] *= 1 + v * 0.3; }) },
  { name: 'noseLen', label: 'nose projection', min: -0.012, max: 0.015, step: 0.004, apply: (d, v) => { each(d, 'nose', h => { h.b[2] -= v; }); each(d, 'nostrils', h => { h.a[2] -= v * 0.6; h.b[2] -= v * 0.6; }); } },
  { name: 'noseY', label: 'nose height', min: -0.015, max: 0.015, step: 0.004, apply: (d, v) => { each(d, 'nose', h => { h.b[1] += v; }); each(d, 'nostrils', h => { h.a[1] += v; h.b[1] += v; }); } },
  { name: 'forehead', label: 'forehead slope', min: -0.02, max: 0.02, step: 0.005, apply: (d, v) => each(d, 'forehead', h => { h.a[2] += v; }) },
  { name: 'neck', label: 'neck width', min: -0.3, max: 0.4, step: 0.08, apply: (d, v) => { d.radiusScale = { ...(d.radiusScale ?? {}), neck: (d.radiusScale?.neck ?? 1) * (1 + v) }; } },
  { name: 'hairVolume', label: 'hair volume', min: -0.01, max: 0.03, step: 0.005, apply: (d, v) => { if (d.hair?.style) d.hair.style.volume = Math.max(0.002, (d.hair.style.volume ?? 0.012) + v); } },
  { name: 'bangs', label: 'bangs length', min: -0.06, max: 0.08, step: 0.02, apply: (d, v) => { if (d.hair?.style) d.hair.style.bangs = Math.max(0.02, d.hair.style.bangs + v); } },
  { name: 'sides', label: 'side length', min: -0.12, max: 0.2, step: 0.04, apply: (d, v) => { if (d.hair?.style) d.hair.style.sides = Math.max(0.04, d.hair.style.sides + v); } },
  { name: 'back', label: 'back length', min: -0.15, max: 0.3, step: 0.05, apply: (d, v) => { if (d.hair?.style) d.hair.style.back = Math.max(0.05, d.hair.style.back + v); } },
  { name: 'hairline', label: 'hairline height', min: -15, max: 20, step: 5, apply: (d, v) => { if (d.hair?.style) d.hair.style.hairlineFront = (d.hair.style.hairlineFront ?? 28) + v; } },
];

export function applyKnobs(base: CharacterDef, values: Record<string, number>): CharacterDef {
  const d = JSON.parse(JSON.stringify(base)) as CharacterDef;
  for (const k of HEAD_KNOBS) { const v = values[k.name]; if (v) k.apply(d, v); }
  return d;
}

/** Fast preview build: head, neck and upper torso only, coarse voxels, no armor, rigid hair. */
export function buildHeadPreview(def: CharacterDef, sk: SkeletonDef) {
  const keep = new Set(['head', 'neck', 'chest', 'spine', 'shoulderL', 'shoulderR']);
  const d: CharacterDef = {
    ...def, armor: [], voxel: 0.014,
    replaceVolumes: [...new Set([...(def.replaceVolumes ?? []), ...sk.bones.map(b => b.name).filter(n => !keep.has(n))])],
    volumes: (def.volumes ?? []).filter(v => keep.has(v.bone)),
    hair: def.hair ? { ...def.hair, spring: false } : undefined,
  };
  return buildCharacter(d, sk, {}).mesh;
}

// ---------------------------------------------------------------- mask normalisation

/**
 * Normalise a silhouette so references with arbitrary crop and scale are comparable:
 * top of the mask at a fixed row, the widest span in the upper part (skull + hair) scaled
 * to a fixed width, centred. Proportions (not absolute size) are what get fitted.
 */
export function normalizeMask(m: Uint8Array, N: number): Uint8Array {
  let top = -1;
  for (let y = 0; y < N && top < 0; y++) for (let x = 0; x < N; x++) if (m[y * N + x]) { top = y; break; }
  if (top < 0) return m;
  const span = (y: number) => { let a = -1, b = -1; for (let x = 0; x < N; x++) if (m[y * N + x]) { if (a < 0) a = x; b = x; } return a < 0 ? null : [a, b]; };
  let wMax = 1, cx = N / 2;
  const lim = Math.min(N, top + Math.round(N * 0.45));
  for (let y = top; y < lim; y++) { const s = span(y); if (s && s[1] - s[0] > wMax) { wMax = s[1] - s[0]; cx = (s[0] + s[1]) / 2; } }
  const scale = (N * 0.42) / wMax, out = new Uint8Array(N * N), top0 = Math.round(N * 0.06);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const sx = Math.round(cx + (x - N / 2) / scale), sy = Math.round(top + (y - top0) / scale);
    if (sx >= 0 && sx < N && sy >= 0 && sy < N) out[y * N + x] = m[sy * N + sx];
  }
  return out;
}

export function iou(a: Uint8Array, b: Uint8Array) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { const x = a[k] > 0, y = b[k] > 0; if (x && y) i++; if (x || y) u++; }
  return u ? i / u : 0;
}

/** Mask → PNG data URL (white on dark), e.g. to turn a rendered silhouette into a reference image. */
export function maskToDataURL(m: Uint8Array, N: number) {
  const c = document.createElement('canvas'); c.width = c.height = N;
  const ctx = c.getContext('2d')!, img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) { const v = m[i] ? 235 : 18; img.data.set([v, v, v, 255], i * 4); }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

// ---------------------------------------------------------------- fitter

export interface FitProgress { evals: number; score: number; start: number; values: Record<string, number>; last: string; perView: Record<string, number>; done: boolean; }

export async function fitHead(opts: {
  base: CharacterDef; sk: SkeletonDef; refs: Partial<Record<RefView, Uint8Array>>; N: number;
  render: (obj: THREE.Object3D, view: RefView) => Uint8Array;
  onProgress: (p: FitProgress, preview: THREE.Object3D) => void | Promise<void>;
  shouldStop: () => boolean; rounds?: number; knobs?: string[];
}): Promise<FitProgress> {
  const views = (Object.keys(opts.refs) as RefView[]).filter(v => opts.refs[v]);
  const refN = Object.fromEntries(views.map(v => [v, normalizeMask(opts.refs[v]!, opts.N)])) as Record<RefView, Uint8Array>;
  const knobs = HEAD_KNOBS.filter(k => !opts.knobs || opts.knobs.includes(k.name));
  let evals = 0;
  const evaluate = (values: Record<string, number>) => {
    evals++;
    const mesh = buildHeadPreview(applyKnobs(opts.base, values), opts.sk);
    const perView: Record<string, number> = {};
    for (const v of views) perView[v] = +iou(normalizeMask(opts.render(mesh, v), opts.N), refN[v]).toFixed(4);
    const score = views.reduce((s, v) => s + perView[v], 0) / Math.max(1, views.length);
    return { mesh, score, perView };
  };
  let values: Record<string, number> = {};
  let best = evaluate(values);
  const prog: FitProgress = { evals, score: best.score, start: best.score, values: {}, last: 'start', perView: best.perView, done: false };
  await opts.onProgress(prog, best.mesh);
  const steps = new Map(knobs.map(k => [k.name, k.step]));
  for (let round = 0; round < (opts.rounds ?? 6) && !opts.shouldStop(); round++) {
    let improved = false;
    for (const k of knobs) {
      if (opts.shouldStop()) break;
      for (const dir of [1, -1]) {
        const cur = values[k.name] ?? 0;
        const nv = +Math.min(k.max, Math.max(k.min, cur + dir * steps.get(k.name)!)).toFixed(4);
        if (nv === cur) continue;
        const cand = { ...values, [k.name]: nv };
        const r = evaluate(cand);
        if (r.score > best.score + 1e-4) {
          best = r; values = cand; improved = true;
          Object.assign(prog, { evals, score: best.score, values: { ...values }, last: `${k.label} → ${nv}`, perView: best.perView });
          await opts.onProgress(prog, best.mesh);
          break;
        }
        await new Promise(r => setTimeout(r, 0)); // keep the page responsive
      }
    }
    if (!improved) for (const k of knobs) steps.set(k.name, steps.get(k.name)! / 2);
    prog.evals = evals;
  }
  prog.done = true;
  await opts.onProgress(prog, best.mesh);
  return prog;
}
