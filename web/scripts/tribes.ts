// Local reference extractor for original Starsiege: Tribes assets (Darkstar engine).
// Output goes to web/reference/tribes/ which is gitignored: the original assets are
// Dynamix/Sierra property (freeware release) — use them to *measure and compare*,
// never ship them or derived copies in the game.
//
// Usage: npm run tribes -- list <file.vol>
//        npm run tribes -- extract <file.vol> [--filter regex]
//        npm run tribes -- textures [--world lush]      (PBMP → PNG, needs palette support)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WEB, flags } from './lib';

export const TRIBES_RAW = process.env.TRIBES_RAW ?? '/Users/shiva/Projects/TribesRaw/base/baseres';
export const OUT = join(WEB, 'reference', 'tribes');

export interface VolEntry { name: string; data: Uint8Array; compression: number; }

/** PVOL: 'PVOL' u32 footerOffset; VBLK blocks; footer 'vols' u32 len + names; 'voli' u32 len + 17-byte entries. */
export function readVol(path: string): VolEntry[] {
  const d = readFileSync(path);
  if (d.toString('latin1', 0, 4) !== 'PVOL') throw new Error(`${path}: not a PVOL archive`);
  const footer = d.readUInt32LE(4);
  if (d.toString('latin1', footer, footer + 4) !== 'vols') throw new Error('missing vols table');
  const strLen = d.readUInt32LE(footer + 4);
  const strs = d.subarray(footer + 8, footer + 8 + strLen);
  let p = footer + 8 + strLen;
  while (d.toString('latin1', p, p + 4) !== 'voli') p++; // padded to alignment
  const idxLen = d.readUInt32LE(p + 4);
  const out: VolEntry[] = [];
  for (let k = 0; k < idxLen / 17; k++) {
    const e = p + 8 + k * 17;
    const nameOff = d.readUInt32LE(e + 4), dataOff = d.readUInt32LE(e + 8), size = d.readUInt32LE(e + 12), comp = d[e + 16];
    const name = strs.toString('latin1', nameOff, strs.indexOf(0, nameOff));
    out.push({ name, data: d.subarray(dataOff + 8, dataOff + 8 + size), compression: comp }); // skip 'VBLK' + len
  }
  return out;
}

// ---------------------------------------------------------------- DTS meshes → GLB (local ghost reference)

/**
 * Bake one detail level of a shape in its default pose into a static GLB: one primitive per
 * material, Y-up, metres. `textures` maps lower-case bitmap names to PNG bytes.
 */
export async function dtsToGLB(s: DtsShape, textures: Map<string, Uint8Array>, detail = 0): Promise<{ glb: Uint8Array; tris: number; height: number }> {
  const { Document, NodeIO } = await import('@gltf-transform/core');
  // World transforms of every node from the default pose.
  const world: { q: THREE.Quaternion; t: THREE.Vector3 }[] = [];
  const nodeWorld = (i: number): { q: THREE.Quaternion; t: THREE.Vector3 } => {
    if (world[i]) return world[i];
    const d = s.transforms[s.nodes[i].defT];
    const lq = quatToY(d.q), lt = vecToY(d.t);
    const par = s.nodes[i].parent;
    if (par < 0 || par === i) return (world[i] = { q: lq, t: lt });
    const pw = nodeWorld(par);
    return (world[i] = { q: pw.q.clone().multiply(lq), t: lt.applyQuaternion(pw.q).add(pw.t) });
  };
  const inDetail = new Set<number>();
  const root = s.details[detail]?.root ?? 0;
  const visit = (i: number) => { inDetail.add(i); s.nodes.forEach((n, j) => { if (n.parent === i && j !== i) visit(j); }); };
  visit(root);

  const byMat = new Map<number, { pos: number[]; uv: number[] }>();
  for (const o of s.objects) {
    if (!inDetail.has(o.node) || /^bounds/i.test(o.name)) continue;
    const m = s.meshes[o.mesh];
    if (!m) continue;
    const w = nodeWorld(o.node), off = vecToY(o.offset);
    const P = m.positions.map(v => vecToY(v as [number, number, number]).add(off).applyQuaternion(w.q).add(w.t));
    for (const f of m.faces) {
      if (f.v.some(v => !P[v])) continue;
      const g = byMat.get(f.mat) ?? { pos: [], uv: [] };
      byMat.set(f.mat, g);
      for (const c of [0, 2, 1]) { // Darkstar winds clockwise; glTF wants counter-clockwise
        g.pos.push(...P[f.v[c]].toArray());
        const t = m.uvs[f.t[c]] ?? [0, 0];
        g.uv.push(t[0], t[1]);
      }
    }
  }
  const doc = new Document();
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh('shape');
  let tris = 0, minY = Infinity, maxY = -Infinity;
  for (const [mi, g] of byMat) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.computeVertexNormals();
    for (let k = 1; k < g.pos.length; k += 3) { minY = Math.min(minY, g.pos[k]); maxY = Math.max(maxY, g.pos[k]); }
    const name = (s.materials[mi] ?? '').toLowerCase();
    const mat = doc.createMaterial(name || `mat${mi}`).setMetallicFactor(0).setRoughnessFactor(0.8);
    const png = textures.get(name);
    if (png) mat.setBaseColorTexture(doc.createTexture(name).setImage(png).setMimeType('image/png'));
    else mat.setBaseColorFactor([0.6, 0.6, 0.62, 1]);
    mesh.addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(geo.getAttribute('normal').array as Float32Array).setBuffer(buffer))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buffer))
      .setMaterial(mat));
    tris += g.pos.length / 9;
  }
  doc.createScene('shape').addChild(doc.createNode('shape').setMesh(mesh));
  return { glb: await new NodeIO().writeBinary(doc), tris, height: maxY - minY };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags: F, pos } = flags(rest);
  if (cmd === 'list') {
    for (const e of readVol(pos[0])) console.log(`${e.name.padEnd(32)} ${String(e.data.length).padStart(9)}  ${Buffer.from(e.data.subarray(0, 4)).toString('latin1')}`);
  } else if (cmd === 'extract') {
    const re = F.filter ? new RegExp(F.filter, 'i') : null;
    const dir = join(OUT, 'raw', basename(pos[0], '.vol'));
    mkdirSync(dir, { recursive: true });
    let n = 0;
    for (const e of readVol(pos[0])) if (!re || re.test(e.name)) { writeFileSync(join(dir, e.name.replace(/[\\/]/g, '_')), e.data); n++; }
    console.log(`extracted ${n} files → ${dir}`);
  } else if (cmd !== 'reference') console.log('commands: list <vol> | extract <vol> [--filter re] | reference [--world lush]');
}

// ---------------------------------------------------------------- palettes & textures

export interface Palette { index: number; type: number; rgb: Uint8Array; } // rgb: 256*3

/** PL98: 'PL98' i32 n, shadeShift, hazeLevels, hazeColor; u8[32]; then n × (u8 rgbx[1024], u32 index, u32 type). */
export function readPalettes(buf: Uint8Array): Palette[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString('latin1', 0, 4) !== 'PL98') throw new Error('not a PL98 palette');
  const n = b.readInt32LE(4);
  const out: Palette[] = [];
  for (let k = 0; k < n; k++) {
    const o = 52 + k * 1032;
    const rgb = new Uint8Array(768);
    for (let c = 0; c < 256; c++) { rgb[c * 3] = b[o + c * 4]; rgb[c * 3 + 1] = b[o + c * 4 + 1]; rgb[c * 3 + 2] = b[o + c * 4 + 2]; }
    out.push({ index: b.readUInt32LE(o + 1024), type: b.readUInt32LE(o + 1028), rgb });
  }
  return out;
}

/** PBMP: chunks head/data/DETL/PiDX. 8-bit indices, rows top-down, stride padded to 4. Returns RGBA (mip 0). */
export function decodePBMP(buf: Uint8Array, palettes: Palette[]): { w: number; h: number; rgba: Uint8Array; transparent: boolean } {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString('latin1', 0, 4) !== 'PBMP') throw new Error('not PBMP');
  let p = 8, w = 0, h = 0, bpp = 8, attr = 0, pidx = 0xffffffff;
  let data: Buffer | null = null;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), size = b.readUInt32LE(p + 4) & 0x7fffffff;
    const d = b.subarray(p + 8, p + 8 + size);
    if (id === 'head') { w = d.readUInt32LE(4); h = d.readUInt32LE(8); bpp = d.readUInt32LE(12); attr = d.readUInt32LE(16); }
    else if (id === 'data') data = d;
    else if (id === 'PiDX') pidx = d.readUInt32LE(0);
    p += 8 + size + (size & 1);
  }
  if (!data || bpp !== 8) throw new Error(`unsupported PBMP (bpp ${bpp})`);
  const pal = palettes.find(q => q.index === pidx) ?? palettes[0];
  const stride = (w + 3) & ~3, rgba = new Uint8Array(w * h * 4), transparent = (attr & 1) !== 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ci = data[y * stride + x], o = (y * w + x) * 4;
    rgba[o] = pal.rgb[ci * 3]; rgba[o + 1] = pal.rgb[ci * 3 + 1]; rgba[o + 2] = pal.rgb[ci * 3 + 2];
    rgba[o + 3] = transparent && ci === 0 ? 0 : 255;
  }
  return { w, h, rgba, transparent };
}

// ---------------------------------------------------------------- TS::Shape (v8) skeleton + animation

export interface DtsShape {
  version: number;
  nodes: { name: string; parent: number; nSub: number; firstSub: number; defT: number }[];
  sequences: { name: string; cyclic: boolean; duration: number }[];
  subs: { seq: number; nKeys: number; firstKey: number }[];
  keys: { pos: number; value: number }[];
  transforms: { q: [number, number, number, number]; t: [number, number, number] }[];
  names: string[];
  details: { root: number; size: number }[];
  objects: { name: string; mesh: number; node: number; offset: [number, number, number] }[];
  meshes: CelMesh[];
  materials: string[];
}

/** TS::CelAnimMesh v3: packed u8 vertices dequantised per frame (scale, origin), float UVs, 3-corner faces. */
export interface CelMesh { positions: number[][]; uvs: number[][]; faces: { v: number[]; t: number[]; mat: number }[]; }

/** Clean-room reader for the v8 header and animation tables (meshes/materials are skipped). */
export function readDts(buf: Uint8Array): DtsShape {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.toString('latin1', 0, 4) !== 'PERS') throw new Error('not a persistent object');
  const nameLen = b.readInt16LE(8);
  let p = 10 + ((nameLen + 1) & ~1);
  const cls = b.toString('latin1', 10, 10 + nameLen);
  if (cls !== 'TS::Shape') throw new Error(`expected TS::Shape, got ${cls}`);
  const version = b.readInt32LE(p); p += 4;
  if (version !== 8) throw new Error(`only TS::Shape v8 supported (got v${version})`);
  const i32 = () => { const v = b.readInt32LE(p); p += 4; return v; };
  const i16 = () => { const v = b.readInt16LE(p); p += 2; return v; };
  const f32 = () => { const v = b.readFloatLE(p); p += 4; return v; };
  const [nNodes, nSeq, nSub, nKeys, nT, nNames, nObj, nDet, nMesh] = Array.from({ length: 9 }, i32);
  const nTrans = i32(), nTrig = i32();
  void nMesh;
  p += 4 * 4 + 6 * 4; // radius, center[3], boundsMin[3], boundsMax[3]
  const nodesRaw = Array.from({ length: nNodes }, () => ({ name: i16(), parent: i16(), nSub: i16(), firstSub: i16(), defT: i16() }));
  const seqRaw = Array.from({ length: nSeq }, () => { const r = { name: i32(), cyclic: i32() !== 0, duration: f32() }; p += 5 * 4; return r; });
  const subs = Array.from({ length: nSub }, () => ({ seq: i16(), nKeys: i16(), firstKey: i16() }));
  const keys = Array.from({ length: nKeys }, () => { const pos = f32(); const value = b.readUInt16LE(p); p += 4; return { pos, value }; });
  const transforms = Array.from({ length: nT }, () => {
    const q = [i16() / 32767, i16() / 32767, i16() / 32767, i16() / 32767] as [number, number, number, number];
    return { q, t: [f32(), f32(), f32()] as [number, number, number] };
  });
  const names = Array.from({ length: nNames }, () => { const s = b.toString('latin1', p, p + 24); p += 24; return s.slice(0, s.indexOf('\0') >= 0 ? s.indexOf('\0') : 24); });
  const objects = Array.from({ length: nObj }, () => {
    const name = i16(); i16(); const mesh = i32(); const node = i16(); i16();
    const offset = [f32(), f32(), f32()] as [number, number, number]; i16(); i16();
    return { name: names[name] ?? `obj${name}`, mesh, node, offset };
  });
  const details = Array.from({ length: nDet }, () => ({ root: i32(), size: f32() }));
  void nTrans; void nTrig;
  // Meshes and the material list follow as nested persistent objects; walk them block by block.
  const meshes: CelMesh[] = [], materials: string[] = [];
  let q = b.indexOf('PERS', p);
  while (q >= 0 && q + 10 < b.length) {
    const size = b.readInt32LE(q + 4), nl = b.readInt16LE(q + 8), kind = b.toString('latin1', q + 10, q + 10 + nl);
    const d = q + 10 + ((nl + 1) & ~1) + 4;
    if (kind === 'TS::CelAnimMesh') meshes.push(readCelMesh(b, d));
    else if (kind === 'TS::MaterialList') {
      const nDetail = b.readInt32LE(d), nMat = b.readInt32LE(d + 4);
      for (let k = 0; k < nMat * Math.max(1, nDetail) && d + 8 + k * 64 + 48 <= q + 8 + size; k++) {
        const raw = b.toString('latin1', d + 8 + k * 64 + 16, d + 8 + k * 64 + 48);
        materials.push(raw.slice(0, raw.indexOf('\0') >= 0 ? raw.indexOf('\0') : 32));
      }
    }
    q += 8 + size;
  }
  return {
    version,
    nodes: nodesRaw.map(n => ({ ...n, name: names[n.name] ?? `node${n.name}` })),
    sequences: seqRaw.map(s => ({ ...s, name: names[s.name] ?? `seq${s.name}` })),
    subs, keys, transforms, names, details, objects, meshes, materials,
  };
}

function readCelMesh(b: Buffer, p: number): CelMesh {
  const [nVerts, vpf, nTex, nFaces, nFrames] = Array.from({ length: 6 }, (_, k) => b.readInt32LE(p + k * 4));
  p += 28; // six counts + radius
  const packed = b.subarray(p, p + nVerts * 4); p += nVerts * 4;
  const uvs = Array.from({ length: nTex }, (_, k) => [b.readFloatLE(p + k * 8), b.readFloatLE(p + k * 8 + 4)]); p += nTex * 8;
  const faces = Array.from({ length: nFaces }, (_, k) => {
    const o = p + k * 28, r = (j: number) => b.readInt32LE(o + j * 4);
    return { v: [r(0), r(2), r(4)], t: [r(1), r(3), r(5)], mat: r(6) };
  });
  p += nFaces * 28;
  // First frame only: these are rigid per-node parts; multi-frame meshes are cel animations (flags, pulses).
  const f = nFrames > 0 ? p : -1;
  const first = f >= 0 ? b.readInt32LE(f) : 0;
  const sc = f >= 0 ? [1, 2, 3].map(k => b.readFloatLE(f + k * 4)) : [1, 1, 1];
  const or = f >= 0 ? [4, 5, 6].map(k => b.readFloatLE(f + k * 4)) : [0, 0, 0];
  const positions: number[][] = [];
  for (let k = first; k < Math.min(nVerts, first + vpf); k++) positions.push([0, 1, 2].map(a => or[a] + packed[k * 4 + a] * sc[a]));
  return { positions, uvs, faces };
}

// ---------------------------------------------------------------- DTS → our SkeletonDef + MotionDef (reference only)
import * as THREE from 'three';
import type { SkeletonDef } from '../src/anim/skeleton';
import { unwrapEuler } from '../src/anim/motion';
import type { MotionDef, Key3 } from '../src/anim/motion';

/** Darkstar is Z-up with row-vector quaternions: conjugate, then rebase (x, y, z) → (x, z, -y). */
const vecToY = (t: [number, number, number]) => new THREE.Vector3(t[0], t[2], -t[1]);
const quatToY = (q: [number, number, number, number]) => new THREE.Quaternion(-q[0], -q[2], q[1], q[3]).normalize();
const clean = (n: string) => n.replace(/\s*\d+$/, '').trim();

export function dtsToReference(s: DtsShape, id: string, detail = 0): { skeleton: SkeletonDef; motions: MotionDef[] } {
  const root = s.details[detail]?.root ?? 0;
  // Nodes in this detail level's subtree, minus mesh-attachment leaves.
  const keep = new Set<number>();
  const visit = (i: number) => { keep.add(i); s.nodes.forEach((n, j) => { if (n.parent === i && !/^submesh/i.test(n.name)) visit(j); }); };
  visit(root);
  const order = [...keep].sort((a, b) => a - b);
  const name = (i: number) => clean(s.nodes[i].name).replace(/\s+/g, '_');
  const skeleton: SkeletonDef = {
    id: `${id}-skeleton`,
    description: 'Converted from original Tribes DTS for local comparison only. Not for distribution.',
    bones: order.map(i => ({ name: name(i), parent: i === root ? null : name(s.nodes[i].parent), offset: vecToY(s.transforms[s.nodes[i].defT].t).toArray().map(v => +v.toFixed(5)) as [number, number, number] })),
    volumes: [],
  };
  const sample = (node: number, seq: number, pos: number, cyclic: boolean) => {
    const n = s.nodes[node];
    for (let k = 0; k < n.nSub; k++) {
      const sub = s.subs[n.firstSub + k];
      if (sub.seq !== seq) continue;
      const ks = s.keys.slice(sub.firstKey, sub.firstKey + sub.nKeys);
      if (!ks.length) break;
      let i = 0;
      while (i < ks.length - 1 && ks[i + 1].pos <= pos) i++;
      const a = ks[i], b = i + 1 < ks.length ? ks[i + 1] : cyclic ? ks[0] : ks[i];
      const span = b === a ? 1 : ((b.pos - a.pos + (b.pos < a.pos ? 1 : 0)) || 1);
      const f = b === a ? 0 : THREE.MathUtils.clamp((pos - a.pos) / span, 0, 1);
      const ta = s.transforms[a.value], tb = s.transforms[b.value];
      return { q: quatToY(ta.q).slerp(quatToY(tb.q), f), t: vecToY(ta.t).lerp(vecToY(tb.t), f) };
    }
    const d = s.transforms[n.defT];
    return { q: quatToY(d.q), t: vecToY(d.t) };
  };
  const motions: MotionDef[] = s.sequences.map((sq, si) => {
    const fps = 30, n = Math.max(2, Math.round(sq.duration * fps));
    const tracks: MotionDef['tracks'] = {};
    const e = new THREE.Euler();
    for (const i of order) {
      const rot: Key3[] = [], pos: Key3[] = [];
      const off = vecToY(s.transforms[s.nodes[i].defT].t);
      for (let k = 0; k <= n; k++) {
        const t = (k / n) * sq.duration;
        const r = sample(i, si, k / n, sq.cyclic);
        e.setFromQuaternion(r.q, 'XYZ');
        rot.push([+t.toFixed(4), ...[e.x, e.y, e.z].map(v => +(v * 180 / Math.PI).toFixed(2))] as Key3);
        pos.push([+t.toFixed(4), ...r.t.clone().sub(off).toArray().map(v => +v.toFixed(5))] as Key3);
      }
      tracks[name(i)] = { rot: unwrapEuler(rot), pos: pos.some(k => Math.abs(k[1]) + Math.abs(k[2]) + Math.abs(k[3]) > 1e-4) ? pos : undefined };
    }
    // Make locomotion in-place: remove the pelvis node's net horizontal travel, record it as speed.
    let speed = 0;
    const pelvis = tracks['VICON'] ?? tracks[name(order[1])];
    if (pelvis?.pos && sq.duration > 0) {
      const a = pelvis.pos[0], z = pelvis.pos[pelvis.pos.length - 1];
      const vx = (z[1] - a[1]) / sq.duration, vz = (z[3] - a[3]) / sq.duration;
      speed = Math.hypot(vx, vz);
      pelvis.pos = pelvis.pos.map(k => [k[0], +(k[1] - vx * k[0]).toFixed(5), k[2], +(k[3] - vz * k[0]).toFixed(5)] as Key3);
    }
    return { id: `${id}-${sq.name.replace(/\s+/g, '-')}`, skeleton: skeleton.id, description: `Original Tribes '${sq.name}' (reference only)`, fps, duration: sq.duration, loop: sq.cyclic, speed: +speed.toFixed(3), tracks };
  });
  return { skeleton, motions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags: F } = flags(rest);
  if (cmd === 'meshes') {
    // Every shape in Entities.vol → reference/meshes/<name>.glb, textured with the chosen world palette.
    const ents = readVol(join(TRIBES_RAW, 'shapes', 'Entities.vol'));
    const world = F.world ?? 'lush';
    const pals = readPalettes(readVol(join(TRIBES_RAW, 'world', `${world}World.vol`)).find(e => e.name === `${world}.day.ppl`)!.data);
    const { encodePNG } = await import('./lib');
    const texCache = new Map<string, Uint8Array>();
    const bmps = new Map(ents.filter(e => /\.bmp$/i.test(e.name)).map(e => [e.name.toLowerCase(), e]));
    const dir = join(WEB, 'reference', 'meshes');
    mkdirSync(dir, { recursive: true });
    const filter = new RegExp(F.filter ?? '.', 'i');
    const index: { id: string; tris: number; height: number }[] = [];
    for (const e of ents.filter(x => /\.dts$/i.test(x.name) && filter.test(x.name))) {
      try {
        const shape = readDts(e.data);
        for (const m of shape.materials) {
          const k = m.toLowerCase();
          if (texCache.has(k) || !bmps.has(k)) continue;
          try { const img = decodePBMP(bmps.get(k)!.data, pals); texCache.set(k, encodePNG(img.rgba, img.w, img.h)); } catch { /* unsupported bitmap */ }
        }
        const { glb, tris, height } = await dtsToGLB(shape, texCache);
        if (!tris) continue;
        const id = basename(e.name).replace(/\.dts$/i, '').toLowerCase();
        writeFileSync(join(dir, `${id}.glb`), glb);
        index.push({ id, tris, height: +height.toFixed(2) });
      } catch (err) { if (F.verbose) console.warn(`${e.name}: ${(err as Error).message}`); }
    }
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 1));
    console.log(`${index.length} shapes → reference/meshes/ (local only, never commit or ship)`);
  }
  if (cmd === 'reference') {
    // Build the local reference library: armor skeletons + animations, and decoded textures.
    const ents = readVol(join(TRIBES_RAW, 'shapes', 'Entities.vol'));
    const world = F.world ?? 'lush';
    const pals = readPalettes(readVol(join(TRIBES_RAW, 'world', `${world}World.vol`)).find(e => e.name === `${world}.day.ppl`)!.data);
    const refDir = join(WEB, 'reference');
    for (const d of ['skeletons', 'motions', 'textures']) mkdirSync(join(refDir, d), { recursive: true });
    for (const armor of ['larmor', 'marmor', 'harmor']) {
      const e = ents.find(x => x.name.toLowerCase() === `${armor}.dts`);
      if (!e) continue;
      const { skeleton, motions } = dtsToReference(readDts(e.data), `tribes-${armor}`);
      writeFileSync(join(refDir, 'skeletons', `${skeleton.id}.json`), JSON.stringify(skeleton, null, 1));
      for (const m of motions) writeFileSync(join(refDir, 'motions', `${m.id}.json`), JSON.stringify(m));
      console.log(`${armor}: ${skeleton.bones.length} bones, ${motions.length} sequences`);
    }
    const { encodePNG } = await import('./lib');
    let nt = 0;
    for (const e of ents) {
      if (!/armor|disc|grenade|chain|turret|station|generator|flag/i.test(e.name) || !/\.bmp$/i.test(e.name)) continue;
      try {
        const img = decodePBMP(e.data, pals);
        writeFileSync(join(refDir, 'textures', e.name.replace(/\.bmp$/i, '.png')), encodePNG(img.rgba, img.w, img.h));
        nt++;
      } catch { /* MS BMP or unsupported depth: skip */ }
    }
    console.log(`${nt} textures decoded with ${world}.day palette → reference/textures/`);
  }
}
