// Runtime access to the CC0 texture library (content/cc0/textures.json → public/cc0/textures/<id>/).
// Browser-only: in Node (headless playtests) everything returns null and shaders keep their procedural look.
import * as THREE from 'three';
import manifest from '../../content/cc0/textures.json';

export type CC0Role = 'rock' | 'cliff' | 'snow' | 'grass' | 'sand' | 'redsoil' | 'redground' | 'dirt' | 'metal' | 'metal_paint' | 'metal_rust' | 'concrete';
export interface CC0Set { diff: THREE.Texture; nor: THREE.Texture; arm: THREE.Texture; }

const cache = new Map<string, CC0Set | null>();
/** Flips to 1 when every requested set has loaded; shaders read it to switch from procedural to textured. */
export const CC0_READY = { value: 0 };
let pending = 0, failed = false;
const browser = typeof document !== 'undefined';

export function cc0(role: CC0Role): CC0Set | null {
  if (!browser) return null;
  if (cache.has(role)) return cache.get(role)!;
  const entry = (manifest.textures as { id: string; role: string }[]).find(t => t.role === role);
  if (!entry) { cache.set(role, null); return null; }
  const loader = new THREE.TextureLoader();
  const load = (map: string, srgb: boolean) => {
    pending++;
    const t = loader.load(`/cc0/textures/${entry.id}/${map}.jpg`,
      () => { if (--pending === 0 && !failed) CC0_READY.value = 1; },
      undefined,
      () => { failed = true; CC0_READY.value = 0; console.info(`CC0 texture ${entry.id}/${map} missing: run \`npm run fetch-cc0\` (procedural fallback in use)`); });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const set = { diff: load('diff', true), nor: load('nor', false), arm: load('arm', false) };
  cache.set(role, set);
  return set;
}
