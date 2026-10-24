import * as THREE from 'three';
import { CALLDOWNS, GRAVITY, WEAPONS, WeaponId } from '../config';
import type { Game } from './game';
import type { Player } from './player';
import type { Structure } from './structures';

export type BotRole = 'offense' | 'defense' | 'builder';

/**
 * Bot brain. Tribes movement for bots: ski downhill, jet uphill and over gaps,
 * manage energy and heat (hug ice/water to cool), lead targets with splash weapons.
 */
export class Bot {
  role: BotRole;
  target: Player | null = null;
  private scanTimer = Math.random() * 0.3;
  private thinkTimer = 0;
  private goal = new THREE.Vector3();
  private jetLatch = false;
  skill: number;
  assist: Structure | null = null;
  private buildCooldown = 10 + Math.random() * 20;
  private stuckTimer = 0;
  private lastPos = new THREE.Vector3();
  private strafeDir = 1;
  private strafeTimer = 0;

  constructor(readonly p: Player, role: BotRole, private game: Game) {
    this.role = role;
    this.skill = 0.55 + Math.random() * 0.35;
  }

  update(dt: number) {
    const p = this.p, g = this.game, c = p.controls;
    if (!p.alive) return;
    if (p.vehicle) { g.exitVehicle(p); }

    this.scanTimer -= dt;
    if (this.scanTimer <= 0) { this.scanTimer = 0.3; this.target = this.pickTarget(); }
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) { this.thinkTimer = 0.5; this.chooseGoal(); }

    // Builder: call down structures when near a goal.
    this.buildCooldown -= dt;
    if (this.role === 'builder' && this.buildCooldown <= 0) this.tryBuild();

    // --- Movement toward goal ---
    const to = new THREE.Vector3(this.goal.x - p.pos.x, 0, this.goal.z - p.pos.z);
    const dist = to.length();
    // Diving to an underwater goal (seabed base) vs. skimming over the sea.
    const diving = g.isSubmerged(this.goal.clone().setY(this.goal.y + 1)) && dist < 140;
    const desiredYaw = Math.atan2(-to.x, -to.z);
    // Steer by velocity, not heading: cancel sideways drift so fast runs actually hit the target.
    const hv = new THREE.Vector3(p.vel.x, 0, p.vel.z);
    const cruise = Math.max(hv.length(), p.armor.runSpeed);
    const want = dist > 0.1 ? to.clone().multiplyScalar(Math.min(cruise, dist * 2) / dist) : new THREE.Vector3();
    const steer = want.sub(hv);
    let moveYaw = steer.lengthSq() > 0.5 ? Math.atan2(-steer.x, -steer.z) : desiredYaw;
    const lining = this.goalIsFlag() && dist < 150;
    c.forward = dist > 3 ? 1 : 0;
    c.strafe = 0;

    // Look where we move unless fighting.
    let lookYaw = desiredYaw;
    let lookPitch = 0;
    c.fire = false;
    if (this.target && !lining) {
      const aim = this.aimAt(this.target);
      if (aim) {
        lookYaw = aim.yaw; lookPitch = aim.pitch;
        const err = Math.abs(angleDiff(c.yaw, aim.yaw)) + Math.abs(c.pitch - aim.pitch);
        c.fire = err < 0.08 / this.skill;
        // Combat strafing.
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) { this.strafeTimer = 0.6 + Math.random(); this.strafeDir = -this.strafeDir; }
      }
    }
    // Underwater goals (seabed bases): dive toward them once close, instead of bobbing at the surface.
    if (p.submerged || diving) {
      lookPitch = Math.atan2(this.goal.y + 1 - p.pos.y, Math.max(dist, 1));
      if (!this.target) c.fire = false;
    }
    // Smooth aim with skill-dependent turn rate.
    const turn = (4 + this.skill * 6) * dt;
    c.yaw += THREE.MathUtils.clamp(angleDiff(c.yaw, lookYaw), -turn, turn);
    c.pitch += THREE.MathUtils.clamp(lookPitch - c.pitch, -turn, turn);
    // Express movement relative to look direction.
    const rel = angleDiff(c.yaw, moveYaw);
    const f = c.forward;
    c.forward = f * Math.cos(rel);
    c.strafe = -f * Math.sin(rel) + (this.target && !lining ? this.strafeDir * 0.5 : 0);

    // Terrain reading: ski downhill, jet up slopes and over obstacles.
    const dirN = dist > 0.1 ? to.clone().divideScalar(dist) : new THREE.Vector3();
    const ahead = 25 + p.speed * 0.6;
    // Treat open water as a surface to skim over (jets cool fast there), unless we're diving to an underwater goal.
    const surfY = (x: number, z: number) => { const y = g.terrain.groundAt(x, z).y; return diving || g.biome.frozen ? y : Math.max(y, g.biome.seaLevel); };
    let hAhead = surfY(p.pos.x + dirN.x * ahead, p.pos.z + dirN.z * ahead);
    // Look further along our actual velocity at speed (0.5–2.5s out) so fast runs don't plough into ridges.
    const hvn = new THREE.Vector3(p.vel.x, 0, p.vel.z);
    const hs = hvn.length();
    let hTrack = -Infinity;
    if (hs > 1) for (const t of [0.5, 1, 1.5, 2.5]) hTrack = Math.max(hTrack, surfY(p.pos.x + p.vel.x * t, p.pos.z + p.vel.z * t));
    const hHere = surfY(p.pos.x, p.pos.z);
    const climb = hAhead - hHere;
    const agl = p.pos.y - hHere;
    const goalAbove = this.goal.y - p.pos.y;
    let wantJet = false;
    // Jet to climb slopes, to reach a higher goal, or (airborne) to clear the terrain ahead.
    // Never just climb into the sky: altitude above the ground ahead is capped.
    const clearance = p.pos.y - hAhead;
    if ((p.grounded && climb > 4) || goalAbove > 4) wantJet = true;
    if (!p.grounded && clearance < 10 + Math.min(30, dist * 0.05) && p.vel.y < 6) wantJet = true;
    if (p.pos.y - hTrack < 6 + hs * 0.08 && p.vel.y < 8) wantJet = true;
    if (clearance > 45 && goalAbove < 0) wantJet = false;
    if (p.grounded && climb < -1 && p.speed > 8) wantJet = false;
    if ((dist < 20 || lining) && goalAbove < 2 && clearance > 3) wantJet = false;
    // Energy/heat hysteresis.
    if (p.energy < 15 || p.heat > 88) this.jetLatch = true;
    if (this.jetLatch && p.energy > 55 && p.heat < 50) this.jetLatch = false;
    if (p.submerged && dist > 6) wantJet = true; // jet-swim toward underwater goals
    c.jet = wantJet && !this.jetLatch;
    // Pure vertical thrust when the ground is coming up fast, and stop adding speed past ~90 m/s.
    const terrainThreat = !p.grounded && p.pos.y - hTrack < 10 + hs * 0.1;
    if ((c.jet && terrainThreat) || (hs > 90 && !p.grounded)) { c.forward = 0; c.strafe = 0; }
    // Ski whenever on downslope or already fast.
    c.ski = !p.submerged && dist > 15 && (climb < 1 || p.speed > p.armor.runSpeed * 1.3);
    if (c.ski && p.grounded && Math.random() < 0.01) c.jumpPressed = true;

    // Stuck detection: jump & jet out.
    this.stuckTimer += dt;
    if (this.stuckTimer > 2) {
      if (p.pos.distanceTo(this.lastPos) < 3 && dist > 10) { c.jumpPressed = true; c.jet = true; this.jetLatch = false; }
      this.lastPos.copy(p.pos);
      this.stuckTimer = 0;
    }

    // Weapon choice.
    if (this.target) {
      const d = this.target.pos.distanceTo(p.pos);
      const want: WeaponId = d > 120 ? 'chaingun' : (this.target.pos.y < p.pos.y - 15 && p.loadout.weapons.includes('grenade')) ? 'grenade' : (d > 60 && p.loadout.weapons.includes('mortar')) ? 'mortar' : 'spinfusor';
      const idx = p.loadout.weapons.indexOf(want);
      if (idx >= 0 && idx !== p.slot) c.weapon = idx;
      if (p.roundsLeft(p.weaponId) <= 0 || (p.reloading > 0 && d < 40)) c.weapon = (p.slot + 1) % p.loadout.weapons.length;
    } else if (p.reloading <= 0) {
      c.reloadPressed = true; // top off between fights
    }
    // Repair.
    c.repair = false;
    if (p.loadout.pack === 'repair' && !this.target) {
      const s = this.damagedFriendly();
      if (s && s.pos.distanceTo(p.pos) < 14) { c.repair = true; c.forward = 0; c.strafe = 0; const d = s.center.sub(p.eye); c.yaw = Math.atan2(-d.x, -d.z); c.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)); }
    }
  }

  private goalIsFlag() {
    const g = this.game, p = this.p;
    const f = p.flag ? g.flags[p.team] : g.flags[1 - p.team];
    return (this.role === 'offense' || !!p.flag) && f.state !== 'carried' && this.goal.distanceTo(f.pos) < 3;
  }

  private damagedFriendly(): Structure | null {
    const g = this.game, p = this.p;
    let best: Structure | null = null, bd = Infinity;
    for (const s of g.structures) {
      if (!s.alive || s.team !== p.team || s.maxHp === Infinity || s.hp > s.maxHp * 0.7) continue;
      const d = s.pos.distanceTo(p.pos);
      if (d < bd && d < 300) { bd = d; best = s; }
    }
    return best;
  }

  private chooseGoal() {
    const g = this.game, p = this.p;
    const myFlag = g.flags[p.team], enemyFlag = g.flags[1 - p.team];
    const home = g.terrain.bases[p.team];
    // Crew request: hold a siege beacon.
    if (this.assist) {
      if (!this.assist.alive) this.assist = null;
      else { this.goal.copy(this.assist.pos); return; }
    }
    if (p.flag) { this.goal.copy(myFlag.home); return; }
    // Anyone near an own dropped flag goes to return it.
    if (myFlag.state === 'dropped' && myFlag.pos.distanceTo(p.pos) < 400) { this.goal.copy(myFlag.pos); return; }
    // Chase our flag carrier.
    if (myFlag.state === 'carried' && myFlag.carrier && (this.role !== 'offense' || myFlag.carrier.pos.distanceTo(p.pos) < 250)) {
      const cpos = myFlag.carrier.pos;
      this.goal.copy(cpos).addScaledVector(myFlag.carrier.vel, 1.0);
      return;
    }
    this.pickRoleGoal();
    // Inside the bunker with somewhere else to be? Route out through the door first.
    const base = g.terrain.bases[p.team];
    const inBunker = Math.hypot(p.pos.x - base.x, p.pos.z - base.z) < 16 && p.pos.y < base.y + 12;
    if (inBunker && Math.hypot(this.goal.x - base.x, this.goal.z - base.z) > 18) this.goal.copy(g.baseDoor(p.team));
  }

  private pickRoleGoal() {
    const g = this.game, p = this.p;
    const myFlag = g.flags[p.team], enemyFlag = g.flags[1 - p.team];
    const home = g.terrain.bases[p.team];
    switch (this.role) {
      case 'offense':
        if (enemyFlag.state === 'carried') this.goal.copy(enemyFlag.carrier!.pos); // escort
        else this.goal.copy(enemyFlag.pos);
        break;
      case 'defense': {
        const s = this.damagedFriendly();
        if (s && p.loadout.pack === 'repair') { this.goal.copy(s.pos); break; }
        if (this.target && this.target.pos.distanceTo(myFlag.home) < 200) { this.goal.copy(this.target.pos); break; }
        const a = (g.time * 0.1 + this.p.name.length) % (Math.PI * 2);
        this.goal.set(myFlag.home.x + Math.cos(a) * 25, myFlag.home.y, myFlag.home.z + Math.sin(a) * 25);
        break;
      }
      case 'builder': {
        const vent = this.nearestFreeVent();
        if (vent) this.goal.copy(vent);
        else this.goal.set(home.x, home.y, home.z);
        break;
      }
    }
  }

  private nearestFreeVent(): THREE.Vector3 | null {
    const g = this.game, p = this.p;
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const v of g.terrain.deposits) {
      if (v.amount <= 0) continue;
      if (g.structures.some(s => s.kind === 'extractor' && s.alive && Math.hypot(s.pos.x - v.x, s.pos.z - v.z) < 10)) continue;
      // Motherlodes are worth a longer trip.
      const d = (Math.hypot(v.x - p.pos.x, v.z - p.pos.z) + Math.hypot(v.x - g.terrain.bases[p.team].x, v.z - g.terrain.bases[p.team].z) * 0.7) / v.richness;
      if (d < bd) { bd = d; best = new THREE.Vector3(v.x, v.y, v.z); }
    }
    return best;
  }

  private tryBuild() {
    const g = this.game, p = this.p;
    if (p.loadout.pack !== 'constructor') return;
    this.buildCooldown = 4;
    const team = g.teams[p.team];
    const vent = this.nearestFreeVent();
    if (vent && vent.distanceTo(p.pos) < 14) {
      const def = CALLDOWNS.find(d => d.kind === 'extractor')!;
      if (team.materiel >= def.cost + 20 && g.build.callDown(p, def, vent) === '') {
        this.buildCooldown = 6;
        // Guard it with a turret if we can afford it.
        const tdef = CALLDOWNS.find(d => d.kind === 'turret')!;
        const tAt = vent.clone().add(new THREE.Vector3(8, 0, 6));
        tAt.y = g.terrain.heightAt(tAt.x, tAt.z);
        if (team.materiel >= tdef.cost + 80) g.build.callDown(p, tdef, tAt);
        return;
      }
    }
    // Occasionally invest in an uplink and sky platform once the economy is going.
    if (team.materiel > 450 && !g.structures.some(s => s.kind === 'uplink' && s.team === p.team && s.alive)) {
      const home = g.terrain.bases[p.team];
      const at = new THREE.Vector3(home.x + (p.team ? -1 : 1) * 70, 0, home.z + 40);
      at.y = g.terrain.heightAt(at.x, at.z);
      g.build.callDown(p, CALLDOWNS.find(d => d.kind === 'uplink')!, at);
    }
  }

  private pickTarget(): Player | null {
    const g = this.game, p = this.p;
    let best: Player | null = null, bd = 220;
    const eye = p.eye;
    for (const o of g.players) {
      if (!o.alive || o.team === p.team) continue;
      const d = o.pos.distanceTo(p.pos) - (o.flag ? 80 : 0);
      if (d > bd) continue;
      if (!g.lineOfSight(eye, o.center)) continue;
      bd = d; best = o;
    }
    return best;
  }

  /** Lead a target, compensating for inherited velocity and projectile drop. */
  private aimAt(t: Player): { yaw: number; pitch: number } | null {
    const p = this.p;
    const w = WEAPONS[p.weaponId];
    const eye = p.eye;
    const tp = t.vehicle ? t.vehicle.pos.clone() : t.center;
    // Splash weapons: aim at feet when the target is near the ground.
    if (w.radius > 0 && t.grounded) tp.y = t.pos.y + 0.2;
    const tv = t.vel;
    let time = tp.distanceTo(eye) / w.speed;
    const aim = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      aim.copy(tp).addScaledVector(tv, time).addScaledVector(p.vel, -w.inherit * time);
      aim.y += 0.5 * GRAVITY * w.gravity * time * time;
      time = aim.distanceTo(eye) / w.speed;
    }
    // Skill-based error.
    const err = (1 - this.skill) * 0.06 * aim.distanceTo(eye);
    aim.x += (Math.random() - 0.5) * err; aim.z += (Math.random() - 0.5) * err; aim.y += (Math.random() - 0.5) * err * 0.5;
    const d = aim.sub(eye);
    if (time > 4) return null;
    return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
  }
}

export function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
