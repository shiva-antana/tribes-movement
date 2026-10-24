import * as THREE from 'three';

/** Oriented box collider (any rotation). Structures are assembled from these. */
export class OBB {
  readonly center = new THREE.Vector3();
  readonly half = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  private inv = new THREE.Quaternion();
  yaw = 0;
  owner: unknown = null;
  enabled = true;

  constructor(center: THREE.Vector3, half: THREE.Vector3, rot: number | THREE.Quaternion = 0, owner: unknown = null) {
    this.center.copy(center); this.half.copy(half); this.owner = owner;
    if (typeof rot === 'number') this.setYaw(rot); else this.setQuat(rot);
  }
  setYaw(y: number) { this.yaw = y; return this.setQuat(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), y)); }
  setQuat(q: THREE.Quaternion) { this.quat.copy(q); this.inv.copy(q).invert(); return this; }

  toLocal(p: THREE.Vector3, out: THREE.Vector3) { return out.subVectors(p, this.center).applyQuaternion(this.inv); }
  dirToLocal(d: THREE.Vector3, out: THREE.Vector3) { return out.copy(d).applyQuaternion(this.inv); }
  dirToWorld(d: THREE.Vector3, out: THREE.Vector3) { return out.copy(d).applyQuaternion(this.quat); }
}

const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

export class ColliderWorld {
  readonly boxes: OBB[] = [];

  add(b: OBB) { this.boxes.push(b); return b; }
  remove(owner: unknown) {
    for (let i = this.boxes.length - 1; i >= 0; i--) if (this.boxes[i].owner === owner) this.boxes.splice(i, 1);
  }

  /**
   * Push a sphere out of all boxes. Mutates `p`. Returns the most upward-facing
   * contact normal (for ground detection) or null.
   */
  resolveSphere(p: THREE.Vector3, r: number, outNormal: THREE.Vector3): boolean {
    let hit = false;
    let bestUp = -2;
    for (const b of this.boxes) {
      if (!b.enabled) continue;
      // Cheap bounding-sphere reject (valid for any rotation).
      const br = b.half.length() + r;
      const dx = p.x - b.center.x, dy = p.y - b.center.y, dz = p.z - b.center.z;
      if (dx * dx + dy * dy + dz * dz > br * br) continue;
      const l = b.toLocal(p, tmpA);
      const q = tmpB.set(
        THREE.MathUtils.clamp(l.x, -b.half.x, b.half.x),
        THREE.MathUtils.clamp(l.y, -b.half.y, b.half.y),
        THREE.MathUtils.clamp(l.z, -b.half.z, b.half.z),
      );
      const d = tmpC.subVectors(l, q);
      const dist = d.length();
      if (dist >= r) continue;
      let nLocal: THREE.Vector3;
      let push: number;
      if (dist > 1e-5) {
        nLocal = d.divideScalar(dist);
        push = r - dist;
      } else {
        // Center is inside the box: push out along the axis of least penetration.
        const px = b.half.x - Math.abs(l.x), py = b.half.y - Math.abs(l.y), pz = b.half.z - Math.abs(l.z);
        if (py <= px && py <= pz) { nLocal = d.set(0, Math.sign(l.y) || 1, 0); push = py + r; }
        else if (px <= pz) { nLocal = d.set(Math.sign(l.x) || 1, 0, 0); push = px + r; }
        else { nLocal = d.set(0, 0, Math.sign(l.z) || 1); push = pz + r; }
      }
      const nWorld = b.dirToWorld(nLocal, tmpA);
      p.addScaledVector(nWorld, push);
      hit = true;
      if (nWorld.y > bestUp) { bestUp = nWorld.y; outNormal.copy(nWorld); }
    }
    return hit;
  }

  /** Segment test against boxes (slab method). Returns t in [0,len] or -1. */
  raycast(o: THREE.Vector3, dir: THREE.Vector3, len: number, out?: { box: OBB | null; normal: THREE.Vector3 }, ignore?: unknown): number {
    let best = -1;
    const lo = new THREE.Vector3(), ld = new THREE.Vector3();
    for (const b of this.boxes) {
      if (!b.enabled || (ignore && b.owner === ignore)) continue;
      b.toLocal(o, lo);
      b.dirToLocal(dir, ld);
      let tmin = 0, tmax = len, axis = -1, sign = 1;
      let ok = true;
      for (let a = 0; a < 3; a++) {
        const oa = a === 0 ? lo.x : a === 1 ? lo.y : lo.z;
        const da = a === 0 ? ld.x : a === 1 ? ld.y : ld.z;
        const h = a === 0 ? b.half.x : a === 1 ? b.half.y : b.half.z;
        if (Math.abs(da) < 1e-8) { if (oa < -h || oa > h) { ok = false; break; } continue; }
        let t1 = (-h - oa) / da, t2 = (h - oa) / da;
        let s = -1;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
        if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) { ok = false; break; }
      }
      if (!ok || axis < 0) continue;
      if (best < 0 || tmin < best) {
        best = tmin;
        if (out) {
          out.box = b;
          const n = new THREE.Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
          b.dirToWorld(n, out.normal);
        }
      }
    }
    return best;
  }

  /** Highest box top surface under (x,z) at or below y+1.5. Used by hover/ground vehicles and flags. */
  surfaceBelow(x: number, y: number, z: number): number {
    let best = -Infinity;
    const p = new THREE.Vector3(), l = new THREE.Vector3(), up = new THREE.Vector3();
    for (const b of this.boxes) {
      if (!b.enabled) continue;
      // Cast down from above the box onto its top face (handles ramps and tilted slabs).
      p.set(x, b.center.y + b.half.length() + 1, z);
      b.toLocal(p, l);
      b.dirToLocal(up.set(0, -1, 0), up);
      const t = slabEntry(l, up, b.half);
      if (t === null) continue;
      const top = p.y - t;
      if (top <= y + 1.5 && top > best) best = top;
    }
    return best;
  }
}

/** Ray (local origin o, local dir d) vs box half-extents: entry distance or null. */
function slabEntry(o: THREE.Vector3, d: THREE.Vector3, h: THREE.Vector3): number | null {
  let tmin = 0, tmax = Infinity;
  for (const [oa, da, ha] of [[o.x, d.x, h.x], [o.y, d.y, h.y], [o.z, d.z, h.z]]) {
    if (Math.abs(da) < 1e-9) { if (oa < -ha || oa > ha) return null; continue; }
    let t1 = (-ha - oa) / da, t2 = (ha - oa) / da;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
