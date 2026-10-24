// Validate every level in content/levels. Exit 1 on any problem.
// Usage: npm run validate
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLevel } from '../src/content/level';
import { validatePrefab } from '../src/content/prefabs';
import { STRUCTURE_HP } from '../src/config';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'levels');
let bad = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '');
  let errs: string[];
  try { errs = validateLevel(JSON.parse(readFileSync(join(dir, f), 'utf8')), id); }
  catch (e) { errs = [`invalid JSON: ${(e as Error).message}`]; }
  if (errs.length) { bad++; console.log(`✗ ${id}\n  - ${errs.join('\n  - ')}`); }
  else console.log(`✓ ${id}`);
}
// Prefabs: schema + known structure kinds.
const pdir = join(dir, '..', 'prefabs');
for (const f of readdirSync(pdir).filter(f => f.endsWith('.json')).sort()) {
  const raw = JSON.parse(readFileSync(join(pdir, f), 'utf8'));
  const errs = [...validatePrefab(raw), ...(raw.pieces ?? []).filter((q: any) => !(q.kind in STRUCTURE_HP)).map((q: any) => `unknown kind ${q.kind}`)];
  if (errs.length) { bad++; console.log(`✗ prefab ${f}\n  - ${errs.join('\n  - ')}`); } else console.log(`✓ prefab ${raw.id}`);
}
process.exit(bad ? 1 : 0);
