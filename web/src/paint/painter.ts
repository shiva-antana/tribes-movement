// Layered texture painter. A material is an ordered list of layers (JSON) that bakes
// on the CPU into glTF-ready maps: albedo, tangent-space normal (from height),
// ORM (occlusion/roughness/metalness), height (for displacement) and emissive.
// Runs identically in Node (CLI) and the browser (workbench, game).
import { Simplex2, mulberry32, clamp, smoothstep } from '../noise';

export type Color = string | number; // '#rrggbb', 0xrrggbb, or '$team'
export type Rect = [number, number, number, number];

export interface Mask {
  regions?: string[];   // atlas regions (bone names) — needs a region map
  rect?: Rect;          // [u0, v0, u1, v1]
  noise?: { scale: number; threshold: number; softness?: number; seed?: number };
  invert?: boolean;
}

interface Base { mask?: Mask; opacity?: number; }
export type Layer = Base & (
  | { type: 'fill'; color: Color; rough?: number; metal?: number; height?: number; emissive?: Color }
  | { type: 'noise'; scale: number; octaves?: number; color?: Color; amount?: number; height?: number; rough?: number; seed?: number }
  | { type: 'panels'; scale: number; seam?: number; depth?: number; seamColor?: Color; jitter?: number; rivets?: boolean; aspect?: number; seed?: number }
  | { type: 'stripes'; axis?: 'u' | 'v'; freq: number; width: number; offset?: number; color: Color; emissive?: Color; height?: number }
  | { type: 'scratches'; count: number; length?: number; width?: number; color?: Color; depth?: number; seed?: number }
  | { type: 'decal'; shape: 'chevron' | 'circle' | 'bar' | 'triangle' | 'ring' | 'eye' | 'brow' | 'mouth' | 'blush'; at: [number, number]; size: number; rot?: number; color: Color; emissive?: Color; height?: number; in?: string; flipX?: boolean; aspect?: number }
  | { type: 'stroke'; points: [number, number][]; radius: number; color?: Color; height?: number; rough?: number; metal?: number; emissive?: Color; hardness?: number; in?: string }
);

export interface MaterialDef {
  id: string;
  description?: string;
  size?: number;            // texture resolution (power of two)
  normalStrength?: number;  // height → normal slope multiplier
  aoStrength?: number;
  tiling?: boolean;         // true for repeatable surfaces (armor plates), false for atlases
  layers: Layer[];
}

export interface BakeOptions {
  size?: number;
  teamColor?: number;
  /** For atlas materials: region name → rect, so masks can target body parts. */
  regions?: Record<string, Rect>;
}

export interface Baked {
  size: number;
  albedo: Uint8ClampedArray;   // RGBA8, sRGB
  normal: Uint8ClampedArray;   // RGBA8, tangent space (OpenGL convention, +Y up)
  orm: Uint8ClampedArray;      // R = AO, G = roughness, B = metalness
  height: Float32Array;        // 0..1, 0.5 = base surface
  emissive: Uint8ClampedArray; // RGBA8
  ms: number;
}

function rgb(c: Color | undefined, team: number): [number, number, number] {
  if (c === undefined) return [1, 1, 1];
  let n: number;
  if (c === '$team') n = team;
  else if (typeof c === 'number') n = c;
  else n = parseInt(c.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function bakeMaterial(def: MaterialDef, opts: BakeOptions = {}): Baked {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const N = opts.size ?? def.size ?? 512;
  const team = opts.teamColor ?? 0x4aa3ff;
  const px = N * N;
  const R = new Float32Array(px).fill(0.5), G = new Float32Array(px).fill(0.5), B = new Float32Array(px).fill(0.5);
  const H = new Float32Array(px).fill(0.5), Rough = new Float32Array(px).fill(0.6), Metal = new Float32Array(px);
  const ER = new Float32Array(px), EG = new Float32Array(px), EB = new Float32Array(px);
  const tiling = def.tiling ?? false;

  // Seamless fbm for tiling materials: blend four offset samples.
  const fbmAt = (s: Simplex2, u: number, v: number, scale: number, oct: number) => {
    if (!tiling) return s.fbm(u * scale, v * scale, oct);
    const f = (a: number, b: number) => s.fbm(a * scale, b * scale, oct);
    return f(u, v) * (1 - u) * (1 - v) + f(u - 1, v) * u * (1 - v) + f(u, v - 1) * (1 - u) * v + f(u - 1, v - 1) * u * v;
  };

  const maskFn = (m: Mask | undefined): ((u: number, v: number) => number) => {
    if (!m) return () => 1;
    const rects: Rect[] = [];
    if (m.rect) rects.push(m.rect);
    for (const r of m.regions ?? []) { const rr = opts.regions?.[r]; if (rr) rects.push(rr); }
    const useRects = !!(m.rect || m.regions);
    const ns = m.noise ? new Simplex2(m.noise.seed ?? 7) : null;
    return (u, v) => {
      let k = 1;
      if (useRects) k = rects.some(r => u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3]) ? 1 : 0;
      if (ns && m.noise) k *= smoothstep(m.noise.threshold - (m.noise.softness ?? 0.05), m.noise.threshold + (m.noise.softness ?? 0.05), fbmAt(ns, u, v, m.noise.scale, 3) * 0.5 + 0.5);
      return m.invert ? 1 - k : k;
    };
  };

  for (const L of def.layers) {
    const mask = maskFn(L.mask);
    const op = L.opacity ?? 1;
    const each = (fn: (i: number, u: number, v: number, k: number) => void) => {
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const u = (x + 0.5) / N, v = (y + 0.5) / N;
        const k = mask(u, v) * op;
        if (k > 0) fn(y * N + x, u, v, k);
      }
    };
    const blendCol = (i: number, c: [number, number, number], k: number) => { R[i] += (c[0] - R[i]) * k; G[i] += (c[1] - G[i]) * k; B[i] += (c[2] - B[i]) * k; };
    const blendEm = (i: number, c: [number, number, number], k: number) => { ER[i] = Math.max(ER[i], c[0] * k); EG[i] = Math.max(EG[i], c[1] * k); EB[i] = Math.max(EB[i], c[2] * k); };
    switch (L.type) {
      case 'fill': {
        const c = rgb(L.color, team), em = L.emissive !== undefined ? rgb(L.emissive, team) : null;
        each((i, _u, _v, k) => {
          blendCol(i, c, k);
          if (L.rough !== undefined) Rough[i] += (L.rough - Rough[i]) * k;
          if (L.metal !== undefined) Metal[i] += (L.metal - Metal[i]) * k;
          if (L.height !== undefined) H[i] += (L.height - H[i]) * k;
          if (em) blendEm(i, em, k);
        });
        break;
      }
      case 'noise': {
        const s = new Simplex2(L.seed ?? 1), c = L.color !== undefined ? rgb(L.color, team) : null;
        each((i, u, v, k) => {
          const n = fbmAt(s, u, v, L.scale, L.octaves ?? 4);
          if (c) blendCol(i, c, clamp((n * 0.5 + 0.5) * (L.amount ?? 0.5), 0, 1) * k);
          if (L.height) H[i] += n * L.height * k;
          if (L.rough) Rough[i] = clamp(Rough[i] + n * L.rough * k, 0.02, 1);
        });
        break;
      }
      case 'panels': {
        const rnd = mulberry32(L.seed ?? 3), seed = rnd() * 1000;
        const sc = L.seamColor !== undefined ? rgb(L.seamColor, team) : null;
        const sx = L.scale, sy = L.scale * (L.aspect ?? 1), seam = L.seam ?? 0.04;
        each((i, u, v, k) => {
          const gx = u * sx, gy = v * sy;
          const fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
          const e = Math.min(fx, 1 - fx, fy, 1 - fy);
          const groove = 1 - smoothstep(seam * 0.5, seam, e);
          H[i] -= groove * (L.depth ?? 0.25) * k;
          if (sc) blendCol(i, sc, groove * k * 0.8);
          const id = Math.sin((Math.floor(gx) * 127.1 + Math.floor(gy) * 311.7 + seed)) * 43758.5453;
          const j = (id - Math.floor(id) - 0.5) * (L.jitter ?? 0.12);
          R[i] = clamp(R[i] + j * k, 0, 1); G[i] = clamp(G[i] + j * k, 0, 1); B[i] = clamp(B[i] + j * k, 0, 1);
          if (L.rivets) {
            const cx = Math.min(fx, 1 - fx), cy = Math.min(fy, 1 - fy);
            const d = Math.hypot(cx - seam * 2.2, cy - seam * 2.2);
            const rv = 1 - smoothstep(seam * 0.5, seam * 0.8, d);
            H[i] += rv * 0.18 * k; Metal[i] = Math.max(Metal[i], rv * k);
          }
        });
        break;
      }
      case 'stripes': {
        const c = rgb(L.color, team), em = L.emissive !== undefined ? rgb(L.emissive, team) : null;
        each((i, u, v, k) => {
          const a = (L.axis ?? 'v') === 'u' ? u : v;
          const f = a * L.freq + (L.offset ?? 0);
          const d = Math.abs(f - Math.floor(f) - 0.5);
          const s = 1 - smoothstep(L.width * 0.5 - 0.02, L.width * 0.5, d);
          if (s <= 0) return;
          blendCol(i, c, s * k);
          if (em) blendEm(i, em, s * k);
          if (L.height) H[i] += L.height * s * k;
        });
        break;
      }
      case 'scratches': {
        const rnd = mulberry32(L.seed ?? 11);
        const c = rgb(L.color ?? '#c8ccd2', team);
        for (let s = 0; s < L.count; s++) {
          const x0 = rnd(), y0 = rnd(), a = rnd() * Math.PI * 2, len = (L.length ?? 0.08) * (0.4 + rnd());
          strokeLine(N, [[x0, y0], [x0 + Math.cos(a) * len, y0 + Math.sin(a) * len]], (L.width ?? 0.002), 0.9, mask, (i, k) => {
            blendCol(i, c, k * (L.opacity ?? 1)); H[i] -= (L.depth ?? 0.08) * k; Metal[i] = Math.max(Metal[i], 0.8 * k); Rough[i] = Math.min(Rough[i], 0.35 + (1 - k) * Rough[i]);
          }, tiling);
        }
        break;
      }
      case 'decal': {
        const c = rgb(L.color, team), em = L.emissive !== undefined ? rgb(L.emissive, team) : null;
        const rot = ((L.rot ?? 0) * Math.PI) / 180, cs = Math.cos(rot), sn = Math.sin(rot);
        // `in`: position/size relative to an atlas region (e.g. place eyes inside the head tile).
        let at = L.at, size = L.size;
        const rr = L.in ? opts.regions?.[L.in] : undefined;
        if (rr) { at = [rr[0] + L.at[0] * (rr[2] - rr[0]), rr[1] + L.at[1] * (rr[3] - rr[1])]; size = L.size * (rr[2] - rr[0]); }
        const white = [0.97, 0.96, 0.95] as [number, number, number], ink = [0.1, 0.07, 0.09] as [number, number, number];
        const asp = L.aspect ?? 1;
        each((i, u, v, k) => {
          const dx = (u - at[0]) / size, dy = (v - at[1]) / (size * asp);
          let x = dx * cs + dy * sn; const y = -dx * sn + dy * cs;
          if (L.flipX) x = -x;
          let inside = 0;
          if (L.shape === 'eye') {
            // Anime eye: sclera, tall iris with darker top, pupil, specular glints, heavy upper lash line.
            const sclera = (x / 0.5) ** 2 + (y / 0.36) ** 2;
            const lashY = 0.3 - 0.18 * x * x - 0.06 * x;
            const onLash = y > lashY - 0.06 && y < lashY + 0.07 && Math.abs(x) < 0.58;
            if (sclera > 1 && !onLash) return;
            let col = white;
            const iris = (x / 0.27) ** 2 + ((y + 0.02) / 0.36) ** 2;
            if (iris < 1) {
              const shade = 0.55 + 0.45 * smoothstep(0.3, -0.3, y);
              col = [c[0] * shade, c[1] * shade, c[2] * shade];
              if ((x / 0.12) ** 2 + ((y + 0.02) / 0.18) ** 2 < 1) col = ink;
              if ((x + 0.09) ** 2 + (y - 0.12) ** 2 < 0.07 ** 2 || (x - 0.08) ** 2 + (y + 0.14) ** 2 < 0.035 ** 2) col = white;
            }
            if (onLash) col = ink;
            blendCol(i, col, k);
            if (em && iris < 1) blendEm(i, em, k * 0.25);
            return;
          }
          switch (L.shape) {
            case 'brow': { const yy = y - (0.08 - 0.25 * x * x); inside = Math.abs(x) < 0.5 && Math.abs(yy) < 0.06 - Math.abs(x) * 0.05 ? 1 : 0; break; }
            case 'mouth': { const yy = y + 0.1 * (1 - (x / 0.5) ** 2); inside = Math.abs(x) < 0.5 && Math.abs(yy) < 0.035 ? 1 : 0; break; }
            case 'blush': { const r = (x / 0.5) ** 2 + (y / 0.25) ** 2; if (r < 1) blendCol(i, c, k * 0.35 * (1 - r)); return; }
            case 'circle': inside = 1 - smoothstep(0.46, 0.5, Math.hypot(x, y)); break;
            case 'ring': { const r = Math.hypot(x, y); inside = (1 - smoothstep(0.46, 0.5, r)) * smoothstep(0.3, 0.34, r); break; }
            case 'bar': inside = Math.abs(x) < 0.5 && Math.abs(y) < 0.12 ? 1 : 0; break;
            case 'triangle': inside = y > -0.4 && y < 0.4 && Math.abs(x) < (0.4 - y) * 0.6 ? 1 : 0; break;
            case 'chevron': { const yy = y + Math.abs(x) * 0.8; inside = Math.abs(x) < 0.5 && yy > -0.1 && yy < 0.12 ? 1 : 0; break; }
          }
          if (!inside) return;
          blendCol(i, c, inside * k);
          if (em) blendEm(i, em, inside * k);
          if (L.height) H[i] += L.height * inside * k;
        });
        break;
      }
      case 'stroke': {
        const c = L.color !== undefined ? rgb(L.color, team) : null, em = L.emissive !== undefined ? rgb(L.emissive, team) : null;
        const sr = L.in ? opts.regions?.[L.in] : undefined;
        const pts = sr ? L.points.map(([u, v]) => [sr[0] + u * (sr[2] - sr[0]), sr[1] + v * (sr[3] - sr[1])] as [number, number]) : L.points;
        strokeLine(N, pts, L.radius, L.hardness ?? 0.6, mask, (i, k) => {
          k *= L.opacity ?? 1;
          if (c) blendCol(i, c, k);
          if (em) blendEm(i, em, k);
          if (L.height) H[i] += L.height * k;
          if (L.rough !== undefined) Rough[i] += (L.rough - Rough[i]) * k;
          if (L.metal !== undefined) Metal[i] += (L.metal - Metal[i]) * k;
        }, tiling);
        break;
      }
    }
  }

  // Derived maps.
  const at = (x: number, y: number) => {
    if (tiling) { x = (x + N) % N; y = (y + N) % N; } else { x = clamp(x, 0, N - 1); y = clamp(y, 0, N - 1); }
    return H[y * N + x];
  };
  const albedo = new Uint8ClampedArray(px * 4), normal = new Uint8ClampedArray(px * 4), orm = new Uint8ClampedArray(px * 4), emissive = new Uint8ClampedArray(px * 4);
  const ns = (def.normalStrength ?? 4) * (N / 512);
  const aoK = def.aoStrength ?? 1.5;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, o = i * 4;
    const dx = (at(x + 1, y) - at(x - 1, y)) * ns, dy = (at(x, y + 1) - at(x, y - 1)) * ns;
    const l = Math.hypot(dx, dy, 1);
    normal[o] = (-dx / l * 0.5 + 0.5) * 255; normal[o + 1] = (-dy / l * 0.5 + 0.5) * 255; normal[o + 2] = (1 / l * 0.5 + 0.5) * 255; normal[o + 3] = 255;
    let avg = 0;
    for (const [ox, oy] of [[-4, 0], [4, 0], [0, -4], [0, 4], [-3, -3], [3, 3], [-3, 3], [3, -3]]) avg += at(x + ox, y + oy);
    const ao = 1 - clamp((avg / 8 - H[i]) * aoK * 4, 0, 0.7);
    albedo[o] = R[i] * 255; albedo[o + 1] = G[i] * 255; albedo[o + 2] = B[i] * 255; albedo[o + 3] = 255;
    orm[o] = ao * 255; orm[o + 1] = clamp(Rough[i], 0.02, 1) * 255; orm[o + 2] = clamp(Metal[i], 0, 1) * 255; orm[o + 3] = 255;
    emissive[o] = ER[i] * 255; emissive[o + 1] = EG[i] * 255; emissive[o + 2] = EB[i] * 255; emissive[o + 3] = 255;
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { size: N, albedo, normal, orm, height: H, emissive, ms: Math.round(t1 - t0) };
}

/** Rasterize a polyline brush into the texture (UV space), calling fn(index, strength). */
function strokeLine(N: number, pts: [number, number][], radius: number, hardness: number, mask: (u: number, v: number) => number, fn: (i: number, k: number) => void, wrap: boolean) {
  if (!pts.length) return;
  const segs: [number, number, number, number][] = [];
  for (let s = 0; s < pts.length; s++) { const a = pts[s], b = pts[Math.min(s + 1, pts.length - 1)]; segs.push([a[0], a[1], b[0], b[1]]); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [ax, ay, bx, by] of segs) { x0 = Math.min(x0, ax, bx); y0 = Math.min(y0, ay, by); x1 = Math.max(x1, ax, bx); y1 = Math.max(y1, ay, by); }
  const pr = radius * N + 1;
  const ix0 = Math.floor(x0 * N - pr), ix1 = Math.ceil(x1 * N + pr), iy0 = Math.floor(y0 * N - pr), iy1 = Math.ceil(y1 * N + pr);
  for (let y = iy0; y <= iy1; y++) for (let x = ix0; x <= ix1; x++) {
    let xx = x, yy = y;
    if (wrap) { xx = ((x % N) + N) % N; yy = ((y % N) + N) % N; } else if (x < 0 || y < 0 || x >= N || y >= N) continue;
    const u = (x + 0.5) / N, v = (y + 0.5) / N;
    let d = Infinity;
    for (const [ax, ay, bx, by] of segs) {
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      const t = l2 > 0 ? clamp(((u - ax) * vx + (v - ay) * vy) / l2, 0, 1) : 0;
      d = Math.min(d, Math.hypot(u - ax - vx * t, v - ay - vy * t));
    }
    if (d > radius) continue;
    const k = 1 - smoothstep(radius * hardness, radius, d);
    const m = mask((xx + 0.5) / N, (yy + 0.5) / N);
    if (k * m > 0) fn(yy * N + xx, k * m);
  }
}

/** Bilinear height lookup (for displacement). */
export function sampleHeight(b: Baked, u: number, v: number, wrap = false) {
  const N = b.size;
  let x = u * N - 0.5, y = v * N - 0.5;
  if (wrap) { x = ((x % N) + N) % N; y = ((y % N) + N) % N; }
  const x0 = clamp(Math.floor(x), 0, N - 1), y0 = clamp(Math.floor(y), 0, N - 1);
  const x1 = wrap ? (x0 + 1) % N : Math.min(N - 1, x0 + 1), y1 = wrap ? (y0 + 1) % N : Math.min(N - 1, y0 + 1);
  const fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1);
  const H = b.height;
  return (H[y0 * N + x0] * (1 - fx) + H[y0 * N + x1] * fx) * (1 - fy) + (H[y1 * N + x0] * (1 - fx) + H[y1 * N + x1] * fx) * fy;
}
