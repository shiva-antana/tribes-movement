import * as THREE from 'three';
import { BIOMES, Biome } from '../world/biomes';
import { levelBiome } from '../content/level';
import { Terrain, Deposit } from '../world/terrain';
import { Environment } from '../world/environment';
import { ColliderWorld, OBB } from './colliders';
import { setSharedUniforms, makeGlowMaterial, makePlateMaterial } from './materials';
import { Player, Loadout } from './player';
import { WeaponSystem, Effects } from './weapons';
import { Structure, blueprint, STRUCTURE_RADIUS, STRUCTURE_LABEL } from './structures';
import { Vehicle } from './vehicles';
import { Flag, checkFlagTouches, CAPTURE_LIMIT } from './ctf';
import type { CalldownDef } from '../config';
import type { PlacementCheck } from './build';
import { BuildSystem } from './build';
import { Bot, BotRole } from './bots';
import { Hud } from '../ui/hud';
import { CharacterLibrary } from '../character/library';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { showLoadoutMenu, showVehicleMenu, MatchSetup } from '../ui/menus';
import { Input } from '../input';
import { Audio } from '../audio';
import { CALLDOWNS, KILL_SPOILS, START_MATERIEL, StructureKind, TEAM_COLORS, TEAM_NAMES, VEHICLES, VehicleKind, WeaponDef } from '../config';

const BOT_NAMES = ['Kestrel', 'Vash', 'Orrin', 'Tamsin', 'Brakk', 'Ilse', 'Corvo', 'Nyx', 'Halvard', 'Juno', 'Rook', 'Sable', 'Tycho', 'Wren', 'Ashe', 'Mako', 'Quill', 'Daro'];

interface Pickup { pos: THREE.Vector3; value: number; mesh: THREE.Mesh; life: number; }

/** The slice of the HUD the simulation talks to (headless runs use a no-op). */
export interface HudLike {
  message(text: string, color?: string): void;
  flashDamage(amount: number, fromAngle?: number): void;
  flashHit(head?: boolean): void;
  callout(text: string, color?: string): void;
  killConfirm(name: string, head: boolean): void;
  setBuildStatus(def: CalldownDef, c: PlacementCheck): void;
  update(dt: number): void;
  dispose(): void;
}
class NullHud implements HudLike {
  log: string[] = [];
  message(t: string) { this.log.push(t); if (this.log.length > 200) this.log.shift(); }
  flashDamage() {} flashHit() {} callout() {} killConfirm() {} setBuildStatus() {} update() {} dispose() {}
}

/** Counters for headless playtests and balance dashboards. */
export interface MatchStats {
  kills: number; deathsByCause: Record<string, number>; grabs: number; caps: number;
  structuresBuilt: number; structuresDestroyed: number; piecesDestroyed: number;
  roadsGraded: number; earthMoved: number; materielMined: number; vehiclesBought: number;
}

export interface GameOptions { headless?: boolean; }
export interface TeamState {
  score: number; materiel: number;
  /** Highway the team's builders are grading from base toward their richest extractor. */
  road?: { tip: THREE.Vector3; target: THREE.Vector3 };
}

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly biome: Biome;
  readonly terrain: Terrain;
  readonly env: Environment;
  readonly colliders = new ColliderWorld();
  readonly weapons: WeaponSystem;
  readonly fx: Effects;
  readonly build: BuildSystem;
  readonly hud: HudLike;
  readonly headless: boolean;
  /** Generated characters (null in headless runs, where players stay as cheap capsules). */
  readonly characters: CharacterLibrary | null;
  readonly captureLimit: number;
  readonly stats: MatchStats = { kills: 0, deathsByCause: {}, grabs: 0, caps: 0, structuresBuilt: 0, structuresDestroyed: 0, piecesDestroyed: 0, roadsGraded: 0, earthMoved: 0, materielMined: 0, vehiclesBought: 0 };
  readonly players: Player[] = [];
  readonly bots: Bot[] = [];
  readonly structures: Structure[] = [];
  readonly vehicles: Vehicle[] = [];
  readonly flags: Flag[] = [];
  readonly teams: TeamState[] = [{ score: 0, materiel: START_MATERIEL }, { score: 0, materiel: START_MATERIEL }];
  readonly human: Player;
  readonly airDomes: { c: THREE.Vector3; r: number }[] = [];
  readonly spawnPoints: THREE.Vector3[][] = [[], []];
  private pickups: Pickup[] = [];
  private crewNeeded = new Map<Structure, number>();
  private viewModel: THREE.Group;
  time = 0;
  thirdPerson = false;
  menuOpen = false;
  over = false;
  private deathCam = new THREE.Vector3();

  constructor(readonly setup: MatchSetup, readonly renderer: THREE.WebGLRenderer | null, readonly input: Input, readonly audio: Audio, private onEnd: (won: boolean) => void, opts: GameOptions = {}) {
    this.headless = !!opts.headless;
    this.characters = this.headless ? null : new CharacterLibrary();
    const lvl = setup.level;
    this.biome = lvl ? levelBiome(lvl) : BIOMES[setup.biome];
    this.captureLimit = lvl?.captureLimit ?? CAPTURE_LIMIT;
    if (lvl?.startMateriel !== undefined) for (const t of this.teams) t.materiel = lvl.startMateriel;
    const aspect = typeof innerWidth === 'number' ? innerWidth / innerHeight : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(85, aspect, 0.3, 9500);
    this.scene.add(this.camera);
    this.terrain = new Terrain(this.biome, lvl?.seed ?? setup.seed, { bases: lvl?.bases, deposits: lvl?.deposits });
    this.env = new Environment(this.biome, this.terrain, setup.seed);
    setSharedUniforms(this.env.uniforms);
    // The terrain material was built before shared uniforms existed in the registry; link them.
    Object.assign(this.terrain.material.uniforms, this.env.uniforms);
    this.scene.add(this.terrain.mesh, this.env.group);
    // Lights for PBR (characters); the world's custom shaders light themselves.
    const sun = new THREE.DirectionalLight(this.biome.sunColor, 2.2);
    sun.position.set(...this.biome.sunDir).multiplyScalar(100);
    this.scene.add(sun, new THREE.HemisphereLight(this.biome.skyTop, 0x3a3430, 0.9));
    if (renderer) {
      // Metals need something to reflect: a soft studio environment, tinted by the biome's sky light.
      this.scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.7;
    }
    this.weapons = new WeaponSystem(this);
    this.fx = new Effects(this.scene);

    this.buildBases();
    for (const d of this.terrain.deposits) this.addDepositMarker(d);

    // Players
    // Headless playtests put a bot in the player's slot so every seat is simulated.
    const human = new Player(this.headless ? 'Seat0' : 'You', 0, this.headless, { armor: 'light', weapons: ['spinfusor', 'grenade', 'chaingun'], pack: 'constructor' }, this);
    this.human = human;
    this.addPlayer(human);
    if (this.headless) this.bots.push(new Bot(human, 'builder', this));
    let ni = Math.floor(Math.random() * BOT_NAMES.length);
    for (let t = 0; t < 2; t++) {
      const count = t === 0 ? setup.teamSize - 1 : setup.teamSize;
      for (let i = 0; i < count; i++) {
        const role: BotRole = i % 3 === 0 ? 'offense' : i % 3 === 1 ? 'defense' : 'builder';
        const lo: Loadout = role === 'offense' ? { armor: 'light', weapons: ['spinfusor', 'chaingun', 'grenade'], pack: 'energy' }
          : role === 'defense' ? { armor: 'heavy', weapons: ['spinfusor', 'chaingun', 'mortar', 'grenade'], pack: 'repair' }
          : { armor: 'medium', weapons: ['spinfusor', 'chaingun', 'grenade'], pack: 'constructor' };
        const p = new Player(BOT_NAMES[ni++ % BOT_NAMES.length], t, true, lo, this);
        this.addPlayer(p);
        this.bots.push(new Bot(p, role, this));
      }
    }
    for (const p of this.players) p.spawn(this.spawnPoint(p.team));
    human.controls.yaw = this.baseYaw(0) + Math.PI;

    this.build = new BuildSystem(this);
    this.hud = this.headless ? new NullHud() : new Hud(this);
    this.viewModel = this.makeViewModel();
    this.camera.add(this.viewModel);
    this.message(this.setup.level ? `${this.setup.level.name}: ${this.setup.level.description}` : `${this.biome.name}: ${this.biome.blurb}`, '#ffe9b0');
    this.message('Capture the enemy flag and bring it to yours. Press B for call-downs, E at stations.', '#cfd8e0');
  }

  teamName(t: number) { return TEAM_NAMES[t]; }
  message(text: string, color?: string) { this.hud?.message(text, color); }

  private addPlayer(p: Player) {
    this.players.push(p);
    this.scene.add(p.mesh);
  }

  // ------------------------------------------------------------------ world setup

  /** Yaw that makes structure-local +Z face the map center. */
  private baseYaw(t: number) {
    const b = this.terrain.bases[t];
    return Math.atan2(-b.x, -b.z);
  }

  /** Point exiting the bunker door (bots route through it). */
  baseDoor(t: number) { return this.local(t, 0, 22, 1.2); }

  local(t: number, x: number, z: number, y?: number) {
    const b = this.terrain.bases[t];
    const yaw = this.baseYaw(t);
    const v = new THREE.Vector3(x, 0, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(new THREE.Vector3(b.x, 0, b.z));
    v.y = y !== undefined ? b.y + y : this.terrain.heightAt(v.x, v.z);
    return v;
  }

  private buildBases() {
    for (let t = 0; t < 2; t++) {
      const b = this.terrain.bases[t];
      const yaw = this.baseYaw(t);
      const center = new THREE.Vector3(b.x, b.y, b.z);
      this.spawnStructure('bunker', t, center, yaw, false);
      const gen = this.spawnStructure('generator', t, this.local(t, 0, -8, 1.2), yaw, false);
      const powered = (s: Structure) => { s.generator = gen; return s; };
      powered(this.spawnStructure('inventory', t, this.local(t, -10, -4, 1.2), yaw, false));
      powered(this.spawnStructure('inventory', t, this.local(t, 10, -4, 1.2), yaw, false));
      powered(this.spawnStructure('turret', t, this.local(t, 0, 0, 12.2), yaw, false));
      powered(this.spawnStructure('sensor', t, this.local(t, -22, -18), yaw, false));
      const flagPos = this.local(t, 0, 50);
      this.spawnStructure('flagStand', t, flagPos, yaw, false);
      powered(this.spawnStructure('turret', t, this.local(t, 14, 44), yaw, false));
      for (let i = 0; i < 4; i++) this.spawnPoints[t].push(this.local(t, -6 + i * 4, 4, 1.4));

      if (this.biome.basesUnderwater) {
        // Seabed base under an air dome; vehicle pad and a forward station on the island shoulder.
        const domeR = 34;
        this.airDomes.push({ c: center.clone().add(new THREE.Vector3(0, 0, 0)), r: domeR });
        const dome = new THREE.Mesh(new THREE.SphereGeometry(domeR, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), makeGlowMaterial(TEAM_COLORS[t], 0.08));
        (dome.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
        dome.position.copy(center);
        this.scene.add(dome);
        const islandX = b.x + (t === 0 ? -120 : 120);
        const isl = new THREE.Vector3(islandX, this.terrain.heightAt(islandX, b.z), b.z);
        powered(this.spawnStructure('vehicleStation', t, isl, yaw, false));
        powered(this.spawnStructure('inventory', t, isl.clone().add(new THREE.Vector3(0, 0, -14)).setY(this.terrain.heightAt(isl.x, isl.z - 14)), yaw, false));
        powered(this.spawnStructure('aaTurret', t, isl.clone().add(new THREE.Vector3(12, 0, -20)).setY(this.terrain.heightAt(isl.x + 12, isl.z - 20)), yaw, false));
      } else {
        powered(this.spawnStructure('vehicleStation', t, this.local(t, 45, 6), yaw, false));
        powered(this.spawnStructure('aaTurret', t, this.local(t, -30, 20), yaw, false));
      }
      const flag = new Flag(t, flagPos.clone().add(new THREE.Vector3(0, 3.2, 0)));
      this.flags.push(flag);
      this.scene.add(flag.mesh);
    }
  }

  private addDepositMarker(d: Deposit) {
    const s = d.richness > 1 ? 1.8 : 1;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(3 * s, 5 * s, 1.2, 12), makePlateMaterial(-1, 0x3a3530, 0xffc860, { emissive: 0.4 }));
    m.position.set(d.x, d.y + 0.3, d.z);
    this.scene.add(m);
    const plume = new THREE.Mesh(new THREE.CylinderGeometry(1.5 * s, 4 * s, 40 * s, 10, 1, true), makeGlowMaterial(d.richness > 1 ? 0xffa030 : 0xffc860, 0.08));
    plume.position.set(d.x, d.y + 20 * s, d.z);
    this.scene.add(plume);
    this.depositPlumes.push({ d, plume });
  }
  private depositPlumes: { d: Deposit; plume: THREE.Mesh }[] = [];

  spawnStructure(kind: StructureKind, team: number, pos: THREE.Vector3, yaw: number, deployable: boolean, opts: Parameters<typeof blueprint>[2] = {}, tilt = 0): Structure {
    const s = new Structure(kind, team, pos.clone(), yaw, blueprint(kind, team, opts), this, tilt);
    s.deployable = deployable;
    if (deployable) this.stats.structuresBuilt++;
    s.radius = STRUCTURE_RADIUS[kind] ?? 4;
    s.label = STRUCTURE_LABEL[kind] ?? kind;
    if (kind === 'skyPlatform') s.deckY = pos.y + 220.8;
    this.structures.push(s);
    this.scene.add(s.group);
    return s;
  }

  spawnPoint(team: number) {
    const pts = this.spawnPoints[team];
    return pts[Math.floor(Math.random() * pts.length)].clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2));
  }

  private makeViewModel() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.3), makePlateMaterial(0, 0x6a717b, TEAM_COLORS[0]));
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, 0.22, 10), makePlateMaterial(0, 0x4a5058, TEAM_COLORS[0]));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, -0.22);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.015, 16), makeGlowMaterial(0x9fe8ff, 0.8));
    disc.position.set(0, 0.045, -0.06);
    g.add(body, barrel, disc);
    g.position.set(0.2, -0.19, -0.55);
    return g;
  }

  // ------------------------------------------------------------------ queries

  isSubmerged(p: THREE.Vector3) {
    if (this.biome.frozen || p.y >= this.biome.seaLevel) return false;
    for (const d of this.airDomes) if (p.distanceTo(d.c) < d.r) return false;
    return true;
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3) {
    if (!this.terrain.lineOfSight(a, b)) return false;
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    d.divideScalar(len);
    const t = this.colliders.raycast(a, d, len - 0.5);
    return t < 0;
  }

  // ------------------------------------------------------------------ combat

  damagePlayer(p: Player, amount: number, attacker: Player | null, cause: string) {
    if (!p.alive || amount <= 0) return;
    if (p.loadout.pack === 'shield' && p.energy > 0) {
      const absorb = Math.min(p.energy / 1.5, amount * 0.7);
      p.energy -= absorb * 1.5;
      amount -= absorb;
    }
    p.health -= amount;
    if (attacker && attacker !== p) { p.lastAttacker = attacker; p.lastHitTime = this.time; }
    const head = cause.endsWith('(head)');
    if (p === this.human) {
      // Direction of the hit relative to where we're looking (0 = ahead, + = to the right).
      let ang: number | undefined;
      if (attacker && attacker !== p) {
        const d = attacker.pos.clone().sub(p.pos);
        const yaw = p.controls.yaw;
        ang = Math.atan2(d.x * Math.cos(yaw) - d.z * Math.sin(yaw), -(d.x * Math.sin(yaw) + d.z * Math.cos(yaw)));
      }
      this.hud.flashDamage(amount, ang);
    }
    if (attacker === this.human && p !== this.human) { this.hud.flashHit(head); if (head) this.audio.headshot(); else this.audio.hit(); }
    if (p.health <= 0) this.killPlayer(p, attacker && attacker !== p ? attacker : (this.time - p.lastHitTime < 5 ? p.lastAttacker : null), cause);
  }

  killPlayer(p: Player, killer: Player | null, cause: string) {
    const wasCarrier = !!p.flag;
    p.alive = false;
    p.health = 0;
    p.deaths++;
    if (p.flag) p.flag.drop(p.vel);
    if (p.vehicle) this.exitVehicle(p);
    p.mesh.visible = false;
    p.respawnTimer = 4;
    this.fx.explosion(p.center, 3, 0xff8060);
    this.spawnPickup(p.pos.clone().add(new THREE.Vector3(0, 1, 0)), KILL_SPOILS);
    this.stats.deathsByCause[cause] = (this.stats.deathsByCause[cause] ?? 0) + 1;
    const ended = p.streak;
    p.streak = 0; p.multi = 0;
    if (killer && killer.team !== p.team) {
      this.stats.kills++;
      killer.kills++;
      killer.streak++;
      killer.multi = this.time - killer.lastKillTime < 4 ? killer.multi + 1 : 1;
      killer.lastKillTime = this.time;
      const head = cause.endsWith('(head)');
      this.message(`${killer.name} ⟶ ${p.name}${head ? ' ◎' : ''}`, killer.team === this.human.team ? '#9fe8ff' : '#ff9a7a');
      const multi = ['', '', 'DOUBLE KILL', 'TRIPLE KILL', 'QUAD KILL'][Math.min(4, killer.multi)];
      const spree = killer.streak === 5 ? 'KILLING SPREE' : killer.streak === 10 ? 'RAMPAGE' : killer.streak === 15 ? 'UNSTOPPABLE' : '';
      if (killer === this.human) {
        this.hud.killConfirm(p.name, head);
        this.audio.kill(killer.multi);
        if (multi) this.hud.callout(multi, '#ffd27a');
        else if (spree) this.hud.callout(spree, '#ff9a40');
        else if (wasCarrier) this.hud.callout('FLAG CARRIER DOWN', '#9fe8ff');
        else if (ended >= 5) this.hud.callout('SPREE ENDED', '#c8f0ff');
      }
      if (spree && killer !== this.human) this.message(`${killer.name} is on a ${spree.toLowerCase()}!`, '#ffb070');
      if (ended >= 5) this.message(`${killer.name} ended ${p.name}'s ${ended}-kill streak`, '#ffd27a');
    } else this.message(`${p.name} died (${cause})`, '#a0a8b0');
    if (p === this.human) { this.deathCam.copy(p.pos); this.build.active = false; }
  }

  directHit(victim: Player | Vehicle, def: WeaponDef, owner: Player | null, dir: THREE.Vector3, mult = 1, head = false) {
    if (victim instanceof Player) {
      if (owner && victim.team === owner.team && victim !== owner) return;
      victim.vel.addScaledVector(dir, def.impulse / victim.armor.mass);
      this.damagePlayer(victim, def.damage * mult, owner, head ? `${def.name} (head)` : def.name);
    } else {
      if (owner && victim.team === owner.team) return;
      victim.damage(def.damage * mult * Math.max(0.5, def.structureMult), owner);
    }
  }

  /** Called when the local player fires: kicks the view model back. */
  onHumanShot(recoil: number) { this.viewKick = Math.min(1, this.viewKick + recoil * 12); }
  private viewKick = 0;

  /** Is a blast at `at` shielded from `target` by terrain or structures? */
  private occluded(at: THREE.Vector3, target: THREE.Vector3) {
    const from = at.clone().add(new THREE.Vector3(0, 0.3, 0));
    return !this.lineOfSight(from, target);
  }

  explode(at: THREE.Vector3, def: WeaponDef, owner: Player | null, team: number, direct: Player | Vehicle | null) {
    const R = def.radius;
    this.fx.explosion(at, R * 0.7, def.color);
    this.audio.explosion(at, Math.min(1.6, R / 8));
    const ground = this.terrain.groundAt(at.x, at.z);
    // Craters are permanent: sustained bombardment trenches the land.
    if (!ground.ice && at.y - ground.y < R * 0.4 && !this.isSubmerged(at)) this.terrain.crater(at.x, at.z, R * 0.55, R * 0.14);
    else if (ground.ice && at.y - ground.y < 1) this.terrain.scorchAt(at.x, at.z, R * 0.6, 0.5);
    if (this.isSubmerged(at)) this.fx.splash(at);

    for (const p of this.players) {
      if (!p.alive || p.vehicle) continue;
      const c = p.center;
      const d = p === direct ? 0 : c.distanceTo(at);
      if (d > R) continue;
      // Cover matters: walls and ridges between you and the blast absorb most of it.
      const cover = p !== direct && d > 1 && this.occluded(at, c) ? 0.25 : 1;
      const k = (1 - d / R) * cover;
      const dir = c.clone().sub(at);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      dir.y += 0.25;
      // Kinetic push applies to everyone (disc-jumping, team boosts); damage only to enemies and self.
      p.vel.addScaledVector(dir.normalize(), def.impulse * k / p.armor.mass);
      if (p === owner) this.damagePlayer(p, def.damage * k * 0.45, owner, 'self');
      else if (p.team !== team) this.damagePlayer(p, def.damage * k, owner, def.name);
    }
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      const d = v === direct ? 0 : Math.max(0, v.pos.distanceTo(at) - v.radius);
      if (d > R) continue;
      const k = 1 - d / R;
      const dir = v.pos.clone().sub(at).normalize();
      v.vel.addScaledVector(dir, def.impulse * k / v.def.mass * 4);
      if (v.team !== team) v.damage(def.damage * k * Math.max(0.6, def.structureMult), owner);
    }
    for (const s of [...this.structures]) {
      if (!s.alive || s.team === team || !s.destructible) continue;
      if (s.pos.distanceTo(at) > R + 300) continue;
      s.blast(at, R, def.damage * def.structureMult);
    }
  }

  damageStructure(s: Structure, amount: number, team: number, box?: OBB) {
    if (s.team !== team) s.damage(amount, box);
  }

  /** Remove a structure. `quiet` = replaced by a merge/upgrade (no explosion, spoils or message). */
  destroyStructure(s: Structure, quiet = false) {
    if (!s.alive) return;
    s.alive = false;
    if (!quiet) this.stats.structuresDestroyed++;
    this.colliders.remove(s);
    this.scene.remove(s.group);
    for (const p of s.pieces) for (const r of p.rubble) this.scene.remove(r);
    if (quiet) { const i = this.structures.indexOf(s); if (i >= 0) this.structures.splice(i, 1); return; }
    this.fx.explosion(s.center, 12, 0xffa040);
    this.audio.explosion(s.center, 1.5);
    const cd = CALLDOWNS.find(c => c.kind === s.kind);
    if (cd && s.kind !== 'beacon') this.spawnPickup(s.center, Math.round(cd.cost * 0.4 + s.mined * 0.3));
    if (s.kind !== 'beacon') this.message(`${this.teamName(s.team)} ${s.label} destroyed`, s.team === this.human.team ? '#ff8a6a' : '#9fe8ff');
    for (const v of this.vehicles) if (v.deployed === s) v.deployed = null;
    const i = this.structures.indexOf(s);
    if (i >= 0) this.structures.splice(i, 1);
    this.crewNeeded.delete(s);
  }

  destroyVehicle(v: Vehicle, attacker: Player | null) {
    if (!v.alive) return;
    v.alive = false;
    const d = v.driver;
    if (d) { this.exitVehicle(d); this.damagePlayer(d, 60, attacker, 'vehicle explosion'); }
    if (v.deployed) this.destroyStructure(v.deployed);
    this.scene.remove(v.mesh);
    this.fx.explosion(v.pos, 10, 0xffa040);
    this.audio.explosion(v.pos, 1.4);
    this.spawnPickup(v.pos.clone(), Math.round(VEHICLES[v.kind].cost * 0.4));
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  /**
   * Repair beam: the only way anything gets fixed. Aims at a point (structure surface or ground)
   * and restores the nearest damaged piece of a friendly structure, rebuilding blown-out panels
   * for materiel.
   */
  repairBeam(p: Player, dt: number) {
    const eye = p.eye, dir = p.aimDir();
    const range = 16;
    let t = this.colliders.raycast(eye, dir, range);
    const tt = this.terrain.raycast(eye, dir, range);
    if (tt >= 0 && (t < 0 || tt < t)) t = tt;
    if (t < 0) t = range;
    const at = eye.clone().addScaledVector(dir, t);
    p.energy -= 12 * dt;
    let best: Structure | null = null, bd = 30;
    for (const s of this.structures) {
      if (!s.alive || s.team !== p.team || !s.destructible) continue;
      const d = s.pos.distanceTo(at) - s.radius * 2;
      if (d < bd) { bd = d; best = s; }
    }
    // Try nearest structures first; repairNear returns false if nothing there needs fixing.
    const cands = this.structures.filter(s => s.alive && s.team === p.team && s.destructible && s.pos.distanceTo(at) < 60)
      .sort((a, b) => a.pos.distanceTo(at) - b.pos.distanceTo(at));
    if (best) cands.unshift(best);
    for (const s of cands) {
      if (s.repairNear(at, 90 * dt)) {
        if (Math.random() < 0.5) this.fx.beam(eye.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0, -0.3, 0)), at, 0x7dffb2, 0.06, 0.08);
        return;
      }
    }
    for (const v of this.vehicles) {
      if (v.team === p.team && v.alive && v.pos.distanceTo(p.pos) < 10 && v.hp < v.def.health) {
        v.hp = Math.min(v.def.health, v.hp + 60 * dt);
        if (Math.random() < 0.5) this.fx.beam(eye, v.pos, 0x7dffb2, 0.06, 0.08);
        return;
      }
    }
    p.health = Math.min(p.armor.health, p.health + 10 * dt);
  }

  private spawnPickup(at: THREE.Vector3, value: number) {
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.5 + value / 80), makeGlowMaterial(0xffd27a, 0.9));
    mesh.position.copy(at);
    this.scene.add(mesh);
    this.pickups.push({ pos: at.clone(), value, mesh, life: 60 });
  }

  // ------------------------------------------------------------------ vehicles

  buyVehicle(p: Player, station: Structure, kind: VehicleKind) {
    const cost = VEHICLES[kind].cost;
    if (this.teams[p.team].materiel < cost) return;
    this.teams[p.team].materiel -= cost;
    this.stats.vehiclesBought++;
    const pad = new THREE.Vector3(0, 0, 12).applyAxisAngle(new THREE.Vector3(0, 1, 0), station.yaw).add(station.pos);
    pad.y = Math.max(this.terrain.heightAt(pad.x, pad.z), station.pos.y) + 3;
    const v = new Vehicle(kind, p.team, pad, station.yaw + Math.PI, this);
    this.vehicles.push(v);
    this.fx.column(pad, 20, TEAM_COLORS[p.team]);
    this.enterVehicle(p, v);
  }

  enterVehicle(p: Player, v: Vehicle) {
    if (v.driver || p.flag || !v.alive) return;
    v.driver = p;
    p.vehicle = v;
    p.controls.yaw = v.yaw;
    this.build.active = false;
  }

  exitVehicle(p: Player) {
    const v = p.vehicle;
    if (!v) return;
    v.driver = null;
    p.vehicle = null;
    p.pos.copy(v.pos).add(new THREE.Vector3(0, v.radius + 1, 0));
    p.vel.copy(v.vel);
  }

  requestCrew(beacon: Structure, n: number) {
    this.crewNeeded.set(beacon, n);
    const free = this.bots.filter(b => b.p.team === beacon.team && !b.p.flag && b.role !== 'offense' && !b.assist)
      .sort((a, b) => a.p.pos.distanceTo(beacon.pos) - b.p.pos.distanceTo(beacon.pos));
    for (const b of free.slice(0, n)) { b.assist = beacon; if (beacon.team === this.human.team) this.message(`${b.p.name}: on my way to the beacon`, '#bfe3ff'); }
  }

  // ------------------------------------------------------------------ interaction

  private nearStation(p: Player, kind: 'inventory' | 'vehicleStation', r = 4.5) {
    return this.structures.find(s => s.kind === kind && s.canUse(p) && s.pos.distanceTo(p.pos) < r) ?? null;
  }

  contextPrompt(): string {
    const p = this.human;
    if (!p.alive || this.menuOpen) return '';
    if (p.vehicle) return p.vehicle.kind === 'transport' ? (p.vehicle.deployed ? 'G — pack up station' : p.vehicle.grounded ? 'G — deploy inventory station' : '') : '';
    if (this.nearStation(p, 'inventory')) return 'E — Inventory station (change armor & loadout)';
    if (this.nearStation(p, 'vehicleStation', 6)) return 'E — Vehicle station';
    const v = this.vehicles.find(v => v.alive && !v.driver && v.team === p.team && v.pos.distanceTo(p.pos) < v.radius + 3);
    if (v) return p.flag ? 'Cannot pilot while carrying the flag' : `E — Pilot ${v.def.name}`;
    const plat = this.structures.find(s => s.kind === 'skyPlatform' && s.team === p.team && Math.hypot(s.pos.x - p.pos.x, s.pos.z - p.pos.z) < 6 && Math.abs(p.pos.y - s.pos.y) < 4);
    if (plat) return 'Step into the beam to go up to the sky platform';
    const ss = this.structures.find(s => s.kind === 'beacon' && s.team === p.team && s.pos.distanceTo(p.pos) < 25);
    if (ss) return `Holding siege beacon: ${Math.round(ss.charge * 100)}% — needs ${this.crewNeeded.get(ss) ?? 2} tribemates`;
    return '';
  }

  warning(): string {
    const p = this.human;
    if (!p.alive) return '';
    if (p.overheated) return 'JETS OVERHEATED — fly low over ice or water to cool';
    if (p.vehicle?.blockedByWater) return 'Water too deep for siege armor — call down a Bridge Span';
    if (p.vehicle?.def.flies) {
      const w = this.env.windAt(p.pos.x, p.pos.y, p.pos.z, new THREE.Vector3()).length();
      if (w > 28) return 'KATABATIC GALE — airframe unstable';
    }
    if (p.flag) return 'YOU HAVE THE FLAG — get it to your stand!';
    const gen = this.structures.find(s => s.kind === 'generator' && s.team === p.team && !s.deployable);
    if (gen?.disabled) return 'Base generator down — stations & turrets offline. Repair it!';
    return '';
  }

  onOverheat(p: Player) {
    if (p === this.human) { this.audio.overheat(); }
  }

  onCapture(team: number) {
    if (this.teams[team].score >= this.captureLimit && !this.over) {
      this.over = true;
      this.input.unlock();
      setTimeout(() => this.onEnd(team === this.human.team), 1500);
    }
  }

  private openLoadout() {
    this.menuOpen = true;
    this.input.unlock();
    showLoadoutMenu(this.human.loadout, l => {
      this.human.applyLoadout(l);
      this.human.stationCooldown = 1;
      this.menuOpen = false;
      this.message(`Equipped ${this.human.armor.name} armor`, '#9fffcf');
      this.input.lock();
    }, () => { this.menuOpen = false; this.input.lock(); });
  }

  // ------------------------------------------------------------------ input

  private humanInput() {
    const p = this.human, c = p.controls, inp = this.input;
    if (this.menuOpen) { Object.assign(c, { forward: 0, strafe: 0, jet: false, fire: false, ski: false, repair: false }); return; }
    c.yaw -= inp.mouseDX * inp.sensitivity;
    c.pitch = THREE.MathUtils.clamp(c.pitch - inp.mouseDY * inp.sensitivity, -1.55, 1.55);
    c.forward = (inp.down('KeyW') ? 1 : 0) - (inp.down('KeyS') ? 1 : 0);
    c.strafe = (inp.down('KeyD') ? 1 : 0) - (inp.down('KeyA') ? 1 : 0);
    c.ski = inp.down('Space');
    if (inp.hit('Space')) c.jumpPressed = true;
    c.jet = inp.rmb || inp.down('ShiftLeft') || inp.down('ShiftRight');
    c.descend = inp.down('KeyC') || inp.down('ControlLeft');
    c.repair = inp.down('KeyF');
    if (inp.hit('KeyV')) this.thirdPerson = !this.thirdPerson;

    if (!p.alive) {
      if (inp.hit('KeyI')) this.openLoadout();
      return;
    }

    // Build mode
    if (inp.hit('KeyB') && !p.vehicle) {
      if (p.loadout.pack !== 'constructor') this.message('You need a Constructor pack to call down structures (inventory station)', '#ffb08a');
      else this.build.active = !this.build.active;
    }
    if (this.build.active) {
      c.fire = false;
      for (let i = 0; i < CALLDOWNS.length; i++) if (inp.hit(i === 9 ? 'Digit0' : i === 10 ? 'Minus' : `Digit${i + 1}`)) { this.build.selected = i; this.build.roadStart = null; }
      if (inp.hit('BracketRight') || inp.hit('BracketLeft')) {
        this.build.selected = (this.build.selected + (inp.hit('BracketRight') ? 1 : -1) + CALLDOWNS.length) % CALLDOWNS.length;
        this.build.roadStart = null;
      }
      // Wheel rotates the piece in 15° steps; R tilts walls (wall → ramp → floor); hold Alt to place freely.
      if (inp.wheel) this.build.rotation += Math.sign(inp.wheel) * Math.PI / 12;
      if (inp.hit('KeyR')) this.build.tiltIndex = (this.build.tiltIndex + 1) % 3;
      this.build.freePlace = inp.down('AltLeft') || inp.down('AltRight');
      if (inp.clicked()) {
        const def = CALLDOWNS[this.build.selected];
        const err = this.build.callDown(p, def, this.build.aimPoint(p));
        if (err) { this.message(err, '#ff8a6a'); this.audio.error(); }
      }
    } else {
      c.fire = inp.lmb;
      for (let i = 0; i < 5; i++) if (inp.hit(`Digit${i + 1}`)) c.weapon = i;
      if (inp.hit('KeyR')) c.reloadPressed = true;
      if (inp.hit('KeyQ') || inp.wheel) c.weapon = (p.slot + (inp.wheel < 0 ? -1 : 1) + p.loadout.weapons.length) % p.loadout.weapons.length;
    }

    if (inp.hit('KeyE')) this.interact();
    if (inp.hit('KeyI')) {
      if (this.nearStation(p, 'inventory', 8)) this.openLoadout();
      else this.message('Loadout changes need a powered inventory station (base, outpost, or deployed APC)', '#ffb08a');
    }
    if (inp.hit('KeyG') && p.vehicle?.kind === 'transport') this.toggleDeploy(p.vehicle);
  }

  private interact() {
    const p = this.human;
    if (p.vehicle) { this.exitVehicle(p); return; }
    if (this.nearStation(p, 'inventory')) { this.openLoadout(); return; }
    const vs = this.nearStation(p, 'vehicleStation', 6);
    if (vs) {
      this.menuOpen = true;
      this.input.unlock();
      showVehicleMenu(this.teams[p.team].materiel, k => { this.menuOpen = false; this.buyVehicle(p, vs, k); this.input.lock(); }, () => { this.menuOpen = false; this.input.lock(); });
      return;
    }
    const v = this.vehicles.find(v => v.alive && !v.driver && v.team === p.team && v.pos.distanceTo(p.pos) < v.radius + 3);
    if (v) this.enterVehicle(p, v);
  }

  private toggleDeploy(v: Vehicle) {
    if (v.deployed) { this.destroyStructure(v.deployed); v.deployed = null; this.message('APC station packed up', '#cfd8e0'); return; }
    if (!v.grounded || v.vel.length() > 3) { this.message('Land the APC to deploy', '#ffb08a'); return; }
    const at = v.pos.clone().add(new THREE.Vector3(Math.cos(v.yaw) * 7, 0, -Math.sin(v.yaw) * 7));
    at.y = this.terrain.heightAt(at.x, at.z);
    v.deployed = this.spawnStructure('inventory', v.team, at, v.yaw, true);
    this.message('APC deployed: mobile inventory station online', '#9fffcf');
  }

  // ------------------------------------------------------------------ loop

  /** Called once per rendered frame. */
  frame(dt: number) {
    if (!this.headless) this.humanInput();
    this.input.endFrame();
    // Fixed-step simulation.
    const step = 1 / 60;
    this.acc = Math.min(this.acc + dt, 0.25);
    while (this.acc >= step) { this.tick(step); this.acc -= step; }
    this.updateCamera(dt);
    this.env.cameraSubmerged = this.isSubmerged(this.camera.position);
    this.env.update(dt, this.camera);
    this.fx.update(dt);
    this.hud.update(dt);
    const p = this.human;
    this.audio.listener.copy(this.camera.position);
    const w = this.env.windAt(p.pos.x, p.pos.y, p.pos.z, new THREE.Vector3());
    this.audio.setAmbient(w.length(), p.alive && p.jetting, p.alive && p.skiing ? p.speed : 0, this.env.cameraSubmerged);
  }
  private acc = 0;

  private tick(dt: number) {
    if (this.over) return;
    this.time += dt;
    for (const b of this.bots) b.update(dt);
    for (const p of this.players) {
      if (!p.alive) {
        p.respawnTimer -= dt;
        if (p.respawnTimer <= 0 && !(p === this.human && this.menuOpen)) p.spawn(this.spawnPoint(p.team));
        continue;
      }
      p.update(dt);
    }
    for (const v of [...this.vehicles]) v.update(dt);
    this.weapons.update(dt);
    for (const s of [...this.structures]) if (s.alive) s.update(dt);
    for (const f of this.flags) f.update(dt, this);
    checkFlagTouches(this);
    this.updatePickups(dt);
    this.updateBeams();
    this.updateBeacons(dt);
    this.updateRams();
    this.terrain.update(dt);
    this.build.update(dt);
  }

  private updatePickups(dt: number) {
    for (const k of this.pickups) {
      k.life -= dt;
      k.mesh.rotation.y += dt * 2;
      const gy = this.terrain.groundAt(k.pos.x, k.pos.z).y + 1;
      if (k.pos.y > gy) k.pos.y = Math.max(gy, k.pos.y - 6 * dt);
      k.mesh.position.copy(k.pos).add(new THREE.Vector3(0, Math.sin(this.time * 3) * 0.2, 0));
      for (const p of this.players) {
        if (!p.alive || p.pos.distanceTo(k.pos) > 3.5) continue;
        this.teams[p.team].materiel += k.value;
        if (p === this.human) this.message(`+${k.value} materiel salvaged`, '#ffd27a');
        k.life = 0;
        break;
      }
      if (k.life <= 0) this.scene.remove(k.mesh);
    }
    this.pickups = this.pickups.filter(k => k.life > 0);
  }

  /** Beam pads between the ground beacon and the sky platform deck. */
  private updateBeams() {
    for (const s of this.structures) {
      if (s.kind !== 'skyPlatform' || !s.alive) continue;
      const deckPad = new THREE.Vector3(12, 0, 12).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(s.pos);
      deckPad.y = s.deckY;
      for (const p of this.players) {
        if (!p.alive || p.vehicle || p.team !== s.team || p.beamCooldown > 0) continue;
        if (Math.hypot(p.pos.x - s.pos.x, p.pos.z - s.pos.z) < 2 && Math.abs(p.pos.y - s.pos.y) < 3) {
          this.fx.column(s.pos, 230, 0x9fd8ff);
          p.pos.copy(deckPad).add(new THREE.Vector3(-4, 0.5, -4).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw));
          p.vel.set(0, 0, 0);
          p.beamCooldown = 2.5;
          if (p === this.human) this.audio.beam();
        } else if (Math.hypot(p.pos.x - deckPad.x, p.pos.z - deckPad.z) < 2 && Math.abs(p.pos.y - deckPad.y) < 3) {
          this.fx.column(s.pos, 230, 0x9fd8ff);
          p.pos.copy(s.pos).add(new THREE.Vector3(4, 0.5, 0));
          p.pos.y = this.terrain.heightAt(p.pos.x, p.pos.z) + 0.5;
          p.vel.set(0, 0, 0);
          p.beamCooldown = 2.5;
          if (p === this.human) this.audio.beam();
        }
      }
    }
  }

  /** Capital call-down beacons charge only while enough tribemates hold them. */
  private updateBeacons(dt: number) {
    for (const [b, need] of [...this.crewNeeded]) {
      if (!b.alive) { this.crewNeeded.delete(b); continue; }
      const crew = this.players.filter(p => p.alive && p.team === b.team && p.pos.distanceTo(b.pos) < 25).length;
      if (crew >= need) b.charge = Math.min(1, b.charge + dt / 10);
      else b.charge = Math.max(0, b.charge - dt / 30);
      if (b.charge >= 1) {
        const at = b.pos.clone();
        const team = b.team;
        this.crewNeeded.delete(b);
        this.destroyStructure(b);
        for (const bot of this.bots) if (bot.assist === b) bot.assist = null;
        this.message(`${this.teamName(team)} siege tank inbound!`, team === this.human.team ? '#7dffb2' : '#ff6a6a');
        this.build.drop(at, team, () => {
          const v = new Vehicle('tank', team, at.clone().add(new THREE.Vector3(0, 2, 0)), 0, this);
          this.vehicles.push(v);
        });
      }
    }
  }

  private updateRams() {
    for (const v of this.vehicles) {
      if (!v.alive || !v.driver) continue;
      const sp = v.vel.length();
      if (sp < 15) continue;
      for (const p of this.players) {
        if (!p.alive || p.vehicle || p.team === v.team) continue;
        if (p.center.distanceTo(v.pos) < v.radius + p.armor.radius) {
          this.damagePlayer(p, sp * 2.5, v.driver, 'roadkill');
          p.vel.addScaledVector(v.vel, 0.8).y += 8;
        }
      }
    }
  }

  private updateCamera(dt: number) {
    const p = this.human, c = p.controls, cam = this.camera;
    cam.rotation.order = 'YXZ';
    this.viewModel.visible = false;
    if (!p.alive) {
      const a = this.time * 0.3;
      cam.position.set(this.deathCam.x + Math.cos(a) * 18, this.deathCam.y + 10, this.deathCam.z + Math.sin(a) * 18);
      cam.lookAt(this.deathCam);
      return;
    }
    if (p.vehicle) {
      const v = p.vehicle;
      const dist = v.radius * 3.2 + 4;
      const dir = p.aimDir();
      const back = v.pos.clone().addScaledVector(dir, -dist).add(new THREE.Vector3(0, v.radius * 0.9 + 1.5, 0));
      const gy = this.terrain.groundAt(back.x, back.z).y + 1.5;
      if (back.y < gy) back.y = gy;
      cam.position.lerp(back, 1 - Math.exp(-12 * dt));
      cam.rotation.set(c.pitch, c.yaw, 0);
      return;
    }
    if (this.thirdPerson) {
      const dir = p.aimDir();
      const back = p.eye.addScaledVector(dir, -7).add(new THREE.Vector3(0, 1.2, 0));
      const gy = this.terrain.groundAt(back.x, back.z).y + 1;
      if (back.y < gy) back.y = gy;
      cam.position.copy(back);
      cam.rotation.set(c.pitch, c.yaw, 0);
      return;
    }
    cam.position.copy(p.eye);
    cam.rotation.set(c.pitch, c.yaw, 0);
    p.mesh.visible = false;
    this.viewModel.visible = !this.build.active;
    // View-model recoil and reload dip.
    this.viewKick = Math.max(0, this.viewKick - dt * 8);
    this.viewModel.position.set(0.2, -0.19 - (p.reloading > 0 ? 0.12 : 0), -0.55 + this.viewKick * 0.12);
    this.viewModel.rotation.x = this.viewKick * 0.25 + (p.reloading > 0 ? -0.6 : 0);
    // Speed-based FOV kick sells velocity.
    const targetFov = 85 + Math.min(20, p.speed * 0.15);
    cam.fov += (targetFov - cam.fov) * (1 - Math.exp(-4 * dt));
    cam.updateProjectionMatrix();
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.hud.dispose();
    document.querySelectorAll('.overlay').forEach(o => o.remove());
  }
}
