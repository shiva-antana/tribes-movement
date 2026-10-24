// Browser-side registry of asset content (skeletons, motions, characters, materials).
import type { SkeletonDef } from '../anim/skeleton';
import type { MotionDef } from '../anim/motion';
import type { CharacterDef } from '../character/builder';
import type { MaterialDef } from '../paint/painter';

// import.meta.glob is a Vite build-time feature; under plain Node (headless playtests) the
// registry is simply empty — Node scripts read content/ from disk instead (scripts/lib.ts).
const byId = <T extends { id: string }>(load: () => Record<string, unknown>) => {
  let files: Record<string, unknown> = {};
  try { files = load(); } catch { /* not running under Vite */ }
  return Object.fromEntries(Object.values(files).map(f => [(f as T).id, f as T])) as Record<string, T>;
};

export const SKELETONS = byId<SkeletonDef>(() => import.meta.glob('../../content/skeletons/*.json', { eager: true, import: 'default' }));
export const MOTIONS = byId<MotionDef>(() => import.meta.glob('../../content/motions/*.json', { eager: true, import: 'default' }));
export const CHARACTERS = byId<CharacterDef>(() => import.meta.glob('../../content/characters/*.json', { eager: true, import: 'default' }));
export const MATERIALS = byId<MaterialDef>(() => import.meta.glob('../../content/materials/*.json', { eager: true, import: 'default' }));
