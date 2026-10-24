// Skeleton definitions are data (content/skeletons/*.json). Everything downstream
// — motions, characters, texture atlases — is keyed by these bone names.
import * as THREE from 'three';

export interface BoneDef { name: string; parent: string | null; offset: [number, number, number]; }
/**
 * A tapered capsule attached to a bone (bone-local endpoints), used to sculpt the body.
 * Optional: `scale` squashes it into an ellipsoid-ish shape (rest-pose world axes),
 * `op: "subtract"` carves (eye sockets, philtrum), `k` overrides the blend radius for crisp
 * features (nose bridge, brow ridge, jawline), `name` documents what it is.
 */
export interface VolumeDef {
  bone: string; a: [number, number, number]; b: [number, number, number]; r0: number; r1: number;
  scale?: [number, number, number]; op?: 'add' | 'subtract'; k?: number; name?: string;
}
export interface SkeletonDef { id: string; description?: string; bones: BoneDef[]; volumes: VolumeDef[]; }

export interface BuiltSkeleton {
  def: SkeletonDef;
  bones: THREE.Bone[];
  byName: Map<string, THREE.Bone>;
  root: THREE.Bone;
  skeleton: THREE.Skeleton;
  /** Rest-pose world positions of each bone (T-pose). */
  restWorld: Map<string, THREE.Vector3>;
}

export function buildSkeleton(def: SkeletonDef): BuiltSkeleton {
  const byName = new Map<string, THREE.Bone>();
  const bones: THREE.Bone[] = [];
  let root: THREE.Bone | null = null;
  for (const b of def.bones) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.set(...b.offset);
    byName.set(b.name, bone);
    bones.push(bone);
    if (b.parent) {
      const p = byName.get(b.parent);
      if (!p) throw new Error(`bone ${b.name}: parent ${b.parent} must be defined before it`);
      p.add(bone);
    } else root = bone;
  }
  if (!root) throw new Error('skeleton has no root');
  root.updateMatrixWorld(true);
  const restWorld = new Map<string, THREE.Vector3>();
  for (const b of bones) restWorld.set(b.name, b.getWorldPosition(new THREE.Vector3()));
  return { def, bones, byName, root, skeleton: new THREE.Skeleton(bones), restWorld };
}

/** First child of a bone (its "tail"), if any. */
export function childOf(def: SkeletonDef, name: string): string | null {
  return def.bones.find(b => b.parent === name)?.name ?? null;
}

export function validateSkeleton(raw: unknown): string[] {
  const e: string[] = [];
  const s = raw as SkeletonDef;
  if (!s || !Array.isArray(s.bones) || !s.bones.length) return ['bones: non-empty array required'];
  const seen = new Set<string>();
  s.bones.forEach((b, i) => {
    if (!b.name || seen.has(b.name)) e.push(`bones[${i}]: missing or duplicate name`);
    if (b.parent !== null && !seen.has(b.parent)) e.push(`bones[${i}] ${b.name}: parent "${b.parent}" must appear earlier`);
    if (!Array.isArray(b.offset) || b.offset.length !== 3) e.push(`bones[${i}] ${b.name}: offset [x,y,z]`);
    seen.add(b.name);
  });
  (s.volumes ?? []).forEach((v, i) => { if (!seen.has(v.bone)) e.push(`volumes[${i}]: unknown bone ${v.bone}`); });
  return e;
}
