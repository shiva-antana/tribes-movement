// Skeleton-agnostic motion comparator.
//
// Two motions on *different* skeletons (ours, CMU BVH, Mixamo, original Tribes armors…) are
// reduced to the same interpretable features: limb directions, joint flexion angles,
// torso lean, normalized hip height and foot clearance. Features are resampled over
// the cycle phase, aligned by the best circular shift (and optional L/R mirror), and
// then diffed. The result is a similarity score, per-feature differences, and
// concrete suggestions in terms of gait-generator parameters.
import * as THREE from 'three';
import { applyMotion, MotionDef } from './motion';
import { buildSkeleton, SkeletonDef, BuiltSkeleton } from './skeleton';

/** Canonical joints every skeleton gets mapped onto. */
export const CANON = ['hips', 'chest', 'head', 'upperArmL', 'foreArmL', 'handL', 'upperArmR', 'foreArmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'] as const;
export type Canon = typeof CANON[number];

/** Name aliases for common rigs (lower-cased, punctuation stripped). Extend freely. */
const ALIASES: Record<Canon, string[]> = {
  hips: ['hips', 'pelvis', 'vicon', 'root', 'hip', 'bip01pelvis', 'mixamorighips'],
  chest: ['chest', 'thorax', 'spine2', 'spine1', 'upperchest', 'torso', 'bip01spine2', 'mixamorigspine2', 'spine'],
  head: ['head', 'bip01head', 'mixamorighead'],
  upperArmL: ['upperarml', 'lhumerus', 'leftarm', 'larm', 'luparm', 'leftupperarm', 'bip01lupperarm', 'mixamorigleftarm', 'shoulderl'],
  foreArmL: ['forearml', 'lradius', 'leftforearm', 'lforearm', 'llowarm', 'leftlowerarm', 'bip01lforearm', 'mixamorigleftforearm'],
  handL: ['handl', 'lefthand', 'lhand', 'bip01lhand', 'mixamoriglefthand'],
  upperArmR: ['upperarmr', 'rhumerus', 'rightarm', 'rarm', 'ruparm', 'rightupperarm', 'bip01rupperarm', 'mixamorigrightarm', 'shoulderr'],
  foreArmR: ['forearmr', 'rradius', 'rightforearm', 'rforearm', 'rlowarm', 'rightlowerarm', 'bip01rforearm', 'mixamorigrightforearm'],
  handR: ['handr', 'dummyhand', 'righthand', 'rhand', 'bip01rhand', 'mixamorigrighthand'],
  thighL: ['thighl', 'lfemur', 'leftupleg', 'lthigh', 'luleg', 'leftupperleg', 'bip01lthigh', 'mixamorigleftupleg'],
  shinL: ['shinl', 'ltibia', 'leftleg', 'lcalf', 'lshin', 'llleg', 'leftlowerleg', 'bip01lcalf', 'mixamorigleftleg'],
  footL: ['footl', 'leftfoot', 'lfoot', 'bip01lfoot', 'mixamorigleftfoot'],
  thighR: ['thighr', 'rfemur', 'rightupleg', 'rthigh', 'ruleg', 'rightupperleg', 'bip01rthigh', 'mixamorigrightupleg'],
  shinR: ['shinr', 'rtibia', 'rightleg', 'rcalf', 'rshin', 'rlleg', 'rightlowerleg', 'bip01rcalf', 'mixamorigrightleg'],
  footR: ['footr', 'rightfoot', 'rfoot', 'bip01rfoot', 'mixamorigrightfoot'],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map a skeleton's bones onto canonical joints: explicit map, then aliases. Unmapped joints are skipped. */
export function mapSkeleton(sk: SkeletonDef, explicit: Partial<Record<Canon, string>> = {}): Partial<Record<Canon, string>> {
  const out: Partial<Record<Canon, string>> = { ...explicit };
  const names = sk.bones.map(b => b.name);
  for (const c of CANON) {
    if (out[c]) continue;
    for (const a of ALIASES[c]) {
      const hit = names.find(n => norm(n) === a);
      if (hit) { out[c] = hit; break; }
    }
  }
  return out;
}

export interface FeatureTrack { name: string; unit: 'deg' | 'ratio'; values: number[]; }
export interface Features { samples: number; tracks: Record<string, FeatureTrack>; cadence: number; speed: number; legLength: number; mapped: string[]; }

const UP = new THREE.Vector3(0, 1, 0);
const deg = (r: number) => (r * 180) / Math.PI;

/** Sample interpretable, skeleton-independent features over one cycle (N phase samples). */
export function extractFeatures(sk: BuiltSkeleton, m: MotionDef, map: Partial<Record<Canon, string>>, N = 64): Features {
  const P = (c: Canon) => { const n = map[c]; return n ? sk.byName.get(n)!.getWorldPosition(new THREE.Vector3()) : null; };
  // Leg length = thigh + shin segment lengths (independent of the rest pose's joint rotations).
  const seg = (a?: string, b?: string) => { const bb = b ? sk.def.bones.find(x => x.name === b) : null; return bb && a ? Math.hypot(...bb.offset) : 0; };
  const legLength = (seg(map.thighL, map.shinL) + seg(map.shinL, map.footL)) || (seg(map.thighR, map.shinR) + seg(map.shinR, map.footR)) || 0.9;
  const tracks: Record<string, FeatureTrack> = {};
  const push = (name: string, unit: FeatureTrack['unit'], v: number) => { (tracks[name] ??= { name, unit, values: [] }).values.push(v); };
  const ang = (a: THREE.Vector3 | null, b: THREE.Vector3 | null, c: THREE.Vector3 | null) => {
    if (!a || !b || !c) return NaN;
    return 180 - deg(a.clone().sub(b).angleTo(c.clone().sub(b))); // 0 = straight limb
  };
  for (let i = 0; i < N; i++) {
    applyMotion(sk, m, (i / N) * m.duration);
    const hips = P('hips'), chest = P('chest'), head = P('head');
    // Heading frame from geometry, not bone axes: forward = (left hip − right hip) × up.
    // Works for any rig's rest orientation and removes root yaw.
    const lh = P('thighL') ?? P('upperArmL'), rh = P('thighR') ?? P('upperArmR');
    const fwd = lh && rh ? lh.clone().sub(rh).cross(UP).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
    const pitchOf = (from: THREE.Vector3 | null, to: THREE.Vector3 | null) => {
      if (!from || !to) return NaN;
      const d = to.clone().sub(from);
      return deg(Math.atan2(d.dot(fwd), -d.y)); // limb swing forward(+)/back(-) from straight down
    };
    for (const s of ['L', 'R'] as const) {
      const th = P(`thigh${s}` as Canon), sh = P(`shin${s}` as Canon), ft = P(`foot${s}` as Canon);
      const ua = P(`upperArm${s}` as Canon), fa = P(`foreArm${s}` as Canon), hd = P(`hand${s}` as Canon);
      push(`hipSwing${s}`, 'deg', pitchOf(th, sh));
      push(`knee${s}`, 'deg', ang(th, sh, ft));
      push(`armSwing${s}`, 'deg', pitchOf(ua, fa));
      push(`elbow${s}`, 'deg', ang(ua, fa, hd));
      push(`footHeight${s}`, 'ratio', ft ? ft.y / legLength : NaN);
    }
    // Whole-torso lean (hips → head): robust to rigs that split the spine differently.
    const top = head ?? chest;
    push('torsoLean', 'deg', hips && top ? deg(Math.atan2(top.clone().sub(hips).dot(fwd), top.y - hips.y)) : NaN);
    push('headPitch', 'deg', chest && head ? deg(Math.atan2(head.clone().sub(chest).dot(fwd), head.y - chest.y)) : NaN);
    push('hipHeight', 'ratio', hips ? hips.y / legLength : NaN);
  }
  // Heights relative to the lowest foot point of the cycle (rigs disagree on where the ground is).
  const fl = tracks.footHeightL?.values ?? [], fr = tracks.footHeightR?.values ?? [];
  const ground = Math.min(...fl.filter(v => !isNaN(v)), ...fr.filter(v => !isNaN(v)));
  if (isFinite(ground)) for (const k of ['footHeightL', 'footHeightR', 'hipHeight']) if (tracks[k]) tracks[k].values = tracks[k].values.map(v => v - ground);
  return { samples: N, tracks, cadence: m.speed > 0 ? 120 / m.duration : 0, speed: m.speed, legLength, mapped: Object.keys(map) };
}

/** Express features relative to a baseline pose (e.g. each rig's idle): cancels rest-angle and proportion differences between rigs. */
export function relativeTo(f: Features, base: Features): Features {
  const tracks: Features['tracks'] = {};
  for (const [k, t] of Object.entries(f.tracks)) {
    const b = base.tracks[k];
    const off = b ? mean(b.values.filter(v => !isNaN(v))) : 0;
    tracks[k] = { ...t, values: t.values.map(v => v - off) };
  }
  return { ...f, tracks };
}

export interface FeatureDiff { name: string; unit: string; rmse: number; meanDiff: number; ampOurs: number; ampRef: number; corr: number; }
export interface Comparison {
  score: number;                 // 0..100 (100 = indistinguishable on these features)
  shift: number;                 // best circular phase shift (fraction of cycle)
  mirrored: boolean;
  diffs: FeatureDiff[];
  suggestions: { param: string; change: number; reason: string }[];
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const amp = (a: number[]) => (Math.max(...a) - Math.min(...a)) / 2;
function corr(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 1e-9 && db > 1e-9 ? n / Math.sqrt(da * db) : 1;
}

/** Feature weights: what matters most for "reads like the same motion". */
const WEIGHT: Record<string, number> = { hipSwing: 1.2, knee: 1, armSwing: 0.8, elbow: 0.5, footHeight: 0.8, torsoLean: 0.8, headPitch: 0.3, hipHeight: 0.6 };
const SCALE: Record<string, number> = { deg: 30, ratio: 0.15 }; // error that counts as "fully wrong"

export function compareFeatures(ours: Features, ref: Features): Comparison {
  const names = Object.keys(ours.tracks).filter(n => ref.tracks[n] && !ours.tracks[n].values.some(isNaN) && !ref.tracks[n].values.some(isNaN));
  const N = ours.samples;
  let best = { cost: Infinity, shift: 0, mirrored: false };
  for (const mirrored of [false, true]) {
    for (let s = 0; s < N; s++) {
      let cost = 0;
      for (const n of names) {
        const rn = mirrored ? n.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R') : n;
        const a = ours.tracks[n].values, b = ref.tracks[rn]?.values;
        if (!b) continue;
        for (let i = 0; i < N; i++) cost += ((a[i] - b[(i + s) % N]) / SCALE[ours.tracks[n].unit]) ** 2;
      }
      if (cost < best.cost) best = { cost, shift: s, mirrored };
    }
  }
  const diffs: FeatureDiff[] = [];
  let wsum = 0, err = 0;
  for (const n of names) {
    const rn = best.mirrored ? n.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R') : n;
    const a = ours.tracks[n].values, b0 = ref.tracks[rn].values;
    const b = a.map((_, i) => b0[(i + best.shift) % N]);
    const rmse = Math.sqrt(mean(a.map((x, i) => (x - b[i]) ** 2)));
    const unit = ours.tracks[n].unit;
    diffs.push({ name: n, unit, rmse: +rmse.toFixed(3), meanDiff: +(mean(a) - mean(b)).toFixed(3), ampOurs: +amp(a).toFixed(3), ampRef: +amp(b).toFixed(3), corr: +corr(a, b).toFixed(3) });
    const w = WEIGHT[n.replace(/[LR]$/, '')] ?? 0.5;
    wsum += w;
    err += w * Math.tanh(rmse / SCALE[unit]); // smooth: large errors still have a gradient
  }
  const score = +(100 * (1 - err / Math.max(1e-9, wsum))).toFixed(1);
  return { score, shift: +(best.shift / N).toFixed(3), mirrored: best.mirrored, diffs, suggestions: suggest(diffs, ours, ref) };
}

/** Translate feature differences into gait-generator parameter nudges (see gait.ts). */
function suggest(diffs: FeatureDiff[], ours: Features, ref: Features) {
  const by = (n: string) => { const d = diffs.filter(x => x.name.replace(/[LR]$/, '') === n); return d.length ? { amp: mean(d.map(x => x.ampRef - x.ampOurs)), mean: mean(d.map(x => x.meanDiff)) } : null; };
  const out: Comparison['suggestions'] = [];
  const arm = by('armSwing'); if (arm && Math.abs(arm.amp) > 4) out.push({ param: 'armSwing', change: +arm.amp.toFixed(1), reason: `arm swing amplitude off by ${arm.amp.toFixed(1)}°` });
  // Per-side carry (e.g. one arm holding a weapon) when the sides disagree.
  for (const side of ['L', 'R'] as const) {
    const d = diffs.find(x => x.name === `armSwing${side}`);
    if (d && Math.abs(d.meanDiff) > 4) out.push({ param: side === 'L' ? 'armForward' : 'armForwardR', change: +(-d.meanDiff).toFixed(1), reason: `${side} arm carried ${d.meanDiff > 0 ? 'too far forward' : 'too far back'}` });
  }
  const elR = diffs.find(x => x.name === 'elbowR'), elL = diffs.find(x => x.name === 'elbowL');
  if (elR && elL && Math.abs(elR.meanDiff - elL.meanDiff) > 10) out.push({ param: 'elbowR', change: +(-elR.meanDiff).toFixed(1), reason: 'right elbow differs from left (weapon hold?)' });
  const el = diffs.find(x => x.name === 'elbowL'); if (el && Math.abs(el.meanDiff) > 6) out.push({ param: 'elbow', change: +(-el.meanDiff).toFixed(1), reason: `elbow bend off by ${(-el.meanDiff).toFixed(1)}°` });
  const lean = by('torsoLean'); if (lean && Math.abs(lean.mean) > 3) out.push({ param: 'lean', change: +(-lean.mean).toFixed(1), reason: `torso lean off by ${(-lean.mean).toFixed(1)}°` });
  const fh = by('footHeight'); if (fh && Math.abs(fh.amp) > 0.03) out.push({ param: 'lift', change: +(fh.amp * 2 * ours.legLength).toFixed(3), reason: `swing foot clearance off by ${(fh.amp * 2 * ref.legLength).toFixed(2)} m` });
  const hs = by('hipSwing');
  if (hs && Math.abs(hs.mean) > 4) out.push({ param: 'footBias', change: +(Math.sin(hs.mean * Math.PI / 180) * ours.legLength).toFixed(3), reason: `legs swing ${hs.mean > 0 ? 'too far forward' : 'too far back'} on average (${hs.mean.toFixed(0)}°)` });
  const hp = by('headPitch'); if (hp && Math.abs(hp.mean) > 5) out.push({ param: 'headPitch', change: +(-hp.mean).toFixed(1), reason: `head pitch off by ${(-hp.mean).toFixed(0)}°` });
  const hh = by('hipHeight');
  if (hh && Math.abs(hh.mean) > 0.02) out.push({ param: 'crouch', change: +(hh.mean * ours.legLength).toFixed(3), reason: `hips ${hh.mean > 0 ? 'too high' : 'too low'} by ${(Math.abs(hh.mean) * ours.legLength).toFixed(2)} m` });
  if (hh && Math.abs(hh.amp) > 0.01) out.push({ param: 'bob', change: +(hh.amp * ours.legLength).toFixed(3), reason: 'vertical bob amplitude differs' });
  if (ref.cadence > 0 && ours.cadence > 0 && Math.abs(ref.cadence / ours.cadence - 1) > 0.05) out.push({ param: 'cycle', change: +(120 / ref.cadence - 120 / ours.cadence).toFixed(3), reason: `cadence ${ours.cadence.toFixed(0)} vs ${ref.cadence.toFixed(0)} steps/min` });
  return out;
}

export function compareMotions(a: { sk: SkeletonDef; m: MotionDef; map?: Partial<Record<Canon, string>> }, b: { sk: SkeletonDef; m: MotionDef; map?: Partial<Record<Canon, string>> }, N = 64) {
  const fa = extractFeatures(buildSkeleton(a.sk), a.m, mapSkeleton(a.sk, a.map), N);
  const fb = extractFeatures(buildSkeleton(b.sk), b.m, mapSkeleton(b.sk, b.map), N);
  return compareFeatures(fa, fb);
}
