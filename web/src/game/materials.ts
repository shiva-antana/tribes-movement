import * as THREE from 'three';
import { NOISE_GLSL, fogGLSL } from '../world/terrainShader';
import { cc0, CC0_READY } from '../world/cc0';

type Shared = Record<string, THREE.IUniform>;
let shared: Shared | null = null;

/** The environment's shared uniforms (fog, sun, camera, time) get linked into every material. */
export function setSharedUniforms(u: Shared) { shared = u; }

/**
 * Procedural plate material for structures & vehicles (placeholder until glTF assets).
 * Damage shows as burned, cracked plating; while a player repairs it the cracks
 * close along a glowing seam (uHealing is driven by the repair beam only).
 */
export function makePlateMaterial(team: number, baseColor: number, teamColor: number, opts: { emissive?: number; transparent?: boolean } = {}) {
  if (!shared) throw new Error('shared uniforms not set');
  const mat = new THREE.ShaderMaterial({
    transparent: !!opts.transparent,
    uniforms: {
      ...shared,
      uBase: { value: new THREE.Color(baseColor) },
      uTeam: { value: new THREE.Color(teamColor) },
      uDamage: { value: 0 },
      uHealing: { value: 0 },
      uPowered: { value: 1 },
      uEmissive: { value: opts.emissive ?? 0 },
      uAlpha: { value: 1 },
      uSeed: { value: Math.random() * 100 },
      // CC0 metal plate (albedo / normal / AO-rough-metal), one texture tile per 2.5 m panel.
      uTex: CC0_READY,
      // Walls: seamed painted panels; floors/decks/roofs: tread plate. Both desaturated to the structure's tint.
      tPlate: { value: cc0('metal_paint')?.diff ?? null },
      nPlate: { value: cc0('metal_paint')?.nor ?? null },
      aPlate: { value: cc0('metal_paint')?.arm ?? null },
      tFloor: { value: cc0('metal')?.diff ?? null },
      nFloor: { value: cc0('metal')?.nor ?? null },
      aFloor: { value: cc0('metal')?.arm ?? null },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vNor; varying vec3 vObj;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vPos = w.xyz; vObj = position;
        vNor = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${fogGLSL()}
      uniform vec3 uBase, uTeam, uSunDir, uSunColor; uniform float uDamage, uHealing, uPowered, uEmissive, uAmbient, uTime, uAlpha, uSeed, uTex;
      uniform sampler2D tPlate, nPlate, aPlate, tFloor, nFloor, aFloor;
      varying vec3 vPos; varying vec3 vNor; varying vec3 vObj;
      void main(){
        vec3 n = normalize(vNor);
        vec3 an = abs(n);
        vec2 uv = an.y > 0.7 ? vPos.xz : (an.x > an.z ? vPos.zy : vPos.xy);
        // Panel grid with seams.
        vec2 g = fract(uv / 2.5);
        float seam = smoothstep(0.03, 0.0, min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y)));
        float panelId = hash12(floor(uv / 2.5) + uSeed);
        vec3 col = uBase * (0.85 + 0.2 * panelId);
        float rough = 0.6, metal = 0.3;
        if (uTex > 0.5) {
          vec2 tuv = uv / 2.5 + floor(panelId * 4.0) * 0.25;   // offset per panel so tiles don't repeat in lockstep
          bool floorFace = an.y > 0.7;
          vec3 tc = floorFace ? texture2D(tFloor, tuv * 2.0).rgb : texture2D(tPlate, tuv).rgb;
          float lum = dot(tc, vec3(0.299, 0.587, 0.114));
          // Keep the photo's detail (luminance) but take colour from the structure's tint.
          col = uBase * (lum / (floorFace ? 0.09 : 0.06)) * (0.9 + 0.15 * panelId);
          vec3 arm = floorFace ? texture2D(aFloor, tuv * 2.0).rgb : texture2D(aPlate, tuv).rgb;
          col *= mix(1.0, arm.r, 0.7);
          rough = arm.g; metal = arm.b;
          vec3 nm = (floorFace ? texture2D(nFloor, tuv * 2.0).xyz : texture2D(nPlate, tuv).xyz) * 2.0 - 1.0;
          vec3 T = an.y > 0.7 ? vec3(1.0, 0.0, 0.0) : (an.x > an.z ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0));
          vec3 B = an.y > 0.7 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
          n = normalize(n + (T * nm.x + B * nm.y) * 0.8);
        } else {
          col *= 0.9 + 0.2 * fbm(uv * 0.7);
        }
        col = mix(col, col * 0.45, seam);
        // Team trim stripe.
        float stripe = smoothstep(0.42, 0.46, abs(fract(vObj.y * 0.25 + 0.1) - 0.5));
        vec3 trim = uTeam * (0.6 + 0.9 * uPowered * (0.7 + 0.3 * sin(uTime * 2.0 + vObj.y)));
        col = mix(col, trim, stripe * 0.8);

        // Damage: burned & cracked where noise falls under the damage level.
        float dn = fbm(uv * 0.35 + uSeed);
        float burned = smoothstep(dn - 0.06, dn + 0.02, uDamage * 0.9);
        float crack = smoothstep(0.03, 0.0, abs(vnoise(uv * 1.3 + uSeed) - 0.5)) * burned;
        col = mix(col, col * 0.18, burned * 0.8);
        col = mix(col, vec3(1.0, 0.45, 0.1) * (0.6 + 0.4 * sin(uTime * 8.0 + dn * 40.0)), crack * 0.7);
        // Repair seam: a glowing front where plating is being restored by a repair beam.
        float front = smoothstep(0.05, 0.0, abs(dn - uDamage * 0.9)) * uHealing;
        vec3 heal = vec3(0.3, 1.0, 0.85) * front * 1.5;

        float diff = max(dot(n, uSunDir), 0.0);
        vec3 lit = col * (uSunColor * diff + uAmbient * mix(vec3(0.5), vec3(0.8, 0.85, 1.0), n.y * 0.5 + 0.5));
        // Blinn-Phong sheen from the roughness/metal maps so plating reads as metal.
        vec3 vdir = normalize(uCamPos - vPos);
        float spec = pow(max(dot(n, normalize(uSunDir + vdir)), 0.0), mix(64.0, 6.0, rough)) * mix(0.08, 0.6, metal) * (1.0 - rough * 0.6);
        lit += uSunColor * spec * diff;
        lit += heal + uTeam * uEmissive * uPowered;
        gl_FragColor = vec4(applyFog(lit, vPos), uAlpha); // output in the renderer's colour space (sRGB)
#include <colorspace_fragment>

      }`,
  });
  return mat;
}

/** Simple lit, fogged material for small things (players, pickups, flags). */
export function makeLitMaterial(color: number, emissive = 0) {
  if (!shared) throw new Error('shared uniforms not set');
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: new THREE.Color(color) }, uEm: { value: emissive } },
    vertexShader: /* glsl */ `
      varying vec3 vPos; varying vec3 vNor;
      void main(){ vec4 w = modelMatrix * vec4(position,1.0); vPos = w.xyz; vNor = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogGLSL()}
      uniform vec3 uColor, uSunDir, uSunColor; uniform float uAmbient, uEm;
      varying vec3 vPos; varying vec3 vNor;
      void main(){
        vec3 n = normalize(vNor);
        float diff = max(dot(n, uSunDir), 0.0);
        vec3 lit = uColor * (uSunColor * diff + uAmbient * 0.8 + uEm);
        gl_FragColor = vec4(applyFog(lit, vPos), 1.0); // output in the renderer's colour space (sRGB)
#include <colorspace_fragment>

      }`,
  });
}

export function makeGlowMaterial(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
}
