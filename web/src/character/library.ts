// In-game character instances: one built mesh per armor (shared geometry), team-tinted
// baked materials, and an AnimationMixer per player driven by movement state.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SKELETONS, MOTIONS, CHARACTERS, MATERIALS } from '../content/assets';
import { buildCharacter, atlasRegions, BuildResult, CharacterDef } from './builder';
import { buildSkeleton, SkeletonDef } from '../anim/skeleton';
import { bakeMaterial, Baked, BakeOptions, MaterialDef } from '../paint/painter';
import type { WorkerJob } from './worker';
import { characterMaterials, addOutline } from './runtime';
import { toClip } from '../anim/motion';
import { SpringRig } from './springs';
import { extractFace, FaceRig, FaceDef, applyFace, cloneFaceMaterial } from './face';

export type AnimState = 'idle' | 'run' | 'ski' | 'jet' | 'fall';

export class CharacterInstance {
  readonly mixer: THREE.AnimationMixer;
  /** Hair/coat-tail spring chains (swing from the character's real world motion). */
  readonly springs: SpringRig;
  /** Expressions + auto-blink (null for characters without a painted face). */
  readonly face: FaceRig | null;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: AnimState | null = null;
  constructor(readonly mesh: THREE.SkinnedMesh, clips: THREE.AnimationClip[], readonly runSpeed: number, springs?: BuildResult['springs'], face: FaceRig | null = null) {
    this.mixer = new THREE.AnimationMixer(mesh);
    this.springs = new SpringRig(mesh, springs);
    this.face = face;
    for (const c of clips) this.actions.set(c.name, this.mixer.clipAction(c));
  }
  /** Cross-fade to a state; `rate` scales playback (e.g. run cadence follows ground speed). */
  set(state: AnimState, rate = 1) {
    const a = this.actions.get(state) ?? this.actions.get('idle');
    if (!a) return;
    a.timeScale = rate;
    if (state === this.current) return;
    const prev = this.current ? this.actions.get(this.current) : null;
    a.reset().play();
    if (prev) a.crossFadeFrom(prev, 0.18, false);
    this.current = state;
  }
  /** Expression weight by VRM preset name (happy, angry, sad, surprised, relaxed, aa, ih, ou, ee, oh, blink…). */
  setExpression(name: string, weight: number) { this.face?.set(name, weight); }
  update(dt: number) {
    this.mixer.update(dt);
    this.springs.update(dt);
    this.face?.update(dt);
  }
}

// ---------------------------------------------------------------- async library (worker-built, cached)

interface Built { mesh: THREE.SkinnedMesh; springs: BuildResult['springs']; clips: THREE.AnimationClip[] }

/** Shared across matches: a second match reuses meshes and textures instantly. */
const CACHE = { built: new Map<string, Built>(), mats: new Map<string, THREE.Material[]>(), faces: new Map<string, FaceDef | null>(), pending: new Map<string, Promise<void>>() };

/** Small pool of module workers for meshing/baking (falls back to the main thread if workers are unavailable). */
class WorkerPool {
  private workers: Worker[] = [];
  private next = 0;
  private waiting = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  constructor(n: number) {
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        w.onmessage = e => { const m = e.data, p = this.waiting.get(m.key); if (!p) return; this.waiting.delete(m.key); m.type === 'error' ? p.reject(new Error(m.error)) : p.resolve(m); };
        this.workers.push(w);
      }
    } catch { this.workers = []; }
  }
  get available() { return this.workers.length > 0; }
  run<T>(job: WorkerJob): Promise<T> {
    return new Promise((resolve, reject) => {
      this.waiting.set(job.key, { resolve, reject });
      this.workers[this.next++ % this.workers.length].postMessage(job);
    });
  }
}
let POOL: WorkerPool | null = null;
const pool = () => (POOL ??= new WorkerPool(Math.max(1, Math.min(3, (navigator.hardwareConcurrency ?? 4) - 1))));

export class CharacterLibrary {
  /** Game LOD: coarser voxels than the workbench default keep 12+ characters cheap. */
  constructor(private voxel = 0.021, private textureSize = 512) {}

  private gameDef(id: string): CharacterDef {
    // Soldiers at coarse voxels; sculpted heroes a bit finer so faces keep their features.
    const src = CHARACTERS[id];
    return { ...src, voxel: src.style === 'toon' ? (src.voxel ?? 0.012) * 1.4 : Math.max(src.voxel ?? 0, this.voxel) };
  }

  ready(id: string, team: number) { return CACHE.built.has(id) && CACHE.mats.has(`${id}:${team}`); }

  /** Start (or join) background preparation of a character for a team. */
  ensure(id: string, team: number): Promise<void> {
    const key = `${id}:${team}`;
    if (this.ready(id, team)) return Promise.resolve();
    let p = CACHE.pending.get(key);
    if (p) return p;
    p = Promise.all([this.ensureMesh(id), this.ensureMaterials(id, team)]).then(() => undefined);
    CACHE.pending.set(key, p);
    p.catch(err => { console.error(`character ${key} failed`, err); CACHE.pending.delete(key); });
    return p;
  }

  private meshPending = new Map<string, Promise<void>>();
  private ensureMesh(id: string): Promise<void> {
    if (CACHE.built.has(id)) return Promise.resolve();
    const existing = this.meshPending.get(id);
    if (existing) return existing;
    const def = this.gameDef(id), sk = SKELETONS[def.skeleton];
    const finish = (attrs: Record<string, { array: ArrayLike<number>; itemSize: number }>, groups: { start: number; count: number; materialIndex?: number }[], bones: SkeletonDef['bones'], springs: BuildResult['springs']) => {
      const g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(attrs)) g.setAttribute(name, new THREE.BufferAttribute(a.array as any, a.itemSize));
      for (const gr of groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
      const built = buildSkeleton({ ...sk, bones });
      const mesh = new THREE.SkinnedMesh(g, []);
      mesh.add(built.root);
      mesh.bind(built.skeleton);
      mesh.frustumCulled = false;
      if (def.style === 'toon') addOutline(mesh, def.outline ?? 0.006);
      const clips = Object.values(MOTIONS).filter(m => m.skeleton === def.skeleton).map(m => toClip(m, built));
      CACHE.built.set(id, { mesh, springs, clips });
    };
    let p: Promise<void>;
    if (pool().available) {
      p = pool().run<any>({ type: 'build', key: `build:${id}:${Math.random()}`, def, skeleton: sk }).then(m => finish(m.attrs, m.groups, m.bones, m.springs));
    } else {
      p = Promise.resolve().then(() => { const r = buildCharacter(def, sk, {}); const a: Record<string, any> = {}; for (const [n, at] of Object.entries(r.mesh.geometry.attributes)) a[n] = { array: (at as any).array, itemSize: (at as any).itemSize }; finish(a, r.mesh.geometry.groups, r.skeleton.def.bones, r.springs); });
    }
    this.meshPending.set(id, p);
    return p;
  }

  private ensureMaterials(id: string, team: number): Promise<void> {
    const key = `${id}:${team}`;
    if (CACHE.mats.has(key)) return Promise.resolve();
    const def = CHARACTERS[id];
    const regions = atlasRegions(SKELETONS[def.skeleton]);
    // Toon heroes draw their face in the shader (expressions), so it isn't baked.
    const split = def.style === 'toon' ? extractFace(MATERIALS[def.materials.body], regions) : { base: MATERIALS[def.materials.body], face: null };
    CACHE.faces.set(id, split.face);
    const bake = (m: MaterialDef, opts: BakeOptions): Promise<Baked> => pool().available
      ? pool().run<any>({ type: 'bake', key: `bake:${key}:${m.id}:${Math.random()}`, def: m, opts }).then(r => r.baked as Baked)
      : Promise.resolve().then(() => bakeMaterial(m, opts));
    return Promise.all([
      bake(split.base, { size: this.textureSize, teamColor: team, regions }),
      bake(MATERIALS[def.materials.armor], { size: this.textureSize, teamColor: team }),
      def.materials.hair ? bake(MATERIALS[def.materials.hair], { size: 256, teamColor: team }) : Promise.resolve(null),
    ]).then(([body, armor, hair]) => {
      const m = characterMaterials(def.style, { body, armor, hair }, team);
      if (split.face) applyFace(m[0], split.face, new Float32Array(16));
      CACHE.mats.set(key, m);
    });
  }

  /** A new animated instance, or null if this character/team isn't prepared yet (call ensure()). */
  create(id: string, teamColor: number): CharacterInstance | null {
    if (!this.ready(id, teamColor)) { void this.ensure(id, teamColor); return null; }
    const b = CACHE.built.get(id)!;
    const mesh = cloneSkinned(b.mesh) as THREE.SkinnedMesh;
    const mats = CACHE.mats.get(`${id}:${teamColor}`)!;
    // Each instance gets its own body material copy so its expression uniforms are its own.
    const face = CACHE.faces.get(id) ? new FaceRig() : null;
    mesh.material = face ? [cloneFaceMaterial(mats[0], face.params), ...mats.slice(1)] : mats;
    mesh.frustumCulled = false;
    const run = Object.values(MOTIONS).find(m => m.id === 'run')?.speed ?? 6.5;
    return new CharacterInstance(mesh, b.clips, run, b.springs, face);
  }
}
