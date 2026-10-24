// Asset toolchain CLI for agents. Everything reads/writes JSON under content/ and
// prints machine-readable reports. Run `npm run assets -- help`.
import { readFileSync, writeFileSync } from 'node:fs';
import { readContent, listContent, writeContent, flags, compactJson } from './lib';
import { buildSkeleton, SkeletonDef, validateSkeleton } from '../src/anim/skeleton';
import { MotionDef, validateMotion } from '../src/anim/motion';
import { generateMotion, PRESETS, GaitParams } from '../src/anim/gait';
import { analyzeMotion, motionVectors } from '../src/anim/analyze';
import { importBVH } from '../src/anim/bvh';
import { compareMotions, extractFeatures, mapSkeleton, relativeTo, compareFeatures } from '../src/anim/compare';
import { fitGait, presetParams } from '../src/anim/fit';
import { compareTextures, decodePNG } from '../src/paint/compare';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT, WEB } from './lib';
import { bakeMaterial, MaterialDef, Baked } from '../src/paint/painter';
import { buildCharacter, CharacterDef, atlasRegions } from '../src/character/builder';
import { characterToGLB } from '../src/character/gltf';
import { encodePNG, writeGenerated } from './lib';

const HELP = `
assets <group> <command> [args]

motion presets                               list gait presets and their parameters
motion gen <preset|all> [--id x] [--skeleton humanoid] [--<param> value ...]
                                             synthesize a motion into content/motions/<id>.json
motion analyze [id|all] [--json]             foot slide, penetration, stride, symmetry, loop seam (exit 1 on issues)
motion vectors <id> [--csv] [--fps n]        per-frame joint rotations (deg) + world positions (m)
motion import-bvh <file.bvh> --id x [--map cmu|mixamo] [--start s] [--end s]
motion compare <ours> <ref> [--json]         skeleton-agnostic comparison: score, per-feature diffs, param suggestions
motion compare <ours> <ref> --baseline <oursIdle>,<refIdle>   (rig-neutral: relative to each rig's idle)
motion fit <preset> --ref <motion> [--id x] [--iters n] [--baseline <oursIdle>,<refIdle>] [--adopt]
                                             self-improving loop: tune gait params toward a reference, keeping QA gates;
                                             writes content/motions/<id>.json and appends to content/benchmarks/history.jsonl
texture compare <png> <reference.png>        palette / tone / detail-frequency / tileability comparison
bench                                        run content/benchmarks/benchmarks.json, record scores, fail on regressions
skeleton validate [id]

paint bake <material|all> [--size n] [--team 0xRRGGBB]
                                             bake albedo/normal/orm/height/emissive PNGs to public/generated/textures/<id>/
character build <id|all> [--glb] [--team 0xRRGGBB] [--size n]
                                             mesh + skin a character; print stats and budget checks;
                                             --glb writes public/generated/characters/<id>.glb with textures + all motions
`;

const TRI_BUDGET = 120000;
/** Motions resolve from content/motions, then the gitignored local reference library. */
function loadMotion(id: string): { m: MotionDef; sk: SkeletonDef } {
  const refPath = join(WEB, 'reference', 'motions', `${id}.json`);
  const m = existsSync(join(CONTENT, 'motions', `${id}.json`)) ? readContent<MotionDef>('motions', id) : JSON.parse(readFileSync(refPath, 'utf8')) as MotionDef;
  const skRef = join(WEB, 'reference', 'skeletons', `${m.skeleton}.json`);
  const sk = existsSync(join(CONTENT, 'skeletons', `${m.skeleton}.json`)) ? readContent<SkeletonDef>('skeletons', m.skeleton) : JSON.parse(readFileSync(skRef, 'utf8')) as SkeletonDef;
  return { m, sk };
}
/** Score history. Runs against local-only references (e.g. original Tribes data) are logged locally, not in content/. */
function record(entry: Record<string, unknown>, local = false) {
  const dir = local ? join(WEB, 'reference') : join(CONTENT, 'benchmarks');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'history.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}
const isLocalRef = (id: string) => !existsSync(join(CONTENT, 'motions', `${id}.json`));
function heightPng(b: Baked) { const o = new Uint8ClampedArray(b.size * b.size * 4); for (let i = 0; i < b.height.length; i++) { const v = Math.max(0, Math.min(255, b.height[i] * 255)); o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = v; o[i * 4 + 3] = 255; } return o; }
function pngs(b: Baked) { return { albedo: encodePNG(b.albedo, b.size, b.size), normal: encodePNG(b.normal, b.size, b.size), orm: encodePNG(b.orm, b.size, b.size), height: encodePNG(heightPng(b), b.size, b.size), emissive: encodePNG(b.emissive, b.size, b.size) }; }

const [group, cmd, ...rest] = process.argv.slice(2);
const { flags: F, pos } = flags(rest);
const skel = (id = F.skeleton ?? 'humanoid') => readContent<SkeletonDef>('skeletons', id);
let exit = 0;

if (!group || group === 'help') console.log(HELP);
else if (group === 'skeleton' && cmd === 'validate') {
  for (const id of pos[0] ? [pos[0]] : listContent('skeletons')) {
    const errs = validateSkeleton(skel(id));
    console.log(errs.length ? `✗ ${id}\n  - ${errs.join('\n  - ')}` : `✓ ${id}`);
    if (errs.length) exit = 1;
  }
} else if (group === 'motion') {
  if (cmd === 'presets') console.log(compactJson(PRESETS));
  else if (cmd === 'gen') {
    const names = pos[0] === 'all' ? Object.keys(PRESETS) : [pos[0]];
    for (const name of names) {
      if (!PRESETS[name]) { console.error(`unknown preset ${name}`); exit = 2; continue; }
      const over: Partial<GaitParams> = { ...PRESETS[name] };
      for (const [k, v] of Object.entries(F)) if (!['id', 'skeleton'].includes(k)) (over as any)[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
      const id = names.length === 1 && F.id ? F.id : name;
      const m = generateMotion(id, skel(), over);
      writeContent('motions', id, m);
      const r = analyzeMotion(buildSkeleton(skel()), m);
      console.log(`${r.ok ? '✓' : '✗'} ${id}  ${m.duration}s  speed ${m.speed} m/s  stride ${r.strideLength} m  slide ${Object.values(r.footSlide).map(s => s.mean).join('/')} m/s${r.issues.length ? '\n  - ' + r.issues.join('\n  - ') : ''}`);
    }
  } else if (cmd === 'analyze') {
    const ids = !pos[0] || pos[0] === 'all' ? listContent('motions') : [pos[0]];
    const reports = ids.map(id => { const m = readContent<MotionDef>('motions', id); const sk = buildSkeleton(skel(m.skeleton)); const errs = validateMotion(m, new Set(sk.def.bones.map(b => b.name))); const r = analyzeMotion(sk, m); r.issues.unshift(...errs); r.ok = r.issues.length === 0; return r; });
    if (F.json) console.log(JSON.stringify(reports, null, 2));
    else for (const r of reports) console.log(`${r.ok ? '✓' : '✗'} ${r.id.padEnd(10)} stride ${r.strideLength}m  cadence ${r.cadence}/min  slide ${Object.values(r.footSlide).map(s => s.mean).join('/')} m/s  contact-err ${Object.values(r.contactHeight).join('/')} m  sym ${r.symmetry}  seam ${r.loopSeam}°${r.issues.length ? '\n    - ' + r.issues.join('\n    - ') : ''}`);
    if (reports.some(r => !r.ok)) exit = 1;
  } else if (cmd === 'vectors') {
    const m = readContent<MotionDef>('motions', pos[0]);
    const frames = motionVectors(buildSkeleton(skel(m.skeleton)), m, F.fps ? Number(F.fps) : m.fps);
    if (F.csv) {
      const bones = Object.keys(frames[0].bones);
      console.log(['t', ...bones.flatMap(b => [`${b}.rx`, `${b}.ry`, `${b}.rz`, `${b}.wx`, `${b}.wy`, `${b}.wz`])].join(','));
      for (const f of frames) console.log([f.t, ...bones.flatMap(b => [...f.bones[b].rot, ...f.bones[b].world])].join(','));
    } else console.log(JSON.stringify(frames));
  } else if (cmd === 'compare') {
    const a = loadMotion(pos[0]), b = loadMotion(pos[1]);
    // --baseline <oursIdle>,<refIdle>: compare relative to each rig's own idle pose.
    const feat = (x: { sk: SkeletonDef; m: MotionDef }, base?: string) => {
      const bs = buildSkeleton(x.sk), map = mapSkeleton(x.sk);
      const f = extractFeatures(bs, x.m, map);
      return base ? relativeTo(f, extractFeatures(bs, loadMotion(base).m, map)) : f;
    };
    const [ba, bb] = F.baseline ? F.baseline.split(',') : [];
    const r = F.baseline ? compareFeatures(feat(a, ba), feat(b, bb)) : compareMotions({ sk: a.sk, m: a.m }, { sk: b.sk, m: b.m });
    if (F.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`similarity ${r.score}/100  (phase shift ${r.shift}${r.mirrored ? ', mirrored L/R' : ''})`);
      for (const d of [...r.diffs].sort((x, y) => y.rmse - x.rmse).slice(0, 10)) console.log(`  ${d.name.padEnd(12)} rmse ${d.rmse}${d.unit === 'deg' ? '°' : ''}  mean Δ ${d.meanDiff}  amp ${d.ampOurs}→${d.ampRef}  corr ${d.corr}`);
      for (const sgn of r.suggestions) console.log(`  → ${sgn.param} ${sgn.change > 0 ? '+' : ''}${sgn.change}: ${sgn.reason}`);
    }
  } else if (cmd === 'fit') {
    const ref = loadMotion(F.ref);
    const [baseOurs, baseRef] = F.baseline ? F.baseline.split(',') : [];
    let refF = extractFeatures(buildSkeleton(ref.sk), ref.m, mapSkeleton(ref.sk));
    if (baseRef) refF = relativeTo(refF, extractFeatures(buildSkeleton(ref.sk), loadMotion(baseRef).m, mapSkeleton(ref.sk)));
    const id = F.id ?? `${pos[0]}-fit`;
    // Resume from the last fitted parameters if this fit has run before (the loop improves over time).
    const prev = (() => { try { return readContent<MotionDef>('motions', id).params; } catch { try { return (JSON.parse(readFileSync(join(WEB, 'reference', 'motions', `${id}.json`), 'utf8')) as MotionDef).params; } catch { return null; } } })();
    const start = { ...presetParams(pos[0]), ...(prev ?? {}) } as any;
    const r = fitGait(id, skel(), start, refF, { iters: F.iters ? +F.iters : 30, baseline: baseOurs ? loadMotion(baseOurs).m : undefined });
    r.motion.description = `Fitted from preset '${pos[0]}' toward reference '${F.ref}' (score ${r.score})`;
    // Fits against local-only references (e.g. original Tribes data) stay local unless explicitly adopted.
    const refIsLocal = !existsSync(join(CONTENT, 'motions', `${F.ref}.json`));
    if (refIsLocal && !F.adopt) {
      mkdirSync(join(WEB, 'reference', 'motions'), { recursive: true });
      writeFileSync(join(WEB, 'reference', 'motions', `${id}.json`), JSON.stringify(r.motion));
      console.log(`(reference is local-only → wrote reference/motions/${id}.json; pass --adopt to write content/motions)`);
    } else writeContent('motions', id, r.motion);
    record({ kind: 'motion-fit', id, ref: F.ref, startScore: r.startScore, score: r.score, evals: r.evals, params: r.params }, refIsLocal && !F.adopt);
    console.log(`${id}: ${r.startScore} → ${r.score} in ${r.evals} evals${prev ? ' (resumed)' : ''}`);
    for (const l of r.log.slice(-12)) console.log('  ' + l);
  } else if (cmd === 'import-bvh') {
    const m = importBVH(readFileSync(pos[0], 'utf8'), F.id ?? 'imported', skel(), { map: F.map, start: F.start ? +F.start : undefined, end: F.end ? +F.end : undefined });
    writeContent('motions', m.id, m);
    console.log(`imported ${m.id}: ${m.duration}s, ${Object.keys(m.tracks).length} bones, ~${m.speed} m/s`);
  } else { console.log(HELP); exit = 2; }
} else if (group === 'texture' && cmd === 'compare') {
  const a = decodePNG(readFileSync(pos[0])), b = decodePNG(readFileSync(pos[1]));
  const r = compareTextures(a, b);
  console.log(JSON.stringify(r, null, 2));
} else if (group === 'bench') {
  const cfgPath = join(CONTENT, 'benchmarks', 'benchmarks.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { motions: { ours: string; ref: string; minScore: number }[] };
  for (const b of cfg.motions) {
    const ok = [b.ours, b.ref].every(id => existsSync(join(CONTENT, 'motions', `${id}.json`)) || existsSync(join(WEB, 'reference', 'motions', `${id}.json`)));
    if (!ok) { console.log(`- ${b.ours} vs ${b.ref}: skipped (reference not available locally)`); continue; }
    const A = loadMotion(b.ours), B = loadMotion(b.ref);
    const r = compareMotions({ sk: A.sk, m: A.m }, { sk: B.sk, m: B.m });
    const pass = r.score >= b.minScore;
    console.log(`${pass ? '✓' : '✗'} ${b.ours} vs ${b.ref}: ${r.score} (min ${b.minScore})`);
    record({ kind: 'bench', ours: b.ours, ref: b.ref, score: r.score }, isLocalRef(b.ref));
    if (!pass) exit = 1;
  }
} else if (group === 'paint' && cmd === 'bake') {
  const ids = !pos[0] || pos[0] === 'all' ? listContent('materials') : [pos[0]];
  const regions = atlasRegions(skel());
  for (const id of ids) {
    const def = readContent<MaterialDef>('materials', id);
    const b = bakeMaterial(def, { size: F.size ? +F.size : undefined, teamColor: F.team ? Number(F.team) : undefined, regions });
    const out = pngs(b);
    for (const [k, buf] of Object.entries(out)) writeGenerated(`textures/${id}/${k}.png`, buf);
    console.log(`✓ ${id}  ${b.size}²  ${def.layers.length} layers  ${b.ms} ms  → public/generated/textures/${id}/`);
  }
} else if (group === 'character' && cmd === 'build') {
  const ids = !pos[0] || pos[0] === 'all' ? listContent('characters') : [pos[0]];
  const team = F.team ? Number(F.team) : 0x4aa3ff;
  for (const id of ids) {
    const def = readContent<CharacterDef>('characters', id);
    const sk = skel(def.skeleton);
    const regions = atlasRegions(sk);
    const bodyMat = bakeMaterial(readContent<MaterialDef>('materials', def.materials.body), { regions, teamColor: team, size: F.size ? +F.size : undefined });
    const res = buildCharacter(def, sk, { bodyHeight: bodyMat });
    const st = res.stats;
    const height = st.bounds[4] - st.bounds[1];
    const issues: string[] = [];
    if (st.triangles > TRI_BUDGET) issues.push(`over triangle budget (${st.triangles} > ${TRI_BUDGET})`);
    if (st.weightError > 1e-3) issues.push(`skin weights don't sum to 1 (err ${st.weightError})`);
    if (st.maxInfluences > 4) issues.push('more than 4 bone influences');
    if (height < 1.6 || height > 2.4) issues.push(`height ${height.toFixed(2)} m out of range`);
    console.log(`${issues.length ? '✗' : '✓'} ${id}  ${st.triangles} tris (body ${st.bodyTriangles}, armor ${st.armorTriangles})  ${st.vertices} verts  ${st.bones} bones  ≤${st.maxInfluences} influences  height ${height.toFixed(2)} m  ${st.ms} ms${issues.length ? '\n  - ' + issues.join('\n  - ') : ''}`);
    if (issues.length) exit = 1;
    if (F.glb) {
      const armorMat = bakeMaterial(readContent<MaterialDef>('materials', def.materials.armor), { teamColor: team });
      const P = (b: Baked) => { const o = pngs(b); return { albedo: o.albedo, normal: o.normal, orm: o.orm, emissive: o.emissive }; };
      const motions = listContent('motions').map(m => readContent<MotionDef>('motions', m)).filter(m => m.skeleton === def.skeleton);
      const glb = await characterToGLB(res, { body: P(bodyMat), armor: P(armorMat), glowColor: team, motions });
      const p = writeGenerated(`characters/${id}.glb`, Buffer.from(glb));
      console.log(`  → ${p.replace(/.*web\//, '')} (${(glb.length / 1024 / 1024).toFixed(1)} MB, ${motions.length} animations)`);
    }
  }
} else { console.log(HELP); exit = 2; }
process.exit(exit);
