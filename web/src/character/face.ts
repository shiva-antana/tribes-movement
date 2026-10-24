// Expressions for painted anime faces. The face's eye/brow/mouth decals (painter layers
// with `in: "head"`) are lifted out of the baked body texture and drawn by the body's
// toon shader instead, from the same decal data, as parametric shapes. Expressions
// (VRM 1.0 preset names) are morph targets over those shape parameters: each preset is a
// target value per parameter and weights blend linearly from neutral, the way blendshapes
// do. The painted mesh is too coarse (~1.3 cm voxels) for vertex-offset eyelids, and
// three.js morphs can't move UVs, so the morph lives in decal space; it is resolution-
// independent and costs one branch per fragment outside the face.
import * as THREE from 'three';
import type { MaterialDef, Layer, Rect, Color } from '../paint/painter';

/** Shape parameters every expression is a target over. */
export const FACE_PARAMS = ['eyeOpenL', 'eyeOpenR', 'eyeSmile', 'eyeTilt', 'irisScale', 'browRaise', 'browTilt', 'mouthOpen', 'mouthWidth', 'mouthCurve', 'mouthRound'] as const;
export type FaceParam = typeof FACE_PARAMS[number];
const NEUTRAL: Record<FaceParam, number> = { eyeOpenL: 1, eyeOpenR: 1, eyeSmile: 0, eyeTilt: 0, irisScale: 1, browRaise: 0, browTilt: 0, mouthOpen: 0, mouthWidth: 1, mouthCurve: 1, mouthRound: 0 };

/**
 * VRM 1.0 expression presets as morph targets (absolute targets; unlisted params stay neutral).
 * eyeTilt/browTilt > 0 lowers the inner end (angry), < 0 raises it (sad). mouthCurve 1 = the painted smile.
 */
export const EXPRESSIONS: Record<string, Partial<Record<FaceParam, number>>> = {
  happy: { eyeOpenL: 0, eyeOpenR: 0, eyeSmile: 1, browRaise: 0.08, mouthCurve: 2, mouthOpen: 0.14, mouthWidth: 1.15, mouthRound: 0 },
  angry: { eyeOpenL: 0.72, eyeOpenR: 0.72, eyeTilt: 1, browTilt: 1, browRaise: -0.1, mouthCurve: -1.1, mouthWidth: 0.85, mouthOpen: 0.05 },
  sad: { eyeOpenL: 0.8, eyeOpenR: 0.8, eyeTilt: -0.8, browTilt: -1, browRaise: 0.06, mouthCurve: -1.2, mouthWidth: 0.8 },
  relaxed: { eyeOpenL: 0.55, eyeOpenR: 0.55, eyeSmile: 0.4, mouthCurve: 1.4, browRaise: 0.03 },
  surprised: { eyeOpenL: 1.25, eyeOpenR: 1.25, irisScale: 0.78, browRaise: 0.22, mouthOpen: 0.3, mouthWidth: 0.55, mouthRound: 1, mouthCurve: 0 },
  aa: { mouthOpen: 0.36, mouthWidth: 0.9, mouthCurve: 0.15, mouthRound: 0.45 },
  ih: { mouthOpen: 0.12, mouthWidth: 1.1, mouthCurve: 0.45 },
  ou: { mouthOpen: 0.2, mouthWidth: 0.45, mouthCurve: 0, mouthRound: 1 },
  ee: { mouthOpen: 0.17, mouthWidth: 1.25, mouthCurve: 0.6 },
  oh: { mouthOpen: 0.3, mouthWidth: 0.65, mouthCurve: 0, mouthRound: 1 },
  blink: { eyeOpenL: 0, eyeOpenR: 0 },
  blinkLeft: { eyeOpenL: 0 },
  blinkRight: { eyeOpenR: 0 },
};
export const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);
const EYE_CLOSERS = ['blink', 'blinkLeft', 'blinkRight', 'happy', 'relaxed'];

export interface FaceFeature {
  kind: 'eye' | 'brow' | 'mouth';
  side: 'L' | 'R' | 'C';            // character's left = higher atlas u on the head tile
  at: [number, number];             // atlas uv
  size: number; aspect: number; rot: number; flip: boolean;
  color: string; emissive?: string;
}
export interface FaceDef { features: FaceFeature[]; }

const FACE_SHAPES = new Set(['eye', 'brow', 'mouth']);
const hex = (c: Color) => typeof c === 'number' ? '#' + c.toString(16).padStart(6, '0') : c;

/** Split a material into the bakeable base (face decals removed) and the face rig's feature list. */
export function extractFace(def: MaterialDef, regions: Record<string, Rect> | undefined): { base: MaterialDef; face: FaceDef | null } {
  if (!regions) return { base: def, face: null };
  const features: FaceFeature[] = [];
  const keep: Layer[] = [];
  for (const L of def.layers) {
    const rr = L.type === 'decal' && L.in ? regions[L.in] : undefined;
    if (L.type !== 'decal' || !FACE_SHAPES.has(L.shape) || !rr || typeof L.color !== 'string' && typeof L.color !== 'number' || L.color === '$team') { keep.push(L); continue; }
    const w = rr[2] - rr[0];
    features.push({
      kind: L.shape as FaceFeature['kind'],
      side: Math.abs(L.at[0] - 0.5) < 0.01 ? 'C' : L.at[0] > 0.5 ? 'L' : 'R',
      at: [rr[0] + L.at[0] * w, rr[1] + L.at[1] * (rr[3] - rr[1])], size: L.size * w, aspect: L.aspect ?? 1,
      rot: L.rot ?? 0, flip: !!L.flipX, color: hex(L.color), emissive: L.emissive !== undefined && L.emissive !== '$team' ? hex(L.emissive) : undefined,
    });
  }
  return features.length ? { base: { ...def, layers: keep }, face: { features } } : { base: def, face: null };
}

/** Expression weights → shape parameters, plus an auto-blink timer. One per character instance. */
export class FaceRig {
  readonly params = new Float32Array(FACE_PARAMS.length);
  readonly weights: Record<string, number> = {};
  autoBlink = true;
  private clock = 0;
  private nextBlink = 1.5;
  private blinkAt = -1;
  constructor(private rnd: () => number = Math.random) { this.apply(0); }

  set(name: string, weight: number) {
    if (!EXPRESSIONS[name]) throw new Error(`unknown expression "${name}" (have: ${EXPRESSION_NAMES.join(', ')})`);
    this.weights[name] = THREE.MathUtils.clamp(weight, 0, 1);
    this.apply(this.autoBlinkWeight());
  }
  clear() { for (const k of Object.keys(this.weights)) delete this.weights[k]; this.apply(this.autoBlinkWeight()); }

  update(dt: number) {
    this.clock += dt;
    if (this.autoBlink && this.blinkAt < 0 && this.clock >= this.nextBlink) this.blinkAt = this.clock;
    this.apply(this.autoBlinkWeight());
  }

  /** 0.06 s close, 0.04 s hold, 0.08 s open; then 1.8–5 s until the next (sometimes a double blink). */
  private autoBlinkWeight() {
    if (this.blinkAt < 0) return 0;
    const t = this.clock - this.blinkAt;
    if (t > 0.18) {
      this.blinkAt = -1;
      this.nextBlink = this.clock + (this.rnd() < 0.15 ? 0.12 : 1.8 + this.rnd() * 3.2);
      return 0;
    }
    return t < 0.06 ? t / 0.06 : t < 0.1 ? 1 : 1 - (t - 0.1) / 0.08;
  }

  private apply(auto: number) {
    const p: Record<FaceParam, number> = { ...NEUTRAL };
    const w = { ...this.weights };
    // VRM-style override: the auto blink yields to expressions that already close the eyes.
    const closing = Math.max(0, ...EYE_CLOSERS.map(n => w[n] ?? 0));
    w.blink = Math.min(1, (w.blink ?? 0) + auto * (1 - closing));
    for (const [name, weight] of Object.entries(w)) {
      if (!weight) continue;
      for (const [k, target] of Object.entries(EXPRESSIONS[name]) as [FaceParam, number][]) p[k] += weight * (target - NEUTRAL[k]);
    }
    p.eyeOpenL = THREE.MathUtils.clamp(p.eyeOpenL, 0, 1.3);
    p.eyeOpenR = THREE.MathUtils.clamp(p.eyeOpenR, 0, 1.3);
    p.eyeSmile = THREE.MathUtils.clamp(p.eyeSmile, 0, 1);
    p.mouthOpen = Math.max(0, p.mouthOpen);
    p.mouthWidth = Math.max(0.2, p.mouthWidth);
    p.mouthRound = THREE.MathUtils.clamp(p.mouthRound, 0, 1);
    FACE_PARAMS.forEach((k, i) => { this.params[i] = p[k]; });
  }
}

// ---------------------------------------------------------------- shader

const P = Object.fromEntries(FACE_PARAMS.map((k, i) => [k, `uFace[${i}]`])) as Record<FaceParam, string>;
const f = (n: number) => { const s = (+n.toFixed(6)).toString(); return s.includes('.') || s.includes('e') ? s : s + '.0'; };
// Colors are computed in the painter's (sRGB) space to match its math, then linearised.
const srgb = (c: string) => { const col = new THREE.Color(); col.setStyle(c, THREE.SRGBColorSpace); const o = { r: 0, g: 0, b: 0 }; col.getRGB(o, THREE.SRGBColorSpace); return `vec3(${f(o.r)}, ${f(o.g)}, ${f(o.b)})`; };

// GLSL ports of the painter's eye/brow/mouth decals, with the morph parameters added.
// At neutral parameters they reproduce the painted shapes.
const FACE_LIB = /* glsl */ `
uniform float uFace[${FACE_PARAMS.length}];
vec3 faceLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
float faceCov(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }
vec4 faceEye(vec2 p, vec3 irisC, float open, float smile, float tilt, float irisS, float aa, out float em) {
  float x = p.x, y = p.y;
  em = 0.0;
  if (abs(x) > 0.8 || abs(y) > 0.8) return vec4(0.0);
  const vec3 white = vec3(0.97, 0.96, 0.95), ink = vec3(0.1, 0.07, 0.09);
  float o = min(open, 1.0);
  float lash = 0.3 - 0.18 * x * x - 0.06 * x + max(open - 1.0, 0.0) * 0.35;
  float closedY = mix(-0.08 + 0.22 * x * x, 0.02 - 0.5 * x * x, smile); // relaxed ∪ → happy ∩
  float upper = mix(closedY, lash, o) + tilt * 0.2 * x * o;
  float lower = mix(closedY - 0.01, -0.62, smoothstep(0.0, 0.6, o));
  float sy = 0.36 * max(1.0, open);
  float scl = (sqrt((x / 0.5) * (x / 0.5) + (y / sy) * (y / sy)) - 1.0) * 0.4;
  float aWhite = faceCov(max(scl, max(y - upper, lower - y)), aa);
  float th = mix(0.03, 0.065, o);
  float aLash = faceCov(max(abs(y - upper - 0.005) - th, abs(x) - 0.58 * mix(0.8, 1.0, o)), aa);
  if (aWhite <= 0.0 && aLash <= 0.0) return vec4(0.0);
  vec3 col = white;
  float iy = y + 0.02;
  float aIris = faceCov((length(vec2(x / 0.27, iy / 0.36) / irisS) - 1.0) * 0.27 * irisS, aa);
  float shade = 0.55 + 0.45 * (1.0 - smoothstep(-0.3, 0.3, y));
  col = mix(col, irisC * shade, aIris);
  col = mix(col, ink, faceCov((length(vec2(x / 0.12, iy / 0.18) / irisS) - 1.0) * 0.12 * irisS, aa));
  float g = min(length(vec2(x + 0.09 * irisS, y - 0.12 * irisS)) - 0.07 * irisS, length(vec2(x - 0.08 * irisS, y + 0.14 * irisS)) - 0.035 * irisS);
  col = mix(col, white, faceCov(g, aa) * aIris);
  em = aIris * aWhite * 0.25;
  col = mix(col, ink, aLash);
  return vec4(col, max(aWhite, aLash));
}
vec4 faceBrow(vec2 p, vec3 c, float raise, float tilt, float aa) {
  float x = p.x;
  float yy = p.y - (0.08 + raise - 0.25 * x * x + tilt * 0.3 * x);
  return vec4(c, faceCov(max(abs(yy) - (0.06 - abs(x) * 0.05), abs(x) - 0.5), aa));
}
vec4 faceMouth(vec2 p, vec3 lip, float open, float width, float curve, float round, float aa) {
  float x = p.x, y = p.y;
  float w = 0.5 * width, xn = clamp(x / w, -1.0, 1.0), q = 1.0 - xn * xn;
  float c = -curve * 0.1 * q;
  float hh = open * mix(q, sqrt(q), round);
  float dy = abs(y - c);
  float a = faceCov(max(dy - hh - 0.035, abs(x) - w), aa);
  if (a <= 0.0) return vec4(0.0);
  vec3 col = lip;
  if (open > 0.005) {
    float aIn = faceCov(max(dy - hh, abs(x) - w + 0.03), aa);
    vec3 inner = mix(vec3(0.24, 0.08, 0.11), vec3(0.78, 0.4, 0.42), smoothstep(-0.2, 0.6, (c - y) / max(hh, 1e-3)) * step(0.12, hh));
    col = mix(col, inner, aIn);
  }
  return vec4(col, a);
}
`;

function faceGLSL(face: FaceDef) {
  const lines = face.features.map(ft => {
    const r = ft.rot * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    const local = `vec2 d = vec2((uv.x - ${f(ft.at[0])}) / ${f(ft.size)}, (uv.y - ${f(ft.at[1])}) / ${f(ft.size * ft.aspect)});
    vec2 p = vec2((d.x * ${f(cs)} + d.y * ${f(sn)}) * ${ft.flip ? '-1.0' : '1.0'}, -d.x * ${f(sn)} + d.y * ${f(cs)});
    float aa = max(length(fwidth(p)) * 0.6, 0.004);`;
    if (ft.kind === 'eye') {
      const open = ft.side === 'R' ? P.eyeOpenR : P.eyeOpenL;
      return `{ ${local}
    float e; vec4 fc = faceEye(p, ${srgb(ft.color)}, ${open}, ${P.eyeSmile}, ${P.eyeTilt}, ${P.irisScale}, aa, e);
    col = mix(col, faceLin(fc.rgb), fc.a); ${ft.emissive ? `faceEm += faceLin(${srgb(ft.emissive)}) * e;` : ''} }`;
    }
    if (ft.kind === 'brow') return `{ ${local}
    vec4 fc = faceBrow(p, ${srgb(ft.color)}, ${P.browRaise}, ${P.browTilt}, aa); col = mix(col, faceLin(fc.rgb), fc.a); }`;
    return `{ ${local}
    vec4 fc = faceMouth(p, ${srgb(ft.color)}, ${P.mouthOpen}, ${P.mouthWidth}, ${P.mouthCurve}, ${P.mouthRound}, aa); col = mix(col, faceLin(fc.rgb), fc.a); }`;
  });
  // Cheap reject: one box around all features.
  const pad = 0.02;
  const us = face.features.map(ft => ft.at[0]), vs = face.features.map(ft => ft.at[1]);
  const box = [Math.min(...us) - pad, Math.min(...vs) - pad, Math.max(...us) + pad, Math.max(...vs) + pad];
  return `${FACE_LIB}
vec3 applyFace(vec2 uv, vec3 col, inout vec3 faceEm) {
  if (uv.x < ${f(box[0])} || uv.y < ${f(box[1])} || uv.x > ${f(box[2])} || uv.y > ${f(box[3])}) return col;
  ${lines.join('\n  ')}
  return col;
}`;
}

/** Patch a toon body material (with a map) to draw the face, driven by `params` (FaceRig.params). */
export function applyFace(mat: THREE.Material, face: FaceDef, params: Float32Array) {
  const base = (mat.userData.faceBase ?? mat.onBeforeCompile) as THREE.Material['onBeforeCompile'];
  const glsl = faceGLSL(face);
  mat.userData.faceBase = base;
  mat.userData.face = face;
  mat.onBeforeCompile = (sh, r) => {
    base.call(mat, sh, r);
    sh.uniforms.uFace = { value: params };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', `${glsl}\nvoid main() {\n  vec3 faceEm = vec3(0.0);`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = applyFace(vMapUv, diffuseColor.rgb, faceEm);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += faceEm;');
  };
  let h = 0;
  for (let i = 0; i < glsl.length; i++) h = (h * 31 + glsl.charCodeAt(i)) | 0;
  mat.customProgramCacheKey = () => `face:${h}:${base.toString().length}`;
  mat.needsUpdate = true;
  return mat;
}

/** A per-instance copy of a face material (shares textures; own expression uniforms). */
export function cloneFaceMaterial(src: THREE.Material, params: Float32Array) {
  const c = src.clone();
  c.onBeforeCompile = src.userData.faceBase;
  return applyFace(c, src.userData.face as FaceDef, params);
}
