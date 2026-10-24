// Validate every level in content/levels. Exit 1 on any problem.
// Usage: npm run validate
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLevel } from '../src/content/level';

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
process.exit(bad ? 1 : 0);
