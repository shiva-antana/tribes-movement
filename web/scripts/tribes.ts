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
}

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
  p += nObj * 28;
  const details = Array.from({ length: nDet }, () => ({ root: i32(), size: f32() }));
  void nTrans; void nTrig;
  return {
    version,
    nodes: nodesRaw.map(n => ({ ...n, name: names[n.name] ?? `node${n.name}` })),
    sequences: seqRaw.map(s => ({ ...s, name: names[s.name] ?? `seq${s.name}` })),
    subs, keys, transforms, names, details,
  };
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
