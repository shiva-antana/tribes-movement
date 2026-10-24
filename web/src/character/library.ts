// In-game character instances: one built mesh per armor (shared geometry), team-tinted
// baked materials, and an AnimationMixer per player driven by movement state.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { SKELETONS, MOTIONS, CHARACTERS, MATERIALS } from '../content/assets';
import { buildCharacter, atlasRegions, BuildResult } from './builder';
import { bakeMaterial } from '../paint/painter';
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

export class CharacterLibrary {
  private built = new Map<string, { res: BuildResult; clips: THREE.AnimationClip[] }>();
  private mats = new Map<string, THREE.Material[]>();
  private faces = new Map<string, FaceDef | null>();
  /** Game LOD: coarser voxels than the workbench default keep 12+ characters cheap. */
  constructor(private voxel = 0.021, private textureSize = 512) {}

  private base(id: string) {
    let b = this.built.get(id);
    if (!b) {
      // Game LOD: soldiers at coarse voxels; sculpted heroes a bit finer so faces keep their features.
      const src = CHARACTERS[id];
      const def = { ...src, voxel: src.style === 'toon' ? (src.voxel ?? 0.012) * 1.4 : Math.max(src.voxel ?? 0, this.voxel) };
      const sk = SKELETONS[def.skeleton];
      const res = buildCharacter(def, sk, {});
      const clips = Object.values(MOTIONS).filter(m => m.skeleton === def.skeleton).map(m => toClip(m, res.skeleton));
      b = { res, clips };
      this.built.set(id, b);
    }
    return b;
  }

  private materials(id: string, team: number) {
    const key = `${id}:${team}`;
    let m = this.mats.get(key);
    if (!m) {
      const def = CHARACTERS[id];
      const regions = atlasRegions(SKELETONS[def.skeleton]);
      // Toon heroes draw their face in the shader (expressions), so it isn't baked.
      const split = def.style === 'toon' ? extractFace(MATERIALS[def.materials.body], regions) : { base: MATERIALS[def.materials.body], face: null };
      this.faces.set(id, split.face);
      const body = bakeMaterial(split.base, { size: this.textureSize, teamColor: team, regions });
      const armor = bakeMaterial(MATERIALS[def.materials.armor], { size: this.textureSize, teamColor: team });
      const hair = def.materials.hair ? bakeMaterial(MATERIALS[def.materials.hair], { size: 256, teamColor: team }) : null;
      m = characterMaterials(def.style, { body, armor, hair }, team);
      if (split.face) applyFace(m[0], split.face, new Float32Array(16));
      this.mats.set(key, m);
    }
    return m;
  }

  create(id: string, teamColor: number): CharacterInstance {
    const b = this.base(id);
    if (CHARACTERS[id].style === 'toon' && !b.res.mesh.getObjectByName('outline')) addOutline(b.res.mesh, CHARACTERS[id].outline ?? 0.006);
    const mesh = cloneSkinned(b.res.mesh) as THREE.SkinnedMesh;
    const mats = this.materials(id, teamColor);
    // Each instance gets its own body material copy so its expression uniforms are its own.
    const face = this.faces.get(id) ? new FaceRig() : null;
    mesh.material = face ? [cloneFaceMaterial(mats[0], face.params), ...mats.slice(1)] : mats;
    mesh.frustumCulled = false;
    const run = Object.values(MOTIONS).find(m => m.id === 'run')?.speed ?? 6.5;
    return new CharacterInstance(mesh, b.clips, run, b.res.springs, face);
  }
}
