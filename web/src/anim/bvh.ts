// BVH (motion-capture text format) → MotionDef, retargeted by bone-name mapping.
// Works for CMU-style and Mixamo-style rigs whose rest pose is a T-pose with
// identity joint orientations (as ours is), so local rotations transfer directly.
import * as THREE from 'three';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { unwrapEuler } from './motion';
import type { MotionDef, Key3 } from './motion';
import type { SkeletonDef } from './skeleton';

export const BONE_MAPS: Record<string, Record<string, string>> = {
  cmu: {
    Hips: 'hips', LowerBack: 'spine', Spine: 'spine', Spine1: 'chest', Neck: 'neck', Neck1: 'neck', Head: 'head',
    LeftShoulder: 'shoulderL', LeftArm: 'upperArmL', LeftForeArm: 'foreArmL', LeftHand: 'handL',
    RightShoulder: 'shoulderR', RightArm: 'upperArmR', RightForeArm: 'foreArmR', RightHand: 'handR',
    LeftUpLeg: 'thighL', LeftLeg: 'shinL', LeftFoot: 'footL', LeftToeBase: 'toeL',
    RightUpLeg: 'thighR', RightLeg: 'shinR', RightFoot: 'footR', RightToeBase: 'toeR',
  },
  mixamo: {
    'mixamorig:Hips': 'hips', 'mixamorig:Spine': 'spine', 'mixamorig:Spine2': 'chest', 'mixamorig:Neck': 'neck', 'mixamorig:Head': 'head',
    'mixamorig:LeftShoulder': 'shoulderL', 'mixamorig:LeftArm': 'upperArmL', 'mixamorig:LeftForeArm': 'foreArmL', 'mixamorig:LeftHand': 'handL',
    'mixamorig:RightShoulder': 'shoulderR', 'mixamorig:RightArm': 'upperArmR', 'mixamorig:RightForeArm': 'foreArmR', 'mixamorig:RightHand': 'handR',
    'mixamorig:LeftUpLeg': 'thighL', 'mixamorig:LeftLeg': 'shinL', 'mixamorig:LeftFoot': 'footL', 'mixamorig:LeftToeBase': 'toeL',
    'mixamorig:RightUpLeg': 'thighR', 'mixamorig:RightLeg': 'shinR', 'mixamorig:RightFoot': 'footR', 'mixamorig:RightToeBase': 'toeR',
  },
};

export function importBVH(text: string, id: string, sk: SkeletonDef, opts: { map?: string; start?: number; end?: number; fps?: number; mirrorX?: boolean } = {}): MotionDef {
  const res = new BVHLoader().parse(text);
  const map = BONE_MAPS[opts.map ?? 'cmu'];
  const clip = res.clip;
  const bvhBones = res.skeleton.bones;
  const t0 = opts.start ?? 0, t1 = Math.min(opts.end ?? clip.duration, clip.duration);
  const fps = opts.fps ?? 30;
  const n = Math.max(1, Math.round((t1 - t0) * fps));
  // Scale: match hip heights.
  const ourHip = sk.bones.find(b => b.name === 'hips')!.offset[1];
  const root = bvhBones[0];
  root.updateMatrixWorld(true);
  let lowest = 0;
  for (const b of bvhBones) lowest = Math.min(lowest, b.getWorldPosition(new THREE.Vector3()).y);
  const bvhHip = root.position.y - lowest || 1;
  const scale = ourHip / bvhHip;

  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  const tracks: MotionDef['tracks'] = {};
  const e = new THREE.Euler();
  const rootStart = new THREE.Vector3(), rootEnd = new THREE.Vector3();
  const rootKeys: [number, THREE.Vector3][] = [];
  const restRoot = root.position.clone();
  for (let i = 0; i <= n; i++) {
    const t = t0 + (i / n) * (t1 - t0);
    mixer.setTime(t);
    const tt = +(t - t0).toFixed(4);
    for (const b of bvhBones) {
      const ours = map[b.name];
      if (!ours || (tracks[ours]?.rot && tracks[ours].rot!.length > i)) continue; // first mapped BVH bone wins
      e.setFromQuaternion(b.quaternion, 'XYZ');
      ((tracks[ours] ??= {}).rot ??= []).push([tt, ...[e.x, e.y, e.z].map(v => +(v * 180 / Math.PI).toFixed(2))] as Key3);
    }
    rootKeys.push([tt, root.position.clone()]);
    if (i === 0) rootStart.copy(root.position);
    if (i === n) rootEnd.copy(root.position);
  }
  for (const tr of Object.values(tracks)) if (tr.rot) unwrapEuler(tr.rot);
  // Make it in-place: remove average horizontal travel (forward speed is recorded as metadata).
  const dur = t1 - t0;
  const vel = rootEnd.clone().sub(rootStart).divideScalar(dur || 1);
  tracks.hips ??= {};
  tracks.hips.pos = rootKeys.map(([t, p]) => [t,
    +((p.x - rootStart.x - vel.x * t) * scale).toFixed(4),
    +((p.y - restRoot.y) * scale).toFixed(4),
    +((p.z - rootStart.z - vel.z * t) * scale).toFixed(4)] as Key3);
  return {
    id, skeleton: sk.id, description: `Imported from BVH (${opts.map ?? 'cmu'} mapping)`, fps, duration: +dur.toFixed(4), loop: false,
    speed: +(Math.hypot(vel.x, vel.z) * scale).toFixed(3), tracks,
    params: { source: 'bvh', map: opts.map ?? 'cmu', start: t0, end: t1, scale: +scale.toFixed(4) },
  };
}
