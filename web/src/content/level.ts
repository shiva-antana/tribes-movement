// Levels are pure data. Agents (or players) add a level by dropping a JSON file into
// web/content/levels/, then running `npm run validate` and `npm run playtest -- <id>`.
import { BIOMES, Biome, BiomeId } from '../world/biomes';
import { SIZE } from '../world/terrain';

export interface LevelDef {
  id: string;                 // kebab-case, matches the file name
  name: string;
  author: string;
  description: string;
  biome: BiomeId;
  seed: number;
  teamSize?: number;          // players per tribe (bots fill), default 6
  captureLimit?: number;      // default 5
  startMateriel?: number;     // default 200
  tags?: string[];
  /** Expected pace, used by playtest gates. Siege/economy maps can declare slower flag play. */
  expect?: { flagGrabsPer5Min?: number };
  /** Tweaks on top of the biome preset. */
  overrides?: Partial<Pick<Biome, 'seaLevel' | 'frozen' | 'coldness' | 'windBase' | 'katabatic' | 'gust' | 'fogDensity' | 'basesUnderwater'>>;
  /** Fixed placements. Omit to let the generator place them. Coordinates in meters, map centered on 0. */
  bases?: [{ x: number; z: number }, { x: number; z: number }];
  deposits?: { x: number; z: number; amount?: number; richness?: number }[];
}

const NUM_RANGES: Record<string, [number, number]> = {
  seaLevel: [-50, 200], coldness: [0.1, 6], windBase: [0, 40], katabatic: [0, 60], gust: [0, 30], fogDensity: [0, 0.003],
};

/** Returns a list of human-readable problems; empty means valid. */
export function validateLevel(raw: unknown, fileId?: string): string[] {
  const e: string[] = [];
  if (!raw || typeof raw !== 'object') return ['level must be a JSON object'];
  const l = raw as Record<string, any>;
  const str = (k: string, max = 200) => { if (typeof l[k] !== 'string' || !l[k].trim()) e.push(`${k}: required string`); else if (l[k].length > max) e.push(`${k}: longer than ${max} chars`); };
  str('id', 48); str('name', 60); str('author', 60); str('description', 400);
  if (typeof l.id === 'string' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(l.id)) e.push('id: must be kebab-case');
  if (fileId && l.id !== fileId) e.push(`id "${l.id}" must match file name "${fileId}"`);
  if (!(l.biome in BIOMES)) e.push(`biome: one of ${Object.keys(BIOMES).join(', ')}`);
  if (!Number.isInteger(l.seed) || l.seed < 0) e.push('seed: non-negative integer');
  const int = (k: string, a: number, b: number) => { if (l[k] !== undefined && (!Number.isInteger(l[k]) || l[k] < a || l[k] > b)) e.push(`${k}: integer ${a}..${b}`); };
  int('teamSize', 1, 16); int('captureLimit', 1, 20); int('startMateriel', 0, 5000);
  if (l.tags !== undefined && (!Array.isArray(l.tags) || l.tags.some((t: unknown) => typeof t !== 'string') || l.tags.length > 8)) e.push('tags: up to 8 strings');
  if (l.expect !== undefined) {
    const f = l.expect?.flagGrabsPer5Min;
    if (typeof l.expect !== 'object' || (f !== undefined && (typeof f !== 'number' || f < 0 || f > 20))) e.push('expect.flagGrabsPer5Min: number 0..20');
  }
  if (l.overrides !== undefined) {
    if (typeof l.overrides !== 'object') e.push('overrides: object');
    else for (const [k, v] of Object.entries(l.overrides)) {
      if (k === 'frozen' || k === 'basesUnderwater') { if (typeof v !== 'boolean') e.push(`overrides.${k}: boolean`); continue; }
      const r = NUM_RANGES[k];
      if (!r) e.push(`overrides.${k}: unknown key`);
      else if (typeof v !== 'number' || v < r[0] || v > r[1]) e.push(`overrides.${k}: number ${r[0]}..${r[1]}`);
    }
  }
  const half = SIZE / 2 - 150;
  const pt = (p: any, where: string) => { if (!p || typeof p.x !== 'number' || typeof p.z !== 'number' || Math.abs(p.x) > half || Math.abs(p.z) > half) e.push(`${where}: {x,z} within ±${half}`); };
  if (l.bases !== undefined) {
    if (!Array.isArray(l.bases) || l.bases.length !== 2) e.push('bases: exactly two {x,z}');
    else { l.bases.forEach((b: any, i: number) => pt(b, `bases[${i}]`)); if (e.length === 0 && Math.hypot(l.bases[0].x - l.bases[1].x, l.bases[0].z - l.bases[1].z) < 800) e.push('bases: must be ≥800m apart'); }
  }
  if (l.deposits !== undefined) {
    if (!Array.isArray(l.deposits) || l.deposits.length > 40) e.push('deposits: array of up to 40');
    else l.deposits.forEach((d: any, i: number) => {
      pt(d, `deposits[${i}]`);
      if (d.richness !== undefined && (typeof d.richness !== 'number' || d.richness < 0.5 || d.richness > 5)) e.push(`deposits[${i}].richness: 0.5..5`);
      if (d.amount !== undefined && (typeof d.amount !== 'number' || d.amount < 50 || d.amount > 20000)) e.push(`deposits[${i}].amount: 50..20000`);
    });
  }
  return e;
}

export function levelBiome(l: LevelDef): Biome {
  return { ...BIOMES[l.biome], ...(l.overrides ?? {}) };
}
