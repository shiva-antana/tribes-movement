import * as THREE from 'three';
import { ARMORS, ArmorDef, ArmorId, GRAVITY, PackId, WEAPONS, WeaponId, TEAM_COLORS, ARMOR_CHARACTER } from '../config';
import type { CharacterInstance } from '../character/library';
import { makeLitMaterial, makeGlowMaterial } from './materials';
import type { Game } from './game';
import type { Vehicle } from './vehicles';
import type { Flag } from './ctf';

/** Intent produced by either keyboard/mouse or bot AI. Physics only reads this. */
export interface Controls {
  forward: number;     // -1..1
  strafe: number;      // -1..1
  ski: boolean;        // jump/ski held
  jumpPressed: boolean;
  jet: boolean;
  fire: boolean;
  usePressed: boolean;
  repair: boolean;
  yaw: number;
  pitch: number;
  weapon: number;      // desired slot (-1 = no change)
  reloadPressed: boolean;
  descend: boolean;    // vehicles: go down
}

export const emptyControls = (): Controls => ({
  forward: 0, strafe: 0, ski: false, jumpPressed: false, jet: false, fire: false, usePressed: false,
  repair: false, yaw: 0, pitch: 0, weapon: -1, descend: false, reloadPressed: false,
});

export interface Loadout { armor: ArmorId; weapons: WeaponId[]; pack: PackId; }

const tmpN = new THREE.Vector3();
const tmpV = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Player {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  readonly prevPos = new THREE.Vector3();
  readonly controls = emptyControls();
  armor: ArmorDef;
  loadout: Loadout;
  health = 100;
  energy = 100;
  heat = 0;
  overheated = false;
  alive = true;
  respawnTimer = 0;
  grounded = false;
  onIce = false;
  skiing = false;
  jetting = false;
  submerged = false;
  slot = 0;
  ammo: Record<string, number> = {};   // reserve rounds (not counting the magazine)
  mag: Record<string, number> = {};    // rounds in the magazine
  reload = 0;                          // time until the next shot is possible
  reloading = 0;                       // magazine reload time remaining
  spin = 0;                            // chaingun barrel spin 0..1
  bloom = 0;                           // accumulated spread from sustained fire
  flag: Flag | null = null;
  vehicle: Vehicle | null = null;
  kills = 0; deaths = 0; caps = 0;
  lastAttacker: Player | null = null;
  lastHitTime = -100;
  stationCooldown = 0;
  beamCooldown = 0;
  repairTarget: unknown = null;
  readonly mesh = new THREE.Group();
  private body!: THREE.Mesh;
  private flame!: THREE.Mesh;
  private character: CharacterInstance | null = null;
  private wasGrounded = false;

  constructor(readonly name: string, readonly team: number, readonly isBot: boolean, loadout: Loadout, private game: Game) {
    this.loadout = loadout;
    this.armor = ARMORS[loadout.armor];
    this.buildMesh();
    this.applyLoadout(loadout);
  }

  get weaponId(): WeaponId { return this.loadout.weapons[this.slot] ?? this.loadout.weapons[0]; }
  get center() { return new THREE.Vector3(this.pos.x, this.pos.y + this.armor.height * 0.55, this.pos.z); }
  get eye() { return new THREE.Vector3(this.pos.x, this.pos.y + this.armor.height * 0.9, this.pos.z); }
  get speed() { return this.vel.length(); }

  aimDir(out = new THREE.Vector3()) {
    const c = this.controls;
    return out.set(-Math.sin(c.yaw) * Math.cos(c.pitch), Math.sin(c.pitch), -Math.cos(c.yaw) * Math.cos(c.pitch));
  }

  private buildMesh() {
    this.mesh.clear();
    const a = this.armor;
    const col = TEAM_COLORS[this.team];
    const s = a.height / 1.9;
    this.character = null;
    const lib = this.game.characters;
    if (lib) {
      // Generated, skinned character (content/characters) scaled to the armor's height.
      this.character = lib.create(ARMOR_CHARACTER[a.id], col);
      this.character.mesh.scale.setScalar(a.height / 1.86);
      this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.16 * s, 1.2 * s, 8), makeGlowMaterial(0x9fd8ff, 0.85));
      this.flame.rotation.x = Math.PI;
      this.flame.position.set(0, a.height * 0.38, 0.32 * s * (a.id === 'heavy' ? 1.5 : 1));
      this.mesh.add(this.character.mesh, this.flame);
      return;
    }
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(a.radius * 0.85, a.height * 0.45, 4, 10), makeLitMaterial(col));
    this.body.position.y = a.height * 0.5;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28 * s, 12, 8), makeLitMaterial(0xc8ccd2));
    head.position.y = a.height * 0.92;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.36 * s, 0.1 * s, 0.1), makeGlowMaterial(col, 0.95));
    visor.position.set(0, a.height * 0.93, -0.24 * s);
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.7 * s, 0.8 * s, 0.35 * s), makeLitMaterial(0x50565e));
    pack.position.set(0, a.height * 0.6, 0.42 * s);
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(a.radius * 2.6, 0.3 * s, 0.6 * s), makeLitMaterial(0x6b727c));
    shoulder.position.y = a.height * 0.76;
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.22 * s, 1.4 * s, 8), makeGlowMaterial(0x9fd8ff, 0.85));
    this.flame.rotation.x = Math.PI;
    this.flame.position.set(0, a.height * 0.2, 0.45 * s);
    this.mesh.add(this.body, head, visor, pack, shoulder, this.flame);
  }

  applyLoadout(l: Loadout) {
    const armorChanged = l.armor !== this.armor.id;
    this.loadout = { armor: l.armor, weapons: l.weapons.filter(w => ARMORS[l.armor].allowed.includes(w)).slice(0, ARMORS[l.armor].weaponSlots), pack: l.pack };
    if (this.loadout.weapons.length === 0) this.loadout.weapons = ['spinfusor'];
    this.armor = ARMORS[l.armor];
    if (armorChanged) this.buildMesh();
    this.health = this.armor.health;
    this.energy = this.armor.energy;
    this.heat = 0; this.overheated = false;
    for (const w of this.loadout.weapons) {
      const d = WEAPONS[w];
      this.mag[w] = d.magazine ? Math.min(d.magazine, d.ammo) : d.ammo;
      this.ammo[w] = d.magazine ? d.ammo - this.mag[w] : 0;
    }
    this.reloading = 0;
    this.slot = Math.min(this.slot, this.loadout.weapons.length - 1);
  }

  spawn(at: THREE.Vector3) {
    this.pos.copy(at);
    this.prevPos.copy(at);
    this.vel.set(0, 0, 0);
    this.alive = true;
    this.mesh.visible = true;
    this.applyLoadout(this.loadout);
  }

  // ------------------------------------------------------------------ physics

  update(dt: number) {
    if (!this.alive) return;
    const g = this.game;
    const c = this.controls;
    const a = this.armor;
    if (this.vehicle) { this.pos.copy(this.vehicle.seatPos()); this.vel.copy(this.vehicle.vel); this.mesh.visible = false; this.coolDown(dt, false); return; }
    this.mesh.visible = true;
    this.stationCooldown = Math.max(0, this.stationCooldown - dt);
    this.beamCooldown = Math.max(0, this.beamCooldown - dt);

    if (c.weapon >= 0 && c.weapon < this.loadout.weapons.length && c.weapon !== this.slot) { this.slot = c.weapon; this.reload = Math.max(this.reload, 0.35); this.reloading = 0; this.spin = 0; }
    c.weapon = -1;
    if (c.reloadPressed) this.startReload();
    c.reloadPressed = false;

    this.submerged = g.isSubmerged(new THREE.Vector3(this.pos.x, this.pos.y + a.height * 0.6, this.pos.z));
    const fwd = tmpV.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = new THREE.Vector3().addScaledVector(fwd, c.forward).addScaledVector(right, c.strafe);
    if (wish.lengthSq() > 1) wish.normalize();

    // --- Jump on press, ski while held (Tribes convention) ---
    if (c.jumpPressed && this.grounded && !this.submerged) {
      this.vel.addScaledVector(this.groundNormal, a.jumpSpeed);
      this.vel.y = Math.max(this.vel.y, a.jumpSpeed * 0.8);
      this.grounded = false;
    }
    c.jumpPressed = false;
    this.skiing = c.ski && this.grounded;

    // --- Jetpack: energy + heat. Cold surfaces (ice/water) cool faster. ---
    const packE = this.loadout.pack === 'energy';
    const canJet = c.jet && !this.overheated && this.energy > 1;
    this.jetting = canJet;
    if (canJet) {
      const eff = Math.min(1, this.energy / (a.jetEnergy * dt));
      const up = a.jetAccel * eff;
      const side = a.jetSideAccel * eff;
      if (this.submerged) {
        // Jet-swimming: underwater the pack thrusts along where you look, not straight up.
        this.vel.addScaledVector(this.aimDir(new THREE.Vector3()), up * 0.85 * dt);
      } else {
        // Directional jetting trades some lift for horizontal thrust.
        const wl = wish.length();
        this.vel.y += up * (1 - 0.25 * wl) * dt;
        this.vel.addScaledVector(wish, side * dt);
      }
      // Hot jets burn more energy: staying cool (low over ice/water) stretches a trek.
      this.energy -= a.jetEnergy * (0.45 + 0.9 * this.heat / 100) * dt;
      this.heat += a.jetHeat * (packE ? 0.8 : 1) * dt;
      if (this.heat >= 100) { this.heat = 100; this.overheated = true; g.onOverheat(this); }
    }
    this.coolDown(dt, canJet);
    if (!canJet) this.energy = Math.min(a.energy, this.energy + a.energyRegen * (packE ? 1.6 : 1) * dt);

    // --- Movement forces ---
    if (this.submerged) {
      // Swimming: thrust along the look direction, buoyancy, heavy drag.
      const look = this.aimDir(new THREE.Vector3());
      const swim = new THREE.Vector3().addScaledVector(look, c.forward).addScaledVector(right, c.strafe);
      if (swim.lengthSq() > 1) swim.normalize();
      this.vel.addScaledVector(swim, a.runAccel * 0.22 * dt);
      const buoy = a.id === 'heavy' ? 0.92 : a.id === 'medium' ? 0.98 : 1.03;
      this.vel.y += GRAVITY * (buoy - 1) * dt;
      this.vel.multiplyScalar(Math.exp(-1.6 * dt));
    } else {
      this.vel.y -= GRAVITY * dt;
      if (this.grounded && !this.skiing) {
        // Walking: accelerate toward desired velocity in the ground plane; friction otherwise.
        const traction = this.onIce ? 0.12 : 1;
        const target = wish.clone().multiplyScalar(a.runSpeed);
        const hv = new THREE.Vector3(this.vel.x, 0, this.vel.z);
        const diff = target.sub(hv);
        const steep = this.groundNormal.y < 0.7;
        if (!steep) {
          const maxDv = a.runAccel * traction * dt;
          if (diff.length() > maxDv) diff.setLength(maxDv);
          // Don't brake people who are moving faster than run speed in their own direction too hard:
          // Tribes keeps momentum; friction only when no input.
          if (hv.length() > a.runSpeed && wish.lengthSq() > 0) diff.multiplyScalar(0.25);
          this.vel.x += diff.x; this.vel.z += diff.z;
        }
      } else if (this.skiing) {
        // Skiing: nearly frictionless; gravity along the slope comes from the contact resolution below.
        const fr = Math.exp(-0.03 * dt);
        this.vel.x *= fr; this.vel.z *= fr;
        this.vel.addScaledVector(wish, a.airControl * 0.5 * dt);
      } else {
        // Air control, limited so it can't create speed beyond run speed in the wish direction.
        const along = this.vel.dot(wish);
        if (along < a.runSpeed * 1.2) this.vel.addScaledVector(wish, a.airControl * dt);
      }
      // Wind drag while airborne (light armors feel the katabatic gusts most).
      if (!this.grounded) {
        const w = g.env.windAt(this.pos.x, this.pos.y, this.pos.z, new THREE.Vector3());
        const k = (this.jetting ? 0.035 : 0.02) * (90 / a.mass);
        this.vel.addScaledVector(w.sub(this.vel), k * dt);
      }
    }

    this.prevPos.copy(this.pos);
    this.pos.addScaledVector(this.vel, dt);
    this.collide(dt);

    // World bounds: invisible force field at the edge, like Tribes mission areas.
    const half = 1500;
    for (const k of ['x', 'z'] as const) {
      if (this.pos[k] > half) { this.pos[k] = half; this.vel[k] = -Math.abs(this.vel[k]) * 0.5; }
      if (this.pos[k] < -half) { this.pos[k] = -half; this.vel[k] = Math.abs(this.vel[k]) * 0.5; }
    }
    if (this.pos.y > 900) { this.pos.y = 900; this.vel.y = Math.min(0, this.vel.y); }

    // Repair pack.
    if (c.repair && this.loadout.pack === 'repair' && this.energy > 2) g.repairBeam(this, dt);
    else this.repairTarget = null;

    this.reload -= dt;
    this.bloom *= Math.exp(-2.5 * dt); // recovers in ~1s; sustained fire settles at a wider cone
    const wdef = WEAPONS[this.weaponId];
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        const take = Math.min((wdef.magazine ?? 0) - (this.mag[wdef.id] ?? 0), this.ammo[wdef.id] ?? 0);
        this.mag[wdef.id] = (this.mag[wdef.id] ?? 0) + take;
        this.ammo[wdef.id] -= take;
      }
    }
    // Chaingun barrels spin up while the trigger is held and wind down when released.
    if (wdef.spinUp) this.spin = THREE.MathUtils.clamp(this.spin + (c.fire ? dt / wdef.spinUp : -dt / (wdef.spinUp * 1.5)), 0, 1);
    if (c.fire && this.reload <= 0 && this.reloading <= 0 && (!wdef.spinUp || this.spin > 0.3)) this.fire();

    // Visuals
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = c.yaw;
    this.flame.visible = this.jetting;
    if (this.jetting) this.flame.scale.y = 0.8 + Math.random() * 0.5;
    if (this.character) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (this.jetting) this.character.set('jet');
      else if (!this.grounded && !this.submerged) this.character.set('fall');
      else if (this.skiing && hs > 3) this.character.set('ski');
      else if (hs > 1.2) this.character.set('run', THREE.MathUtils.clamp(hs / this.character.runSpeed, 0.5, 2.2));
      else this.character.set('idle');
      this.character.update(dt);
    }
  }

  private coolDown(dt: number, jetting: boolean) {
    const g = this.game;
    const prox = g.env.coldSurfaceProximity(this.pos.x, this.pos.y, this.pos.z);
    let mult = g.biome.coldness;
    if (prox.submerged) mult *= 5;
    else if (prox.over < 25) mult *= 1 + 2.5 * (1 - Math.max(0, prox.over) / 25);
    this.coolingMult = mult;
    const rate = (jetting ? 4 : 12) * mult;
    this.heat = Math.max(0, this.heat - rate * dt);
    if (this.overheated && this.heat < 35) this.overheated = false;
  }
  coolingMult = 1;

  private collide(dt: number) {
    const g = this.game;
    const a = this.armor;
    this.wasGrounded = this.grounded;
    this.grounded = false;
    // Terrain / ice.
    const gr = g.terrain.groundAt(this.pos.x, this.pos.z);
    const groundY = gr.y;
    const n = gr.ice ? tmpN.set(0, 1, 0) : g.terrain.normalAt(this.pos.x, this.pos.z, tmpN);
    const snap = this.wasGrounded && !this.skiing && !this.jetting && this.vel.y <= 0.5 ? 0.6 : 0.05;
    if (this.pos.y <= groundY + snap) {
      const into = this.vel.dot(n);
      if (this.pos.y < groundY || into < 0 || snap > 0.1) {
        this.pos.y = snap > 0.1 ? groundY : Math.max(this.pos.y, groundY);
        if (into < 0) {
          // Hard landings hurt (Tribes falling damage), unless you land "with" the slope.
          if (into < -55) this.game.damagePlayer(this, (-into - 55) * 1.5, null, 'impact');
          this.vel.addScaledVector(n, -into);
        }
        this.grounded = n.y > 0.3;
        this.onIce = gr.ice;
        this.groundNormal.copy(n);
      }
    }
    // Structures: two spheres (feet and head).
    const r = a.radius;
    const contact = new THREE.Vector3();
    for (const off of [r, a.height - r]) {
      const p = new THREE.Vector3(this.pos.x, this.pos.y + off, this.pos.z);
      if (g.colliders.resolveSphere(p, r, contact)) {
        this.pos.set(p.x, p.y - off, p.z);
        const into = this.vel.dot(contact);
        if (into < 0) {
          if (into < -55) this.game.damagePlayer(this, (-into - 55) * 1.5, null, 'impact');
          this.vel.addScaledVector(contact, -into);
        }
        if (contact.y > 0.6) { this.grounded = true; this.onIce = false; this.groundNormal.copy(contact); }
      }
    }
    void dt;
  }

  /** Total rounds available for a weapon (magazine + reserve). */
  roundsLeft(id: WeaponId) { return (this.mag[id] ?? 0) + (this.ammo[id] ?? 0); }

  startReload() {
    const w = WEAPONS[this.weaponId];
    if (!w.magazine || this.reloading > 0 || (this.mag[w.id] ?? 0) >= w.magazine || (this.ammo[w.id] ?? 0) <= 0) return;
    this.reloading = w.reloadTime ?? 2;
    this.spin = 0;
  }

  /** Current cone half-angle: base spread, plus bloom from sustained fire, plus your own motion. */
  currentSpread() {
    const w = WEAPONS[this.weaponId];
    const move = 1 + Math.min(1.5, this.speed / 40) + (this.grounded ? 0 : 0.4);
    return (w.spread + this.bloom) * move;
  }

  private fire() {
    const g = this.game;
    const w = WEAPONS[this.weaponId];
    if ((this.mag[w.id] ?? 0) <= 0) { this.startReload(); return; }
    if (w.energyCost > 0) { if (this.energy < w.energyCost) return; this.energy -= w.energyCost; }
    // Spinning barrels: fire rate ramps with spin.
    this.reload = w.spinUp ? w.reload / Math.max(0.35, this.spin) : w.reload;
    if (w.ammo !== Infinity) this.mag[w.id]--;
    const dir = this.aimDir();
    const spread = this.currentSpread();
    if (spread > 0) {
      // Uniform-in-cone jitter.
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const right = new THREE.Vector3().crossVectors(dir, UP).normalize(), up = new THREE.Vector3().crossVectors(right, dir);
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    this.bloom = Math.min(0.06, this.bloom + (w.bloom ?? 0));
    // Recoil: muzzle climbs, with a little horizontal wander.
    if (w.recoil) {
      this.controls.pitch = Math.min(1.55, this.controls.pitch + w.recoil * (0.7 + Math.random() * 0.6));
      this.controls.yaw += (Math.random() - 0.5) * w.recoil * 0.6;
    }
    if (this === g.human) g.onHumanShot(w.recoil ?? 0.01);
    if ((this.mag[w.id] ?? 0) <= 0) this.startReload();
    const right = new THREE.Vector3().crossVectors(dir, UP).normalize();
    const muzzle = this.eye.addScaledVector(dir, 1.0).addScaledVector(right, 0.35).add(new THREE.Vector3(0, -0.25, 0));
    g.weapons.fire(w, muzzle, dir, this.vel, this, this.team);
    g.fx.muzzleFlash(muzzle, dir, w.color);
    g.audio.shot(muzzle, w.id, this === g.human);
  }
}
