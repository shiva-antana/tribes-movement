// Shared helpers for asset scripts (Node only).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTENT = join(WEB, 'content');
export const GENERATED = join(WEB, 'public', 'generated');

export function readContent<T>(kind: string, id: string): T {
  const p = join(CONTENT, kind, `${id}.json`);
  if (!existsSync(p)) throw new Error(`no ${kind}/${id}.json`);
  return JSON.parse(readFileSync(p, 'utf8')) as T;
}
export function listContent(kind: string): string[] {
  const d = join(CONTENT, kind);
  return existsSync(d) ? readdirSync(d).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort() : [];
}
export function writeContent(kind: string, id: string, data: unknown) {
  mkdirSync(join(CONTENT, kind), { recursive: true });
  writeFileSync(join(CONTENT, kind, `${id}.json`), compactJson(data) + '\n');
}
export function writeGenerated(rel: string, data: Buffer | string) {
  const p = join(GENERATED, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  return p;
}

/** JSON with keyframe arrays kept on one line, so motions stay readable and diffable. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data, null, 2).replace(/\[\s+(-?[\d.e-]+),\s+(-?[\d.e-]+),\s+(-?[\d.e-]+),\s+(-?[\d.e-]+)\s+\]/g, '[$1, $2, $3, $4]')
    .replace(/\[\s+(-?[\d.e-]+),\s+(-?[\d.e-]+),\s+(-?[\d.e-]+)\s+\]/g, '[$1, $2, $3]')
    .replace(/\[\s+(-?[\d.e-]+),\s+(-?[\d.e-]+)\s+\]/g, '[$1, $2]');
}

export function flags(args: string[]) {
  const out: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { const k = args[i].slice(2); const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true'; out[k] = v; }
    else pos.push(args[i]);
  }
  return { flags: out, pos };
}

// ---- minimal PNG encoder (RGBA8) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf: Buffer) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
