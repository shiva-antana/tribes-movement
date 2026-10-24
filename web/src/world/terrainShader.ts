import * as THREE from 'three';
import { Biome } from './biomes';
import { cc0, CC0_READY, CC0Role } from './cc0';

// Shared GLSL: hash-based value noise + fbm. Every surface texture in the game is
// generated from this at runtime — there are no texture image assets.
export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){ float s=0.0, a=0.5; for(int i=0;i<5;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; } return s; }
`;

export function fogGLSL() {
  return /* glsl */ `
uniform vec3 uFogColor; uniform float uFogDensity; uniform vec3 uCamPos; uniform float uUnderwater; uniform vec3 uWaterTint;
vec3 applyFog(vec3 col, vec3 wpos){
  float d = length(wpos - uCamPos);
  float density = mix(uFogDensity, 0.018, uUnderwater);
  vec3 fc = mix(uFogColor, uWaterTint, uUnderwater);
  float f = 1.0 - exp(-pow(d * density, 1.6) );
  // Height fog: valleys are hazier, which sells scale.
  f = clamp(f + (1.0 - uUnderwater) * 0.25 * exp(-max(wpos.y, 0.0) * 0.012) * smoothstep(80.0, 600.0, d), 0.0, 1.0);
  return mix(col, fc, f);
}`;
}

export function sharedUniforms(b: Biome) {
  const sd = new THREE.Vector3(...b.sunDir).normalize();
  return {
    uFogColor: { value: new THREE.Color(b.fogColor) },
    uFogDensity: { value: b.fogDensity },
    uCamPos: { value: new THREE.Vector3() },
    uUnderwater: { value: 0 },
    uWaterTint: { value: new THREE.Color(b.waterColor).multiplyScalar(0.6) },
    uSunDir: { value: sd },
    uSunColor: { value: new THREE.Color(b.sunColor) },
    uAmbient: { value: b.ambient },
    uTime: { value: 0 },
  };
}

export function makeTerrainMaterial(b: Biome, dmg: THREE.DataTexture, size: number) {
  const c = (n: number) => new THREE.Color(n);
  const uniforms = {
    ...sharedUniforms(b),
    uDmg: { value: dmg },
    uSize: { value: size },
    uLow: { value: c(b.palette.low) },
    uMid: { value: c(b.palette.mid) },
    uHigh: { value: c(b.palette.high) },
    uRock: { value: c(b.palette.rock) },
    uShore: { value: c(b.palette.shore) },
    uScorch: { value: c(b.palette.scorch) },
    uSea: { value: b.seaLevel },
    uFrozen: { value: b.frozen ? 1 : 0 },
    // CC0 PBR layers (diffuse + normal); uTex flips to 1 when all have loaded.
    uTex: CC0_READY,
    ...Object.fromEntries((['low', 'mid', 'high', 'rock', 'shore'] as const).flatMap(k => {
      const set = cc0(b.layers[k] as CC0Role);
      const cap = k[0].toUpperCase() + k.slice(1);
      return [[`t${cap}`, { value: set?.diff ?? null }], [`n${cap}`, { value: set?.nor ?? null }]];
    })),
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vNor;
      void main(){
        vPos = position; vNor = normal;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${fogGLSL()}
      uniform sampler2D uDmg; uniform float uSize;
      uniform vec3 uLow, uMid, uHigh, uRock, uShore, uScorch;
      uniform float uSea, uFrozen, uAmbient, uTime, uTex;
      uniform vec3 uSunDir, uSunColor;
      uniform sampler2D tLow, tMid, tHigh, tRock, tShore, nLow, nMid, nHigh, nRock, nShore;
      varying vec3 vPos; varying vec3 vNor;
      // Two-scale sampling breaks up visible tiling.
      vec3 tile(sampler2D t, vec2 uv, float k) { return mix(texture2D(t, uv).rgb, texture2D(t, uv * 0.23 + 0.31).rgb, k); }
      vec3 nrm(sampler2D t, vec2 uv) { return texture2D(t, uv).xyz * 2.0 - 1.0; }
      // Triplanar sampling for cliffs (no stretching on steep faces).
      vec3 triplanar(sampler2D t, vec3 p, vec3 w, float s) { return texture2D(t, p.zy * s).rgb * w.x + texture2D(t, p.xz * s).rgb * w.y + texture2D(t, p.xy * s).rgb * w.z; }
      void main(){
        vec3 n = normalize(vNor);
        float slope = 1.0 - n.y;
        vec2 p = vPos.xz;
        float macro = fbm(p * 0.0025);
        float meso = fbm(p * 0.03);
        float micro = vnoise(p * 0.6) * 0.5 + vnoise(p * 2.3) * 0.5;
        float h = vPos.y + (macro - 0.5) * 60.0;

        float wMid = smoothstep(0.3, 0.7, macro);
        float wHigh = smoothstep(140.0, 240.0, h);
        float wRock = smoothstep(0.28, 0.48, slope + (meso - 0.5) * 0.15);
        float shore = 1.0 - smoothstep(1.5, 6.0 + meso * 4.0, abs(vPos.y - uSea));
        float wShore = shore * (1.0 - uFrozen) * (1.0 - smoothstep(0.3, 0.5, slope));
        vec3 col;
        if (uTex > 0.5) {
          // Real CC0 PBR layers, tinted toward the biome palette so fog and atmosphere still tie together.
          vec2 uv = p / 7.0;
          float k = 0.35 + 0.3 * meso;
          vec3 cLow = tile(tLow, uv, k), cMid = tile(tMid, uv * 0.9, k), cHigh = tile(tHigh, uv, k), cShore = tile(tShore, uv * 1.4, k);
          vec3 w3 = pow(abs(n), vec3(4.0)); w3 /= (w3.x + w3.y + w3.z);
          vec3 cRock = mix(triplanar(tRock, vPos, w3, 1.0 / 9.0), triplanar(tRock, vPos.zyx + 17.0, w3.zyx, 1.0 / 37.0), 0.45 + 0.3 * k);
          col = mix(cLow, cMid, wMid);
          col = mix(col, cHigh, wHigh);
          col = mix(col, cRock, wRock);
          col = mix(col, cShore, wShore);
          col *= mix(vec3(1.0), (mix(mix(uLow, uMid, wMid), uHigh, wHigh) / max(0.25, dot(mix(mix(uLow, uMid, wMid), uHigh, wHigh), vec3(0.333)))), 0.35);
          col *= 0.9 + 0.2 * macro;
          // Normal maps: flat layers perturb in world x/z; cliffs use the side projections.
          vec3 nm = mix(mix(nrm(nLow, uv), nrm(nMid, uv * 0.9), wMid), nrm(nHigh, uv), wHigh);
          nm = mix(nm, nrm(nShore, uv * 1.4), wShore);
          vec3 nr = nrm(nRock, vPos.zy / 9.0) * w3.x + nrm(nRock, vPos.xz / 9.0) * w3.y + nrm(nRock, vPos.xy / 9.0) * w3.z;
          nm = mix(nm, nr, wRock);
          n = normalize(n + vec3(nm.x, 0.0, -nm.y) * 0.7);
        } else {
          col = mix(uLow, uMid, wMid);
          col = mix(col, uHigh, wHigh);
          // Strata on steep faces.
          float strata = 0.5 + 0.5 * sin(vPos.y * 0.9 + meso * 6.0);
          vec3 rock = uRock * (0.75 + 0.35 * strata) * (0.8 + 0.4 * meso);
          col = mix(col, rock, wRock);
          col = mix(col, uShore, wShore);
          col *= 0.88 + 0.24 * micro;
        }
        // Under the sea: darker silt.
        col = mix(col, uShore * 0.45, smoothstep(uSea - 2.0, uSea - 14.0, vPos.y) * (1.0 - uFrozen));

        // Surface map: R = scorch (permanent), B = graded road.
        vec2 duv = p / uSize + 0.5;
        vec4 d = texture2D(uDmg, duv);
        float scorch = d.r * (0.75 + 0.5 * vnoise(p * 0.8));
        col = mix(col, uScorch, clamp(scorch, 0.0, 0.92));
        // Graded roads: compacted aggregate with pale edge markers.
        float road = smoothstep(0.25, 0.6, d.b);
        vec3 roadCol = mix(vec3(0.33, 0.32, 0.3), uRock * 0.9, 0.35) * (0.85 + 0.25 * vnoise(p * 3.0));
        float edgeLine = smoothstep(0.5, 0.58, d.b) * (1.0 - smoothstep(0.62, 0.72, d.b));
        col = mix(col, roadCol, road);
        col = mix(col, vec3(0.85, 0.8, 0.55), edgeLine * 0.6);

        float diff = max(dot(n, uSunDir), 0.0);
        float sky = 0.5 + 0.5 * n.y;
        vec3 lit = col * (uSunColor * diff * 1.05 + uAmbient * mix(vec3(0.55,0.5,0.45), vec3(0.75,0.85,1.0), sky));
        gl_FragColor = vec4(applyFog(lit, vPos), 1.0); // output in the renderer's colour space (sRGB)
#include <colorspace_fragment>

      }`,
  });
}
