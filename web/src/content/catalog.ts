// Browser-side level catalog: every JSON in web/content/levels is bundled automatically.
import type { LevelDef } from './level';
import { validateLevel } from './level';

let files: Record<string, unknown> = {};
try { files = import.meta.glob('../../content/levels/*.json', { eager: true, import: 'default' }) as Record<string, unknown>; } catch { /* not under Vite */ }

export const LEVELS: LevelDef[] = Object.entries(files)
  .map(([path, raw]) => {
    const id = path.split('/').pop()!.replace(/\.json$/, '');
    const errs = validateLevel(raw, id);
    if (errs.length) { console.warn(`Skipping invalid level ${id}:`, errs); return null; }
    return raw as LevelDef;
  })
  .filter((l): l is LevelDef => !!l)
  .sort((a, b) => a.name.localeCompare(b.name));
