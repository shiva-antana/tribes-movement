import * as THREE from 'three';
import { GRAVITY, TEAM_COLORS } from '../config';
import { makeGlowMaterial, makeLitMaterial } from './materials';
import type { Game } from './game';
import type { Player } from './player';

export const CAPTURE_LIMIT = 5;

export class Flag {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  state: 'home' | 'carried' | 'dropped' = 'home';
  carrier: Player | null = null;
  dropTimer = 0;
  readonly mesh = new THREE.Group();
  private cloth: THREE.Mesh;
  private beacon: THREE.Mesh;

  constructor(readonly team: number, readonly home: THREE.Vector3) {
    this.pos.copy(home);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.2, 6), makeLitMaterial(0xd0d4da));
    pole.position.y = 1.6;
    this.cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1, 8, 4), makeGlowMaterial(TEAM_COLORS[team], 0.95));
    (this.cloth.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
    this.cloth.position.set(0.8, 2.6, 0);
    // Tall faint light pillar so flags are findable across vast maps.
    this.beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 300, 8, 1, true), makeGlowMaterial(TEAM_COLORS[team], 0.08));
    this.beacon.position.y = 150;
    this.mesh.add(pole, this.cloth, this.beacon);
  }

  pickUp(p: Player) {
    this.state = 'carried';
    this.carrier = p;
    p.flag = this;
  }

  drop(vel: THREE.Vector3) {
    if (this.carrier) this.carrier.flag = null;
    this.carrier = null;
    this.state = 'dropped';
    this.dropTimer = 30;
    this.vel.copy(vel).multiplyScalar(0.8);
    this.vel.y += 6;
  }

  returnHome() {
    if (this.carrier) this.carrier.flag = null;
    this.carrier = null;
    this.state = 'home';
    this.pos.copy(this.home);
    this.vel.set(0, 0, 0);
  }

  update(dt: number, game: Game) {
    if (this.state === 'carried' && this.carrier) {
      this.pos.copy(this.carrier.pos).add(new THREE.Vector3(0, 0.6, 0));
      if (this.carrier.vehicle) this.pos.copy(this.carrier.vehicle.pos).add(new THREE.Vector3(0, 2, 0));
    } else if (this.state === 'dropped') {
      this.dropTimer -= dt;
      if (this.dropTimer <= 0) {
        this.returnHome();
        game.message(`${game.teamName(this.team)} flag returned to base`, '#cfd8e0');
      }
      this.vel.y -= GRAVITY * dt;
      if (game.isSubmerged(this.pos)) this.vel.multiplyScalar(Math.exp(-2 * dt));
      this.pos.addScaledVector(this.vel, dt);
      const gy = Math.max(game.terrain.groundAt(this.pos.x, this.pos.z).y, game.colliders.surfaceBelow(this.pos.x, this.pos.y, this.pos.z));
      if (this.pos.y < gy) { this.pos.y = gy; this.vel.multiplyScalar(0.3); this.vel.y = 0; }
    }
    this.mesh.position.copy(this.pos);
    this.beacon.visible = this.state !== 'carried';
    // Cloth flutter driven by the local wind.
    const w = game.env.windAt(this.pos.x, this.pos.y, this.pos.z, new THREE.Vector3());
    this.mesh.rotation.y = Math.atan2(-w.z, w.x);
    const t = game.time;
    const pos = this.cloth.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + 0.8;
      pos.setZ(i, Math.sin(t * 8 + x * 4) * 0.12 * x * Math.min(1, w.length() / 10 + 0.3));
    }
    pos.needsUpdate = true;
  }
}

export function checkFlagTouches(game: Game) {
  for (const p of game.players) {
    if (!p.alive || p.vehicle) continue;
    for (const f of game.flags) {
      if (f.state === 'carried') continue;
      // Swept test so fast flag runs (100+ m/s) can't tunnel past the flag between ticks.
      const fp = f.pos.clone().add(new THREE.Vector3(0, 1.4 - p.armor.height * 0.55, 0));
      const d = distToSegment(fp, p.prevPos, p.pos);
      if (d > 2.6 + p.armor.radius) continue;
      if (f.team !== p.team) {
        f.pickUp(p);
        game.stats.grabs++;
        game.message(`${p.name} took the ${game.teamName(f.team)} flag!`, p.team === game.human.team ? '#9fe8ff' : '#ff8a6a');
        game.audio.alert(p.team === game.human.team);
      } else if (f.state === 'dropped') {
        f.returnHome();
        game.message(`${p.name} returned the ${game.teamName(f.team)} flag`, '#cfd8e0');
      } else if (f.state === 'home' && p.flag) {
        const enemy = p.flag;
        enemy.returnHome();
        p.caps++;
        game.stats.caps++;
        game.teams[p.team].score++;
        game.teams[p.team].materiel += 100;
        game.message(`${p.name} captured the ${game.teamName(enemy.team)} flag! (+100 materiel)`, p.team === game.human.team ? '#7dffb2' : '#ff6a6a');
        game.audio.alert(p.team === game.human.team, true);
        game.onCapture(p.team);
      }
    }
  }
}

function distToSegment(q: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a);
  const l2 = ab.lengthSq();
  const t = l2 > 1e-8 ? THREE.MathUtils.clamp(q.clone().sub(a).dot(ab) / l2, 0, 1) : 0;
  return a.clone().addScaledVector(ab, t).distanceTo(q);
}
