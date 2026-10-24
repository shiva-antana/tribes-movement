// Texture comparator: reduces an image to style statistics (palette, tone, saturation,
// detail-frequency spectrum, edge density, tileability) and diffs two images, with
// suggestions phrased as painter-layer changes. Works on any RGBA buffer, so it can
// compare our baked maps with reference textures (e.g. extracted originals).
import { inflateSync } from 'node:zlib';

export interface Img { w: number; h: number; data: Uint8Array | Uint8ClampedArray; }

/** Minimal PNG decoder (8-bit RGB/RGBA/gray, non-interlaced) — enough for our own and extracted textures. */
export function decodePNG(buf: Uint8Array): Img {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat: Uint8Array[] = [];
  let plte: Uint8Array | null = null;
  while (p < buf.length) {
    const len = dv.getUint32(p); const type = String.fromCharCode(...buf.subarray(p + 4, p + 8));
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); bd = d[8]; ct = d[9]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error(`PNG bit depth ${bd} unsupported`);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat.map(x => Buffer.from(x))));
  const stride = w * ch, out = new Uint8Array(w * h * 4), line = new Uint8Array(stride), prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let r = v;
      if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      line[x] = r & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ch === 1 && plte && ct === 3) { const k = line[x] * 3; out[o] = plte[k]; out[o + 1] = plte[k + 1]; out[o + 2] = plte[k + 2]; out[o + 3] = 255; }
      else if (ch <= 2) { out[o] = out[o + 1] = out[o + 2] = line[x * ch]; out[o + 3] = ch === 2 ? line[x * 2 + 1] : 255; }
      else { out[o] = line[x * ch]; out[o + 1] = line[x * ch + 1]; out[o + 2] = line[x * ch + 2]; out[o + 3] = ch === 4 ? line[x * 4 + 3] : 255; }
    }
    prev.set(line);
  }
  return { w, h, data: out };
}

export interface TexStats {
  luminance: { mean: number; std: number };
  saturation: number;
  palette: { rgb: [number, number, number]; share: number }[];
  bands: number[];      // relative detail energy per octave (fine → coarse), sums to 1
  edgeDensity: number;
  tileSeam: number;     // 0 = perfectly tileable
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function textureStats(img: Img): TexStats {
  const { w, h, data } = img;
  const L = new Float32Array(w * h);
  let sumL = 0, sumL2 = 0, sat = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    const l = lum(r, g, b); L[i] = l; sumL += l; sumL2 += l * l;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx > 0 ? (mx - mn) / mx : 0;
  }
  const n = w * h, mean = sumL / n;
  // Palette: k-means (k=6) over a pixel sample.
  const sample: [number, number, number][] = [];
  const stepS = Math.max(1, Math.floor(n / 4000));
  for (let i = 0; i < n; i += stepS) sample.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  let cent = Array.from({ length: 6 }, (_, k) => [...sample[Math.floor((k + 0.5) * sample.length / 6)]] as [number, number, number]);
  let assign = new Int32Array(sample.length);
  for (let it = 0; it < 10; it++) {
    sample.forEach((s, i) => { let bd = Infinity; cent.forEach((c, k) => { const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2; if (d < bd) { bd = d; assign[i] = k; } }); });
    cent = cent.map((c, k) => { const m = sample.filter((_, i) => assign[i] === k); return m.length ? [0, 1, 2].map(j => m.reduce((s, x) => s + x[j], 0) / m.length) as [number, number, number] : c; });
  }
  const palette = cent.map((rgb, k) => ({ rgb: rgb.map(Math.round) as [number, number, number], share: +(assign.filter(a => a === k).length / sample.length).toFixed(3) })).sort((a, b) => b.share - a.share);
  // Detail spectrum: energy of differences between successive box-downsampled levels.
  const bands: number[] = [];
  let cur = L, cw = w, chh = h;
  for (let o = 0; o < 5 && cw >= 8 && chh >= 8; o++) {
    const nw = cw >> 1, nh = chh >> 1, nxt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) nxt[y * nw + x] = (cur[2 * y * cw + 2 * x] + cur[2 * y * cw + 2 * x + 1] + cur[(2 * y + 1) * cw + 2 * x] + cur[(2 * y + 1) * cw + 2 * x + 1]) / 4;
    let e = 0;
    for (let y = 0; y < nh * 2; y++) for (let x = 0; x < nw * 2; x++) e += (cur[y * cw + x] - nxt[(y >> 1) * nw + (x >> 1)]) ** 2;
    bands.push(e / (nw * nh * 4));
    cur = nxt; cw = nw; chh = nh;
  }
  const bs = bands.reduce((s, x) => s + x, 0) || 1;
  // Edges and tileability.
  let edge = 0, neigh = 0, seam = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = L[y * w + x + 1] - L[y * w + x - 1], gy = L[(y + 1) * w + x] - L[(y - 1) * w + x];
    edge += Math.hypot(gx, gy);
    neigh += Math.abs(L[y * w + x] - L[y * w + x + 1]);
  }
  for (let y = 0; y < h; y++) seam += Math.abs(L[y * w] - L[y * w + w - 1]);
  for (let x = 0; x < w; x++) seam += Math.abs(L[x] - L[(h - 1) * w + x]);
  const meanNeigh = neigh / ((w - 2) * (h - 2)) || 1e-6;
  return {
    luminance: { mean: +mean.toFixed(3), std: +Math.sqrt(Math.max(0, sumL2 / n - mean * mean)).toFixed(3) },
    saturation: +(sat / n).toFixed(3), palette,
    bands: bands.map(b => +(b / bs).toFixed(3)),
    edgeDensity: +(edge / ((w - 2) * (h - 2))).toFixed(4),
    tileSeam: +((seam / (w + h)) / meanNeigh).toFixed(2),
  };
}

export function compareTextures(ours: Img, ref: Img) {
  const a = textureStats(ours), b = textureStats(ref);
  const sugg: string[] = [];
  const dL = b.luminance.mean - a.luminance.mean;
  if (Math.abs(dL) > 0.05) sugg.push(`${dL > 0 ? 'brighten' : 'darken'} base fill by ~${Math.round(Math.abs(dL) * 100)}%`);
  const dC = b.luminance.std - a.luminance.std;
  if (Math.abs(dC) > 0.03) sugg.push(`${dC > 0 ? 'raise' : 'lower'} contrast (noise amount / panel seam darkness)`);
  const dS = b.saturation - a.saturation;
  if (Math.abs(dS) > 0.06) sugg.push(`${dS > 0 ? 'more' : 'less'} saturated colors`);
  // Detail: compare the centroid of the band spectrum (low index = finer detail).
  const centroid = (x: number[]) => x.reduce((s, v, i) => s + v * i, 0);
  const dB = centroid(b.bands) - centroid(a.bands);
  if (Math.abs(dB) > 0.3) sugg.push(`detail is ${dB > 0 ? 'finer than the reference: lower noise/panel scale' : 'coarser than the reference: raise noise/panel scale'} (~×${Math.pow(2, Math.abs(dB)).toFixed(1)})`);
  if (a.tileSeam > 3 && b.tileSeam < 2) sugg.push('reference tiles seamlessly; set "tiling": true');
  // Palette distance: each reference color to its nearest ours, weighted by share.
  const pd = b.palette.reduce((s, pc) => s + pc.share * Math.min(...a.palette.map(qc => Math.hypot(pc.rgb[0] - qc.rgb[0], pc.rgb[1] - qc.rgb[1], pc.rgb[2] - qc.rgb[2]))), 0);
  if (pd > 30) sugg.push(`palette differs (Δ ${pd.toFixed(0)}); reference colors: ${b.palette.slice(0, 4).map(p => '#' + p.rgb.map(v => v.toString(16).padStart(2, '0')).join('')).join(' ')}`);
  const score = Math.max(0, 100 - (Math.abs(dL) * 120 + Math.abs(dC) * 150 + Math.abs(dS) * 80 + Math.abs(dB) * 15 + pd * 0.4));
  return { score: +score.toFixed(1), ours: a, reference: b, suggestions: sugg };
}
