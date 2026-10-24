// Motions are interpretable data: per-bone local rotations as Euler degrees (order XYZ)
// sampled at a fixed rate, plus an optional hips translation offset. An agent can read
// "thighL pitches 35° forward at t=0.2s" straight out of the JSON and edit it.
import * as THREE from 'three';
import type { BuiltSkeleton } from './skeleton';

export type Key3 = [number, number, number, number]; // [t, x, y, z]

export interface MotionDef {
  id: string;
  skeleton: string;
  description?: string;
  fps: number;
  duration: number;
  loop: boolean;
  /** Ground speed the cycle was authored for (m/s, along -Z). Playback rate scales with actual speed. */
  speed: number;
  /** Per-bone tracks. rot = Euler degrees (XYZ) relative to rest; pos = meters added to rest offset. */
  tracks: Record<string, { rot?: Key3[]; pos?: Key3[] }>;
  /** Foot contact intervals [start, end] in seconds, used by analysis and IK. */
  contacts?: Record<string, [number, number][]>;
  /** Generator parameters, kept so an agent can regenerate or tweak. */
  params?: Record<string, unknown>;
}

const D2R = Math.PI / 180;
const eul = new THREE.Euler();
const q = new THREE.Quaternion();

function sampleKeys(keys: Key3[], t: number, out: [number, number, number]) {
  if (keys.length === 1) { out[0] = keys[0][1]; out[1] = keys[0][2]; out[2] = keys[0][3]; return; }
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1][0] <= t) i++;
  const a = keys[i], b = keys[i + 1];
  const k = b[0] === a[0] ? 0 : THREE.MathUtils.clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
  out[0] = a[1] + (b[1] - a[1]) * k; out[1] = a[2] + (b[2] - a[2]) * k; out[2] = a[3] + (b[3] - a[3]) * k;
}

/** Make Euler key tracks continuous (no ±180° jumps), so linear interpolation between keys is safe. */
export function unwrapEuler(keys: Key3[]): Key3[] {
  for (let i = 1; i < keys.length; i++) for (let c = 1; c <= 3; c++) {
    let d = keys[i][c] - keys[i - 1][c];
    while (d > 180) { keys[i][c] -= 360; d -= 360; }
    while (d < -180) { keys[i][c] += 360; d += 360; }
  }
  return keys;
}

/** Pose a built skeleton at time t (CPU; used by analysis and the CLI). */
export function applyMotion(sk: BuiltSkeleton, m: MotionDef, t: number) {
  const tt = m.loop ? ((t % m.duration) + m.duration) % m.duration : Math.min(t, m.duration);
  const v: [number, number, number] = [0, 0, 0];
  for (const b of sk.def.bones) {
    const bone = sk.byName.get(b.name)!;
    const tr = m.tracks[b.name];
    if (tr?.rot) { sampleKeys(tr.rot, tt, v); bone.quaternion.setFromEuler(eul.set(v[0] * D2R, v[1] * D2R, v[2] * D2R, 'XYZ')); }
    else bone.quaternion.identity();
    bone.position.set(...b.offset);
    if (tr?.pos) { sampleKeys(tr.pos, tt, v); bone.position.x += v[0]; bone.position.y += v[1]; bone.position.z += v[2]; }
  }
  sk.root.updateMatrixWorld(true);
}

/** Convert to a three.js AnimationClip (quaternion tracks) for AnimationMixer playback. */
export function toClip(m: MotionDef, sk: BuiltSkeleton): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  for (const b of sk.def.bones) {
    const tr = m.tracks[b.name];
    if (tr?.rot) {
      const times: number[] = [], vals: number[] = [];
      for (const k of tr.rot) {
        q.setFromEuler(eul.set(k[1] * D2R, k[2] * D2R, k[3] * D2R, 'XYZ'));
        times.push(k[0]); vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, vals));
    }
    if (tr?.pos) {
      const times: number[] = [], vals: number[] = [];
      for (const k of tr.pos) { times.push(k[0]); vals.push(b.offset[0] + k[1], b.offset[1] + k[2], b.offset[2] + k[3]); }
      tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, vals));
    }
  }
  return new THREE.AnimationClip(m.id, m.duration, tracks);
}

export function validateMotion(raw: unknown, boneNames: Set<string>): string[] {
  const e: string[] = [];
  const m = raw as MotionDef;
  if (!m || typeof m !== 'object') return ['motion must be an object'];
  if (!m.id) e.push('id required');
  if (!(m.duration > 0)) e.push('duration > 0');
  if (!(m.fps > 0)) e.push('fps > 0');
  for (const [bone, tr] of Object.entries(m.tracks ?? {})) {
    if (!boneNames.has(bone)) e.push(`tracks.${bone}: unknown bone`);
    for (const kind of ['rot', 'pos'] as const) {
      const keys = tr[kind];
      if (!keys) continue;
      keys.forEach((k, i) => { if (k.length !== 4 || k.some(n => typeof n !== 'number' || !isFinite(n))) e.push(`tracks.${bone}.${kind}[${i}]: [t,x,y,z]`); });
      for (let i = 1; i < keys.length; i++) if (keys[i][0] < keys[i - 1][0]) { e.push(`tracks.${bone}.${kind}: times must increase`); break; }
    }
  }
  return e;
}
