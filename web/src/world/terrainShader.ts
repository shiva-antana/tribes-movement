import * as THREE from 'three';
import { Biome } from './biomes';

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
      uniform float uSea, uFrozen, uAmbient, uTime;
      uniform vec3 uSunDir, uSunColor;
      varying vec3 vPos; varying vec3 vNor;
      void main(){
        vec3 n = normalize(vNor);
        float slope = 1.0 - n.y;
        vec2 p = vPos.xz;
        float macro = fbm(p * 0.0025);
        float meso = fbm(p * 0.03);
        float micro = vnoise(p * 0.6) * 0.5 + vnoise(p * 2.3) * 0.5;
        float h = vPos.y + (macro - 0.5) * 60.0;

        vec3 col = mix(uLow, uMid, smoothstep(0.3, 0.7, macro));
        col = mix(col, uHigh, smoothstep(140.0, 240.0, h));
        // Strata on steep faces.
        float strata = 0.5 + 0.5 * sin(vPos.y * 0.9 + meso * 6.0);
        vec3 rock = uRock * (0.75 + 0.35 * strata) * (0.8 + 0.4 * meso);
        col = mix(col, rock, smoothstep(0.28, 0.48, slope + (meso - 0.5) * 0.15));
        // Shoreline band.
        float shore = 1.0 - smoothstep(1.5, 6.0 + meso * 4.0, abs(vPos.y - uSea));
        col = mix(col, uShore, shore * (1.0 - uFrozen) * (1.0 - smoothstep(0.3, 0.5, slope)));
        // Under the sea: darker silt.
        col = mix(col, uShore * 0.45, smoothstep(uSea - 2.0, uSea - 14.0, vPos.y) * (1.0 - uFrozen));
        col *= 0.88 + 0.24 * micro;

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
        gl_FragColor = vec4(applyFog(lit, vPos), 1.0);
      }`,
  });
}
