// Self-improving motion loop: tune gait-generator parameters until our motion matches a
// reference (any skeleton) on interpretable features, without breaking quality gates
// (foot slide, penetration, loop seam). Deterministic coordinate descent: cheap, explainable,
// and every accepted step is logged.
import { generateMotion, GaitParams, PRESETS } from './gait';
import { extractFeatures, compareFeatures, Features, mapSkeleton, relativeTo } from './compare';
import { analyzeMotion } from './analyze';
import { buildSkeleton, SkeletonDef } from './skeleton';
import type { MotionDef } from './motion';

const TUNABLE: { key: keyof GaitParams; step: number; min: number; max: number }[] = [
  { key: 'armSwing', step: 6, min: 0, max: 80 }, { key: 'armForward', step: 6, min: -40, max: 85 },
  { key: 'elbow', step: 10, min: 0, max: 120 }, { key: 'lean', step: 3, min: -10, max: 40 },
  { key: 'lift', step: 0.04, min: 0.02, max: 0.75 }, { key: 'crouch', step: 0.03, min: 0, max: 0.4 },
  { key: 'bob', step: 0.015, min: 0, max: 0.12 }, { key: 'cycle', step: 0.05, min: 0.3, max: 2 },
  { key: 'stance', step: 0.04, min: 0.15, max: 0.75 }, { key: 'twist', step: 3, min: 0, max: 25 },
  { key: 'armDown', step: 6, min: 30, max: 88 },
  { key: 'armForwardR', step: 6, min: -40, max: 85 }, { key: 'armSwingR', step: 6, min: 0, max: 80 },
  { key: 'elbowR', step: 10, min: 0, max: 130 },
  { key: 'footBias', step: 0.05, min: -0.4, max: 0.4 }, { key: 'headPitch', step: 5, min: -30, max: 40 },
];

export interface FitResult { params: Partial<GaitParams>; motion: MotionDef; score: number; startScore: number; evals: number; log: string[]; }

export function fitGait(id: string, sk: SkeletonDef, start: Partial<GaitParams>, ref: Features, opts: { iters?: number; keys?: (keyof GaitParams)[]; baseline?: MotionDef } = {}): FitResult {
  const built = buildSkeleton(sk);
  const map = mapSkeleton(sk);
  let evals = 0;
  const baseF = opts.baseline ? extractFeatures(built, opts.baseline, map, ref.samples) : null;
  const evaluate = (p: Partial<GaitParams>) => {
    evals++;
    const m = generateMotion(id, sk, p);
    let fo = extractFeatures(built, m, map, ref.samples);
    if (baseF) fo = relativeTo(fo, baseF);
    const cmp = compareFeatures(fo, ref);
    const qa = analyzeMotion(built, m);
    // Quality gates are hard constraints: a better match with sliding feet is not better.
    const cost = (100 - cmp.score) + (qa.ok ? 0 : 50 + qa.issues.length * 10);
    return { m, score: cmp.score, cost, ok: qa.ok, suggestions: cmp.suggestions };
  };
  const clampKey = (k: keyof GaitParams, v: number) => { const t = TUNABLE.find(x => x.key === k); return t ? Math.min(t.max, Math.max(t.min, v)) : v; };
  let cur = { ...start };
  let best = evaluate(cur);
  const startScore = best.score;
  const log = [`start score ${best.score}${best.ok ? '' : ' (QA issues)'}`];
  const keys = TUNABLE.filter(t => !opts.keys || opts.keys.includes(t.key));
  const steps = new Map(keys.map(k => [k.key, k.step]));
  for (let it = 0; it < (opts.iters ?? 30); it++) {
    let improved = false;
    // 1) Diagnosis-driven jump: apply the comparator's own suggestions (full, half, quarter strength).
    for (const k of [1, 0.5, 0.25]) {
      if (!best.suggestions.length) break;
      const cand: Partial<GaitParams> = { ...cur };
      for (const sg of best.suggestions) {
        const key = sg.param as keyof GaitParams;
        if (!keys.some(t => t.key === key)) continue;
        const v = ((cand[key] as number | undefined) ?? 0) + sg.change * k;
        (cand as any)[key] = +clampKey(key, v).toFixed(4);
      }
      const r = evaluate(cand);
      if (r.cost < best.cost - 1e-6) { best = r; cur = cand; improved = true; log.push(`suggested jump ×${k}  score ${r.score}`); break; }
    }
    if (improved) continue;
    // 2) Coordinate descent on one parameter at a time.
    for (const t of keys) {
      for (const dir of [1, -1]) {
        const v = (cur[t.key] as number | undefined) ?? (start[t.key] as number) ?? 0;
        const nv = Math.min(t.max, Math.max(t.min, +(v + dir * steps.get(t.key)!).toFixed(4)));
        if (nv === v) continue;
        const cand = { ...cur, [t.key]: nv };
        const r = evaluate(cand);
        if (r.cost < best.cost - 1e-6) { best = r; cur = cand; improved = true; log.push(`${String(t.key)} → ${nv}  score ${r.score}`); break; }
      }
    }
    if (!improved) {
      // Refine: halve step sizes; stop when all are tiny.
      let any = false;
      for (const t of keys) { const s = steps.get(t.key)! / 2; steps.set(t.key, s); if (s > t.step / 16) any = true; }
      if (!any) break;
    }
  }
  return { params: cur, motion: best.m, score: best.score, startScore, evals, log };
}

export function presetParams(name: string): Partial<GaitParams> { return { ...(PRESETS[name] ?? {}) }; }
