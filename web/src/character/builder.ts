// Procedural character builder. A character is data: skeleton volumes (smooth-unioned
// tapered capsules) meshed with surface nets into a smooth, high-poly body; skin weights
// come analytically from each bone's volumes ("bone glow"); armor pieces are rounded
// solids rigidly bound to bones. UVs are a per-bone cylindrical atlas so the texture
// painter can target body regions by bone name. Height maps displace the surface
// (baked tessellation).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { buildSkeleton, childOf, SkeletonDef, VolumeDef, BuiltSkeleton, BoneDef } from '../anim/skeleton';
import { chainWeights, SpringChainDef, SpringColliderDef, SpringSet } from './springs';
import type { Baked, Rect } from '../paint/painter';
import { sampleHeight } from '../paint/painter';

export interface ArmorPiece {
  bone: string;
  shape: 'box' | 'capsule' | 'sphere';
  size: [number, number, number];   // box: w,h,d · capsule: radius, length, - · sphere: rx, ry, rz
  at: [number, number, number];     // offset from the bone (bone-local, rest pose)
  rot?: [number, number, number];   // degrees
  round?: number;                   // box corner radius
  material?: 'armor' | 'glow';
  mirror?: boolean;                 // also place a copy on the opposite side (L<->R, x negated)
  spring?: boolean | SpringParams;  // swing as a spring chain along the piece's local -y (coat tails, capes)
}

/** Spring-chain tuning (see src/character/springs.ts). Stiffness/drag are per 1/60 s step. */
export interface SpringParams { bones?: number; stiffness?: number; drag?: number; gravity?: number; radius?: number; colliders?: string[]; }
const HAIR_SPRING: Required<Omit<SpringParams, 'bones'>> = { stiffness: 0.22, drag: 0.05, gravity: 3, radius: 0.012, colliders: ['head', 'neck', 'chest', 'shoulderL', 'shoulderR', 'upperArmL', 'upperArmR'] };
const CLOTH_SPRING: Required<Omit<SpringParams, 'bones'>> = { stiffness: 0.12, drag: 0.04, gravity: 9.8, radius: 0.02, colliders: ['hips', 'thighL', 'thighR', 'shinL', 'shinR'] };

/** One hair clump: a tapered, flattened tube grown from the scalp. Angles in degrees; az 0 = front, +90 = right. */
export interface HairClump { az: number; el: number; length: number; width: number; droop?: number; outward?: number; curl?: number; }
/** Layered hairstyle: roots in rows inside a hairline, clumps flow from the crown, hug the skull, then fall. */
export interface HairStyle {
  bangs: number; sides: number; back: number;   // clump lengths (m) by region
  rows?: number;                                // root rows from crown to hairline
  density?: number;                             // roots per row at the widest row
  width?: number;                               // clump width multiplier (1 = just touching neighbours)
  volume?: number;                              // how far hair sits off the scalp (m)
  sweep?: number;                               // sideways sweep of bangs (deg, + = to the character's right)
  part?: number;                                // parting azimuth (deg, 0 = centre)
  hairlineFront?: number;                       // elevation of the front hairline (deg)
  curl?: number;                                // tip curl
}

export interface HairDef {
  preset?: 'swept' | 'spiky' | 'long' | 'layered' | 'none';
  style?: HairStyle;             // used by preset "layered"
  scalp?: { center: [number, number, number]; radii: [number, number, number] }; // head-bone space ellipsoid
  clumps?: HairClump[];          // extra clumps on top of the preset
  scale?: number;                // multiplies clump length/width
  cap?: boolean;                 // scalp shell (default true)
  seed?: number;
  spring?: false | SpringParams; // clumps swing on bone chains (default on; false = rigid to the head)
}

export interface CharacterDef {
  id: string;
  name?: string;
  description?: string;
  skeleton: string;
  voxel?: number;                   // meshing resolution in meters (smaller = more polys)
  bulk?: number;                    // multiplies all volume radii
  smooth?: number;                  // smooth-union blend radius (m)
  volumes?: VolumeDef[];            // extra volumes added to the skeleton's defaults
  replaceVolumes?: string[];        // drop the skeleton's default volumes for these bones (e.g. sculpt a custom head)
  radiusScale?: Record<string, number>; // per-bone radius multipliers (e.g. thick thighs)
  armor?: ArmorPiece[];
  materials: { body: string; armor: string; hair?: string };
  style?: 'pbr' | 'toon';         // toon = cel ramp + rim light + outline shell
  outline?: number;               // outline shell width (m), toon only
  hair?: HairDef;
  displacement?: number;            // meters of height-map displacement on the body
  armorTexelsPerMeter?: number;     // UV density on armor
}

export interface BuildResult {
  mesh: THREE.SkinnedMesh;
  skeleton: BuiltSkeleton;
  regions: Record<string, Rect>;
  /** Spring chains + colliders for SpringRig (chain bones are appended to the skeleton). */
  springs: SpringSet;
  stats: { vertices: number; triangles: number; bodyTriangles: number; armorTriangles: number; bones: number; springChains: number; maxInfluences: number; weightError: number; ms: number; bounds: number[] };
}

export interface BuildOptions {
  bodyHeight?: Baked | null;        // painter output for displacement
  materials?: THREE.Material[];     // [body, armor, glow]
}

/**
 * Atlas layout shared with the painter: the head gets a 2×2 block (faces need texels),
 * every other bone one tile, row-major with padding.
 */
export function atlasRegions(sk: SkeletonDef): Record<string, Rect> {
  const hasHead = sk.bones.some(b => b.name === 'head');
  const n = sk.bones.length + (hasHead ? 3 : 0), g = Math.ceil(Math.sqrt(n)), t = 1 / g, pad = t * 0.06;
  const out: Record<string, Rect> = {};
  const used = new Set<number>();
  if (hasHead) { out.head = [pad, pad, 2 * t - pad, 2 * t - pad]; [0, 1, g, g + 1].forEach(c => used.add(c)); }
  let cell = 0;
  for (const b of sk.bones) {
    if (b.name === 'head' && hasHead) continue;
    while (used.has(cell)) cell++;
    const cx = cell % g, cy = Math.floor(cell / g);
    out[b.name] = [cx * t + pad, cy * t + pad, (cx + 1) * t - pad, (cy + 1) * t - pad];
    used.add(cell);
  }
  return out;
}

/** Head-bone meters → head-region UV (0..1 within the head tile). Use it to place face decals. */
export const FACE_UV = { span: 0.3, y0: -0.05, uv: (x: number, y: number): [number, number] => [0.5 + x / 0.3, (y + 0.05) / 0.3] };

interface WVol { bone: string; a: THREE.Vector3; b: THREE.Vector3; r0: number; r1: number; ba: THREE.Vector3; l2: number; scale: THREE.Vector3 | null; mid: THREE.Vector3; sub: boolean; k: number; }

const smin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a: number, b: number, k: number) => -smin(-a, -b, k);

export function buildCharacter(def: CharacterDef, skDef: SkeletonDef, opts: BuildOptions = {}): BuildResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const base = buildSkeleton(skDef);
  const bulk = def.bulk ?? 1;
  const k = def.smooth ?? 0.035;
  const voxel = def.voxel ?? 0.018;

  // ---- Spring chains: extra bones appended to the skeleton (rest rotations are identity,
  // so a bone's local offset is just the world-space delta from its parent) ----
  const extra: BoneDef[] = [];
  const chains: SpringChainDef[] = [];
  const addChain = (prefix: string, parent: string, pts: THREE.Vector3[], p: Required<Omit<SpringParams, 'bones'>>) => {
    const names = pts.slice(0, -1).map((_, j) => `${prefix}_${j}`);
    let prev = base.restWorld.get(parent)!;
    names.forEach((name, j) => { extra.push({ name, parent: j ? names[j - 1] : parent, offset: pts[j].clone().sub(prev).toArray() }); prev = pts[j]; });
    const tip = pts[pts.length - 1].clone().sub(prev).toArray();
    chains.push({ bones: names, tip, stiffness: p.stiffness, drag: p.drag, gravity: p.gravity, radius: p.radius, colliders: p.colliders });
    return names;
  };
  const along = (path: THREE.Vector3[], n: number) => Array.from({ length: n + 1 }, (_, j) => {
    const f = (j / n) * (path.length - 1), i = Math.min(path.length - 2, Math.floor(f));
    return path[i].clone().lerp(path[i + 1], f - i);
  });
  // Hair: one chain per clump, built in head space and moved to the rest pose.
  type HairBuilt = HairPart & { chain?: string[] };
  let hair: HairBuilt[] = [];
  if (def.hair && def.hair.preset !== 'none' && base.byName.has('head')) {
    const headM = base.byName.get('head')!.matrixWorld;
    hair = hairGeometry(def.hair, (def.radiusScale?.head ?? 1) * bulk);
    const sp = def.hair.spring === false ? null : { ...HAIR_SPRING, ...(def.hair.spring ?? {}) };
    hair.forEach((h, i) => {
      h.geo.applyMatrix4(headM);
      if (!sp || !h.path) return;
      const path = h.path.map(p => p.clone().applyMatrix4(headM));
      const L = path.reduce((s, p, j) => s + (j ? p.distanceTo(path[j - 1]) : 0), 0);
      const n = (def.hair!.spring || undefined)?.bones ?? THREE.MathUtils.clamp(Math.round(L / 0.11), 2, 4);
      h.chain = addChain(`hair${i}`, 'head', along(path, n), sp);
    });
  }
  // Armor pieces (mirrors expanded); spring pieces get a chain from their top edge to the bottom.
  const pieces = [...(def.armor ?? [])];
  for (const p of def.armor ?? []) if (p.mirror) {
    const other = p.bone.endsWith('L') ? p.bone.slice(0, -1) + 'R' : p.bone.endsWith('R') ? p.bone.slice(0, -1) + 'L' : p.bone;
    pieces.push({ ...p, bone: other, at: [-p.at[0], p.at[1], p.at[2]], rot: p.rot ? [p.rot[0], -p.rot[1], -p.rot[2]] : undefined, mirror: false });
  }
  const pieceMatrix = (p: ArmorPiece, bone: THREE.Bone) => new THREE.Matrix4().compose(new THREE.Vector3(...p.at), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(p.rot ?? [0, 0, 0]).map(d => d * Math.PI / 180) as [number, number, number])), new THREE.Vector3(1, 1, 1)).premultiply(bone.matrixWorld);
  const pieceChains = new Map<number, { names: string[]; top: THREE.Vector3; bottom: THREE.Vector3 }>();
  pieces.forEach((p, i) => {
    const bone = base.byName.get(p.bone);
    if (!p.spring || !bone || p.shape === 'sphere') return;
    const sp = { ...CLOTH_SPRING, ...(typeof p.spring === 'object' ? p.spring : {}) };
    const h = p.shape === 'box' ? p.size[1] / 2 : p.size[1] / 2 + p.size[0];
    const m = pieceMatrix(p, bone);
    const top = new THREE.Vector3(0, h, 0).applyMatrix4(m), bottom = new THREE.Vector3(0, -h, 0).applyMatrix4(m);
    const n = (typeof p.spring === 'object' ? p.spring.bones : undefined) ?? THREE.MathUtils.clamp(Math.round(h * 2 / 0.12), 2, 5);
    pieceChains.set(i, { names: addChain(`cloth${i}`, p.bone, along([top, bottom], n), sp), top, bottom });
  });
  const sk = extra.length ? buildSkeleton({ ...skDef, bones: [...skDef.bones, ...extra] }) : base;

  // World-space (rest pose) volumes.
  const replaced = new Set(def.replaceVolumes ?? []);
  const allVolumes = [...skDef.volumes.filter(v => !replaced.has(v.bone)), ...(def.volumes ?? [])];
  const vols: WVol[] = allVolumes.map(v => {
    const bone = sk.byName.get(v.bone)!;
    const m = bone.matrixWorld;
    const a = new THREE.Vector3(...v.a).applyMatrix4(m), b = new THREE.Vector3(...v.b).applyMatrix4(m);
    const rs = (def.radiusScale?.[v.bone] ?? 1) * bulk;
    const ba = b.clone().sub(a);
    return { bone: v.bone, a, b, r0: v.r0 * rs, r1: v.r1 * rs, ba, l2: Math.max(1e-9, ba.lengthSq()), scale: v.scale ? new THREE.Vector3(...v.scale) : null, mid: a.clone().add(b).multiplyScalar(0.5), sub: v.op === 'subtract', k: v.k ?? k };
  });
  const addVols = vols.filter(v => !v.sub), subVols = vols.filter(v => v.sub);
  const volDist = (v: WVol, x: number, y: number, z: number): number => {
    if (v.scale) {
      // Ellipsoid-ish: evaluate in a squashed space around the volume's midpoint.
      const s = v.scale, m = v.mid;
      const d = capDist(v, m.x + (x - m.x) / s.x, m.y + (y - m.y) / s.y, m.z + (z - m.z) / s.z);
      return d * Math.min(s.x, s.y, s.z);
    }
    return capDist(v, x, y, z);
  };
  const capDist = (v: WVol, x: number, y: number, z: number) => {
    const px = x - v.a.x, py = y - v.a.y, pz = z - v.a.z;
    const t = Math.min(1, Math.max(0, (px * v.ba.x + py * v.ba.y + pz * v.ba.z) / v.l2));
    const dx = px - v.ba.x * t, dy = py - v.ba.y * t, dz = pz - v.ba.z * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) - (v.r0 + (v.r1 - v.r0) * t);
  };
  const sdf = (x: number, y: number, z: number) => {
    let d = Infinity;
    for (const v of addVols) d = d === Infinity ? volDist(v, x, y, z) : smin(d, volDist(v, x, y, z), v.k);
    for (const v of subVols) d = smax(d, -volDist(v, x, y, z), v.k);
    return d;
  };

  // ---- Surface nets ----
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const v of addVols) { const r = Math.max(v.r0, v.r1) * (v.scale ? Math.max(v.scale.x, v.scale.y, v.scale.z) : 1) + v.k + voxel * 2; for (const p of [v.a, v.b]) { lo.min(p.clone().subScalar(r)); hi.max(p.clone().addScalar(r)); } }
  const nx = Math.ceil((hi.x - lo.x) / voxel), ny = Math.ceil((hi.y - lo.y) / voxel), nz = Math.ceil((hi.z - lo.z) / voxel);
  const sx = nx + 1, sy = ny + 1;
  const F = new Float32Array(sx * sy * (nz + 1));
  for (let z = 0; z <= nz; z++) for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    F[(z * sy + y) * sx + x] = sdf(lo.x + x * voxel, lo.y + y * voxel, lo.z + z * voxel);
  }
  const cellIdx = new Int32Array(nx * ny * nz).fill(-1);
  const pos: number[] = [];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const corner = new Float32Array(8);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) {
      const cx = x + (c & 1), cy = y + ((c >> 1) & 1), cz = z + ((c >> 2) & 1);
      corner[c] = F[(cz * sy + cy) * sx + cx];
      if (corner[c] < 0) mask |= 1 << c;
    }
    if (mask === 0 || mask === 255) continue;
    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (const [e0, e1] of EDGES) {
      const d0 = corner[e0], d1 = corner[e1];
      if ((d0 < 0) === (d1 < 0)) continue;
      const t = d0 / (d0 - d1);
      ax += (e0 & 1) + (((e1 & 1) - (e0 & 1)) * t);
      ay += ((e0 >> 1) & 1) + ((((e1 >> 1) & 1) - ((e0 >> 1) & 1)) * t);
      az += ((e0 >> 2) & 1) + ((((e1 >> 2) & 1) - ((e0 >> 2) & 1)) * t);
      cnt++;
    }
    cellIdx[(z * ny + y) * nx + x] = pos.length / 3;
    pos.push(lo.x + (x + ax / cnt) * voxel, lo.y + (y + ay / cnt) * voxel, lo.z + (z + az / cnt) * voxel);
  }
  const quads: number[] = [];
  const cell = (x: number, y: number, z: number) => cellIdx[(z * ny + y) * nx + x];
  for (let z = 1; z < nz; z++) for (let y = 1; y < ny; y++) for (let x = 1; x < nx; x++) {
    const f0 = F[(z * sy + y) * sx + x] < 0;
    // Edges along +x, +y, +z from this grid point; each is shared by 4 cells.
    if (x < nx && (F[(z * sy + y) * sx + x + 1] < 0) !== f0) quads.push(cell(x, y - 1, z - 1), cell(x, y, z - 1), cell(x, y, z), cell(x, y - 1, z), f0 ? 1 : 0);
    if (y < ny && (F[(z * sy + y + 1) * sx + x] < 0) !== f0) quads.push(cell(x - 1, y, z - 1), cell(x - 1, y, z), cell(x, y, z), cell(x, y, z - 1), f0 ? 1 : 0);
    if (z < nz && (F[((z + 1) * sy + y) * sx + x] < 0) !== f0) quads.push(cell(x - 1, y - 1, z), cell(x, y - 1, z), cell(x, y, z), cell(x - 1, y, z), f0 ? 1 : 0);
  }

  // Refine vertices onto the surface and get smooth normals from the field gradient.
  const nv = pos.length / 3;
  const nor = new Float32Array(nv * 3);
  const e = voxel * 0.5;
  for (let i = 0; i < nv; i++) {
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    for (let it = 0; it < 2; it++) {
      const d = sdf(x, y, z);
      const gx = sdf(x + e, y, z) - sdf(x - e, y, z), gy = sdf(x, y + e, z) - sdf(x, y - e, z), gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const gl = Math.hypot(gx, gy, gz) || 1;
      x -= (gx / gl) * d; y -= (gy / gl) * d; z -= (gz / gl) * d;
      if (it === 1) { nor[i * 3] = gx / gl; nor[i * 3 + 1] = gy / gl; nor[i * 3 + 2] = gz / gl; }
    }
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
  }

  // Triangles, oriented so the face normal agrees with the field gradient.
  const tris: number[] = [];
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), pc = new THREE.Vector3(), fn = new THREE.Vector3();
  const pushTri = (a: number, b: number, c: number) => {
    pa.fromArray(pos, a * 3); pb.fromArray(pos, b * 3); pc.fromArray(pos, c * 3);
    fn.subVectors(pb, pa).cross(pc.clone().sub(pa));
    const dot = fn.x * (nor[a * 3] + nor[b * 3] + nor[c * 3]) + fn.y * (nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1]) + fn.z * (nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2]);
    if (dot >= 0) tris.push(a, b, c); else tris.push(a, c, b);
  };
  for (let q = 0; q < quads.length; q += 5) {
    const [a, b, c, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue;
    pushTri(a, b, c); pushTri(a, c, d);
  }

  // ---- Skin weights: analytic bone glow from each bone's volumes ----
  const boneIndex = new Map(sk.def.bones.map((b, i) => [b.name, i]));
  const skinIdx = new Uint16Array(nv * 4), skinW = new Float32Array(nv * 4);
  const dominant = new Int32Array(nv);
  const blend = 0.05;
  let maxInf = 0;
  for (let i = 0; i < nv; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const per = new Map<number, number>();
    let dmin = Infinity;
    const ds = addVols.map(v => { const d = volDist(v, x, y, z); dmin = Math.min(dmin, d); return d; });
    addVols.forEach((v, j) => {
      const w = Math.max(0, 1 - (ds[j] - dmin) / blend);
      if (w > 0) { const bi = boneIndex.get(v.bone)!; per.set(bi, Math.max(per.get(bi) ?? 0, w * w)); }
    });
    const top = [...per.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([bi, w], s) => { skinIdx[i * 4 + s] = bi; skinW[i * 4 + s] = w / sum; });
    maxInf = Math.max(maxInf, top.length);
    dominant[i] = top[0]?.[0] ?? 0;
  }

  // ---- Per-bone cylindrical atlas UVs (vertices split where regions meet) ----
  const regions = atlasRegions(skDef);
  const restW = (n: string) => sk.restWorld.get(n)!;
  const frames = skDef.bones.map(b => {
    const head = restW(b.name);
    const c = childOf(skDef, b.name);
    let axis = c ? restW(c).clone().sub(head) : new THREE.Vector3(...b.offset);
    if (axis.lengthSq() < 1e-6) axis = new THREE.Vector3(0, 1, 0);
    const len = axis.length();
    axis.normalize();
    let ref = new THREE.Vector3(0, 0, -1);
    if (Math.abs(ref.dot(axis)) > 0.9) ref = new THREE.Vector3(0, 1, 0);
    ref.sub(axis.clone().multiplyScalar(ref.dot(axis))).normalize();
    const side = new THREE.Vector3().crossVectors(axis, ref);
    return { head, axis, ref, side, len };
  });
  // The face is front-projected (orthographic, uniform scale) so decals stay undistorted;
  // other bones use cylindrical mapping around their axis.
  const headIdx = skDef.bones.findIndex(b => b.name === 'head');
  // Face texture space: u = 0.5 + x / 0.3, v = (y + 0.05) / 0.3 in head-bone meters (exported as FACE_UV).
  const headSpan = FACE_UV.span;
  const cyl = (vi: number, bi: number) => {
    const f = frames[bi];
    if (bi === headIdx) {
      const p = new THREE.Vector3().fromArray(pos, vi * 3).sub(f.head);
      return [0.5 + p.x / headSpan, p.y];
    }
    const p = new THREE.Vector3().fromArray(pos, vi * 3).sub(f.head);
    const t = p.dot(f.axis);
    const ang = Math.atan2(p.dot(f.side), p.dot(f.ref)) / (2 * Math.PI) + 0.5;
    return [ang, t];
  };
  // Region of each triangle = most-weighted bone over its three vertices.
  const triRegion = new Int32Array(tris.length / 3);
  const tRange = skDef.bones.map(() => [Infinity, -Infinity]);
  for (let t = 0; t < tris.length / 3; t++) {
    const score = new Map<number, number>();
    for (let c = 0; c < 3; c++) { const v = tris[t * 3 + c]; for (let s = 0; s < 4; s++) score.set(skinIdx[v * 4 + s], (score.get(skinIdx[v * 4 + s]) ?? 0) + skinW[v * 4 + s]); }
    const r = [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
    triRegion[t] = r;
    for (let c = 0; c < 3; c++) { const [, tt] = cyl(tris[t * 3 + c], r); tRange[r][0] = Math.min(tRange[r][0], tt); tRange[r][1] = Math.max(tRange[r][1], tt); }
  }
  const outPos: number[] = [], outNor: number[] = [], outUv: number[] = [], outSi: number[] = [], outSw: number[] = [], outIdx: number[] = [];
  const remap = new Map<number, number>();
  for (let t = 0; t < tris.length / 3; t++) {
    const r = triRegion[t], rect = regions[skDef.bones[r].name];
    const uvs = [0, 1, 2].map(c => cyl(tris[t * 3 + c], r));
    // Keep triangles that straddle the cylinder seam contiguous.
    const us = uvs.map(u => u[0]);
    if (r !== headIdx && Math.max(...us) - Math.min(...us) > 0.5) uvs.forEach(u => { if (u[0] < 0.5) u[0] += 1; });
    for (let c = 0; c < 3; c++) {
      const v = tris[t * 3 + c];
      const wrapped = uvs[c][0] > 1 ? 1 : 0;
      const key = (v * 64 + r) * 2 + wrapped;
      let ni = remap.get(key);
      if (ni === undefined) {
        ni = outPos.length / 3;
        remap.set(key, ni);
        outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
        outNor.push(nor[v * 3], nor[v * 3 + 1], nor[v * 3 + 2]);
        const [tmin, tmax] = tRange[r];
        const uu = r === headIdx ? uvs[c][0] : uvs[c][0] * 0.94 + 0.03;
        const vv = r === headIdx ? THREE.MathUtils.clamp((uvs[c][1] + 0.05) / headSpan, 0, 1) : (uvs[c][1] - tmin) / Math.max(1e-6, tmax - tmin);
        outUv.push(rect[0] + uu * (rect[2] - rect[0]), rect[1] + vv * (rect[3] - rect[1]));
        for (let s = 0; s < 4; s++) { outSi.push(skinIdx[v * 4 + s]); outSw.push(skinW[v * 4 + s]); }
      }
      outIdx.push(ni);
    }
  }
  // Displacement from the painted height map ("tessellation" baked into the dense mesh).
  if (opts.bodyHeight && def.displacement) {
    for (let i = 0; i < outPos.length / 3; i++) {
      const h = sampleHeight(opts.bodyHeight, outUv[i * 2], outUv[i * 2 + 1]) - 0.5;
      for (let c = 0; c < 3; c++) outPos[i * 3 + c] += outNor[i * 3 + c] * h * 2 * def.displacement;
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(outUv, 2));
  body.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(outSi, 4));
  body.setAttribute('skinWeight', new THREE.Float32BufferAttribute(outSw, 4));
  body.setIndex(outIdx);
  if (opts.bodyHeight && def.displacement) body.computeVertexNormals();

  // ---- Armor ----
  // Skin a geometry to a spring chain: each vertex's t (root→tip) blends adjacent chain bones.
  const skinChain = (g: THREE.BufferGeometry, anchor: string, chain: string[], tOf: (i: number) => number) => {
    const n = g.attributes.position.count, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const ids = chain.map(c => boneIndex.get(c)!), a = boneIndex.get(anchor)!;
    for (let i = 0; i < n; i++) chainWeights(tOf(i), chain.length).forEach(([j, w], s) => { si[i * 4 + s] = j < 0 ? a : ids[j]; sw[i * 4 + s] = w; });
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  };
  const rigid = (g: THREE.BufferGeometry, bi: number) => {
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, j) => (j % 4 === 0 ? bi : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, j) => (j % 4 === 0 ? 1 : 0)), 4));
  };
  const armorGeos: THREE.BufferGeometry[] = [], glowGeos: THREE.BufferGeometry[] = [];
  const density = def.armorTexelsPerMeter ?? 3;
  pieces.forEach((p, pi) => {
    const bone = sk.byName.get(p.bone);
    if (!bone) return;
    const pc = pieceChains.get(pi);
    let g: THREE.BufferGeometry;
    // Spring pieces need rows along their length to bend.
    if (pc && p.shape === 'box') g = new THREE.BoxGeometry(p.size[0], p.size[1], p.size[2], 1, pc.names.length * 6, 1);
    else if (pc) g = new THREE.CapsuleGeometry(p.size[0], p.size[1], 6, 16, pc.names.length * 6);
    else if (p.shape === 'box') g = new RoundedBoxGeometry(p.size[0], p.size[1], p.size[2], 3, Math.min(p.round ?? 0.015, Math.min(...p.size) * 0.45));
    else if (p.shape === 'capsule') g = new THREE.CapsuleGeometry(p.size[0], p.size[1], 6, 16);
    else { g = new THREE.SphereGeometry(1, 24, 16); g.scale(p.size[0], p.size[1], p.size[2]); }
    g = g.index ? g.toNonIndexed() : g;
    g.applyMatrix4(pieceMatrix(p, bone));
    // Box-projected UVs at a constant texel density (consistent panel scale across pieces).
    const P = g.attributes.position, N = g.attributes.normal;
    const uv = new Float32Array(P.count * 2);
    for (let i = 0; i < P.count; i++) {
      const ax = Math.abs(N.getX(i)), ay = Math.abs(N.getY(i)), az = Math.abs(N.getZ(i));
      const [a, b] = ax > ay && ax > az ? [P.getZ(i), P.getY(i)] : ay > az ? [P.getX(i), P.getZ(i)] : [P.getX(i), P.getY(i)];
      uv[i * 2] = a * density; uv[i * 2 + 1] = b * density;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (pc) {
      const ax = pc.bottom.clone().sub(pc.top), l2 = ax.lengthSq(), v = new THREE.Vector3();
      skinChain(g, p.bone, pc.names, i => v.fromBufferAttribute(P, i).sub(pc.top).dot(ax) / l2);
    } else rigid(g, boneIndex.get(p.bone)!);
    (p.material === 'glow' ? glowGeos : armorGeos).push(g);
  });
  // ---- Hair: the cap is rigid to the head; each clump is skinned to its chain (uv.v = root→tip) ----
  const hairGeos: THREE.BufferGeometry[] = [];
  for (const h of hair) {
    if (h.chain) { const uv = h.geo.attributes.uv; skinChain(h.geo, 'head', h.chain, i => uv.getY(i)); }
    else rigid(h.geo, boneIndex.get('head')!);
    hairGeos.push(h.geo.index ? h.geo.toNonIndexed() : h.geo);
  }
  // Capsule colliders for the chains: the body volumes of every bone a chain lists.
  const wanted = new Set(chains.flatMap(c => c.colliders));
  const colliders: SpringColliderDef[] = [];
  allVolumes.forEach((v, i) => {
    if (!wanted.has(v.bone) || v.op === 'subtract') return;
    const rs = (def.radiusScale?.[v.bone] ?? 1) * bulk;
    colliders.push({ name: `${v.bone}:${i}`, bone: v.bone, a: v.a, b: v.b, r: Math.max(v.r0, v.r1) * rs });
  });
  for (const c of chains) c.colliders = colliders.filter(k => c.colliders.includes(k.bone)).map(k => k.name);

  // Material slots: 0 = body (atlas), 1 = armor (tiling plates), 2 = glow (visors, lights), 3 = hair.
  const sources: [THREE.BufferGeometry, number][] = [[body, 0]];
  if (armorGeos.length) sources.push([mergeGeometries(armorGeos.map(g => { g.deleteAttribute('normal'); g.computeVertexNormals(); return g; }))!, 1]);
  if (glowGeos.length) sources.push([mergeGeometries(glowGeos)!, 2]);
  if (hairGeos.length) sources.push([mergeGeometries(hairGeos)!, 3]);
  const merged = mergeGeometries(sources.map(([g]) => (g.index ? g.toNonIndexed() : g)), true)!;
  merged.groups.forEach((gr, i) => { gr.materialIndex = sources[i][1]; });
  // Default slots must cover every group (body, armor, glow, hair) or three.js silently skips groups.
  const mats = opts.materials ?? [new THREE.MeshStandardMaterial({ color: 0x9aa2ad }), new THREE.MeshStandardMaterial({ color: 0x6a717b, metalness: 0.6, roughness: 0.4 }), new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x9fe8ff }), new THREE.MeshStandardMaterial({ color: 0x4b3a66 })];
  const mesh = new THREE.SkinnedMesh(merged, mats);
  mesh.add(sk.root);
  mesh.bind(sk.skeleton);
  mesh.frustumCulled = false;

  const bodyTris = outIdx.length / 3;
  const armorTris = (merged.attributes.position.count - outIdx.length) / 3;
  // Weight sanity: every vertex's weights should sum to 1.
  let werr = 0;
  const sw = merged.attributes.skinWeight;
  for (let i = 0; i < sw.count; i++) werr = Math.max(werr, Math.abs(sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i) - 1));
  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    mesh, skeleton: sk, regions, springs: { chains, colliders },
    stats: {
      vertices: merged.attributes.position.count, triangles: merged.attributes.position.count / 3, bodyTriangles: bodyTris, armorTriangles: armorTris,
      bones: sk.def.bones.length, springChains: chains.length, maxInfluences: maxInf, weightError: +werr.toFixed(5), ms: Math.round(t1 - t0),
      bounds: [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z].map(v => +v.toFixed(3)),
    },
  };
}

// ---------------------------------------------------------------- hair

const HAIR_PRESETS: Record<string, HairClump[]> = {
  swept: [
    ...[120, 145, 170, 195, 220, 245].map((az, i) => ({ az, el: 18 + (i % 2) * 14, length: 0.34, width: 0.075, droop: 0.95, outward: 0.25, curl: i % 2 ? 0.12 : -0.12 })),
    { az: -78, el: 8, length: 0.28, width: 0.055, droop: 1, outward: 0.15, curl: 0.05 },
    { az: 78, el: 8, length: 0.28, width: 0.055, droop: 1, outward: 0.15, curl: -0.05 },
    ...[-38, -14, 10, 32].map((az, i) => ({ az, el: 48, length: 0.17, width: 0.055, droop: 0.8, outward: 0.18, curl: (i - 1.5) * 0.12 })),
    { az: 175, el: 82, length: 0.14, width: 0.022, droop: -0.35, outward: 0.3, curl: 0.8 },
  ],
  spiky: [
    ...Array.from({ length: 14 }, (_, i) => ({ az: i * 26 + 100, el: 25 + (i % 3) * 18, length: 0.2, width: 0.06, droop: -0.1, outward: 0.8, curl: 0.15 })),
    ...[-30, 0, 30].map(az => ({ az, el: 50, length: 0.15, width: 0.05, droop: 0.5, outward: 0.4, curl: 0.1 })),
  ],
  long: [
    ...[110, 135, 160, 180, 200, 225, 250].map((az, i) => ({ az, el: 15 + (i % 2) * 12, length: 0.62, width: 0.08, droop: 1.1, outward: 0.15, curl: i % 2 ? 0.08 : -0.08 })),
    { az: -75, el: 5, length: 0.45, width: 0.06, droop: 1.1, outward: 0.1, curl: 0.04 },
    { az: 75, el: 5, length: 0.45, width: 0.06, droop: 1.1, outward: 0.1, curl: -0.04 },
    ...[-30, -8, 14, 34].map((az, i) => ({ az, el: 50, length: 0.16, width: 0.05, droop: 0.85, outward: 0.15, curl: (i - 1.5) * 0.1 })),
  ],
};

export interface HairPart { geo: THREE.BufferGeometry; path: THREE.Vector3[] | null; }

/** Hair geometry in head-bone space (rest pose): scalp cap + tapered clumps with their centerlines. UV: u around, v root→tip. */
export function hairGeometry(h: HairDef, headScale: number): HairPart[] {
  if (h.preset === 'layered') return layeredHair(h);
  const out: HairPart[] = [];
  // The head is a vertical capsule (two sphere centers 7cm apart), so model the scalp as an ellipsoid.
  const c = new THREE.Vector3(0, 0.115, -0.003);
  const R = 0.1 * headScale;
  const ey = (0.035 + R) / R;
  const scalp = (d: THREE.Vector3, k: number) => c.clone().add(new THREE.Vector3(d.x * R * k, d.y * R * ey * k, d.z * R * k));
  if (h.cap !== false) {
    const cap = new THREE.SphereGeometry(R * 1.09, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.6);
    cap.rotateX(0.38); // sweep the hairline back from the forehead
    cap.scale(1.02, ey, 1.04);
    cap.translate(c.x, c.y + 0.006, c.z + 0.01);
    cap.computeVertexNormals();
    out.push({ geo: cap, path: null });
  }
  const clumps = [...(HAIR_PRESETS[h.preset ?? 'swept'] ?? []), ...(h.clumps ?? [])];
  const sc = h.scale ?? 1;
  const rnd = (i: number) => { const x = Math.sin(i * 12.9898 + (h.seed ?? 1) * 78.233) * 43758.5453; return x - Math.floor(x); };
  clumps.forEach((cl, idx) => {
    const az = (cl.az + (rnd(idx) - 0.5) * 6) * Math.PI / 180, el = cl.el * Math.PI / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    const root = scalp(dir, 0.97);
    const L = cl.length * sc * (0.92 + rnd(idx + 7) * 0.16), W = cl.width * sc;
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const S = 12, ring = 8;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= S; k++) {
      const t = k / S;
      pts.push(root.clone()
        .addScaledVector(dir, L * t * (cl.outward ?? 0.3))
        .add(new THREE.Vector3(0, -L * (cl.droop ?? 0.8) * Math.pow(t, 1.5), 0))
        .addScaledVector(side, L * (cl.curl ?? 0) * t * t));
    }
    const pos: number[] = [], uv: number[] = [], idxs: number[] = [];
    for (let k = 0; k <= S; k++) {
      const t = k / S;
      const T = pts[Math.min(S, k + 1)].clone().sub(pts[Math.max(0, k - 1)]).normalize();
      let B = new THREE.Vector3().crossVectors(T, dir);
      if (B.lengthSq() < 1e-6) B = side.clone();
      B.normalize();
      const N = new THREE.Vector3().crossVectors(B, T).normalize();
      const w = W * Math.pow(1 - t, 0.75) + 0.0015, th = w * 0.42;
      for (let r = 0; r <= ring; r++) {
        const a = (r / ring) * Math.PI * 2;
        const p = pts[k].clone().addScaledVector(B, Math.cos(a) * w).addScaledVector(N, Math.sin(a) * th);
        pos.push(p.x, p.y, p.z);
        uv.push(r / ring, t);
      }
    }
    for (let k = 0; k < S; k++) for (let r = 0; r < ring; r++) {
      const a = k * (ring + 1) + r, b = a + ring + 1;
      idxs.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idxs);
    g.computeVertexNormals();
    out.push({ geo: g, path: pts });
  });
  return out;
}

// ---------------------------------------------------------------- layered hair

/** Tube-ish ribbon along a path: flattened cross-section lying against `normals` (flat against the head). */
function ribbon(path: THREE.Vector3[], normals: THREE.Vector3[], width: number, thick: number): THREE.BufferGeometry {
  const ring = 6, S = path.length - 1;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let k = 0; k <= S; k++) {
    const t = k / S;
    const T = path[Math.min(S, k + 1)].clone().sub(path[Math.max(0, k - 1)]).normalize();
    const N = normals[k].clone().sub(T.clone().multiplyScalar(normals[k].dot(T))).normalize();
    const B = new THREE.Vector3().crossVectors(T, N).normalize();
    const w = width * (0.35 + 0.65 * Math.pow(1 - t, 0.6)) * (t > 0.85 ? (1 - t) / 0.15 * 0.9 + 0.1 : 1) + 0.001;
    const th = thick * (1 - 0.7 * t) + 0.0008;
    for (let r = 0; r <= ring; r++) {
      const a = (r / ring) * Math.PI * 2;
      const p = path[k].clone().addScaledVector(B, Math.cos(a) * w).addScaledVector(N, Math.sin(a) * th);
      pos.push(p.x, p.y, p.z);
      uv.push(r / ring, t);
    }
  }
  for (let k = 0; k < S; k++) for (let r = 0; r < ring; r++) { const a = k * (ring + 1) + r, b = a + ring + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function layeredHair(h: HairDef): HairPart[] {
  const st: HairStyle = { rows: 7, density: 16, width: 1.25, volume: 0.012, sweep: 0, part: 0, hairlineFront: 28, curl: 0.15, ...(h.style ?? { bangs: 0.12, sides: 0.2, back: 0.3 }) };
  const c = new THREE.Vector3(...(h.scalp?.center ?? [0, 0.125, 0.012]));
  const R = new THREE.Vector3(...(h.scalp?.radii ?? [0.085, 0.095, 0.1]));
  const rnd = (i: number) => { const x = Math.sin(i * 12.9898 + (h.seed ?? 1) * 78.233) * 43758.5453; return x - Math.floor(x); };
  const D2R = Math.PI / 180;
  const dirOf = (az: number, el: number) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  const onScalp = (d: THREE.Vector3, off: number) => { const n = new THREE.Vector3(d.x / R.x, d.y / R.y, d.z / R.z).normalize(); return { p: c.clone().add(new THREE.Vector3(d.x * R.x, d.y * R.y, d.z * R.z)).addScaledVector(n, off), n }; };
  /** Project a point back onto the (inflated) scalp ellipsoid. */
  const project = (p: THREE.Vector3, off: number) => {
    const q = p.clone().sub(c);
    const d = new THREE.Vector3(q.x / R.x, q.y / R.y, q.z / R.z).normalize();
    return onScalp(d, off);
  };
  // Hairline elevation by azimuth: high at the forehead, dipping at the sideburns, low at the nape.
  const hairline = (az: number) => {
    const back = (1 - Math.cos(az)) / 2;                       // 0 front … 1 back
    const side = Math.pow(Math.abs(Math.sin(az)), 4);          // sideburn dip around ±90°
    return (st.hairlineFront! * (1 - back) + -38 * back - 22 * side * (1 - back * 0.6)) * D2R;
  };
  const lengthAt = (az: number) => {
    const f = 1 - Math.abs(((az / D2R + 540) % 360) - 180) / 180;  // 0 = back … 1 = front (az 0 = front)
    if (f > 0.75) return st.sides + (st.bangs - st.sides) * (f - 0.75) / 0.25;
    if (f > 0.35) return st.back + (st.sides - st.back) * (f - 0.35) / 0.4;
    return st.back;
  };
  const crown = c.clone().add(new THREE.Vector3(0, R.y, R.z * 0.35));
  const out: HairPart[] = [];

  // Underlayer: follows the skull exactly, only inside the hairline (so no cap bump, no bald gaps).
  {
    const nu = 48, nv = 18, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const az = (i / nu) * Math.PI * 2 - Math.PI, hl = hairline(az);
      const el = hl + (Math.PI / 2 - hl) * (1 - j / nv);
      const { p } = onScalp(dirOf(az, el), st.volume! * 0.35);
      pos.push(p.x, p.y, p.z); uv.push(i / nu, 0.04);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + nu + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    out.push({ geo: g, path: null });
  }

  // Clumps: rows from the crown down to the hairline.
  let n = 0;
  for (let row = 0; row < st.rows!; row++) {
    const f = (row + 0.5) / st.rows!;
    const count = Math.max(4, Math.round(st.density! * Math.sin(Math.PI * (0.25 + 0.75 * f) / 2)));
    for (let i = 0; i < count; i++) {
      const az = ((i + (row % 2) * 0.5) / count) * Math.PI * 2 - Math.PI + (rnd(n) - 0.5) * 0.15;
      const hl = hairline(az);
      const el = Math.PI / 2 - (Math.PI / 2 - hl) * f * 0.92;
      const root = onScalp(dirOf(az, el), st.volume! * 0.5);
      const L = lengthAt(az) * (0.85 + rnd(n + 3) * 0.3) * (0.6 + 0.4 * f);
      const isBang = Math.abs(az) < 1.0 && f > 0.5;
      // Flow: away from the crown (and the part), along the scalp.
      let flow = root.p.clone().sub(crown);
      if (isBang) flow.add(new THREE.Vector3(Math.sin((st.sweep! + (st.part ?? 0)) * D2R) * 0.05, -0.02, -0.02));
      flow.sub(root.n.clone().multiplyScalar(flow.dot(root.n))).normalize();
      const steps = 10, step = L / steps;
      const path = [root.p.clone()], norms = [root.n.clone()];
      let p = root.p.clone(), dir = flow.clone();
      for (let k = 1; k <= steps; k++) {
        p = p.clone().addScaledVector(dir, step);
        const below = p.y < c.y - R.y * 0.15;               // past the widest point: let it fall
        if (!below) {
          const pr = project(p, st.volume! * (0.6 + 0.6 * k / steps));
          p = pr.p;
          const tangent = dir.clone().sub(pr.n.clone().multiplyScalar(dir.dot(pr.n))).normalize();
          dir = tangent.lerp(new THREE.Vector3(0, -1, 0), 0.08).normalize();
          norms.push(pr.n);
        } else {
          dir.lerp(new THREE.Vector3(0, -1, 0), 0.35).normalize();
          // Keep falling hair outside the head/neck silhouette.
          const q = p.clone().sub(c), rr = Math.hypot(q.x / R.x, q.z / R.z);
          if (rr < 1.05 && p.y > c.y - R.y * 1.6) { const k2 = 1.05 / Math.max(rr, 1e-3); p.x = c.x + q.x * k2; p.z = c.z + q.z * k2; }
          norms.push(new THREE.Vector3(q.x, 0, q.z).normalize());
        }
        // Bangs stop above the eyes.
        if (isBang && p.y < c.y - R.y * 0.1) { p.y = c.y - R.y * 0.1; }
        path.push(p.clone());
      }
      // Tip curl toward the face/neck.
      const tip = path[path.length - 1], back = path[path.length - 2];
      tip.add(tip.clone().sub(back).cross(new THREE.Vector3(0, 1, 0)).multiplyScalar((st.curl ?? 0) * (rnd(n + 9) - 0.5)));
      const spacing = (2 * Math.PI * Math.cos(el) * Math.max(R.x, R.z)) / count;
      const g = ribbon(path, norms, Math.max(0.012, spacing * 0.55 * st.width!), 0.006);
      out.push({ geo: g, path: L > 0.17 ? path : null }); // only longer clumps get spring chains
      n++;
    }
  }
  return out;
}
