// Motion QA: turns a motion into numbers an agent can reason about, plus per-frame
// joint vectors (local Euler rotations + world positions) for inspection or export.
import * as THREE from 'three';
import { applyMotion, MotionDef } from './motion';
import type { BuiltSkeleton } from './skeleton';

export interface MotionReport {
  id: string;
  ok: boolean;
  issues: string[];
  footSlide: Record<string, { mean: number; max: number }>;   // m/s deviation from expected ground motion while planted
  contactHeight: Record<string, number>;                       // mean |ankle height error| while planted (m)
  minAnkleHeight: number;                                      // below the rest ankle height = ground penetration
  strideLength: number;                                        // m per foot contact
  cadence: number;                                             // steps per minute
  symmetry: number;                                            // phase gap between L and R contacts (ideal 0.5)
  loopSeam: number;                                            // max joint angle jump (deg) between last and first frame
  rom: Record<string, [number, number]>;                       // pitch range (deg) per bone
}

const D = 60;

export function analyzeMotion(sk: BuiltSkeleton, m: MotionDef): MotionReport {
  const issues: string[] = [];
  const restAnkle = sk.restWorld.get('footL')!.y;
  const feet = ['footL', 'footR'].filter(f => sk.byName.has(f));
  const inContact = (foot: string, t: number) => (m.contacts?.[foot] ?? []).some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6);
  const prev = new Map<string, THREE.Vector3>();
  const slide: Record<string, number[]> = {}, height: Record<string, number[]> = {};
  let minAnkle = Infinity;
  const steps = Math.max(2, Math.round(m.duration * D));
  const dt = m.duration / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    applyMotion(sk, m, t);
    for (const f of feet) {
      const w = sk.byName.get(f)!.getWorldPosition(new THREE.Vector3());
      minAnkle = Math.min(minAnkle, w.y);
      const c = inContact(f, t);
      if (c) (height[f] ??= []).push(Math.abs(w.y - restAnkle));
      const pv = prev.get(f);
      if (pv && c && inContact(f, t - dt)) {
        // In-place cycles: a planted foot should travel backward at the authored speed.
        const vx = (w.x - pv.x) / dt, vz = (w.z - pv.z) / dt;
        (slide[f] ??= []).push(Math.hypot(vx, vz - m.speed));
      }
      prev.set(f, w);
    }
  }
  const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const footSlide: MotionReport['footSlide'] = {}, contactHeight: MotionReport['contactHeight'] = {};
  for (const f of feet) {
    footSlide[f] = { mean: +mean(slide[f] ?? []).toFixed(3), max: +Math.max(0, ...(slide[f] ?? [0])).toFixed(3) };
    contactHeight[f] = +mean(height[f] ?? []).toFixed(4);
    if (footSlide[f].mean > 0.15) issues.push(`${f} slides ${footSlide[f].mean} m/s while planted`);
    if (contactHeight[f] > 0.02) issues.push(`${f} floats/penetrates ${contactHeight[f]} m while planted`);
  }
  if (minAnkle < restAnkle - 0.02) issues.push(`ankle goes ${(restAnkle - minAnkle).toFixed(3)} m below ground`);

  const cL = m.contacts?.footL?.[0], cR = m.contacts?.footR?.[0];
  const contactDur = cL ? cL[1] - cL[0] : 0;
  const symmetry = cL && cR ? +(((cR[0] - cL[0]) / m.duration + 1) % 1).toFixed(3) : 0;
  if (m.speed > 0 && cL && cR && Math.abs(symmetry - 0.5) > 0.08) issues.push(`asymmetric gait (phase gap ${symmetry})`);

  // Range of motion + hyperextension + loop seam.
  const rom: Record<string, [number, number]> = {};
  let seam = 0;
  for (const [b, tr] of Object.entries(m.tracks)) {
    if (!tr.rot?.length) continue;
    const xs = tr.rot.map(k => k[1]);
    rom[b] = [Math.min(...xs), Math.max(...xs)];
    if (m.loop) {
      const a = tr.rot[0], z = tr.rot[tr.rot.length - 1];
      seam = Math.max(seam, Math.abs(a[1] - z[1]), Math.abs(a[2] - z[2]), Math.abs(a[3] - z[3]));
    }
    if (b.startsWith('shin') && rom[b][1] > 5) issues.push(`${b} hyperextends (knee pitch up to ${rom[b][1]}°)`);
  }
  if (seam > 3) issues.push(`loop seam jumps ${seam.toFixed(1)}°`);

  return {
    id: m.id, ok: issues.length === 0, issues, footSlide, contactHeight,
    minAnkleHeight: +(minAnkle - restAnkle).toFixed(3),
    strideLength: +(m.speed * contactDur).toFixed(3),
    cadence: m.speed > 0 ? +((2 / m.duration) * 60).toFixed(1) : 0,
    symmetry, loopSeam: +seam.toFixed(2), rom,
  };
}

/** Per-frame joint vectors: local Euler (deg) and world position (m) for every bone. */
export function motionVectors(sk: BuiltSkeleton, m: MotionDef, fps = m.fps) {
  const frames: { t: number; bones: Record<string, { rot: number[]; world: number[] }> }[] = [];
  const steps = Math.round(m.duration * fps);
  const e = new THREE.Euler();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * m.duration;
    applyMotion(sk, m, t);
    const bones: Record<string, { rot: number[]; world: number[] }> = {};
    for (const b of sk.bones) {
      e.setFromQuaternion(b.quaternion, 'XYZ');
      const w = b.getWorldPosition(new THREE.Vector3());
      bones[b.name] = { rot: [e.x, e.y, e.z].map(v => +(v * 180 / Math.PI).toFixed(2)), world: [w.x, w.y, w.z].map(v => +v.toFixed(4)) };
    }
    frames.push({ t: +t.toFixed(4), bones });
  }
  return frames;
}
