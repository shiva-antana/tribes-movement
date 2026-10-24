// Procedural motion synthesis. Feet follow explicit trajectories (planted while in contact,
// arcing during swing) and the legs reach them with analytic two-bone IK, so contacts
// don't slide by construction. Everything is parameterised for agents to tune.
import * as THREE from 'three';
import type { MotionDef, Key3 } from './motion';
import type { SkeletonDef } from './skeleton';

export interface GaitParams {
  mode: 'gait' | 'pose';
  description?: string;
  speed: number;          // m/s the cycle covers (gait mode)
  cycle: number;          // seconds per full cycle (two steps)
  stance: number;         // fraction of the cycle each foot is planted (walk ~0.6, run ~0.35)
  lift: number;           // swing foot height (m)
  bob: number;            // vertical hip bob (m)
  run: boolean;           // hips lowest at mid-stance (run) vs highest (walk)
  crouch: number;         // hips lowered (m)
  lean: number;           // torso pitch forward (deg)
  stepWidth: number;      // extra lateral foot spacing (m)
  armDown: number;        // shoulder adduction from T-pose (deg, 90 = arms at sides)
  armSwing: number;       // fore/aft arm swing (deg)
  armForward: number;     // constant arm pitch forward (deg)
  elbow: number;          // elbow bend (deg)
  twist: number;          // torso counter-rotation (deg)
  sway: number;           // hip roll (deg)
  toeOff: number;         // toe flex at push-off (deg)
  // Asymmetric carry (e.g. right hand on a weapon). Undefined = mirror the left/shared values.
  footBias?: number;      // shifts the whole foot path backward (+) / forward (-) relative to the hips (m)
  headPitch?: number;     // extra head pitch, + = looking down (deg)
  armForwardR?: number;
  armSwingR?: number;
  elbowR?: number;
  // pose mode
  feet?: { l: [number, number, number]; r: [number, number, number] }; // ankle targets relative to hips ground point [x, y above ground, z]
  contacts?: boolean;     // pose mode: are the feet planted?
  wobble?: number;        // pose mode: slow sway amplitude (deg)
}

const DEF: GaitParams = {
  mode: 'gait', speed: 1.5, cycle: 1.1, stance: 0.6, lift: 0.12, bob: 0.03, run: false, crouch: 0.02, lean: 4,
  stepWidth: 0.02, armDown: 78, armSwing: 22, armForward: 0, elbow: 12, twist: 6, sway: 3, toeOff: 20,
};

export const PRESETS: Record<string, Partial<GaitParams>> = {
  idle: { mode: 'pose', description: 'Relaxed stance with breathing sway.', cycle: 3, crouch: 0.03, lean: 2, armDown: 80, elbow: 10, feet: { l: [-0.13, 0.06, 0.02], r: [0.13, 0.06, -0.03] }, contacts: true, wobble: 1.5 },
  walk: { mode: 'gait', description: 'Unhurried walk.', speed: 1.6, cycle: 1.05, stance: 0.62, lift: 0.12, bob: 0.03, lean: 4, armSwing: 24, elbow: 14 },
  run: { mode: 'gait', description: 'Armored sprint. Plays faster with ground speed.', speed: 6.5, cycle: 0.62, stance: 0.24, lift: 0.3, bob: 0.05, run: true, crouch: 0.07, lean: 14, armSwing: 42, armForward: 8, armDown: 72, elbow: 75, twist: 10, sway: 2, toeOff: 30 },
  ski: { mode: 'pose', description: 'Skiing tuck: knees bent, feet staggered, arms out for balance.', cycle: 2, crouch: 0.3, lean: 24, armDown: 50, armForward: 25, elbow: 35, feet: { l: [-0.17, 0.06, -0.14], r: [0.17, 0.06, 0.14] }, contacts: true, wobble: 3, sway: 4 },
  jet: { mode: 'pose', description: 'Jetting: legs trailing and bent, arms back.', cycle: 1.2, crouch: 0, lean: 12, armDown: 62, armForward: -18, elbow: 25, feet: { l: [-0.12, 0.3, 0.2], r: [0.12, 0.24, 0.12] }, contacts: false, wobble: 4 },
  fall: { mode: 'pose', description: 'Airborne without jets: arms out, legs braced for landing.', cycle: 0.9, crouch: 0, lean: -4, armDown: 25, armForward: 10, elbow: 30, feet: { l: [-0.15, 0.25, -0.12], r: [0.15, 0.16, 0.16] }, contacts: false, wobble: 8 },
};

const R2D = 180 / Math.PI;
const smooth = (k: number) => k * k * (3 - 2 * k);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function generateMotion(id: string, sk: SkeletonDef, overrides: Partial<GaitParams>): MotionDef {
  const P: GaitParams = { ...DEF, ...overrides };
  const bone = (n: string) => sk.bones.find(b => b.name === n)!;
  const hipRest = bone('hips').offset[1];
  const thighOff = bone('thighL').offset; // mirrored for R
  const L1 = Math.abs(bone('shinL').offset[1]);
  const L2 = Math.abs(bone('footL').offset[1]);
  const ankleH = hipRest + thighOff[1] - L1 - L2; // ankle height above ground in rest pose
  const fps = P.cycle < 0.8 ? 60 : 30; // fast cycles need denser keys for planted feet to stay put
  const dur = P.cycle;
  const n = Math.round(dur * fps);
  const S = P.speed * P.stance * P.cycle; // stride length per foot contact
  const tracks: MotionDef['tracks'] = {};
  const push = (b: string, kind: 'rot' | 'pos', k: Key3) => { ((tracks[b] ??= {})[kind] ??= []).push(k); };
  const contacts: Record<string, [number, number][]> = { footL: [], footR: [] };

  const footAt = (phase: number, side: -1 | 1): { pos: THREE.Vector3; contact: boolean; toe: number } => {
    const x = side * (Math.abs(thighOff[0]) + P.stepWidth);
    if (P.mode === 'pose') {
      const f = side < 0 ? P.feet!.l : P.feet!.r;
      return { pos: new THREE.Vector3(f[0], f[1], f[2]), contact: !!P.contacts, toe: 0 };
    }
    if (phase < P.stance) {
      const k = phase / P.stance;
      return { pos: new THREE.Vector3(x, ankleH, -S / 2 + k * S + (P.footBias ?? 0)), contact: true, toe: k > 0.75 ? (k - 0.75) / 0.25 * P.toeOff : 0 };
    }
    const k = (phase - P.stance) / (1 - P.stance);
    return { pos: new THREE.Vector3(x, ankleH + P.lift * Math.sin(Math.PI * k), S / 2 - smooth(k) * S + (P.footBias ?? 0)), contact: false, toe: (1 - k) * P.toeOff * 0.5 };
  };

  const hipsQ = new THREE.Quaternion(), inv = new THREE.Quaternion();
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * dur;
    const p = i / n;
    const osc = Math.sin(2 * Math.PI * p);
    let hipY = -P.crouch, hipRoll = 0, hipYaw = 0;
    const L = footAt(p % 1, -1), R = footAt((p + 0.5) % 1, 1);
    // How far forward each foot is, -1..1 (drives arm swing and torso twist).
    const fwdL = P.mode === 'gait' ? -(L.pos.z - (P.footBias ?? 0)) / (S / 2 || 1) : 0;
    const fwdR = P.mode === 'gait' ? -(R.pos.z - (P.footBias ?? 0)) / (S / 2 || 1) : 0;
    if (P.mode === 'gait') {
      hipY += (P.run ? -1 : 1) * P.bob * Math.cos(4 * Math.PI * (p - P.stance / 2));
      hipRoll = P.sway * Math.sin(2 * Math.PI * p);
      hipYaw = P.twist * 0.6 * (fwdL - fwdR) / 2;
    } else {
      hipY += 0.01 * Math.sin(2 * Math.PI * p);
      hipRoll = (P.wobble ?? 0) * 0.4 * osc;
    }
    // Auto-crouch: never ask the legs to reach further than 98% of their length,
    // otherwise IK clamps and planted feet slide.
    for (const F of [L, R]) {
      const jx = Math.abs(thighOff[0]), horiz2 = (Math.abs(F.pos.x) - jx) ** 2 + F.pos.z ** 2;
      const reach = (L1 + L2) * 0.98;
      if (horiz2 < reach * reach) hipY = Math.min(hipY, F.pos.y + Math.sqrt(reach * reach - horiz2) - thighOff[1] - hipRest);
    }
    push('hips', 'pos', [r4(t), 0, r4(hipY), 0]);
    push('hips', 'rot', [r4(t), 0, r2(hipYaw), r2(hipRoll)]);
    hipsQ.setFromEuler(new THREE.Euler(0, hipYaw / R2D, hipRoll / R2D, 'XYZ'));
    inv.copy(hipsQ).invert();
    const hipsPos = new THREE.Vector3(0, hipRest + hipY, 0);

    for (const [side, F, tag] of [[-1, L, 'L'], [1, R, 'R']] as const) {
      const joint = new THREE.Vector3(side * Math.abs(thighOff[0]), thighOff[1], thighOff[2]).applyQuaternion(hipsQ).add(hipsPos);
      const d = F.pos.clone().sub(joint).applyQuaternion(inv);
      const dist = Math.min(d.length(), (L1 + L2) * 0.999);
      const roll = Math.asin(THREE.MathUtils.clamp(d.x / d.length(), -1, 1));
      const phi = Math.atan2(-d.z, -d.y);
      const alpha = Math.acos(THREE.MathUtils.clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1));
      const beta = Math.acos(THREE.MathUtils.clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1));
      const thighX = (phi + alpha) * R2D, shinX = -(Math.PI - beta) * R2D;
      push(`thigh${tag}`, 'rot', [r4(t), r2(thighX), 0, r2(roll * R2D)]);
      push(`shin${tag}`, 'rot', [r4(t), r2(shinX), 0, 0]);
      // Keep the sole level with the ground; flex the toe at push-off.
      push(`foot${tag}`, 'rot', [r4(t), r2(-(thighX + shinX)), 0, r2(-roll * R2D)]);
      push(`toe${tag}`, 'rot', [r4(t), r2(-F.toe), 0, 0]);
    }

    // Upper body.
    const breath = P.mode === 'pose' ? (P.wobble ?? 0) * osc : 0;
    push('spine', 'rot', [r4(t), r2(-P.lean * 0.5 + breath * 0.2), r2(P.twist * (fwdR - fwdL) / 2 * 0.6), r2(-hipRoll * 0.5)]);
    push('chest', 'rot', [r4(t), r2(-P.lean * 0.5), r2(P.twist * (fwdR - fwdL) / 2 * 0.4), 0]);
    if (P.headPitch) push('neck', 'rot', [r4(t), r2(-P.headPitch), 0, 0]); // pitch the neck so the head actually moves
    push('head', 'rot', [r4(t), r2(P.lean * 0.8), r2(-P.twist * (fwdR - fwdL) / 2 * 0.5), r2(breath * 0.3)]);
    // Arms counter-swing to the opposite leg. Euler XYZ = swing(X) after drop(Z).
    const swingL = P.armForward + P.armSwing * fwdR + breath * 0.5;
    const swingR = (P.armForwardR ?? P.armForward) + (P.armSwingR ?? P.armSwing) * fwdL - breath * 0.5;
    push('upperArmL', 'rot', [r4(t), r2(swingL), 0, r2(P.armDown)]);
    push('upperArmR', 'rot', [r4(t), r2(swingR), 0, r2(-P.armDown)]);
    push('foreArmL', 'rot', [r4(t), 0, r2(-(P.elbow + Math.max(0, swingL) * 0.4)), 0]);
    push('foreArmR', 'rot', [r4(t), 0, r2((P.elbowR ?? P.elbow) + Math.max(0, swingR) * 0.4), 0]);
  }

  // Contact intervals (seconds).
  if (P.mode === 'gait') {
    contacts.footL.push([0, P.stance * dur]);
    const rs = 0.5 * dur, re = ((0.5 + P.stance) % 1) * dur;
    if (re > rs) contacts.footR.push([rs, re]); else { contacts.footR.push([rs, dur]); contacts.footR.push([0, re]); }
  } else if (P.contacts) { contacts.footL.push([0, dur]); contacts.footR.push([0, dur]); }

  return {
    id, skeleton: sk.id, description: P.description, fps, duration: dur, loop: true,
    speed: P.mode === 'gait' ? P.speed : 0, tracks, contacts, params: { ...overrides },
  };
}
