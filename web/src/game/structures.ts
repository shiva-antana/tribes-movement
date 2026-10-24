import * as THREE from 'three';
import { OBB } from './colliders';
import { makePlateMaterial, makeGlowMaterial } from './materials';
import { STRUCTURE_HP, StructureKind, TEAM_COLORS, WeaponDef } from '../config';
import type { Game } from './game';
import type { Player } from './player';
import type { Vehicle } from './vehicles';

interface Part {
  size: [number, number, number];
  at: [number, number, number];     // center offset in structure-local space
  color?: number;
  collide?: boolean;
  glow?: number;                     // additive glow color (no collision)
  geo?: 'box' | 'cyl' | 'sphere';
  key?: string;                      // named part (e.g. turret head)
  alpha?: number;
  hp?: number;                       // piece hit points for piecewise structures (Infinity = indestructible)
}

export const TURRET_PLASMA: WeaponDef = {
  id: 'blaster', name: 'Turret Plasma', speed: 95, gravity: 0, inherit: 0, damage: 32, radius: 4.5,
  impulse: 900, reload: 1.1, ammo: Infinity, energyCost: 0, bounce: false, fuse: 3, spread: 0.01,
  color: 0xff9a40, structureMult: 0.6,
};
export const FLAK: WeaponDef = {
  id: 'blaster', name: 'Flak', speed: 180, gravity: 0, inherit: 0, damage: 38, radius: 9,
  impulse: 1500, reload: 0.7, ammo: Infinity, energyCost: 0, bounce: false, fuse: 3, spread: 0,
  color: 0xffe0a0, structureMult: 0.2,
};

/** Turret mounts: eye height and range. Height on a wall buys range. */
const TURRET_STATS: Partial<Record<StructureKind, { muzzleY: number; range: number }>> = {
  turret: { muzzleY: 5, range: 160 },
  aaTurret: { muzzleY: 6, range: 320 },
  battery: { muzzleY: 9.4, range: 210 },
  flakTower: { muzzleY: 10.5, range: 380 },
};

/** Architecture that breaks apart panel by panel instead of as one hit-point pool. */
const PIECEWISE = new Set<StructureKind>(['bunker', 'wall', 'bridge', 'skyPlatform', 'flagStand']);
/** Materiel cost per hit point when rebuilding a piece that was blown away. */
export const REBUILD_COST_PER_HP = 0.06;

/** One destructible panel/segment of a piecewise structure. */
export class Piece {
  hp: number;
  destroyed = false;
  rubble: THREE.Object3D[] = [];
  constructor(readonly mesh: THREE.Mesh, readonly mat: THREE.ShaderMaterial, readonly collider: OBB, readonly maxHp: number) {
    this.hp = maxHp;
  }
  get center() { return this.collider.center; }
}

let nextId = 1;
const tmpL = new THREE.Vector3();

export class Structure {
  readonly id = nextId++;
  readonly group = new THREE.Group();
  readonly colliders: OBB[] = [];
  readonly mats: THREE.ShaderMaterial[] = [];
  readonly named = new Map<string, THREE.Object3D>();
  readonly pieces: Piece[] = [];
  readonly piecewise: boolean;
  hp: number;
  maxHp: number;
  alive = true;
  disabled = false;
  deployable = false;
  generator: Structure | null = null;
  lastDamaged = -100;
  healing = 0;
  fireTimer = 0;
  produceTimer = 0;
  aimYaw = 0;
  charge = 0;                 // capital call-down beacon progress
  payload: string | null = null;
  radius = 4;                 // rough radius for splash damage / targeting
  label = '';
  deckY = 0;                  // sky platform deck height
  mined = 0;                  // extractor: materiel produced (part of it drops as spoils if destroyed)
  depositIndex = -1;          // extractor: which deposit it is tapping
  muzzleY = 5;                // turret eye height above pos
  range = 160;                // turret engagement range
  readonly quat: THREE.Quaternion;

  constructor(readonly kind: StructureKind, readonly team: number, readonly pos: THREE.Vector3, readonly yaw: number, parts: Part[], private game: Game, readonly tilt = 0) {
    this.piecewise = PIECEWISE.has(kind);
    this.maxHp = this.hp = STRUCTURE_HP[kind];
    const base = 0x8a9099;
    const teamCol = TEAM_COLORS[team] ?? 0xaaaaaa;
    this.group.position.copy(pos);
    // Yaw then tilt (pitch about the piece's own X axis): walls can become ramps and floor slabs.
    this.quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt, yaw, 0, 'YXZ'));
    this.group.quaternion.copy(this.quat);
    const turret = TURRET_STATS[kind];
    if (turret) { this.muzzleY = turret.muzzleY; this.range = turret.range; }
    for (const p of parts) {
      let geo: THREE.BufferGeometry;
      if (p.geo === 'cyl') geo = new THREE.CylinderGeometry(p.size[0] / 2, p.size[2] / 2, p.size[1], 16);
      else if (p.geo === 'sphere') geo = new THREE.SphereGeometry(p.size[0] / 2, 24, 12);
      else geo = new THREE.BoxGeometry(...p.size);
      let mat: THREE.Material;
      if (p.glow !== undefined) mat = makeGlowMaterial(p.glow, p.alpha ?? 0.6);
      else {
        const m = makePlateMaterial(team, p.color ?? base, teamCol, { transparent: p.alpha !== undefined });
        if (p.alpha !== undefined) { m.uniforms.uAlpha.value = p.alpha; m.depthWrite = false; m.side = THREE.DoubleSide; }
        this.mats.push(m);
        mat = m;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(...p.at);
      this.group.add(mesh);
      if (p.key) this.named.set(p.key, mesh);
      if (p.collide !== false && p.glow === undefined && p.alpha === undefined) {
        const c = new THREE.Vector3(...p.at).applyQuaternion(this.quat).add(pos);
        const half = new THREE.Vector3(p.size[0] / 2, p.size[1] / 2, p.size[2] / 2);
        if (p.geo === 'cyl') half.x = half.z = Math.max(p.size[0], p.size[2]) / 2 * 0.8;
        const box = game.colliders.add(new OBB(c, half, this.quat, this));
        this.colliders.push(box);
        if (this.piecewise) this.pieces.push(new Piece(mesh, mat as THREE.ShaderMaterial, box, p.hp ?? 500));
      }
    }
    if (this.piecewise) this.recountHp();
  }

  get powered() { return !this.disabled && (this.generator ? this.generator.alive && !this.generator.disabled : true); }
  get center() { return new THREE.Vector3(this.pos.x, this.pos.y + this.radius * 0.6, this.pos.z); }
  get destructible() { return this.maxHp !== Infinity && this.maxHp > 0; }

  private recountHp() {
    let hp = 0, max = 0;
    for (const p of this.pieces) if (p.maxHp !== Infinity) { hp += Math.max(0, p.hp); max += p.maxHp; }
    this.hp = hp;
    this.maxHp = max > 0 ? max : Infinity;
  }

  /** Damage. Piecewise structures route it to the piece that was hit (or the nearest intact one). */
  damage(amount: number, box?: OBB | null) {
    if (!this.alive || !this.destructible) return;
    this.lastDamaged = this.game.time;
    if (this.piecewise) {
      const piece = (box && this.pieces.find(p => p.collider === box)) || this.pieces.find(p => !p.destroyed && p.maxHp !== Infinity);
      if (piece) this.damagePiece(piece, amount);
      return;
    }
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      if (this.deployable) this.game.destroyStructure(this);
      else if (!this.disabled) {
        this.disabled = true;
        this.game.message(`${this.game.teamName(this.team)} ${this.label || this.kind} disabled!`, this.team === this.game.human.team ? '#ff8a6a' : '#9fe8ff');
        this.game.fx.explosion(this.center, 10, 0xffa040);
      }
    }
  }

  /** Splash damage: piecewise structures take it per panel by distance to each panel's surface. */
  blast(at: THREE.Vector3, radius: number, amount: number) {
    if (!this.alive || !this.destructible) return;
    if (!this.piecewise) {
      const d = Math.max(0, this.center.distanceTo(at) - this.radius);
      if (d < radius) this.damage(amount * (1 - d / radius));
      return;
    }
    for (const p of this.pieces) {
      if (p.destroyed || p.maxHp === Infinity) continue;
      const d = distToBox(p.collider, at);
      if (d < radius) { this.lastDamaged = this.game.time; this.damagePiece(p, amount * (1 - d / radius)); }
    }
  }

  private damagePiece(p: Piece, amount: number) {
    if (p.destroyed || p.maxHp === Infinity) return;
    p.hp -= amount;
    if (p.hp <= 0) { this.breakPiece(p); this.game.stats.piecesDestroyed++; }
    this.recountHp();
    if (this.deployable && this.pieces.every(q => q.destroyed || q.maxHp === Infinity)) this.game.destroyStructure(this);
  }

  private breakPiece(p: Piece) {
    const g = this.game;
    p.hp = 0;
    p.destroyed = true;
    p.mesh.visible = false;
    p.collider.enabled = false;
    const c = p.collider.center;
    g.fx.explosion(c, Math.min(14, 4 + p.collider.half.length() * 0.5), 0xffa040);
    g.audio.explosion(c, 1.2);
    // Rubble: a few slabs dropped where the panel stood (cosmetic; rebuilt panels clear it).
    const ground = Math.max(g.terrain.heightAt(c.x, c.z), g.colliders.surfaceBelow(c.x, c.y, c.z));
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const sz = 0.6 + Math.random() * Math.min(3, p.collider.half.x * 0.5 + 0.5);
      const r = new THREE.Mesh(new THREE.BoxGeometry(sz, sz * 0.5, sz * 0.8), p.mat);
      r.position.set(c.x + (Math.random() - 0.5) * p.collider.half.x * 1.6, Math.min(c.y, ground) + sz * 0.2, c.z + (Math.random() - 0.5) * p.collider.half.z * 1.6);
      r.rotation.set(Math.random(), Math.random() * 6, Math.random() * 0.5);
      g.scene.add(r);
      p.rubble.push(r);
    }
  }

  /**
   * Repair beam. Restores the damaged piece nearest `at`, including blown-away panels
   * (which cost materiel to rebuild). Returns false if nothing here needs repair.
   */
  repairNear(at: THREE.Vector3, amount: number): boolean {
    if (!this.alive || !this.destructible) return false;
    if (!this.piecewise) {
      if (this.hp >= this.maxHp) return false;
      this.repair(amount);
      return true;
    }
    let best: Piece | null = null, bd = 14;
    for (const p of this.pieces) {
      if (p.maxHp === Infinity || p.hp >= p.maxHp) continue;
      const d = distToBox(p.collider, at);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return false;
    if (best.destroyed) {
      const team = this.game.teams[this.team];
      const cost = amount * REBUILD_COST_PER_HP;
      if (team.materiel < cost) return false;
      team.materiel -= cost;
    }
    best.hp = Math.min(best.maxHp, best.hp + amount);
    if (best.destroyed && best.hp >= best.maxHp * 0.35) {
      best.destroyed = false;
      best.mesh.visible = true;
      best.collider.enabled = true;
      for (const r of best.rubble) this.game.scene.remove(r);
      best.rubble = [];
    }
    best.mat.uniforms.uHealing.value = 1;
    this.recountHp();
    return true;
  }

  repair(amount: number) {
    if (!this.alive || !this.destructible) return;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.healing = 1;
    if (this.disabled && this.hp >= this.maxHp * 0.5) {
      this.disabled = false;
      this.game.message(`${this.game.teamName(this.team)} ${this.label || this.kind} back online`, '#9fffcf');
    }
  }

  update(dt: number) {
    const g = this.game;
    // No passive regeneration: everything broken stays broken until a player repairs it.
    this.healing = Math.max(0, this.healing - dt * 0.8);
    if (this.piecewise) {
      for (const p of this.pieces) {
        p.mat.uniforms.uDamage.value = p.maxHp === Infinity ? 0 : 1 - p.hp / p.maxHp;
        p.mat.uniforms.uHealing.value = Math.max(0, p.mat.uniforms.uHealing.value - dt * 0.8);
      }
    } else {
      const dmg = this.destructible ? 1 - this.hp / this.maxHp : 0;
      for (const m of this.mats) {
        m.uniforms.uDamage.value = dmg;
        m.uniforms.uHealing.value = this.healing;
        m.uniforms.uPowered.value = this.powered ? 1 : 0;
      }
    }

    switch (this.kind) {
      case 'turret': case 'battery': this.updateTurret(dt, false); break;
      case 'aaTurret': case 'flakTower': this.updateTurret(dt, true); break;
      case 'generator': {
        const core = this.named.get('core');
        if (core) { core.visible = this.powered; core.rotation.y += dt * 2; }
        break;
      }
      case 'extractor': {
        const drill = this.named.get('drill');
        const dep = g.terrain.deposits[this.depositIndex];
        const working = this.powered && !!dep && dep.amount > 0;
        if (drill && working) drill.rotation.y += dt * 3;
        if (working) {
          this.produceTimer += dt;
          if (this.produceTimer > 4) {
            this.produceTimer = 0;
            const got = Math.min(dep.amount, 2 * dep.richness);
            dep.amount -= got;
            this.mined += got;
            g.teams[this.team].materiel += got;
            g.stats.materielMined += got;
            if (dep.amount <= 0) g.message(`A ${dep.richness > 1 ? 'motherlode' : 'deposit'} has been mined out`, '#cfd8e0');
          }
        }
        break;
      }
      case 'inventory': case 'vehicleStation': {
        const glow = this.named.get('glow');
        if (glow) glow.visible = this.powered;
        break;
      }
      case 'beacon': {
        const ring = this.named.get('ring');
        if (ring) { ring.rotation.y += dt; ring.scale.setScalar(1 + this.charge * 2); }
        break;
      }
      case 'uplink': {
        const dish = this.named.get('dish');
        if (dish && this.powered) dish.rotation.y += dt * 0.3;
        break;
      }
    }
  }

  private updateTurret(dt: number, aa: boolean) {
    if (!this.powered) return;
    const g = this.game;
    this.fireTimer -= dt;
    const range = this.range;
    const eye = new THREE.Vector3(this.pos.x, this.pos.y + this.muzzleY, this.pos.z);
    let best: { pos: THREE.Vector3; vel: THREE.Vector3; d: number } | null = null;
    const consider = (pos: THREE.Vector3, vel: THREE.Vector3) => {
      const d = pos.distanceTo(eye);
      if (d > range || (best && d > best.d)) return;
      if (!g.lineOfSight(eye, pos)) return;
      best = { pos, vel, d };
    };
    for (const p of g.players) {
      if (!p.alive || p.team === this.team || p.vehicle) continue;
      const agl = p.pos.y - g.terrain.heightAt(p.pos.x, p.pos.z);
      if (aa && agl < 14) continue;
      consider(p.center, p.vel);
    }
    for (const v of g.vehicles) {
      if (!v.alive || v.team === this.team || !v.driver) continue;
      if (aa !== v.def.flies) continue;
      consider(v.pos, v.vel);
    }
    if (!best) return;
    const b = best as { pos: THREE.Vector3; vel: THREE.Vector3; d: number };
    const def = aa ? FLAK : TURRET_PLASMA;
    const t = b.d / def.speed;
    const aim = b.pos.clone().addScaledVector(b.vel, t);
    const dir = aim.sub(eye).normalize();
    this.aimYaw = Math.atan2(dir.x, dir.z);
    const head = this.named.get('head');
    if (head) head.rotation.y = this.aimYaw - this.yaw;
    if (this.fireTimer <= 0) {
      this.fireTimer = def.reload;
      const p = g.weapons.fire(def, eye.clone().addScaledVector(dir, 2.5), dir, new THREE.Vector3(), null, this.team);
      if (aa && p) p.fuseLeft = Math.max(0.15, t + (Math.random() - 0.5) * 0.1);
      g.audio.shot(eye, aa ? 'flak' : 'turret');
    }
  }

  /** Who can use this station (inventory/vehicle station)? */
  canUse(p: Player | Vehicle) { return this.alive && this.powered && p.team === this.team; }
}

/** Distance from a point to the surface of a box (0 inside). */
export function distToBox(b: OBB, p: THREE.Vector3) {
  const l = b.toLocal(p, tmpL);
  const dx = Math.max(0, Math.abs(l.x) - b.half.x);
  const dy = Math.max(0, Math.abs(l.y) - b.half.y);
  const dz = Math.max(0, Math.abs(l.z) - b.half.z);
  return Math.hypot(dx, dy, dz);
}

// ---------- blueprints ----------

export function blueprint(kind: StructureKind, team: number, opts: { length?: number; heights?: number[]; sea?: number } = {}): Part[] {
  const T = TEAM_COLORS[team] ?? 0xaaaaaa;
  switch (kind) {
    case 'bunker': {
      // Walls and roof come apart panel by panel; the foundation slab is permanent.
      const W = 30, D = 26, H = 10, t = 1.2, door = 9;
      const side = (W - door) / 2;
      const WALL = 0x7f8690, WHP = 700;
      const parts: Part[] = [{ size: [W + 4, 1.2, D + 4], at: [0, 0.6, 0], color: 0x6b7078, hp: Infinity }];
      for (let i = 0; i < 3; i++) parts.push({ size: [W / 3, H, t], at: [-W / 3 + i * W / 3, H / 2 + 1, -D / 2], color: WALL, hp: WHP });
      for (const sx of [-1, 1]) for (let i = 0; i < 2; i++) parts.push({ size: [t, H, D / 2], at: [sx * W / 2, H / 2 + 1, -D / 4 + i * D / 2], color: WALL, hp: WHP });
      parts.push(
        { size: [side, H, t], at: [-(door / 2 + side / 2), H / 2 + 1, D / 2], color: WALL, hp: WHP },
        { size: [side, H, t], at: [door / 2 + side / 2, H / 2 + 1, D / 2], color: WALL, hp: WHP },
        { size: [door, 3, t], at: [0, H - 0.5, D / 2], color: WALL, hp: 400 },
      );
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ size: [(W + 2) / 2, 1.2, (D + 2) / 2], at: [sx * (W + 2) / 4, H + 1.6, sz * (D + 2) / 4], color: 0x737a84, hp: 900 });
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push({ size: [3, 14, 3], at: [x * (W / 2 + 1), 7, z * (D / 2 + 1)], color: 0x5d636b, hp: 1000 });
      parts.push({ size: [6, 0.4, 6], at: [0, H + 2.4, 0], glow: T, alpha: 0.5 });
      return parts;
    }
    case 'generator':
      return [
        { size: [5, 4.5, 4], at: [0, 2.25, 0], color: 0x5c6470 },
        { size: [2.2, 3.5, 2.2], at: [0, 3.5, 0], glow: 0x7fffd4, geo: 'cyl', key: 'core', alpha: 0.8 },
      ];
    case 'inventory':
      return [
        { size: [3.2, 0.3, 3.2], at: [0, 0.15, 0], color: 0x4a5058, collide: false },
        { size: [0.5, 4, 0.5], at: [-1.6, 2, 0], color: 0x9aa2ad },
        { size: [0.5, 4, 0.5], at: [1.6, 2, 0], color: 0x9aa2ad },
        { size: [3.7, 0.5, 0.6], at: [0, 4.2, 0], color: 0x9aa2ad, collide: false },
        { size: [2.6, 3.6, 2.6], at: [0, 2, 0], glow: T, alpha: 0.18, key: 'glow', geo: 'cyl' },
      ];
    case 'turret':
      return [
        { size: [2.4, 4, 2.4], at: [0, 2, 0], color: 0x6a717b },
        { size: [2.2, 1.4, 3], at: [0, 4.8, 0], color: 0x8a929c, key: 'head' },
      ];
    case 'aaTurret':
      return [
        { size: [3.2, 5, 3.2], at: [0, 2.5, 0], color: 0x5f6670 },
        { size: [3.6, 1.8, 2.4], at: [0, 6, 0], color: 0x848c96, key: 'head' },
      ];
    case 'wall':
      return [{ size: [14, 7, 1.2], at: [0, 3.5, 0], color: 0x7b828c, hp: 500 }];
    case 'post':
      return [
        { size: [2.2, 8.2, 2.2], at: [0, 4.1, 0], color: 0x6a717b },
        { size: [2.8, 0.6, 2.8], at: [0, 8.5, 0], color: 0x7b828c },
        { size: [0.6, 0.6, 0.6], at: [0, 9.1, 0], glow: T, alpha: 0.8 },
      ];
    case 'battery': case 'flakTower': {
      // A wall section that grew battlements and an integrated gun platform.
      const aa = kind === 'flakTower';
      const parts: Part[] = [
        { size: [14, 7, 2.4], at: [0, 3.5, 0], color: 0x737a84 },
        { size: [4.2, aa ? 3.2 : 1.6, 3.6], at: [0, 7 + (aa ? 1.6 : 0.8), 0], color: 0x6a717b },
        { size: [14.2, 0.4, 2.8], at: [0, 7.2, 0], color: 0x8a929c, collide: false },
      ];
      for (const x of [-6, -3.6, 3.6, 6]) parts.push({ size: [1.4, 1.3, 2.6], at: [x, 7.65, 0], color: 0x7f8690 });
      parts.push({ size: aa ? [3.8, 1.8, 2.6] : [2.6, 1.4, 3.2], at: [0, aa ? 10.5 : 9.4, 0], color: 0x8a929c, key: 'head' });
      parts.push({ size: [14.4, 0.25, 0.25], at: [0, 6.3, -1.3], glow: T, alpha: 0.7 });
      return parts;
    }
    case 'extractor':
      return [
        { size: [6, 1, 6], at: [0, 0.5, 0], color: 0x555b62 },
        { size: [0.6, 10, 0.6], at: [-2.2, 5, -2.2], color: 0x9aa2ad },
        { size: [0.6, 10, 0.6], at: [2.2, 5, -2.2], color: 0x9aa2ad },
        { size: [0.6, 10, 0.6], at: [0, 5, 2.4], color: 0x9aa2ad },
        { size: [1.6, 7, 1.6], at: [0, 4.5, 0], color: 0xc8a050, geo: 'cyl', key: 'drill', collide: false },
        { size: [3, 3, 3], at: [0, 1.5, 0], glow: 0xffc860, alpha: 0.35, geo: 'sphere', collide: false },
      ];
    case 'skyPlatform': {
      const y = 220;
      return [
        // Ground beacon pad.
        { size: [4, 0.4, 4], at: [0, 0.2, 0], color: 0x4a5058, collide: false },
        { size: [3.4, 6, 3.4], at: [0, 3, 0], glow: 0x9fd8ff, alpha: 0.25, geo: 'cyl', key: 'beamDown' },
        // Deck: 3x3 tiles that can be shot out from under people.
        ...[-1, 0, 1].flatMap(i => [-1, 0, 1].map(j => ({ size: [12.66, 1.6, 12.66] as [number, number, number], at: [i * 12.66, y, j * 12.66] as [number, number, number], color: 0x737a84, hp: 450 }))),
        { size: [38, 1.4, 1], at: [0, y + 1.5, -18.5], color: 0x8a929c, hp: 150 },
        { size: [38, 1.4, 1], at: [0, y + 1.5, 18.5], color: 0x8a929c, hp: 150 },
        { size: [1, 1.4, 38], at: [-18.5, y + 1.5, 0], color: 0x8a929c, hp: 150 },
        { size: [10, 4, 10], at: [0, y - 2.8, 0], color: 0x5a6068, geo: 'cyl', hp: 900 },
        { size: [3.4, 6, 3.4], at: [12, y + 3.8, 12], glow: 0x9fd8ff, alpha: 0.25, geo: 'cyl', key: 'beamUp' },
        { size: [44, 0.2, 44], at: [0, y - 0.9, 0], glow: T, alpha: 0.12, collide: false },
      ];
    }
    case 'bridge': {
      const L = opts.length ?? 110, n = 12, seg = L / n;
      const hs = opts.heights ?? new Array(n).fill(4);
      const parts: Part[] = [];
      for (let i = 0; i < n; i++) {
        const z = L / 2 - seg * (i + 0.5); // i=0 at the near (start) end; local -Z is forward
        parts.push({ size: [9, 1.2, seg + 0.05], at: [0, hs[i], z], color: 0x7b828c, hp: 450 });
        parts.push({ size: [0.4, 1.2, seg], at: [-4.3, hs[i] + 1.2, z], color: 0x9aa2ad, collide: false });
        parts.push({ size: [0.4, 1.2, seg], at: [4.3, hs[i] + 1.2, z], color: 0x9aa2ad, collide: false });
        if (i % 3 === 1) parts.push({ size: [2, hs[i] + 40, 2], at: [0, hs[i] - (hs[i] + 40) / 2 - 0.6, z], color: 0x5d636b, hp: 600 });
      }
      return parts;
    }
    case 'vehicleStation':
      return [
        { size: [3, 3, 2], at: [0, 1.5, 0], color: 0x6a717b },
        { size: [16, 0.5, 16], at: [0, 0.25, 12], color: 0x50565e, collide: false },
        { size: [14, 0.2, 14], at: [0, 0.55, 12], glow: T, alpha: 0.15, key: 'glow', collide: false },
      ];
    case 'uplink':
      return [
        { size: [4, 14, 4], at: [0, 7, 0], color: 0x6a717b },
        { size: [12, 1, 12], at: [0, 15, 0], color: 0xa0a8b2, geo: 'cyl', key: 'dish', collide: false },
        { size: [1, 6, 1], at: [0, 18, 0], glow: T, alpha: 0.7 },
      ];
    case 'beacon':
      return [
        { size: [0.6, 5, 0.6], at: [0, 2.5, 0], color: 0x9aa2ad },
        { size: [6, 0.2, 6], at: [0, 0.3, 0], glow: 0xffd060, alpha: 0.5, geo: 'cyl', key: 'ring' },
      ];
    case 'flagStand':
      return [{ size: [3, 3, 3], at: [0, 1.5, 0], color: 0x6b7078, hp: Infinity }, { size: [3.6, 0.2, 3.6], at: [0, 3.1, 0], glow: T, alpha: 0.5 }];
    case 'sensor':
      return [{ size: [0.8, 12, 0.8], at: [0, 6, 0], color: 0x9aa2ad }, { size: [2, 2, 2], at: [0, 12.5, 0], glow: T, alpha: 0.7, geo: 'sphere' }];
  }
  return [];
}

export const STRUCTURE_RADIUS: Partial<Record<StructureKind, number>> = {
  battery: 7, flakTower: 7, post: 2,
  generator: 4, inventory: 3, turret: 3, aaTurret: 4, wall: 7, extractor: 5, skyPlatform: 6, bridge: 10,
  vehicleStation: 3, uplink: 6, beacon: 3, sensor: 2,
};

export const STRUCTURE_LABEL: Partial<Record<StructureKind, string>> = {
  battery: 'Wall Battery', flakTower: 'Flak Tower', post: 'Wall Post',
  generator: 'Generator', inventory: 'Inventory Station', turret: 'Turret', aaTurret: 'AA Battery', wall: 'Wall',
  extractor: 'Extractor', skyPlatform: 'Sky Platform', bridge: 'Bridge', vehicleStation: 'Vehicle Station',
  uplink: 'Command Uplink', beacon: 'Drop Beacon', sensor: 'Sensor',
};
