// Prefabs: saved fortification layouts, dropped as one unit from the build menu.
// Content prefabs live in content/prefabs/*.json; players' own saved layouts live in localStorage.
import type { StructureKind } from '../config';

export interface PrefabPiece {
  kind: StructureKind;
  at: [number, number, number]; // local meters: x right, z forward (-z = toward where you face), y above ground
  yaw: number;                  // degrees, relative to the prefab
  tilt?: number;                // degrees (walls: 45 ramp, 90 floor)
}
export interface PrefabDef { id: string; name: string; description?: string; pieces: PrefabPiece[]; user?: boolean; }

let files: Record<string, unknown> = {};
try { files = import.meta.glob('../../content/prefabs/*.json', { eager: true, import: 'default' }) as Record<string, unknown>; } catch { /* not under Vite */ }
export const CONTENT_PREFABS: PrefabDef[] = Object.values(files).map(f => f as PrefabDef).sort((a, b) => a.name.localeCompare(b.name));

const KEY = 'vastlands.prefabs';
export function loadUserPrefabs(): PrefabDef[] {
  try { return (JSON.parse(localStorage.getItem(KEY) ?? '[]') as PrefabDef[]).map(p => ({ ...p, user: true })); } catch { return []; }
}
export function saveUserPrefab(p: PrefabDef) {
  try {
    const all = loadUserPrefabs().filter(q => q.id !== p.id);
    all.push({ ...p, user: true });
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* storage unavailable: kept for this session only */ }
}

export function validatePrefab(raw: unknown): string[] {
  const p = raw as PrefabDef, e: string[] = [];
  if (!p?.id || !p.name) e.push('id and name required');
  if (!Array.isArray(p?.pieces) || !p.pieces.length || p.pieces.length > 40) e.push('pieces: 1..40');
  p?.pieces?.forEach((q, i) => { if (!q.kind || !Array.isArray(q.at) || q.at.length !== 3) e.push(`pieces[${i}]: kind + at[x,y,z]`); });
  return e;
}
