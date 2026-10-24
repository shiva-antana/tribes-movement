import * as THREE from 'three';
import { Biome } from './biomes';
import { Terrain, SIZE } from './terrain';
import { NOISE_GLSL, fogGLSL, sharedUniforms } from './terrainShader';
import { Simplex2 } from '../noise';

/** Sky dome, sea/ice, wind field and wind-borne particles. */
export class Environment {
  readonly group = new THREE.Group();
  readonly uniforms: ReturnType<typeof sharedUniforms>;
  private sky: THREE.Mesh;
  private water: THREE.Mesh;
  private particles: THREE.Points;
  private pVel: Float32Array;
  private noise: Simplex2;
  private windDir: THREE.Vector2;
  private time = 0;
  private lastCam: THREE.Vector3 | null = null;
  readonly mats: THREE.ShaderMaterial[] = [];
  /** Set by the game each frame (air domes keep base interiors dry). */
  cameraSubmerged = false;

  constructor(readonly biome: Biome, readonly terrain: Terrain, seed: number) {
    this.uniforms = sharedUniforms(biome);
    this.noise = new Simplex2(seed + 99);
    const a = (seed % 360) * Math.PI / 180;
    this.windDir = new THREE.Vector2(Math.cos(a), Math.sin(a));

    // --- Sky ---
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        ...this.uniforms,
        uTop: { value: new THREE.Color(biome.skyTop) },
        uHorizon: { value: new THREE.Color(biome.skyHorizon) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        uniform vec3 uTop, uHorizon, uSunDir, uSunColor, uFogColor; uniform float uTime, uUnderwater; uniform vec3 uWaterTint;
        varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55));
          col = mix(col, uFogColor, smoothstep(0.12, -0.05, h));
          float sun = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sun, 900.0) * 3.0 + pow(sun, 12.0) * 0.25);
          // A huge pale gas giant hanging over the horizon: the far, desolate frontier.
          vec3 pd = normalize(vec3(-0.6, 0.28, -0.75));
          float pr = acos(clamp(dot(d, pd), -1.0, 1.0));
          if (pr < 0.22) {
            float r = pr / 0.22;
            float bands = fbm(vec2(dot(d, vec3(0.2, 1.0, 0.1)) * 40.0, uTime * 0.002));
            vec3 pc = mix(vec3(0.95, 0.88, 0.8), vec3(0.78, 0.84, 0.95), bands);
            float limb = sqrt(1.0 - r * r);
            // Lit crescent facing the sun, pale and hazy like it's seen through thin atmosphere.
            vec3 nrm = normalize(d - pd * (1.0 - limb));
            float lit = clamp(dot(normalize(d - pd), uSunDir) * 0.8 + 0.55, 0.25, 1.0);
            vec3 planet = pc * (0.55 + 0.45 * limb) * lit;
            col = mix(col, planet, smoothstep(1.0, 0.97, r) * 0.32 * smoothstep(-0.02, 0.15, h));
          }
          // Wispy high cloud.
          vec2 cp = d.xz / max(h, 0.05) * 1.5 + uTime * 0.004;
          float cl = smoothstep(0.55, 0.85, fbm(cp)) * smoothstep(0.0, 0.25, h);
          col = mix(col, vec3(1.0), cl * 0.35);
          col = mix(col, uWaterTint, uUnderwater);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);
    this.mats.push(skyMat);

    // --- Sea / ice ---
    const waterMat = new THREE.ShaderMaterial({
      transparent: !biome.frozen,
      side: THREE.DoubleSide,
      uniforms: {
        ...this.uniforms,
        uWater: { value: new THREE.Color(biome.waterColor) },
        uFrozen: { value: biome.frozen ? 1 : 0 },
      },
      vertexShader: `varying vec3 vPos; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        ${NOISE_GLSL}
        ${fogGLSL()}
        uniform vec3 uWater, uSunDir, uSunColor; uniform float uFrozen, uTime;
        varying vec3 vPos;
        void main(){
          vec2 p = vPos.xz;
          vec3 v = normalize(uCamPos - vPos);
          if (uFrozen > 0.5) {
            float cracks = smoothstep(0.02, 0.0, abs(vnoise(p * 0.08) - 0.5)) + smoothstep(0.015, 0.0, abs(vnoise(p * 0.21 + 7.0) - 0.5)) * 0.6;
            float frost = fbm(p * 0.05);
            vec3 col = mix(uWater, vec3(0.92, 0.96, 1.0), frost * 0.7);
            col = mix(col, uWater * 0.6, cracks * 0.6);
            float spec = pow(max(dot(reflect(-uSunDir, vec3(0,1,0)), v), 0.0), 60.0);
            col += uSunColor * spec * 0.6;
            gl_FragColor = vec4(applyFog(col, vPos), 1.0);
            return;
          }
          float t = uTime;
          vec2 g = vec2(vnoise(p * 0.05 + t * 0.15) - vnoise(p * 0.05 + vec2(3.1, 1.7) - t * 0.12),
                        vnoise(p * 0.11 - t * 0.2) - vnoise(p * 0.13 + vec2(9.0, 4.0) + t * 0.1));
          vec3 n = normalize(vec3(g.x * 0.35, 1.0, g.y * 0.35));
          float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
          vec3 refl = mix(uFogColor, vec3(0.8, 0.9, 1.0), 0.3);
          vec3 col = mix(uWater, refl, 0.15 + 0.75 * fres);
          float spec = pow(max(dot(reflect(-uSunDir, n), v), 0.0), 120.0);
          col += uSunColor * spec * 1.5;
          float a = mix(0.82, 0.97, fres);
          if (uCamPos.y < vPos.y) { col = uWater * 0.8; a = 0.6; }
          gl_FragColor = vec4(applyFog(col, vPos), a);
        }`,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(SIZE * 3, SIZE * 3, 1, 1), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = biome.seaLevel;
    this.water.renderOrder = 2;
    this.group.add(this.water);
    this.mats.push(waterMat);

    // --- Wind-borne particles (snow, dust, sea spray) ---
    const N = 4000;
    const pos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 240;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 120;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 240;
      this.pVel[i] = 0.5 + Math.random();
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pcol = biome.particles === 'snow' ? 0xffffff : biome.particles === 'dust' ? 0xc89a70 : 0xe0f0ff;
    const pMat = new THREE.PointsMaterial({ color: pcol, size: biome.particles === 'snow' ? 0.35 : 0.25, transparent: true, opacity: 0.75, depthWrite: false });
    this.particles = new THREE.Points(pg, pMat);
    this.particles.frustumCulled = false;
    this.group.add(this.particles);
  }

  /** Wind velocity at a point: prevailing + katabatic downslope drainage + gusts. */
  windAt(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    const b = this.biome;
    const t = this.time;
    out.set(this.windDir.x * b.windBase, 0, this.windDir.y * b.windBase);
    if (b.katabatic > 0) {
      // Cold dense air drains down the large-scale terrain gradient.
      const e = 90;
      const T = this.terrain;
      const gx = T.heightAt(x + e, z) - T.heightAt(x - e, z);
      const gz = T.heightAt(x, z + e) - T.heightAt(x, z - e);
      const g = Math.hypot(gx, gz) + 1e-3;
      const steep = Math.min(1, g / 60);
      const agl = y - T.heightAt(x, z);
      const layer = Math.exp(-Math.max(0, agl) / 180);
      // Pulsing surges: katabatic flows arrive in waves.
      const surge = 0.6 + 0.4 * Math.sin(t * 0.25 + x * 0.002 + z * 0.0015);
      const k = b.katabatic * steep * layer * surge;
      out.x -= (gx / g) * k;
      out.z -= (gz / g) * k;
      out.y -= k * 0.15 * steep;
    }
    const gn = this.noise.noise(x * 0.004 + t * 0.12, z * 0.004 - t * 0.09);
    const gn2 = this.noise.noise(z * 0.004 - t * 0.1 + 40, x * 0.004 + 13);
    out.x += gn * b.gust;
    out.z += gn2 * b.gust;
    out.y += this.noise.noise(x * 0.01 + t * 0.3, z * 0.01) * b.gust * 0.2;
    return out;
  }

  /** Distance above the nearest cold surface (water or ice) — drives jetpack cooling. */
  coldSurfaceProximity(x: number, y: number, z: number): { submerged: boolean; over: number } {
    const sea = this.biome.seaLevel;
    const terrainH = this.terrain.heightAt(x, z);
    if (terrainH < sea) {
      if (y < sea && !this.biome.frozen) return { submerged: true, over: 0 };
      return { submerged: false, over: y - sea };
    }
    // Snowfields in the tundra count as weakly cold surfaces.
    return { submerged: false, over: this.biome.frozen ? (y - terrainH) * 1.5 + 12 : Infinity };
  }

  update(dt: number, cam: THREE.Camera) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.uniforms.uCamPos.value.copy(cam.position);
    this.sky.position.copy(cam.position);
    const under = this.cameraSubmerged ? 1 : 0;
    this.uniforms.uUnderwater.value = under;

    const attr = this.particles.geometry.attributes.position as THREE.BufferAttribute;
    const P = attr.array as Float32Array;
    const w = this.windAt(cam.position.x, cam.position.y, cam.position.z, new THREE.Vector3());
    const fall = this.biome.particles === 'snow' ? -2.5 : this.biome.particles === 'spray' ? -0.6 : -0.3;
    this.particles.position.copy(cam.position);
    for (let i = 0; i < P.length / 3; i++) {
      const s = this.pVel[i];
      P[i * 3] += w.x * dt * s;
      P[i * 3 + 1] += (w.y * 0.3 + fall) * dt * s;
      P[i * 3 + 2] += w.z * dt * s;
      for (let k = 0; k < 3; k++) {
        const lim = k === 1 ? 60 : 120;
        if (P[i * 3 + k] > lim) P[i * 3 + k] -= lim * 2;
        else if (P[i * 3 + k] < -lim) P[i * 3 + k] += lim * 2;
      }
    }
    attr.needsUpdate = true;
    // Particles live in camera-relative space; shift them when the camera moves.
    const last = this.lastCam;
    if (last) {
      const dx = cam.position.x - last.x, dy = cam.position.y - last.y, dz = cam.position.z - last.z;
      for (let i = 0; i < P.length / 3; i++) { P[i * 3] -= dx; P[i * 3 + 1] -= dy; P[i * 3 + 2] -= dz; }
    }
    this.lastCam = cam.position.clone();
    (this.particles.material as THREE.PointsMaterial).opacity = under ? 0.2 : 0.75;
  }
}
