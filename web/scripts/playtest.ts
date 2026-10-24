// Headless bot playtest: runs full matches with no renderer and checks quality gates.
// Agents run this after adding or changing a level, weapon, or AI behavior.
//
// Usage: npm run playtest -- [levelId|all] [--minutes 10] [--seeds 1,2] [--json]
// Results are pooled across seeds (bots are stochastic) before gates are checked.
// Exit code 1 if any gate fails.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLevel, LevelDef } from '../src/content/level';
import { mulberry32 } from '../src/noise';
import { Game, MatchStats } from '../src/game/game';

function mergeStats(a: MatchStats, b: MatchStats): MatchStats {
  const out = { ...a } as any;
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
    else { out[k] = { ...out[k] }; for (const [c, n] of Object.entries(v as Record<string, number>)) out[k][c] = (out[k][c] ?? 0) + n; }
  }
  return out;
}
import { Audio } from '../src/audio';
import type { Input } from '../src/input';

const args = process.argv.slice(2);
const flag = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const minutes = flag('minutes', 10);
const si = args.indexOf('--seeds');
const seeds = si >= 0 ? args[si + 1].split(',').map(Number) : [flag('seed', 1)];
const asJson = args.includes('--json');
const target = args.find(a => !a.startsWith('--') && isNaN(Number(a))) ?? 'all';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'levels');
const levels: LevelDef[] = readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .filter((l: LevelDef) => target === 'all' || l.id === target);
if (!levels.length) { console.error(`No level "${target}"`); process.exit(2); }

const nullInput = { down: () => false, hit: () => false, clicked: () => false, lock() {}, unlock() {}, endFrame() {}, mouseDX: 0, mouseDY: 0, wheel: 0, lmb: false, rmb: false, sensitivity: 0, locked: false } as unknown as Input;

interface Gate { name: string; ok: boolean; detail: string; }
const reports: unknown[] = [];
let failed = false;

for (const level of levels) {
  const errs = validateLevel(level, level.id);
  if (errs.length) { console.log(`✗ ${level.id}: invalid level\n  - ${errs.join('\n  - ')}`); failed = true; continue; }
  const t0 = performance.now();
  let error: string | null = null;
  const tickMs: number[] = [];
  let stuckSamples = 0, samples = 0, traveled = 0, simTime = 0;
  let st: MatchStats | null = null;
  const scores: number[][] = [];
  for (const seed of seeds) {
    Math.random = mulberry32(seed * 7919 + level.seed); // reproducible runs
    let g: Game | null = null;
    try {
      g = new Game({ biome: level.biome, seed: level.seed, teamSize: level.teamSize ?? 6, level }, null, nullInput, new Audio(), () => {}, { headless: true });
      const last = g.players.map(p => p.pos.clone());
      const frames = Math.round(minutes * 60 * 60);
      for (let i = 0; i < frames; i++) {
        const s = performance.now();
        g.frame(1 / 60);
        if (i % 60 === 0) tickMs.push(performance.now() - s);
        if (i % (60 * 10) === 0 && i > 0) {
          // A bot that moved <5m in 10s while away from its own flag is "stuck".
          g.players.forEach((p, k) => {
            if (!p.alive) { last[k].copy(p.pos); return; }
            const moved = p.pos.distanceTo(last[k]);
            traveled += moved;
            samples++;
            if (moved < 5 && p.pos.distanceTo(g!.flags[p.team].home) > 80) stuckSamples++;
            last[k].copy(p.pos);
          });
        }
        if (g.over) break;
      }
    } catch (e) { error = (e as Error).stack?.split('\n').slice(0, 6).join('\n') ?? String(e); }
    if (!g) break;
    simTime += g.time;
    scores.push(g.teams.map(t => t.score));
    st = st ? mergeStats(st, g.stats) : structuredClone(g.stats);
    if (error) break;
  }
  tickMs.sort((a, b) => a - b);
  const p95 = tickMs[Math.floor(tickMs.length * 0.95)] ?? 0;
  const perFive = (n: number) => n / Math.max(0.01, simTime / 300);
  const stuck = samples ? stuckSamples / samples : 1;
  const wantGrabs = level.expect?.flagGrabsPer5Min ?? 0.9;
  const gates: Gate[] = [
    { name: 'no-crash', ok: !error, detail: error ?? 'ok' },
    { name: 'sim-perf', ok: p95 < 8, detail: `p95 frame ${p95.toFixed(2)}ms (budget 8ms)` },
    { name: 'combat', ok: (st?.kills ?? 0) > 0, detail: `${st?.kills ?? 0} kills` },
    { name: 'flag-pressure', ok: perFive(st?.grabs ?? 0) >= wantGrabs, detail: `${(st?.grabs ?? 0)} grabs (${perFive(st?.grabs ?? 0).toFixed(2)}/5min, level expects ≥${wantGrabs})` },
    { name: 'mobility', ok: stuck < 0.2, detail: `${(stuck * 100).toFixed(0)}% stuck samples (need <20%)` },
    { name: 'economy', ok: (st?.materielMined ?? 0) > 0, detail: `${Math.round(st?.materielMined ?? 0)} materiel mined` },
  ];
  const ok = gates.every(x => x.ok);
  failed ||= !ok;
  const report = {
    level: level.id, ok, seeds, simMinutes: +(simTime / 60).toFixed(1), wallSeconds: +((performance.now() - t0) / 1000).toFixed(1),
    score: scores.map(s => s.join('-')).join(', '),
    avgBotSpeed: samples ? +(traveled / samples / 10).toFixed(1) : 0, stats: st, gates,
  };
  reports.push(report);
  if (!asJson) {
    console.log(`${ok ? '✓' : '✗'} ${level.id}  ${report.simMinutes} sim-min (seeds ${seeds.join(',')}) in ${report.wallSeconds}s  scores ${report.score}  avg speed ${report.avgBotSpeed} m/s`);
    for (const x of gates) console.log(`    ${x.ok ? 'pass' : 'FAIL'} ${x.name.padEnd(14)} ${x.detail}`);
    if (st) console.log(`    deaths: ${Object.entries(st.deathsByCause).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
}
if (asJson) console.log(JSON.stringify(reports, null, 2));
process.exit(failed ? 1 : 0);
