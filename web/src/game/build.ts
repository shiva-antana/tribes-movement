import * as THREE from 'three';
import { CALLDOWNS, CalldownDef, ROAD_COST_PER_M3, StructureKind, BUILD_LIMIT, STRUCTURE_COST } from '../config';
import { CONTENT_PREFABS, loadUserPrefabs, saveUserPrefab, PrefabDef } from '../content/prefabs';
import { blueprint } from './structures';
import { makeGlowMaterial, makeLitMaterial } from './materials';
import type { Game } from './game';
import type { Player } from './player';
import type { Structure } from './structures';

interface Pod {
  mesh: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  team: number;
  land: () => void;
}

export interface PlacementCheck { ok: boolean; reason: string; at: THREE.Vector3; yaw: number; cost?: number; placement?: Placement; }

/** Where and how a piece will land, after rotation, snapping and merge rules. */
export interface Placement {
  at: THREE.Vector3;
  yaw: number;
  tilt: number;
  note: string;                       // shown in the HUD: what the snap/merge will do
  host?: Structure;                   // structure we snapped to / merge into
  merge?: StructureKind;              // Tiny Glade-style transform: host becomes this
  post?: THREE.Vector3;               // add a junction post here (wall corners)
  snapped: boolean;
}

/** Placement intent for a caller. The human's comes from the build UI; bots pass their own. */
export interface Pose { yaw?: number; rotation?: number; tilt?: number; free?: boolean; }

export type Socket = { p: THREE.Vector3; type: 'end' | 'top' | 'bridgeEnd'; dir: THREE.Vector3 };

const WALL_LEN = 14, WALL_H = 7;
const STEP = Math.PI / 12;               // 15° rotation steps
const TILTS = [0, Math.PI / 4, Math.PI / 2]; // wall → ramp → floor slab
const MERGES: Partial<Record<string, StructureKind>> = { turret: 'battery', aaTurret: 'flakTower' };

/** Snap sockets of a placed structure (world space). */
export function sockets(s: Structure): Socket[] {
  const out: Socket[] = [];
  const W = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(s.quat).add(s.pos);
  const D = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyQuaternion(s.quat).normalize();
  if (s.kind === 'wall' || s.kind === 'battery' || s.kind === 'flakTower') {
    out.push({ p: W(WALL_LEN / 2, 0, 0), type: 'end', dir: D(1, 0, 0) }, { p: W(-WALL_LEN / 2, 0, 0), type: 'end', dir: D(-1, 0, 0) });
    if (s.kind === 'wall' && s.tilt === 0) out.push({ p: W(0, WALL_H, 0), type: 'top', dir: D(0, 1, 0) });
  }
  if (s.kind === 'bridge') {
    const L = 110;
    out.push({ p: W(0, 0, -L / 2 + 4), type: 'bridgeEnd', dir: D(0, 0, -1) });
  }
  return out;
}

const ROAD_WIDTH = 12;
const ROAD_MAX = 220;

/** Call-downs: orbital drop pods that deliver structures anywhere on the map. */
export class BuildSystem {
  private pods: Pod[] = [];
  readonly ghost: THREE.Mesh;
  selected = 0;
  active = false;
  /** First click of a two-click road. */
  roadStart: THREE.Vector3 | null = null;
  /** Player rotation offset (mouse wheel, 15° steps) and tilt index (R): wall → ramp → floor. */
  rotation = 0;
  tiltIndex = 0;
  freePlace = false;                  // hold Alt: ignore snapping
  private preview: THREE.Group | null = null;
  /** Prefab layouts: content prefabs + the player's saved ones. */
  prefabIndex = 0;
  private userPrefabs: PrefabDef[] = typeof localStorage !== 'undefined' ? loadUserPrefabs() : [];
  private previewKey = '';

  constructor(private game: Game) {
    this.ghost = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 0.4, 24), makeGlowMaterial(0x7dffb2, 0.35));
    this.ghost.visible = false;
    game.scene.add(this.ghost);
  }

  aimPoint(p: Player, range = 140): THREE.Vector3 | null {
    const g = this.game;
    const o = p.eye, d = p.aimDir();
    const tT = g.terrain.raycast(o, d, range);
    const tB = g.colliders.raycast(o, d, range);
    let t = -1;
    if (tT >= 0) t = tT;
    if (tB >= 0 && (t < 0 || tB < t)) t = tB;
    if (t < 0) return null;
    const at = o.addScaledVector(d, t);
    return at;
  }

  defAt(i: number): CalldownDef { return CALLDOWNS[i]; }

  // ---------------------------------------------------------------- prefabs & budget
  get prefabs(): PrefabDef[] { return [...CONTENT_PREFABS, ...this.userPrefabs]; }
  get prefab(): PrefabDef | null { const all = this.prefabs; return all.length ? all[((this.prefabIndex % all.length) + all.length) % all.length] : null; }
  prefabCost(pf: PrefabDef) { return Math.round(pf.pieces.reduce((s, q) => s + (STRUCTURE_COST[q.kind] ?? 20), 0) * 0.9); }
  /** Alive deployables a team has (the build budget counts these). */
  teamBuilt(team: number) { return this.game.structures.filter(s => s.alive && s.deployable && s.team === team).length; }

  /** World placements of a prefab's pieces, anchored at `at` and turned by `yaw` (pieces follow the ground). */
  prefabPlacements(pf: PrefabDef, at: THREE.Vector3, yaw: number) {
    const g = this.game, up = new THREE.Vector3(0, 1, 0);
    return pf.pieces.map(q => {
      const pos = new THREE.Vector3(q.at[0], 0, q.at[2]).applyAxisAngle(up, yaw).add(at);
      pos.y = g.terrain.heightAt(pos.x, pos.z) + q.at[1];
      return { kind: q.kind, pos, yaw: yaw + (q.yaw * Math.PI) / 180, tilt: ((q.tilt ?? 0) * Math.PI) / 180 };
    });
  }

  /** Save the team's own structures around `aim` (25 m) as a reusable layout. */
  captureLayout(p: Player, aim: THREE.Vector3, name?: string): PrefabDef | null {
    const g = this.game, yaw = Math.round(p.controls.yaw / STEP) * STEP, up = new THREE.Vector3(0, 1, 0);
    const skip = new Set<StructureKind>(['extractor', 'beacon', 'skyPlatform', 'bridge', 'bunker', 'flagStand']);
    const pieces = g.structures.filter(s => s.alive && s.deployable && s.team === p.team && !skip.has(s.kind) && Math.hypot(s.pos.x - aim.x, s.pos.z - aim.z) < 25)
      .map(s => {
        const l = new THREE.Vector3(s.pos.x - aim.x, 0, s.pos.z - aim.z).applyAxisAngle(up, -yaw);
        return { kind: s.kind, at: [+l.x.toFixed(2), +(s.pos.y - g.terrain.heightAt(s.pos.x, s.pos.z)).toFixed(2), +l.z.toFixed(2)] as [number, number, number], yaw: +(((s.yaw - yaw) * 180) / Math.PI).toFixed(1), tilt: +((s.tilt * 180) / Math.PI).toFixed(1) };
      });
    if (!pieces.length) return null;
    const n = this.userPrefabs.length + 1;
    const pf: PrefabDef = { id: `layout-${Date.now().toString(36)}`, name: name ?? `My layout ${n}`, pieces, user: true };
    this.userPrefabs.push(pf);
    if (typeof localStorage !== 'undefined') saveUserPrefab(pf);
    this.prefabIndex = this.prefabs.length - 1;
    return pf;
  }

  /** Rotation, snapping and Tiny Glade-style merge rules. */
  resolve(p: Player, def: CalldownDef, aim: THREE.Vector3, pose?: Pose): Placement {
    const g = this.game;
    // The human's build UI state applies only to the human; bots supply their own pose.
    const ui = p === g.human && !pose;
    const rotation = ui ? this.rotation : pose?.rotation ?? 0;
    const tiltIdx = ui ? this.tiltIndex : pose?.tilt ?? 0;
    const freePlace = ui ? this.freePlace : !!pose?.free;
    const userYaw = pose?.yaw ?? Math.round((p.controls.yaw + rotation) / STEP) * STEP;
    const tilt = def.kind === 'wall' ? TILTS[tiltIdx % TILTS.length] : 0;
    const free: Placement = { at: aim.clone(), yaw: userYaw, tilt, note: freePlace ? 'Free placement' : 'Free placement (no snap target)', snapped: false };
    if (freePlace) return free;
    const near = g.structures.filter(s => s.alive && s.team === p.team && s.pos.distanceTo(aim) < 30);
    const all = near.flatMap(s => sockets(s).map(k => ({ s, k })));
    const nearest = (type: Socket['type'], maxD: number) => {
      let best: { s: Structure; k: Socket } | null = null, bd = maxD;
      for (const c of all) if (c.k.type === type) { const d = c.k.p.distanceTo(aim); if (d < bd) { bd = d; best = c; } }
      return best;
    };
    const angDiff = (a: number, b: number) => { let d = (a - b) % Math.PI; if (d > Math.PI / 2) d -= Math.PI; if (d < -Math.PI / 2) d += Math.PI; return Math.abs(d); };

    // Turret / AA aimed at a wall top → the wall grows battlements and becomes a battery.
    const merge = MERGES[def.kind];
    if (merge) {
      const top = nearest('top', 7);
      if (top && aim.y > top.s.pos.y + WALL_H * 0.5) {
        return { at: top.s.pos.clone(), yaw: top.s.yaw, tilt: 0, note: `Merge → ${merge === 'battery' ? 'Wall Battery (+height, +range)' : 'Flak Tower (+height, +range)'}`, host: top.s, merge, snapped: true };
      }
    }
    if (def.kind === 'wall') {
      // Floor slab onto a wall top: pivots on the top edge and spans toward where you aim.
      const top = nearest('top', 6);
      if (top && tilt === Math.PI / 2) {
        const side = new THREE.Vector3(0, 0, 1).applyQuaternion(top.s.quat).dot(aim.clone().sub(top.k.p)) >= 0 ? 0 : Math.PI;
        return { at: top.k.p.clone(), yaw: top.s.yaw + side, tilt, note: 'Snap: floor slab on wall top', host: top.s, snapped: true };
      }
      if (top && tilt === 0 && aim.y > top.s.pos.y + WALL_H * 0.6) {
        return { at: top.k.p.clone(), yaw: top.s.yaw, tilt, note: 'Snap: stack on wall', host: top.s, snapped: true };
      }
      // Continue a wall from its end: straight or at a right-angle corner (corners get a post).
      const end = nearest('end', 5);
      if (end && tilt === 0) {
        let best = { k: 0, d: Infinity };
        for (const k of [0, 1, -1]) {
          const a = end.k.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), k * Math.PI / 2);
          const yaw = Math.atan2(-a.z, a.x);
          const d = angDiff(yaw, userYaw);
          if (d < best.d) best = { k, d };
        }
        const a = end.k.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), best.k * Math.PI / 2);
        const at = end.k.p.clone().addScaledVector(a, WALL_LEN / 2);
        return { at, yaw: Math.atan2(-a.z, a.x), tilt, note: best.k === 0 ? 'Snap: continue wall' : 'Snap: corner (adds a post)', host: end.s, post: best.k !== 0 ? end.k.p.clone() : undefined, snapped: true };
      }
    }
    if (def.kind === 'bridge') {
      const be = nearest('bridgeEnd', 14);
      if (be) return { at: be.k.p.clone(), yaw: be.s.yaw, tilt: 0, note: 'Snap: extend bridge', host: be.s, snapped: true };
    }
    if (def.kind === 'turret' || def.kind === 'aaTurret' || def.kind === 'inventory') {
      // Align with a nearby wall's facing so defenses read as part of the fortification.
      const end = nearest('end', 10);
      if (end) return { ...free, yaw: end.s.yaw, note: 'Aligned to wall' };
    }
    return free;
  }

  check(p: Player, def: CalldownDef, aimAt: THREE.Vector3 | null, pose?: Pose): PlacementCheck {
    const g = this.game;
    if (!aimAt) return { ok: false, reason: 'No surface in range', at: p.pos.clone(), yaw: p.controls.yaw };
    const pl = def.kind === 'road' || def.kind === 'extractor' ? null : this.resolve(p, def, aimAt, pose);
    const at = pl ? pl.at : aimAt;
    const yaw = pl ? pl.yaw : p.controls.yaw;
    const res = (ok: boolean, reason: string): PlacementCheck => ({ ok, reason: ok && pl ? pl.note : reason, at, yaw, placement: pl ?? undefined });
    if (p.loadout.pack !== 'constructor') return res(false, 'Need Constructor pack (inventory station)');
    if (def.kind === 'road') return this.checkRoad(p, at);
    const built = this.teamBuilt(p.team);
    if (def.kind === 'prefab') {
      const pf = this.prefab;
      if (!pf) return res(false, 'No prefabs yet: press K to save the structures around your aim');
      const cost = this.prefabCost(pf);
      if (g.teams[p.team].materiel < cost) return { ...res(false, `Need ${cost} materiel for ${pf.name}`), cost };
      if (built + pf.pieces.length > BUILD_LIMIT) return res(false, `Build limit: ${built}/${BUILD_LIMIT} structures`);
      const enemyBase = g.terrain.bases[1 - p.team];
      if (Math.hypot(at.x - enemyBase.x, at.z - enemyBase.z) < 220) return res(false, 'Too close to enemy base');
      return { ok: true, reason: `${pf.name}: ${pf.pieces.length} pieces · ${cost} materiel (P: next layout)`, at, yaw: pl?.yaw ?? yaw, cost };
    }
    if (def.kind !== 'siegeDrop' && built >= BUILD_LIMIT) return res(false, `Build limit: ${built}/${BUILD_LIMIT} structures`);
    if (g.teams[p.team].materiel < def.cost) return res(false, `Need ${def.cost} materiel`);
    if (def.requires === 'uplink' && !g.structures.some(s => s.kind === 'uplink' && s.team === p.team && s.alive)) return res(false, 'Requires a Command Uplink');
    const enemyBase = g.terrain.bases[1 - p.team];
    const dEnemy = Math.hypot(at.x - enemyBase.x, at.z - enemyBase.z);
    if (def.minEnemyDist && dEnemy < def.minEnemyDist) return res(false, `Too close to enemy airspace (${Math.round(dEnemy)}m < ${def.minEnemyDist}m)`);
    if (dEnemy < 220) return res(false, 'Too close to enemy base');
    if (def.kind === 'extractor') {
      const vent = g.terrain.deposits.find(v => Math.hypot(v.x - at.x, v.z - at.z) < 16 + v.richness * 4);
      if (!vent) return res(false, 'Extractors must be placed on a resource deposit');
      if (vent.amount <= 0) return res(false, 'Deposit is mined out');
      if (g.structures.some(s => s.kind === 'extractor' && s.alive && Math.hypot(s.pos.x - vent.x, s.pos.z - vent.z) < 10)) return res(false, 'Deposit already tapped');
      return { ok: true, reason: '', at: new THREE.Vector3(vent.x, g.terrain.heightAt(vent.x, vent.z), vent.z), yaw };
    }
    const n = g.terrain.normalAt(at.x, at.z);
    if (!pl?.snapped && def.kind !== 'bridge' && n.y < 0.75 && at.y - g.terrain.heightAt(at.x, at.z) < 0.5) return res(false, 'Ground too steep');
    return res(true, '');
  }

  private checkRoad(p: Player, at: THREE.Vector3): PlacementCheck {
    const g = this.game;
    const yaw = p.controls.yaw;
    if (!this.roadStart) return { ok: true, reason: 'Click to set the road start', at, yaw };
    const len = Math.hypot(at.x - this.roadStart.x, at.z - this.roadStart.z);
    if (len < 10) return { ok: false, reason: 'Road too short', at, yaw };
    if (len > ROAD_MAX) return { ok: false, reason: `Max ${ROAD_MAX}m per segment (${Math.round(len)}m)`, at, yaw };
    const { volume } = g.terrain.gradeRoad(this.roadStart, at, ROAD_WIDTH, false);
    const cost = Math.round(15 + volume * ROAD_COST_PER_M3);
    if (g.teams[p.team].materiel < cost) return { ok: false, reason: `Need ${cost} materiel (${Math.round(volume)} m³ earthworks)`, at, yaw, cost };
    return { ok: true, reason: `${Math.round(len)}m road · ${Math.round(volume)} m³ · ${cost} materiel`, at, yaw, cost };
  }

  /** One-call road for bots/scripts (no two-click UI state). Returns error string or ''. */
  gradeRoad(p: Player, a: THREE.Vector3, b: THREE.Vector3): string {
    const g = this.game;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 10 || len > ROAD_MAX) return `road length ${Math.round(len)}m out of range`;
    const { volume } = g.terrain.gradeRoad(a, b, ROAD_WIDTH, false);
    const cost = Math.round(15 + volume * ROAD_COST_PER_M3);
    if (g.teams[p.team].materiel < cost) return `need ${cost} materiel`;
    g.teams[p.team].materiel -= cost;
    const moved = g.terrain.gradeRoad(a, b, ROAD_WIDTH, true);
    g.stats.roadsGraded++;
    g.stats.earthMoved += moved.volume;
    for (let t = 0; t <= 1; t += 0.2) { const q = a.clone().lerp(b, t); q.y = g.terrain.heightAt(q.x, q.z) + 1; g.fx.explosion(q, 5, 0xb09070); }
    g.message(`${p.name} graded ${Math.round(len)}m of road (${cost} materiel)`, p.team === g.human.team ? '#ffd27a' : '#ffb08a');
    for (const pl of g.players) if (pl.alive && !pl.vehicle) pl.pos.y = Math.max(pl.pos.y, g.terrain.groundAt(pl.pos.x, pl.pos.z).y);
    return '';
  }

  /** Attempt a call-down. Returns error string or '' on success. */
  callDown(p: Player, def: CalldownDef, at: THREE.Vector3 | null, pose?: Pose): string {
    const c = this.check(p, def, at, pose);
    if (!c.ok) return c.reason;
    const g = this.game;
    if (def.kind === 'road') {
      if (!this.roadStart) { this.roadStart = c.at.clone(); if (p === g.human) g.message('Road start set: click the end point', '#ffd27a'); return ''; }
      const a = this.roadStart, b = c.at.clone();
      this.roadStart = null;
      g.teams[p.team].materiel -= c.cost ?? 0;
      const moved = g.terrain.gradeRoad(a, b, ROAD_WIDTH, true);
      g.stats.roadsGraded++;
      g.stats.earthMoved += moved.volume;
      // Earthworks: dust bursts along the corridor.
      for (let t = 0; t <= 1; t += 0.1) {
        const q = a.clone().lerp(b, t);
        q.y = g.terrain.heightAt(q.x, q.z) + 1;
        g.fx.explosion(q, 6, 0xb09070);
      }
      g.audio.explosion(a.clone().lerp(b, 0.5), 1.5);
      g.message(`${p.name} graded ${Math.round(a.distanceTo(b))}m of road (${c.cost} materiel)`, '#ffd27a');
      // Anything standing on the old surface settles onto the new one.
      for (const pl of g.players) if (pl.alive && !pl.vehicle) pl.pos.y = Math.max(pl.pos.y, g.terrain.groundAt(pl.pos.x, pl.pos.z).y);
      return '';
    }
    g.teams[p.team].materiel -= def.cost;
    const pos = c.at.clone();
    const yaw = c.yaw;
    const team = p.team;
    const pl = c.placement;
    if (def.kind === 'prefab') {
      const pf = this.prefab!;
      g.teams[team].materiel -= c.cost ?? 0;
      for (const q of this.prefabPlacements(pf, pos, yaw)) this.drop(q.pos, team, () => { g.spawnStructure(q.kind, team, q.pos, q.yaw, true, {}, q.tilt); });
      g.message(`${p.name} called down ${pf.name} (${pf.pieces.length} pieces)`, team === g.human.team ? '#ffd27a' : '#ffb08a');
      return '';
    }
    if (pl?.merge && pl.host) {
      const host = pl.host, merge = pl.merge;
      this.drop(host.pos.clone().add(new THREE.Vector3(0, WALL_H, 0)), team, () => {
        if (!host.alive) return;
        const ratio = host.destructible ? host.hp / host.maxHp : 1;
        g.destroyStructure(host, true);
        const b = g.spawnStructure(merge, team, host.pos, host.yaw, true);
        b.hp = b.maxHp * Math.max(0.3, ratio);
        g.message(`Wall became a ${b.label}`, team === g.human.team ? '#ffd27a' : '#ffb08a');
      });
      g.message(`${p.name} called down ${def.name} → merging into wall`, team === g.human.team ? '#ffd27a' : '#ffb08a');
      return '';
    }
    if (def.kind === 'wall') {
      const tilt = pl?.tilt ?? 0;
      this.drop(pos, team, () => {
        g.spawnStructure('wall', team, pos, yaw, true, {}, tilt);
        if (pl?.post && !g.structures.some(s => s.kind === 'post' && s.alive && s.pos.distanceTo(pl.post!) < 1.5)) g.spawnStructure('post', team, pl.post, yaw, true);
      });
      g.message(`${p.name} called down ${def.name}`, team === g.human.team ? '#ffd27a' : '#ffb08a');
      return '';
    }
    g.message(`${p.name} called down ${def.name}`, team === g.human.team ? '#ffd27a' : '#ffb08a');
    switch (def.kind) {
      case 'outpost': {
        this.drop(pos, team, () => {
          const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
          const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
          const gen = g.spawnStructure('generator', team, pos, yaw, true);
          const at2 = (v: THREE.Vector3) => { v.y = g.terrain.heightAt(v.x, v.z); return v; };
          const inv = g.spawnStructure('inventory', team, at2(pos.clone().addScaledVector(right, 9)), yaw, true);
          const tur = g.spawnStructure('turret', team, at2(pos.clone().addScaledVector(fwd, 10)), yaw, true);
          inv.generator = gen; tur.generator = gen;
        });
        break;
      }
      case 'siegeDrop': {
        const b = g.spawnStructure('beacon', team, pos, yaw, true);
        b.payload = 'tank';
        g.requestCrew(b, def.crew ?? 2);
        g.message(`Siege drop beacon placed — ${def.crew} tribemates must hold the beacon`, '#ffd27a');
        break;
      }
      case 'bridge': {
        this.drop(pos, team, () => this.spawnBridge(pos, yaw, team));
        break;
      }
      case 'skyPlatform': {
        this.drop(pos, team, () => g.spawnStructure('skyPlatform', team, pos, yaw, true));
        break;
      }
      case 'extractor': {
        const di = g.terrain.deposits.findIndex(d => Math.hypot(d.x - pos.x, d.z - pos.z) < 1);
        this.drop(pos, team, () => { g.spawnStructure('extractor', team, pos, yaw, true).depositIndex = di; });
        break;
      }
      default: {
        const kind = def.kind as Structure['kind'];
        this.drop(pos, team, () => g.spawnStructure(kind, team, pos, yaw, true));
      }
    }
    return '';
  }

  spawnBridge(start: THREE.Vector3, yaw: number, team: number) {
    const g = this.game;
    const L = 110, n = 12;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const center = start.clone().addScaledVector(fwd, L / 2 - 4);
    const sea = g.biome.seaLevel;
    const end = start.clone().addScaledVector(fwd, L - 8);
    const y0 = Math.max(g.terrain.heightAt(start.x, start.z) + 0.2, sea + 2.5);
    const y1 = Math.max(g.terrain.heightAt(end.x, end.z) + 0.2, sea + 2.5);
    center.y = Math.min(y0, y1) - 0.6;
    const heights: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const p = start.clone().addScaledVector(fwd, -4 + t * L);
      const ground = g.terrain.heightAt(p.x, p.z);
      const lin = y0 + (y1 - y0) * t;
      heights.push(Math.max(lin, ground + 0.2, sea + 2.5) - center.y - 0.6);
    }
    // Structure yaw: bridge length runs along local Z; our forward is -Z so yaw matches player yaw.
    g.spawnStructure('bridge', team, center, yaw, true, { length: L, heights });
  }

  /** Orbital drop pod: falls from the sky, crushes anything below, then deploys. */
  drop(to: THREE.Vector3, team: number, land: () => void) {
    const g = this.game;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(2.2, 6, 8), makeLitMaterial(0x9aa2ad));
    body.rotation.x = Math.PI;
    const flame = new THREE.Mesh(new THREE.ConeGeometry(1.6, 10, 8), makeGlowMaterial(0xffa040, 0.7));
    flame.position.y = 7;
    mesh.add(body, flame);
    const from = to.clone().add(new THREE.Vector3(80, 650, 40));
    mesh.position.copy(from);
    g.scene.add(mesh);
    this.pods.push({ mesh, from, to: to.clone(), t: 0, dur: 2.4, team, land });
    g.audio.incoming(to);
  }

  update(dt: number) {
    const g = this.game;
    for (const pod of this.pods) {
      pod.t += dt;
      const k = Math.min(1, pod.t / pod.dur);
      const e = k * k;
      pod.mesh.position.lerpVectors(pod.from, pod.to, e);
      pod.mesh.lookAt(pod.to);
      pod.mesh.rotateX(Math.PI / 2);
      if (Math.random() < 0.6) g.fx.trail(pod.mesh.position, 0xffa040);
      if (k >= 1) {
        g.scene.remove(pod.mesh);
        g.fx.explosion(pod.to, 9, 0xffc070);
        g.audio.explosion(pod.to, 1.2);
        for (const pl of g.players) if (pl.alive && pl.team !== pod.team && pl.pos.distanceTo(pod.to) < 6) g.damagePlayer(pl, 300, null, 'drop pod');
        pod.land();
      }
    }
    this.pods = this.pods.filter(p => p.t < p.dur);

    // Placement ghost for the human: a translucent preview of the real piece at its snapped pose.
    const h = g.human;
    this.ghost.visible = false;
    if (this.preview) this.preview.visible = false;
    if (this.active && h.alive && !h.vehicle) {
      const def = this.defAt(this.selected);
      const at = this.aimPoint(h);
      const c = this.check(h, def, at);
      if (at && def.kind === 'road') {
        this.ghost.visible = true;
        this.ghost.position.copy(c.at).add(new THREE.Vector3(0, 0.3, 0));
        this.ghost.scale.set(1, 1, 1);
        if (this.roadStart) {
          const mid = this.roadStart.clone().add(c.at).multiplyScalar(0.5);
          const len = Math.hypot(c.at.x - this.roadStart.x, c.at.z - this.roadStart.z);
          this.ghost.position.copy(mid).add(new THREE.Vector3(0, 1, 0));
          this.ghost.scale.set(ROAD_WIDTH / 8, 1, Math.max(1, len / 8));
          this.ghost.rotation.y = Math.atan2(c.at.x - this.roadStart.x, c.at.z - this.roadStart.z);
        }
        (this.ghost.material as THREE.MeshBasicMaterial).color.set(c.ok ? 0x7dffb2 : 0xff5a5a);
      } else if (at) {
        const pl = c.placement;
        const kind: StructureKind = pl?.merge ?? (def.kind === 'outpost' ? 'generator' : def.kind === 'siegeDrop' ? 'beacon' : def.kind as StructureKind);
        const pf = def.kind === 'prefab' ? this.prefab : null;
        const key = pf ? `prefab:${pf.id}` : `${kind}:${def.kind}`;
        if (key !== this.previewKey) {
          if (this.preview) g.scene.remove(this.preview);
          this.preview = new THREE.Group();
          const addParts = (k: StructureKind, parent: THREE.Object3D) => {
            for (const part of blueprint(k, h.team)) {
              if (part.glow !== undefined) continue;
              const geo = part.geo === 'cyl' ? new THREE.CylinderGeometry(part.size[0] / 2, part.size[2] / 2, part.size[1], 12) : part.geo === 'sphere' ? new THREE.SphereGeometry(part.size[0] / 2, 12, 8) : new THREE.BoxGeometry(...part.size);
              const m = new THREE.Mesh(geo, this.ghost.material);
              m.position.set(...part.at);
              parent.add(m);
            }
          };
          if (pf) for (const q of pf.pieces) {
            const sub = new THREE.Group();
            sub.position.set(q.at[0], q.at[1], q.at[2]);
            sub.rotation.set(((q.tilt ?? 0) * Math.PI) / 180, (q.yaw * Math.PI) / 180, 0, 'YXZ');
            addParts(q.kind, sub);
            this.preview.add(sub);
          }
          else addParts(kind, this.preview);
          g.scene.add(this.preview);
          this.previewKey = key;
        }
        const pv = this.preview!;
        pv.visible = true;
        pv.position.copy(c.at);
        pv.quaternion.setFromEuler(new THREE.Euler(pf ? 0 : pl?.tilt ?? 0, c.yaw, 0, 'YXZ'));
        const mat = this.ghost.material as THREE.MeshBasicMaterial;
        mat.color.set(!c.ok ? 0xff5a5a : pl?.merge ? 0xffd27a : pl?.snapped ? 0x7dd8ff : 0x7dffb2);
      }
      g.hud.setBuildStatus(def, c);
    }
  }
}
