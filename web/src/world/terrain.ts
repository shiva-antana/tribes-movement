import * as THREE from 'three';
import { Simplex2, mulberry32, clamp, smoothstep, lerp } from '../noise';
import { Biome } from './biomes';
import { makeTerrainMaterial } from './terrainShader';

export const GRID = 512;          // cells per side
export const CELL = 6;            // meters per cell
export const SIZE = GRID * CELL;  // world size in meters (3072m)
const VERTS = GRID + 1;
const DMG_RES = 1024;
const CHUNK = 32;

export interface Site { x: number; z: number; y: number; }
/** A finite resource deposit. Extractors drain it; motherlodes are richer and contested. */
export interface Deposit extends Site { amount: number; max: number; richness: number; }

export interface TerrainOverrides {
  deposits?: { x: number; z: number; amount?: number; richness?: number }[];
  bases?: { x: number; z: number }[];
}

/**
 * Procedural heightfield with permanent deformation: craters from explosions and
 * graded roads/causeways from terraforming. A 1024² surface map records scorch (R)
 * and road (B) so the shader can draw them.
 */
export class Terrain {
  readonly heights = new Float32Array(VERTS * VERTS);
  readonly base = new Float32Array(VERTS * VERTS);
  readonly mesh: THREE.Mesh;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;
  readonly bases: Site[] = [];
  readonly deposits: Deposit[] = [];
  private scorch = new Float32Array(DMG_RES * DMG_RES);
  private road = new Float32Array(DMG_RES * DMG_RES);
  private dmgData = new Uint8Array(DMG_RES * DMG_RES * 4);
  readonly dmgTex: THREE.DataTexture;
  private surfaceDirty = false;
  private uploadTimer = 0;
  /** Bumped whenever the shape of the land changes (minimap etc. can redraw). */
  version = 0;

  constructor(readonly biome: Biome, readonly seed: number, private overrides: TerrainOverrides = {}) {
    const s = new Simplex2(seed);
    for (let j = 0; j < VERTS; j++) {
      for (let i = 0; i < VERTS; i++) {
        this.heights[j * VERTS + i] = biome.height(s, i / GRID, j / GRID);
      }
    }
    this.placeSites(s);
    this.base.set(this.heights);

    this.dmgTex = new THREE.DataTexture(this.dmgData, DMG_RES, DMG_RES, THREE.RGBAFormat);
    this.dmgTex.magFilter = THREE.LinearFilter;
    this.dmgTex.minFilter = THREE.LinearFilter;
    this.dmgTex.needsUpdate = true;

    this.geometry = this.buildGeometry();
    this.material = makeTerrainMaterial(biome, this.dmgTex, SIZE);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  // ---------- generation ----------

  private placeSites(s: Simplex2) {
    const rnd = mulberry32(this.seed * 7 + 3);
    const b = this.biome;
    const flip = rnd() < 0.5 ? 1 : -1;
    for (let t = 0; t < 2; t++) {
      const u = t === 0 ? 0.2 : 0.8;
      const v = 0.5 + (t === 0 ? 1 : -1) * flip * (0.06 + rnd() * 0.1);
      const ov = this.overrides.bases?.[t];
      const x = ov ? ov.x : (u - 0.5) * SIZE, z = ov ? ov.z : (v - 0.5) * SIZE;
      let y: number;
      if (b.basesUnderwater) {
        y = b.seaLevel - 24;
        this.flatten(x, z, 70, 150, y);
        // A small island shoulder next to the base so the base tower breaches the surface.
        this.raiseMound(x + (x < 0 ? -120 : 120), z, 140, b.seaLevel + 25);
      } else {
        y = Math.max(this.sampleRaw(x, z), b.seaLevel + 18);
        this.flatten(x, z, 75, 170, y);
      }
      this.bases.push({ x, z, y });
    }
    const addDeposit = (x: number, z: number, amount: number, richness: number) => {
      // Deposits in open water get a shoal so they can be built on (and fought over).
      if (!b.frozen && this.sampleRaw(x, z) < b.seaLevel + 2) this.raiseMound(x, z, 50 + richness * 15, b.seaLevel + 4);
      const h = Math.max(this.sampleRaw(x, z), b.frozen ? b.seaLevel : -Infinity);
      this.flatten(x, z, 10 + richness * 4, 35 + richness * 10, h);
      this.deposits.push({ x, z, y: this.sampleRaw(x, z), amount, max: amount, richness });
    };
    if (this.overrides.deposits) {
      for (const d of this.overrides.deposits) addDeposit(d.x, d.z, d.amount ?? (d.richness ?? 1) * 700, d.richness ?? 1);
      return;
    }
    // Motherlodes: rich, finite, in the contested middle of the map.
    let tries = 0;
    while (this.deposits.length < 2 && tries++ < 400) {
      const x = (rnd() - 0.5) * SIZE * 0.25, z = (rnd() - 0.5) * SIZE * 0.5;
      if (this.deposits.some(p => Math.hypot(p.x - x, p.z - z) < 400)) continue;
      addDeposit(x, z, 2600, 3);
    }
    // Standard deposits spread across the map, away from bases.
    tries = 0;
    while (this.deposits.length < 12 && tries++ < 600) {
      const u = 0.12 + rnd() * 0.76, v = 0.12 + rnd() * 0.76;
      const x = (u - 0.5) * SIZE, z = (v - 0.5) * SIZE;
      if (this.bases.some(p => Math.hypot(p.x - x, p.z - z) < 380)) continue;
      if (this.deposits.some(p => Math.hypot(p.x - x, p.z - z) < 260)) continue;
      if (this.sampleRaw(x, z) < b.seaLevel + 2 && !b.frozen) continue;
      addDeposit(x, z, 700, 1);
    }
    void s;
  }

  private sampleRaw(x: number, z: number) {
    const i = clamp(Math.round(x / CELL + GRID / 2), 0, GRID);
    const j = clamp(Math.round(z / CELL + GRID / 2), 0, GRID);
    return this.heights[j * VERTS + i];
  }

  private flatten(x: number, z: number, inner: number, outer: number, y: number) {
    this.forRadius(x, z, outer, (idx, d) => {
      const t = smoothstep(outer, inner, d);
      this.heights[idx] = lerp(this.heights[idx], y, t);
    });
  }

  private raiseMound(x: number, z: number, r: number, top: number) {
    this.forRadius(x, z, r, (idx, d) => {
      const t = smoothstep(r, r * 0.25, d);
      this.heights[idx] = Math.max(this.heights[idx], lerp(this.heights[idx], top, t));
    });
  }

  private forRadius(x: number, z: number, r: number, fn: (idx: number, d: number) => void) {
    const ci = x / CELL + GRID / 2, cj = z / CELL + GRID / 2, rc = r / CELL;
    const i0 = Math.max(0, Math.floor(ci - rc)), i1 = Math.min(GRID, Math.ceil(ci + rc));
    const j0 = Math.max(0, Math.floor(cj - rc)), j1 = Math.min(GRID, Math.ceil(cj + rc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot((i - ci) * CELL, (j - cj) * CELL);
      if (d <= r) fn(j * VERTS + i, d);
    }
  }

  private buildGeometry() {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(VERTS * VERTS * 3);
    const nor = new Float32Array(VERTS * VERTS * 3);
    for (let j = 0; j < VERTS; j++) for (let i = 0; i < VERTS; i++) {
      const k = (j * VERTS + i) * 3;
      pos[k] = (i - GRID / 2) * CELL;
      pos[k + 1] = this.heights[j * VERTS + i];
      pos[k + 2] = (j - GRID / 2) * CELL;
    }
    const idx = new Uint32Array(GRID * GRID * 6);
    let p = 0;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      const a = j * VERTS + i, b = a + 1, c = a + VERTS, d = c + 1;
      // Triangles (a,c,b) and (b,c,d): diagonal b–c, matching heightAt().
      idx[p++] = a; idx[p++] = c; idx[p++] = b;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.writeNormals(nor, 0, 0, GRID, GRID);
    return g;
  }

  private writeNormals(nor: Float32Array, i0: number, j0: number, i1: number, j1: number) {
    const H = this.heights;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const hl = H[j * VERTS + Math.max(0, i - 1)], hr = H[j * VERTS + Math.min(GRID, i + 1)];
      const hd = H[Math.max(0, j - 1) * VERTS + i], hu = H[Math.min(GRID, j + 1) * VERTS + i];
      let nx = hl - hr, ny = 2 * CELL, nz = hd - hu;
      const l = Math.hypot(nx, ny, nz);
      const k = (j * VERTS + i) * 3;
      nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
    }
  }

  // ---------- queries ----------

  heightAt(x: number, z: number): number {
    const fx0 = clamp(x / CELL + GRID / 2, 0, GRID - 1e-4);
    const fz0 = clamp(z / CELL + GRID / 2, 0, GRID - 1e-4);
    const i = Math.floor(fx0), j = Math.floor(fz0);
    const fx = fx0 - i, fz = fz0 - j;
    const H = this.heights, a = j * VERTS + i;
    const h00 = H[a], h10 = H[a + 1], h01 = H[a + VERTS], h11 = H[a + VERTS + 1];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  normalAt(x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = CELL * 0.5;
    const hl = this.heightAt(x - e, z), hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e), hu = this.heightAt(x, z + e);
    return out.set(hl - hr, 2 * e, hd - hu).normalize();
  }

  /** Surface the player stands on: terrain, or ice when the biome's water is frozen. */
  groundAt(x: number, z: number): { y: number; ice: boolean } {
    const h = this.heightAt(x, z);
    if (this.biome.frozen && h < this.biome.seaLevel) return { y: this.biome.seaLevel, ice: true };
    return { y: h, ice: false };
  }

  inBounds(x: number, z: number, margin = 0) {
    const half = SIZE / 2 - margin;
    return x > -half && x < half && z > -half && z < half;
  }

  /** March a segment against the heightfield. Returns hit distance fraction or -1. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): number {
    const step = 2;
    let prevT = 0;
    let prevAbove = o.y - this.groundAt(o.x, o.z).y;
    if (prevAbove < 0) return 0;
    for (let t = step; t <= maxDist + step; t += step) {
      const tt = Math.min(t, maxDist);
      const x = o.x + d.x * tt, y = o.y + d.y * tt, z = o.z + d.z * tt;
      const above = y - this.groundAt(x, z).y;
      if (above < 0) {
        // refine
        let lo = prevT, hi = tt;
        for (let k = 0; k < 6; k++) {
          const m = (lo + hi) / 2;
          const yy = o.y + d.y * m;
          if (yy - this.groundAt(o.x + d.x * m, o.z + d.z * m).y < 0) hi = m; else lo = m;
        }
        return hi;
      }
      prevT = tt; prevAbove = above;
      if (tt >= maxDist) break;
    }
    void prevAbove;
    return -1;
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    d.divideScalar(len);
    const t = this.raycast(a, d, len - 1);
    return t < 0;
  }

  // ---------- deformation & healing ----------

  crater(x: number, z: number, radius: number, depth: number) {
    const r = radius;
    this.forRadius(x, z, r, (idx, d) => {
      const t = 1 - d / r;
      const prof = t * t * (3 - 2 * t);
      // Permanent. Capped at 30m below the original surface so the world stays bounded.
      this.heights[idx] = Math.max(this.base[idx] - 30, this.heights[idx] - depth * prof);
    });
    this.refreshArea(x - r, z - r, x + r, z + r);
    this.scorchAt(x, z, radius * 1.4, 1);
  }

  /**
   * Terraform a road (or causeway across water) from a to b: a graded, slope-limited
   * corridor `width` wide with blended shoulders. Permanent. Returns earth moved in m³.
   */
  gradeRoad(a: THREE.Vector3, b: THREE.Vector3, width: number, apply = true): { volume: number; endY: number } {
    const sea = this.biome.seaLevel;
    const minY = this.biome.frozen ? -Infinity : sea + 1.5;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const y0 = Math.max(this.heightAt(a.x, a.z), minY);
    let y1 = Math.max(this.heightAt(b.x, b.z), minY);
    const maxGrade = 0.22; // ~12°: tanks climb it at speed
    y1 = THREE.MathUtils.clamp(y1, y0 - len * maxGrade, y0 + len * maxGrade);
    const dx = (b.x - a.x) / (len || 1), dz = (b.z - a.z) / (len || 1);
    const half = width / 2, shoulder = 10;
    const pad = half + shoulder;
    const x0 = Math.min(a.x, b.x) - pad, x1 = Math.max(a.x, b.x) + pad;
    const z0 = Math.min(a.z, b.z) - pad, z1 = Math.max(a.z, b.z) + pad;
    const i0 = Math.max(0, Math.floor(x0 / CELL + GRID / 2)), i1 = Math.min(GRID, Math.ceil(x1 / CELL + GRID / 2));
    const j0 = Math.max(0, Math.floor(z0 / CELL + GRID / 2)), j1 = Math.min(GRID, Math.ceil(z1 / CELL + GRID / 2));
    let volume = 0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i - GRID / 2) * CELL, z = (j - GRID / 2) * CELL;
      const along = THREE.MathUtils.clamp((x - a.x) * dx + (z - a.z) * dz, 0, len);
      const px = a.x + dx * along, pz = a.z + dz * along;
      const off = Math.hypot(x - px, z - pz);
      if (off > pad) continue;
      const target = y0 + (y1 - y0) * (len ? along / len : 0);
      const w = off <= half ? 1 : smoothstep(pad, half, off);
      const k = j * VERTS + i;
      const nh = lerp(this.heights[k], target, w);
      volume += Math.abs(nh - this.heights[k]) * CELL * CELL;
      if (apply) this.heights[k] = nh;
    }
    if (apply) {
      this.refreshArea(x0, z0, x1, z1);
      this.paintRoad(a, b, half);
    }
    return { volume, endY: y1 };
  }

  private paintRoad(a: THREE.Vector3, b: THREE.Vector3, half: number) {
    const steps = Math.ceil(a.distanceTo(b) / 2);
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      this.paint(this.road, x, z, half, 1, true);
    }
  }

  /** 0..1 how much of a graded road is under this point. */
  roadAt(x: number, z: number) {
    const i = clamp(Math.round((x / SIZE + 0.5) * DMG_RES), 0, DMG_RES - 1);
    const j = clamp(Math.round((z / SIZE + 0.5) * DMG_RES), 0, DMG_RES - 1);
    return this.road[j * DMG_RES + i];
  }

  scorchAt(x: number, z: number, radius: number, amount: number) {
    this.paint(this.scorch, x, z, radius, amount, false);
  }

  private paint(buf: Float32Array, x: number, z: number, radius: number, amount: number, hard: boolean) {
    const px = (x / SIZE + 0.5) * DMG_RES, pz = (z / SIZE + 0.5) * DMG_RES;
    const pr = (radius / SIZE) * DMG_RES + 1;
    const i0 = Math.max(0, Math.floor(px - pr)), i1 = Math.min(DMG_RES - 1, Math.ceil(px + pr));
    const j0 = Math.max(0, Math.floor(pz - pr)), j1 = Math.min(DMG_RES - 1, Math.ceil(pz + pr));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i - px, j - pz) / pr;
      if (d < 1) {
        const k = j * DMG_RES + i;
        const v = hard ? amount * smoothstep(1, 0.7, d) : amount * (1 - d * d);
        buf[k] = Math.min(1, Math.max(buf[k], hard ? v : buf[k] + v));
        this.dmgData[k * 4] = this.scorch[k] * 255;
        this.dmgData[k * 4 + 2] = this.road[k] * 255;
      }
    }
    this.surfaceDirty = true;
  }

  /** Rebuild mesh positions/normals over a world-space rectangle after the heights changed. */
  private refreshArea(x0: number, z0: number, x1: number, z1: number) {
    const ci0 = Math.floor(clamp(x0 / CELL + GRID / 2, 0, GRID) / CHUNK);
    const ci1 = Math.floor(clamp(x1 / CELL + GRID / 2, 0, GRID) / CHUNK);
    const cj0 = Math.floor(clamp(z0 / CELL + GRID / 2, 0, GRID) / CHUNK);
    const cj1 = Math.floor(clamp(z1 / CELL + GRID / 2, 0, GRID) / CHUNK);
    for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) this.refreshChunk(ci, cj);
    this.version++;
  }

  private refreshChunk(ci: number, cj: number) {
    const pos = this.geometry.attributes.position as THREE.BufferAttribute;
    const nor = this.geometry.attributes.normal as THREE.BufferAttribute;
    const i0 = ci * CHUNK, j0 = cj * CHUNK;
    const i1 = Math.min(GRID, i0 + CHUNK), j1 = Math.min(GRID, j0 + CHUNK);
    const P = pos.array as Float32Array;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      P[(j * VERTS + i) * 3 + 1] = this.heights[j * VERTS + i];
    }
    this.writeNormals(nor.array as Float32Array, Math.max(0, i0 - 1), Math.max(0, j0 - 1), Math.min(GRID, i1 + 1), Math.min(GRID, j1 + 1));
    pos.needsUpdate = true;
    nor.needsUpdate = true;
  }

  update(dt: number) {
    // Nothing heals. Just batch surface-map uploads to the GPU.
    this.uploadTimer += dt;
    if (this.surfaceDirty && this.uploadTimer > 0.2) {
      this.uploadTimer = 0;
      this.surfaceDirty = false;
      this.dmgTex.needsUpdate = true;
    }
  }
}
