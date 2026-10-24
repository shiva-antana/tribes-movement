import * as THREE from 'three';
import { GRAVITY, WeaponDef } from '../config';
import { makeGlowMaterial } from './materials';
import type { Game } from './game';
import type { Player } from './player';
import type { Vehicle } from './vehicles';

export class Projectile {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  age = 0;
  fuseLeft: number;
  alive = true;
  ownerVehicle: Vehicle | null = null;
  trailTimer = 0;
  traveled = 0;
  constructor(readonly def: WeaponDef, readonly owner: Player | null, readonly team: number, readonly mesh: THREE.Object3D) {
    this.fuseLeft = def.fuse;
  }
}

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry) {
  let g = geoCache.get(key);
  if (!g) { g = make(); geoCache.set(key, g); }
  return g;
}

export class WeaponSystem {
  readonly list: Projectile[] = [];
  constructor(private game: Game) {}

  fire(def: WeaponDef, origin: THREE.Vector3, dir: THREE.Vector3, shooterVel: THREE.Vector3, owner: Player | null, team: number, ownerVehicle: Vehicle | null = null): Projectile {
    let mesh: THREE.Object3D;
    if (def.name === 'Spinfusor') {
      mesh = new THREE.Mesh(geo('disc', () => new THREE.CylinderGeometry(0.35, 0.35, 0.1, 16)), makeGlowMaterial(def.color, 0.95));
    } else if (def.radius === 0) {
      mesh = new THREE.Mesh(geo('tracer', () => new THREE.BoxGeometry(0.06, 0.06, 2.4)), makeGlowMaterial(def.color, 0.9));
    } else {
      const r = Math.min(0.6, 0.15 + def.radius * 0.03);
      mesh = new THREE.Mesh(geo('ball' + r, () => new THREE.SphereGeometry(r, 10, 8)), makeGlowMaterial(def.color, 0.95));
    }
    const p = new Projectile(def, owner, team, mesh);
    p.ownerVehicle = ownerVehicle;
    p.pos.copy(origin);
    p.vel.copy(dir).multiplyScalar(def.speed).addScaledVector(shooterVel, def.inherit);
    mesh.position.copy(origin);
    this.game.scene.add(mesh);
    this.list.push(p);
    return p;
  }

  update(dt: number) {
    const g = this.game;
    const seg = new THREE.Vector3();
    const hitInfo = { box: null as unknown as import('./colliders').OBB | null, normal: new THREE.Vector3() };
    for (const p of this.list) {
      if (!p.alive) continue;
      p.age += dt;
      p.fuseLeft -= dt;
      if (p.fuseLeft <= 0) { this.detonate(p, p.pos.clone(), null); continue; }
      const wasSub = g.isSubmerged(p.pos);
      p.vel.y -= GRAVITY * p.def.gravity * dt;
      if (wasSub) p.vel.multiplyScalar(Math.exp(-1.2 * dt));
      else if (p.def.drag) {
        // Drag acts on velocity relative to the moving air: slow rounds drift downwind in a gale.
        const air = g.env.windAt(p.pos.x, p.pos.y, p.pos.z, new THREE.Vector3());
        p.vel.addScaledVector(air.sub(p.vel), Math.min(1, p.def.drag * dt));
      }
      seg.copy(p.vel).multiplyScalar(dt);
      const len = seg.length();
      if (len < 1e-6) continue;
      const dir = seg.clone().divideScalar(len);

      // Entities first (direct hits).
      let tHit = Infinity;
      let victim: Player | Vehicle | null = null;
      for (const pl of g.players) {
        if (!pl.alive || pl.vehicle || (pl === p.owner && p.age < 0.25)) continue;
        if (pl.team === p.team && pl !== p.owner && p.def.radius === 0) continue;
        const t = segSphere(p.pos, dir, len, pl.center, pl.armor.radius + 0.35);
        if (t >= 0 && t < tHit) { tHit = t; victim = pl; }
      }
      for (const v of g.vehicles) {
        if (!v.alive || v === p.ownerVehicle) continue;
        const t = segSphere(p.pos, dir, len, v.pos, v.radius);
        if (t >= 0 && t < tHit) { tHit = t; victim = v; }
      }
      const tBox = g.colliders.raycast(p.pos, dir, len, hitInfo);
      const tTer = g.terrain.raycast(p.pos, dir, len);
      let surface: 'box' | 'terrain' | null = null;
      let tSurf = Infinity;
      if (tBox >= 0 && tBox < tSurf) { tSurf = tBox; surface = 'box'; }
      if (tTer >= 0 && tTer < tSurf) { tSurf = tTer; surface = 'terrain'; }

      if (victim && tHit <= tSurf) {
        const at = p.pos.clone().addScaledVector(dir, tHit);
        if (p.def.radius > 0) this.detonate(p, at, victim);
        else {
          // Range falloff and head hits for bullets/bolts.
          let mult = 1;
          const fo = p.def.falloff;
          if (fo) { const d = p.traveled + tHit; mult = d <= fo[0] ? 1 : Math.max(fo[2], 1 - (1 - fo[2]) * (d - fo[0]) / (fo[1] - fo[0])); }
          const head = 'armor' in victim && at.y > victim.pos.y + victim.armor.height * 0.8;
          if (head && p.def.headshot) mult *= p.def.headshot;
          g.directHit(victim, p.def, p.owner, dir, mult, head);
          g.fx.spark(at, head ? 0xff4040 : p.def.color);
          this.kill(p);
        }
        continue;
      }
      if (surface) {
        const at = p.pos.clone().addScaledVector(dir, Math.max(0, tSurf - 0.05));
        const n = surface === 'terrain' ? g.terrain.normalAt(at.x, at.z) : hitInfo.normal.clone();
        if (surface === 'terrain' && g.biome.frozen && at.y <= g.biome.seaLevel + 0.1) n.set(0, 1, 0);
        if (p.def.bounce && p.def.radius > 0) {
          const vn = p.vel.dot(n);
          p.vel.addScaledVector(n, -1.55 * vn).multiplyScalar(0.6);
          p.pos.copy(at).addScaledVector(n, 0.15);
          if (p.vel.length() < 2) p.vel.set(0, 0, 0);
          g.audio.bounce(at);
        } else if (p.def.radius > 0) {
          this.detonate(p, at, null);
        } else {
          if (surface === 'box' && hitInfo.box?.owner) g.damageStructure(hitInfo.box.owner as any, p.def.damage * p.def.structureMult, p.team, hitInfo.box);
          g.fx.spark(at, p.def.color);
          this.kill(p);
        }
        continue;
      }
      p.pos.add(seg);
      p.traveled += len;
      const nowSub = g.isSubmerged(p.pos);
      if (nowSub && !wasSub) { g.fx.splash(p.pos); p.vel.multiplyScalar(0.4); }
      p.mesh.position.copy(p.pos);
      if (p.def.name === 'Spinfusor') p.mesh.rotation.y += dt * 30;
      else p.mesh.lookAt(p.pos.clone().add(p.vel));
      p.trailTimer -= dt;
      if (p.def.radius > 0 && p.trailTimer <= 0) { p.trailTimer = 0.025; g.fx.trail(p.pos, p.def.color); }
      if (!g.terrain.inBounds(p.pos.x, p.pos.z, -200) || p.pos.y < -50) this.kill(p);
    }
    for (let i = this.list.length - 1; i >= 0; i--) if (!this.list[i].alive) this.list.splice(i, 1);
  }

  private detonate(p: Projectile, at: THREE.Vector3, direct: Player | Vehicle | null) {
    if (p.def.radius > 0) this.game.explode(at, p.def, p.owner, p.team, direct);
    this.kill(p);
  }

  private kill(p: Projectile) {
    p.alive = false;
    this.game.scene.remove(p.mesh);
    ((p.mesh as THREE.Mesh).material as THREE.Material).dispose();
    void 0;
  }
}

/** Segment (origin o, unit dir d, length len) vs sphere. Returns distance or -1. */
export function segSphere(o: THREE.Vector3, d: THREE.Vector3, len: number, c: THREE.Vector3, r: number): number {
  const mx = o.x - c.x, my = o.y - c.y, mz = o.z - c.z;
  const b = mx * d.x + my * d.y + mz * d.z;
  const cc = mx * mx + my * my + mz * mz - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = Math.max(0, -b - Math.sqrt(disc));
  return t <= len ? t : -1;
}

// ---------------------------------------------------------------- effects

interface Fx { obj: THREE.Object3D; life: number; max: number; tick: (f: Fx, k: number, dt: number) => void; }

export class Effects {
  private list: Fx[] = [];
  constructor(private scene: THREE.Scene) {}

  private add(obj: THREE.Object3D, life: number, tick: Fx['tick']) {
    this.scene.add(obj);
    this.list.push({ obj, life, max: life, tick });
  }

  explosion(at: THREE.Vector3, radius: number, color = 0xffb060) {
    const core = new THREE.Mesh(geo('exp', () => new THREE.SphereGeometry(1, 20, 12)), makeGlowMaterial(color, 1));
    core.position.copy(at);
    this.add(core, 0.5, (f, k) => { core.scale.setScalar(radius * (0.3 + 0.9 * (1 - k))); (core.material as THREE.MeshBasicMaterial).opacity = k; });
    const white = new THREE.Mesh(geo('exp', () => new THREE.SphereGeometry(1, 20, 12)), makeGlowMaterial(0xffffff, 1));
    white.position.copy(at);
    this.add(white, 0.15, (f, k) => { white.scale.setScalar(radius * 0.5 * (1.2 - k)); (white.material as THREE.MeshBasicMaterial).opacity = k; });
    const ring = new THREE.Mesh(geo('ring', () => new THREE.RingGeometry(0.85, 1, 32)), makeGlowMaterial(color, 0.6));
    ring.position.copy(at); ring.rotation.x = -Math.PI / 2;
    (ring.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    this.add(ring, 0.6, (f, k) => { ring.scale.setScalar(radius * 2.2 * (1 - k) + 0.5); (ring.material as THREE.MeshBasicMaterial).opacity = k * 0.6; });
    for (let i = 0; i < 6; i++) {
      const smoke = new THREE.Mesh(geo('smoke', () => new THREE.SphereGeometry(1, 8, 6)), new THREE.MeshBasicMaterial({ color: 0x3a3632, transparent: true, opacity: 0.5, depthWrite: false }));
      smoke.position.copy(at).add(new THREE.Vector3((Math.random() - 0.5) * radius, Math.random() * radius * 0.5, (Math.random() - 0.5) * radius));
      const rise = 2 + Math.random() * 3;
      this.add(smoke, 2.5, (f, k, dt) => { smoke.position.y += rise * dt; smoke.scale.setScalar(radius * 0.35 * (1.6 - k)); (smoke.material as THREE.MeshBasicMaterial).opacity = k * 0.45; });
    }
  }

  spark(at: THREE.Vector3, color: number) {
    const s = new THREE.Mesh(geo('spark', () => new THREE.SphereGeometry(0.25, 6, 4)), makeGlowMaterial(color, 1));
    s.position.copy(at);
    this.add(s, 0.15, (f, k) => { s.scale.setScalar(1 + (1 - k) * 2); (s.material as THREE.MeshBasicMaterial).opacity = k; });
  }

  trail(at: THREE.Vector3, color: number) {
    const s = new THREE.Mesh(geo('trail', () => new THREE.SphereGeometry(0.2, 6, 4)), makeGlowMaterial(color, 0.5));
    s.position.copy(at);
    this.add(s, 0.35, (f, k) => { (s.material as THREE.MeshBasicMaterial).opacity = k * 0.45; s.scale.setScalar(0.6 + (1 - k) * 2); });
  }

  splash(at: THREE.Vector3) {
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Mesh(geo('spray', () => new THREE.SphereGeometry(0.3, 6, 4)), makeGlowMaterial(0xe8f6ff, 0.8));
      s.position.copy(at);
      const v = new THREE.Vector3((Math.random() - 0.5) * 6, 6 + Math.random() * 6, (Math.random() - 0.5) * 6);
      this.add(s, 0.8, (f, k, dt) => { v.y -= GRAVITY * dt; s.position.addScaledVector(v, dt); (s.material as THREE.MeshBasicMaterial).opacity = k; });
    }
  }

  beam(a: THREE.Vector3, b: THREE.Vector3, color: number, life = 0.08, width = 0.12) {
    const len = a.distanceTo(b);
    const m = new THREE.Mesh(geo('beam', () => new THREE.BoxGeometry(1, 1, 1)), makeGlowMaterial(color, 0.8));
    m.scale.set(width, width, len);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.lookAt(b);
    this.add(m, life, (f, k) => { (m.material as THREE.MeshBasicMaterial).opacity = k * 0.8; });
  }

  /** Brief muzzle flash at the barrel. */
  muzzleFlash(at: THREE.Vector3, dir: THREE.Vector3, color: number) {
    const m = new THREE.Mesh(geo('flash', () => new THREE.ConeGeometry(0.12, 0.5, 6)), makeGlowMaterial(0xfff2c0, 1));
    m.position.copy(at).addScaledVector(dir, 0.25);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const c = new THREE.Mesh(geo('flashc', () => new THREE.SphereGeometry(0.12, 6, 4)), makeGlowMaterial(color, 0.9));
    c.position.copy(at);
    this.add(m, 0.05, (f, k) => { m.scale.setScalar(0.6 + Math.random() * 0.8); (m.material as THREE.MeshBasicMaterial).opacity = k; });
    this.add(c, 0.06, (f, k) => { (c.material as THREE.MeshBasicMaterial).opacity = k; });
  }

  /** Vertical teleport column (beam-up to sky platforms). */
  column(at: THREE.Vector3, height: number, color = 0x9fd8ff) {
    const m = new THREE.Mesh(geo('col', () => new THREE.CylinderGeometry(1, 1, 1, 16, 1, true)), makeGlowMaterial(color, 0.6));
    (m.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    m.scale.set(2, height, 2);
    m.position.copy(at).add(new THREE.Vector3(0, height / 2, 0));
    this.add(m, 0.8, (f, k) => { (m.material as THREE.MeshBasicMaterial).opacity = k * 0.6; m.scale.x = m.scale.z = 2 * k + 0.2; });
  }

  update(dt: number) {
    for (const f of this.list) {
      f.life -= dt;
      f.tick(f, Math.max(0, f.life / f.max), dt);
      if (f.life <= 0) {
        this.scene.remove(f.obj);
        const m = (f.obj as THREE.Mesh).material as THREE.Material | undefined;
        m?.dispose();
      }
    }
    this.list = this.list.filter(f => f.life > 0);
  }
}
