// Turn baked painter output into three.js materials (browser + game).
import * as THREE from 'three';
import type { Baked } from '../paint/painter';

export function bakedTextures(b: Baked, repeat: boolean) {
  const mk = (data: Uint8ClampedArray, srgb: boolean) => {
    const t = new THREE.DataTexture(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), b.size, b.size, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(b.albedo, true), normalMap: mk(b.normal, false), orm: mk(b.orm, false), emissiveMap: mk(b.emissive, true) };
}

export function pbrMaterial(b: Baked, repeat: boolean) {
  const t = bakedTextures(b, repeat);
  return new THREE.MeshStandardMaterial({
    map: t.map, normalMap: t.normalMap, roughnessMap: t.orm, metalnessMap: t.orm, aoMap: t.orm,
    emissiveMap: t.emissiveMap, emissive: 0xffffff, emissiveIntensity: 1, roughness: 1, metalness: 1,
  });
}

export function glowMaterial(color: number) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3 });
}

/** Update an existing material's textures in place (live painting). */
export function updatePbr(mat: THREE.MeshStandardMaterial, b: Baked, repeat: boolean) {
  const t = bakedTextures(b, repeat);
  for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap'] as const) mat[k]?.dispose();
  mat.map = t.map; mat.normalMap = t.normalMap; mat.roughnessMap = t.orm; mat.metalnessMap = t.orm; mat.aoMap = t.orm; mat.emissiveMap = t.emissiveMap;
  mat.needsUpdate = true;
}

// ---------------------------------------------------------------- toon (anime) style

let ramp: THREE.DataTexture | null = null;
/** 3-band cel ramp: shadow, mid, lit. */
function toonRamp() {
  if (ramp) return ramp;
  const d = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

/** Cel-shaded material with a fresnel rim light (Genshin-style), from painter output. */
export function toonMaterial(b: Baked, repeat: boolean, rim = 0xbfe6ff, rimStrength = 0.55) {
  const t = bakedTextures(b, repeat);
  const m = new THREE.MeshToonMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), emissiveMap: t.emissiveMap, emissive: 0xffffff, gradientMap: toonRamp() });
  m.onBeforeCompile = sh => {
    sh.uniforms.uRim = { value: new THREE.Color(rim) };
    sh.uniforms.uRimStrength = { value: rimStrength };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uRim; uniform float uRimStrength;\nvoid main() {')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float rimF = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += uRim * smoothstep(0.35, 0.6, rimF) * uRimStrength;`);
  };
  return m;
}

/** Inverted-hull outline: a back-face shell pushed out along skinned normals. */
export function addOutline(mesh: THREE.SkinnedMesh, width = 0.008, color = 0x1a1420) {
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.onBeforeCompile = sh => {
    sh.uniforms.uOutline = { value: width };
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'uniform float uOutline;\nattribute float outlineScale;\nvoid main() {')
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n  transformed += normalize(objectNormal) * uOutline * outlineScale;');
  };
  // Per-vertex outline scale: thin lines on the head so the nose/lips don't get heavy rings.
  const g = mesh.geometry;
  const headBone = mesh.skeleton.bones.findIndex(b => b.name === 'head');
  if (headBone >= 0 && !g.getAttribute('outlineScale')) {
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    const sc = new Float32Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let w = 0;
      for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === headBone) w += sw.getComponent(i, c);
      sc[i] = 1 - 0.7 * w;
    }
    g.setAttribute('outlineScale', new THREE.BufferAttribute(sc, 1));
  } else if (!g.getAttribute('outlineScale')) g.setAttribute('outlineScale', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(1), 1));
  const shell = new THREE.SkinnedMesh(mesh.geometry, mat);
  shell.name = 'outline';
  shell.frustumCulled = false;
  shell.bind(mesh.skeleton, mesh.bindMatrix);
  mesh.add(shell);
  return shell;
}

export interface CharacterBakes { body: Baked; armor: Baked; hair?: Baked | null; }

/** Material array for a built character (slots: body, armor, glow, hair) in its declared style. */
export function characterMaterials(style: 'pbr' | 'toon' | undefined, b: CharacterBakes, team: number): THREE.Material[] {
  if (style === 'toon') {
    return [toonMaterial(b.body, false), toonMaterial(b.armor, true), glowMaterial(team), b.hair ? toonMaterial(b.hair, false, 0xffffff, 0.35) : toonMaterial(b.body, false)];
  }
  return [pbrMaterial(b.body, false), pbrMaterial(b.armor, true), glowMaterial(team), b.hair ? pbrMaterial(b.hair, false) : pbrMaterial(b.body, false)];
}
