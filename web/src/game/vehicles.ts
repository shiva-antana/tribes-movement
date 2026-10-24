import * as THREE from 'three';
import { GRAVITY, TEAM_COLORS, VEHICLES, VehicleDef, VehicleKind, WeaponDef } from '../config';
import { makePlateMaterial, makeGlowMaterial } from './materials';
import type { Game } from './game';
import type { Player } from './player';
import type { Structure } from './structures';

export const SHRIKE_BLASTER: WeaponDef = {
  id: 'blaster', name: 'Shrike Blaster', speed: 220, gravity: 0, inherit: 1, damage: 22, radius: 2.5,
  impulse: 300, reload: 0.14, ammo: Infinity, energyCost: 0, bounce: false, fuse: 2, spread: 0.006,
  color: 0xff4a8a, structureMult: 0.8,
};
export const TANK_SHELL: WeaponDef = {
  id: 'mortar', name: 'Siege Shell', speed: 85, gravity: 0.6, inherit: 0.5, damage: 150, radius: 14,
  impulse: 6000, reload: 2.4, ammo: Infinity, energyCost: 0, bounce: false, fuse: 8, spread: 0,
  color: 0xffb040, structureMult: 3.5,
};

const UP = new THREE.Vector3(0, 1, 0);

function placed(m: THREE.Mesh, at: number[], rot?: number[]) {
  m.position.set(at[0], at[1], at[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  return m;
}

export class Vehicle {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly def: VehicleDef;
  readonly mesh = new THREE.Group();
  readonly mats: THREE.ShaderMaterial[] = [];
  readonly named = new Map<string, THREE.Object3D>();
  hp: number;
  alive = true;
  driver: Player | null = null;
  yaw = 0; pitch = 0; roll = 0;
  hullYaw = 0;
  energy = 100;
  fireTimer = 0;
  side = 1;
  deployed: Structure | null = null;
  grounded = false;
  blockedByWater = false;
  onRoad = false;
  radius: number;
  lastDamaged = -100;
  abandonTimer = 0;

  constructor(readonly kind: VehicleKind, readonly team: number, at: THREE.Vector3, yaw: number, private game: Game) {
    this.def = VEHICLES[kind];
    this.hp = this.def.health;
    this.pos.copy(at);
    this.yaw = this.hullYaw = yaw;
    this.radius = kind === 'gravcycle' ? 2.2 : kind === 'shrike' ? 4 : kind === 'tank' ? 4.5 : 6;
    this.buildMesh();
    game.scene.add(this.mesh);
  }

  private part(size: [number, number, number], at: [number, number, number], color: number, key?: string, parent: THREE.Object3D = this.mesh) {
    const m = makePlateMaterial(this.team, color, TEAM_COLORS[this.team]);
    this.mats.push(m);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), m);
    mesh.position.set(...at);
    parent.add(mesh);
    if (key) this.named.set(key, mesh);
    return mesh;
  }

  private buildMesh() {
    const T = TEAM_COLORS[this.team];
    switch (this.kind) {
      case 'gravcycle':
        this.part([1.4, 0.8, 4.2], [0, 0.6, 0], 0x8a929c);
        this.part([2.8, 0.2, 1.2], [0, 0.4, 1.4], 0x6a717b);
        this.part([0.9, 0.6, 1], [0, 1.2, 0.4], 0x50565e);
        this.mesh.add(placed(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.1, 3.6), makeGlowMaterial(T, 0.5)), [0, 0.05, 0]));
        break;
      case 'shrike':
        this.part([1.6, 1.4, 8], [0, 0, 0], 0x8a929c);
        this.part([11, 0.25, 2.4], [0, -0.1, 0.8], 0x737a84);
        this.part([4.5, 0.2, 1.4], [0, 0.4, 3.6], 0x737a84);
        this.part([0.2, 1.8, 1.4], [0, 1.2, 3.6], 0x737a84);
        this.part([1.2, 0.7, 2], [0, 0.85, -1.4], 0x2a3038);
        this.mesh.add(placed(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.2, 1.5, 8), makeGlowMaterial(0x9fd8ff, 0.8)), [0, 0, 4.6], [Math.PI / 2, 0, 0]));
        break;
      case 'tank': {
        this.part([5.2, 1.6, 8], [0, 1.0, 0], 0x6a717b, 'hull');
        this.part([1.2, 1.4, 8.4], [-2.8, 0.7, 0], 0x40454c);
        this.part([1.2, 1.4, 8.4], [2.8, 0.7, 0], 0x40454c);
        const turret = new THREE.Group();
        turret.position.set(0, 2.2, 0);
        this.mesh.add(turret);
        this.named.set('turret', turret);
        this.part([3.4, 1.3, 3.8], [0, 0, 0], 0x7b828c, undefined, turret);
        const barrel = new THREE.Group();
        barrel.position.set(0, 0.2, -1.6);
        turret.add(barrel);
        this.named.set('barrel', barrel);
        this.part([0.5, 0.5, 5], [0, 0, -2.5], 0x5a6068, undefined, barrel);
        break;
      }
      case 'transport':
        this.part([5, 3.4, 12], [0, 0, 0], 0x7b828c);
        this.part([5.4, 0.6, 9], [0, 1.9, 0.5], 0x5d636b);
        for (const [x, z] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
          this.part([2, 1.4, 2.6], [x, 0.2, z], 0x6a717b);
          this.mesh.add(placed(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.2, 12), makeGlowMaterial(0x9fd8ff, 0.6)), [x, -0.6, z]));
        }
        this.part([3, 1.2, 1.4], [0, 0.6, -6.4], 0x2a3038);
        break;
    }
  }

  seatPos() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.2, this.pos.z); }

  damage(amount: number, attacker: Player | null) {
    if (!this.alive) return;
    this.hp -= amount;
    this.lastDamaged = this.game.time;
    if (this.hp <= 0) this.game.destroyVehicle(this, attacker);
  }

  /** Ground surface for this vehicle: terrain, ice, structure tops, and (for hover) water. */
  private surface(x: number, z: number, hoverOverWater: boolean) {
    const g = this.game;
    const gr = g.terrain.groundAt(x, z);
    let y = gr.y;
    const sb = g.colliders.surfaceBelow(x, this.pos.y + 1, z);
    if (sb > y) y = sb;
    const sea = g.biome.seaLevel;
    if (hoverOverWater && y < sea) y = sea;
    return { y, water: !g.biome.frozen && y < sea - 0.01, depth: sea - y, onStructure: sb >= gr.y };
  }

  update(dt: number) {
    if (!this.alive) return;
    const g = this.game;
    const c = this.driver?.controls;
    this.fireTimer -= dt;
    this.energy = Math.min(100, this.energy + 12 * dt);
    if (!this.driver) {
      this.abandonTimer += dt;
      if (this.abandonTimer > 90 && !this.deployed) { g.destroyVehicle(this, null); return; }
    } else this.abandonTimer = 0;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wind = g.env.windAt(this.pos.x, this.pos.y, this.pos.z, new THREE.Vector3());

    if (this.deployed) { this.vel.set(0, 0, 0); this.syncMesh(); return; }

    switch (this.kind) {
      case 'gravcycle': {
        if (c) this.yaw = c.yaw;
        const s = this.surface(this.pos.x, this.pos.z, true);
        const target = s.y + 1.8;
        if (c) {
          this.vel.addScaledVector(fwd, 42 * c.forward * dt);
          this.vel.addScaledVector(right, 22 * c.strafe * dt);
          if (c.jet && this.energy > 1) { this.vel.addScaledVector(fwd, 38 * dt); this.energy -= 30 * dt; }
          if (c.jumpPressed && this.pos.y < target + 0.8) this.vel.y += 11;
          c.jumpPressed = false;
        }
        this.vel.y -= GRAVITY * dt;
        if (this.pos.y < target) {
          this.vel.y += ((target - this.pos.y) * 40 - this.vel.y * 5) * dt;
          // Slopes push hover vehicles downhill — a hover "ski".
          const n = g.terrain.normalAt(this.pos.x, this.pos.z);
          this.vel.x += n.x * GRAVITY * 0.6 * dt; this.vel.z += n.z * GRAVITY * 0.6 * dt;
          if (this.pos.y < s.y + 0.3) this.pos.y = s.y + 0.3;
        }
        const drag = Math.exp(-(c && (c.forward || c.strafe) ? 0.35 : 1.0) * dt);
        this.vel.x *= drag; this.vel.z *= drag;
        this.vel.addScaledVector(wind.clone().sub(this.vel).setY(0), this.def.windArea * 0.03 * dt);
        this.pitch = THREE.MathUtils.lerp(this.pitch, -this.vel.y * 0.02, 0.1);
        this.roll = THREE.MathUtils.lerp(this.roll, -(c?.strafe ?? 0) * 0.3, 0.1);
        break;
      }
      case 'tank': {
        if (c) {
          this.hullYaw -= c.strafe * 1.1 * dt;
          this.yaw = this.hullYaw;
        }
        const hf = new THREE.Vector3(-Math.sin(this.hullYaw), 0, -Math.cos(this.hullYaw));
        const s = this.surface(this.pos.x, this.pos.z, false);
        const onGround = this.pos.y <= s.y + 0.4;
        this.vel.y -= GRAVITY * dt;
        if (onGround) {
          this.pos.y = Math.max(this.pos.y, s.y);
          if (this.vel.y < 0) this.vel.y = 0;
          const n = s.onStructure ? UP : g.terrain.normalAt(this.pos.x, this.pos.z);
          let throttle = c ? c.forward : 0;
          if (c?.jet && this.energy > 1) { throttle *= 1.5; this.energy -= 20 * dt; }
          // Treads: velocity locks to hull direction.
          const along = this.vel.dot(hf);
          let newAlong = along + throttle * 14 * dt;
          newAlong *= Math.exp(-(throttle ? 0.3 : 2.2) * dt);
          // Climbing steep slopes is slow.
          const uphill = -(n.x * hf.x + n.z * hf.z) * Math.sign(newAlong);
          if (uphill > 0.35 && g.terrain.roadAt(this.pos.x, this.pos.z) < 0.5) newAlong *= Math.exp(-uphill * 3 * dt);
          // Graded roads: full traction, no climb penalty, 60% higher top speed.
          const road = g.terrain.roadAt(this.pos.x, this.pos.z) > 0.5;
          this.onRoad = road;
          if (road && throttle) newAlong += throttle * 8 * dt;
          newAlong = THREE.MathUtils.clamp(newAlong, -8, this.def.maxSpeed * (road ? 1.6 : 1));
          this.vel.x = hf.x * newAlong; this.vel.z = hf.z * newAlong;
          this.pitch = THREE.MathUtils.lerp(this.pitch, -Math.asin(THREE.MathUtils.clamp(n.x * hf.x + n.z * hf.z, -1, 1)), 0.1);
        }
        // Deep water is impassable for siege armor: it has to go around or over a bridge.
        const next = this.pos.clone().addScaledVector(this.vel, dt * 6);
        const ns = this.surface(next.x, next.z, false);
        this.blockedByWater = ns.water && ns.depth > 2.5;
        if (this.blockedByWater) { this.vel.x *= -0.2; this.vel.z *= -0.2; }
        // Turret tracks the driver's aim.
        const turret = this.named.get('turret'), barrel = this.named.get('barrel');
        if (c && turret && barrel) {
          turret.rotation.y = c.yaw - this.hullYaw;
          barrel.rotation.x = THREE.MathUtils.clamp(c.pitch, -0.2, 0.7);
        }
        break;
      }
      case 'shrike': {
        if (c) { this.yaw = c.yaw; this.pitch = THREE.MathUtils.clamp(c.pitch, -1.2, 1.2); }
        const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
        const throttle = c ? Math.max(0, c.forward) : 0;
        this.vel.addScaledVector(look, (30 + throttle * 40) * dt * (c ? 1 : 0));
        if (c?.jet && this.energy > 1) { this.vel.addScaledVector(look, 40 * dt); this.energy -= 25 * dt; }
        if (c && c.forward < 0) this.vel.multiplyScalar(Math.exp(-1.2 * dt));
        const air = this.vel.clone().sub(wind);
        const spd = air.length();
        // Lift scales with airspeed: stall below ~30 m/s.
        const lift = GRAVITY * Math.min(1.05, (spd / 35) ** 2);
        this.vel.y += (lift - GRAVITY) * dt;
        // Align velocity with the nose (aerodynamic).
        const along = look.clone().multiplyScalar(this.vel.dot(look));
        const lateral = this.vel.clone().sub(along);
        this.vel.addScaledVector(lateral, -Math.min(1, 1.8 * dt));
        // Wind: gusts and katabatic downdrafts shove the airframe.
        this.vel.addScaledVector(wind.clone().sub(this.vel), this.def.windArea * 0.05 * dt);
        const turb = wind.length() * this.def.windArea * 0.35;
        this.vel.x += (Math.random() - 0.5) * turb * dt * 4;
        this.vel.y += (Math.random() - 0.5) * turb * dt * 4;
        this.vel.z += (Math.random() - 0.5) * turb * dt * 4;
        this.vel.multiplyScalar(Math.exp(-0.15 * dt));
        this.roll = THREE.MathUtils.lerp(this.roll, -(c?.strafe ?? 0) * 0.6, 0.08);
        break;
      }
      case 'transport': {
        if (c) this.yaw = c.yaw;
        if (c) {
          this.vel.addScaledVector(fwd, 22 * c.forward * dt);
          this.vel.addScaledVector(right, 14 * c.strafe * dt);
          if (c.jet && this.energy > 0.5) { this.vel.y += 30 * dt; this.energy -= 6 * dt; }
          if (c.descend) this.vel.y -= 14 * dt;
          this.vel.y -= this.vel.y * 1.5 * dt; // anti-grav damping (hover)
        } else this.vel.y -= GRAVITY * 0.5 * dt;
        this.vel.x *= Math.exp(-0.5 * dt); this.vel.z *= Math.exp(-0.5 * dt);
        this.vel.addScaledVector(wind.clone().sub(this.vel), this.def.windArea * 0.04 * dt);
        const turb = wind.length() * this.def.windArea * 0.25;
        this.vel.x += (Math.random() - 0.5) * turb * dt * 4;
        this.vel.z += (Math.random() - 0.5) * turb * dt * 4;
        this.pitch = THREE.MathUtils.lerp(this.pitch, -(c?.forward ?? 0) * 0.12, 0.05);
        this.roll = THREE.MathUtils.lerp(this.roll, -(c?.strafe ?? 0) * 0.15, 0.05);
        break;
      }
    }

    // Speed cap.
    const sp = this.vel.length();
    const cap = this.def.maxSpeed * (this.onRoad ? 1.7 : 1.4);
    if (sp > cap) this.vel.multiplyScalar(cap / sp);

    this.pos.addScaledVector(this.vel, dt);

    // Generic ground collision for flyers / fallen vehicles.
    const s = this.surface(this.pos.x, this.pos.z, this.kind === 'gravcycle');
    const minY = s.y + (this.def.flies ? 1.6 : 0);
    this.grounded = false;
    if (this.pos.y < minY) {
      const impact = -this.vel.y;
      if (impact > 18 && this.def.flies) this.damage((impact - 18) * 12, null);
      this.pos.y = minY;
      if (this.vel.y < 0) this.vel.y = 0;
      this.grounded = true;
      if (this.def.flies) { this.vel.x *= Math.exp(-3 * dt); this.vel.z *= Math.exp(-3 * dt); }
    }
    if (s.water && this.def.flies && this.pos.y < g.biome.seaLevel + 1) { this.vel.y += 25 * dt; }
    // Structures.
    const n = new THREE.Vector3();
    const center = this.pos.clone().add(new THREE.Vector3(0, this.radius * 0.5, 0));
    if (g.colliders.resolveSphere(center, this.radius * 0.6, n)) {
      const delta = center.sub(this.pos).sub(new THREE.Vector3(0, this.radius * 0.5, 0));
      this.pos.add(delta);
      const into = this.vel.dot(n);
      if (into < 0) { if (into < -22) this.damage((-into - 22) * 10, null); this.vel.addScaledVector(n, -into * 1.2); }
    }
    const half = 1500;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -half, half);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -half, half);
    this.pos.y = Math.min(this.pos.y, 900);

    if (c && c.fire && this.fireTimer <= 0 && this.driver) this.fireWeapon(this.driver);
    this.syncMesh();
  }

  private fireWeapon(d: Player) {
    const g = this.game;
    if (this.kind === 'shrike') {
      this.fireTimer = SHRIKE_BLASTER.reload;
      this.side = -this.side;
      const look = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
      const right = new THREE.Vector3().crossVectors(look, UP).normalize();
      const muzzle = this.pos.clone().addScaledVector(look, 5).addScaledVector(right, this.side * 3);
      g.weapons.fire(SHRIKE_BLASTER, muzzle, look, this.vel, d, this.team, this);
      g.audio.shot(muzzle, 'blaster', d === g.human);
    } else if (this.kind === 'tank') {
      this.fireTimer = TANK_SHELL.reload;
      const dir = d.aimDir();
      const muzzle = this.pos.clone().add(new THREE.Vector3(0, 2.6, 0)).addScaledVector(dir, 6);
      g.weapons.fire(TANK_SHELL, muzzle, dir, this.vel, d, this.team, this);
      g.audio.shot(muzzle, 'mortar', d === g.human);
      this.vel.addScaledVector(dir, -2);
    }
  }

  private syncMesh() {
    this.mesh.position.copy(this.pos);
    if (this.kind === 'tank') this.mesh.rotation.set(0, this.hullYaw, 0);
    else this.mesh.rotation.set(0, this.yaw, 0);
    this.mesh.rotateX(this.pitch);
    this.mesh.rotateZ(this.roll);
    const dmg = 1 - this.hp / this.def.health;
    for (const m of this.mats) m.uniforms.uDamage.value = dmg;
  }
}
