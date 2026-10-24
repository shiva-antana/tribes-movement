// Download the CC0 textures listed in content/cc0/textures.json into public/cc0/textures/<id>/
// (diff.jpg, nor.jpg [OpenGL normal], arm.jpg [AO/rough/metal]). Idempotent; skips files present.
// Usage: npm run fetch-cc0 [-- --res 2k]
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WEB, flags } from './lib';

const { flags: F } = flags(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(join(WEB, 'content', 'cc0', 'textures.json'), 'utf8')) as { resolution: string; textures: { id: string; source: string }[] };
const res = F.res ?? manifest.resolution;
const MAPS: Record<string, string> = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm' };
let fetched = 0, skipped = 0, failed = 0;
for (const t of manifest.textures) {
  if (t.source !== 'polyhaven') continue;
  const dir = join(WEB, 'public', 'cc0', 'textures', t.id);
  mkdirSync(dir, { recursive: true });
  if (Object.keys(MAPS).every(k => existsSync(join(dir, `${k}.jpg`)))) { skipped++; continue; }
  try {
    const files = await (await fetch(`https://api.polyhaven.com/files/${t.id}`)).json() as any;
    for (const [out, key] of Object.entries(MAPS)) {
      const entry = files[key]?.[res]?.jpg ?? files[key]?.[res]?.png;
      if (!entry) throw new Error(`no ${key} @ ${res}`);
      const buf = Buffer.from(await (await fetch(entry.url)).arrayBuffer());
      writeFileSync(join(dir, `${out}.jpg`), buf);
    }
    fetched++;
    console.log(`✓ ${t.id}`);
  } catch (e) { failed++; console.log(`✗ ${t.id}: ${(e as Error).message}`); }
}
console.log(`${fetched} fetched, ${skipped} already present, ${failed} failed → public/cc0/textures/`);
process.exit(failed ? 1 : 0);
