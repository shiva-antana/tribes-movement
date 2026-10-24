// Spring bones: verlet chains for hair clumps, coat tails and capes. The builder appends
// the chain bones to the skeleton at build time and skins geometry to them; this runtime
// swings them after the AnimationMixer has posed the body. Each chain particle is the
// tail of one bone: it keeps its momentum (minus drag), is pulled back toward the pose
// the bone would have if it kept its rest rotation (stiffness), falls (gravity), keeps
// its bone length, and is pushed out of capsule colliders on the body (head, chest,
// hips, thighs...). Bone rotations are then aimed at the particles.
import * as THREE from 'three';

export interface SpringChainDef {
  /** Chain bones root→tip; the first bone's parent is the animated anchor (head, hips). */
  bones: string[];
  /** Tail of the last bone, in its local space. */
  tip: [number, number, number];
  stiffness: number;   // pull toward the rest shape per 1/60 s step (0..1)
  drag: number;        // velocity lost per 1/60 s step (0..1)
  gravity: number;     // m/s², straight down
  radius: number;      // particle radius against colliders (m)
  colliders: string[]; // collider names this chain hits
}

/** A capsule collider in a bone's local space. */
export interface SpringColliderDef { name: string; bone: string; a: [number, number, number]; b: [number, number, number]; r: number; }

export interface SpringSet { chains: SpringChainDef[]; colliders: SpringColliderDef[]; }

const STEP = 1 / 60;
const _rd = new THREE.Vector3(), _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _dq = new THREE.Quaternion();

interface Particle { bone: THREE.Bone; rest: THREE.Quaternion; off: THREE.Vector3; len: number; p: THREE.Vector3; prev: THREE.Vector3; effR: Float32Array; }
interface Chain { def: SpringChainDef; parts: Particle[]; cols: number[]; }
interface Collider { bone: THREE.Bone; a: THREE.Vector3; b: THREE.Vector3; r: number; wa: THREE.Vector3; wb: THREE.Vector3; }

function closestOnSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3) {
  _d.subVectors(b, a);
  const l2 = _d.lengthSq();
  const t = l2 > 1e-12 ? THREE.MathUtils.clamp(_w.subVectors(p, a).dot(_d) / l2, 0, 1) : 0;
  return out.copy(a).addScaledVector(_d, t);
}

export class SpringRig {
  enabled = true;
  private chains: Chain[] = [];
  private colliders: Collider[] = [];
  private acc = 0;
  private anchor = new THREE.Vector3();
  private hasAnchor = false;

  constructor(private mesh: THREE.SkinnedMesh, set: SpringSet | undefined) {
    if (!set?.chains.length) return;
    const byName = new Map(mesh.skeleton.bones.map(b => [b.name, b]));
    const colIndex = new Map<string, number>();
    for (const c of set.colliders) {
      const bone = byName.get(c.bone);
      if (!bone) continue;
      colIndex.set(c.name, this.colliders.length);
      this.colliders.push({ bone, a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b), r: c.r, wa: new THREE.Vector3(), wb: new THREE.Vector3() });
    }
    // Rest-pose (bind) positions in mesh space, from the inverse bind matrices, so the
    // per-particle collider radii don't depend on whatever pose the mesh is in now.
    const restOf = (bone: THREE.Bone) => new THREE.Matrix4().copy(mesh.skeleton.boneInverses[mesh.skeleton.bones.indexOf(bone)]).invert();
    for (const def of set.chains) {
      const bones = def.bones.map(n => byName.get(n)).filter((b): b is THREE.Bone => !!b);
      if (bones.length !== def.bones.length) continue;
      const cols = def.colliders.map(n => colIndex.get(n)).filter((i): i is number => i !== undefined);
      const parts = bones.map((bone, j) => {
        const off = j + 1 < bones.length ? bones[j + 1].position.clone() : new THREE.Vector3(...def.tip);
        const restTail = off.clone().applyMatrix4(restOf(bone));
        // A particle that starts inside a collider (hair roots sit in the scalp) gets a
        // shrunken radius for that collider: it can't be pushed deeper, but isn't popped out.
        const effR = new Float32Array(cols.length);
        cols.forEach((ci, k) => {
          const c = this.colliders[ci], m = restOf(c.bone);
          const d = restTail.distanceTo(closestOnSegment(restTail, c.a.clone().applyMatrix4(m), c.b.clone().applyMatrix4(m), _c));
          effR[k] = Math.min(c.r + def.radius, d - 0.002);
        });
        return { bone, rest: bone.quaternion.clone(), off, len: off.length(), p: new THREE.Vector3(), prev: new THREE.Vector3(), effR };
      });
      this.chains.push({ def, parts, cols });
    }
  }

  get chainCount() { return this.chains.length; }

  /** Snap every particle to the animated pose (call after teleports or rebuilds). */
  reset() {
    this.mesh.updateWorldMatrix(true, true);
    for (const ch of this.chains) for (const pt of ch.parts) {
      pt.bone.quaternion.copy(pt.rest);
      pt.bone.updateMatrixWorld(true);
      pt.p.copy(pt.off).applyMatrix4(pt.bone.matrixWorld);
      pt.prev.copy(pt.p);
    }
    this.hasAnchor = false;
    this.acc = 0;
  }

  /**
   * Advance the chains. Call after the mixer has posed the skeleton. `frameVelocity` is the
   * world velocity of a frame the character is held still in (the workbench treadmill), so
   * air drag acts as if the character really moved.
   */
  update(dt: number, frameVelocity?: THREE.Vector3) {
    if (!this.chains.length) return;
    this.mesh.updateWorldMatrix(true, true);
    if (!this.enabled) { for (const ch of this.chains) for (const pt of ch.parts) pt.bone.quaternion.copy(pt.rest); return; }
    this.mesh.getWorldPosition(_v);
    if (!this.hasAnchor || _v.distanceTo(this.anchor) > 3) { this.reset(); this.mesh.getWorldPosition(this.anchor); this.hasAnchor = true; }
    this.anchor.copy(_v);
    this.acc = Math.min(this.acc + dt, STEP * 4);
    const steps = Math.floor(this.acc / STEP);
    this.acc -= steps * STEP;
    for (let s = 0; s < steps; s++) this.step(frameVelocity);
  }

  private step(frameVelocity?: THREE.Vector3) {
    for (const c of this.colliders) { c.wa.copy(c.a).applyMatrix4(c.bone.matrixWorld); c.wb.copy(c.b).applyMatrix4(c.bone.matrixWorld); }
    const scale = this.mesh.matrixWorld.getMaxScaleOnAxis();
    for (const ch of this.chains) {
      const d = ch.def;
      for (const pt of ch.parts) {
        const bone = pt.bone, parent = bone.parent!;
        const head = _v.setFromMatrixPosition(bone.matrixWorld);
        parent.getWorldQuaternion(_pq);
        _q.copy(_pq).multiply(pt.rest);                                   // world rotation at rest
        const restDir = _rd.copy(pt.off).applyQuaternion(_q).normalize();
        const len = pt.len * scale;
        // Verlet: inertia with drag, pull toward the rest tail, gravity, frame drag.
        _w.subVectors(pt.p, pt.prev).multiplyScalar(1 - d.drag);
        pt.prev.copy(pt.p);
        pt.p.add(_w);
        _c.copy(head).addScaledVector(restDir, len);
        pt.p.lerp(_c, d.stiffness);
        pt.p.y -= d.gravity * STEP * STEP;
        if (frameVelocity) pt.p.addScaledVector(frameVelocity, -STEP * d.drag);
        // Keep the bone length, then push out of colliders (and re-fix the length).
        for (let it = 0; it < 2; it++) {
          pt.p.sub(head).setLength(len).add(head);
          ch.cols.forEach((ci, k) => {
            const R = pt.effR[k] * scale;
            if (R <= 0) return;
            const col = this.colliders[ci];
            closestOnSegment(pt.p, col.wa, col.wb, _c);
            const dist = pt.p.distanceTo(_c);
            if (dist < R && dist > 1e-6) pt.p.sub(_c).multiplyScalar(R / dist).add(_c);
          });
        }
        // Aim the bone at its particle.
        _w.subVectors(pt.p, head).normalize();
        _dq.setFromUnitVectors(restDir, _w);
        bone.quaternion.copy(_pq.invert()).multiply(_dq).multiply(_q);
        bone.updateMatrixWorld(true);
      }
    }
  }
}

/** Linear-blend weights along a chain of `n` bones for a point at t ∈ [0,1] root→tip. Index -1 = the anchor bone. */
export function chainWeights(t: number, n: number): [number, number][] {
  const s = THREE.MathUtils.clamp(t, 0, 1) * n;
  const j = Math.min(n - 1, Math.floor(s)), f = s - j;
  const out: [number, number][] = f < 0.5 ? [[j - 1, 0.5 - f], [j, 0.5 + f]] : [[j, 1.5 - f], [Math.min(n - 1, j + 1), f - 0.5]];
  if (out[0][0] === out[1][0]) return [[out[0][0], 1]];
  return out.filter(([, w]) => w > 1e-4);
}
