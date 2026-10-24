# Self-improving graphics workflow

The loop: **generate → measure → compare against references → adjust → gate → record.**
Every step is a command that prints numbers, so an agent, or a scheduled job, can run it
unattended. Improvements are kept only if the quality gates still pass, and every run is
logged so progress is measurable and regressions fail.

```
              ┌──────────── content/ (data: skeletons, motions, characters, materials) ───────────┐
              ▼                                                                                    │
 generate ─► measure (analyze: foot slide, budgets) ─► compare (vs reference) ─► adjust (fit) ─► gate ─► record
              │                                              ▲                                    │
              │                         reference/ (local, gitignored)                            ▼
              │                     CC0 clips · BVH mocap · original Tribes (analysis only)   content/benchmarks/history.jsonl
              └──────────────────────── residual gaps → extend the generator (new params/features) ◄┘
```

## Tools

| Step | Command | What it does |
|---|---|---|
| Reference library | `npm run tribes -- reference [--world lush]` | Reads the original Tribes PVOL archives (clean-room readers for PVOL, PL98 palettes, PBMP bitmaps, and TS::Shape v8 nodes, sequences and keyframes). Converts the armor skeletons and all 45 sequences to our motion JSON, and the skins to PNG, in `reference/` (gitignored) |
| Compare motions | `npm run assets -- motion compare <ours> <ref> [--baseline oursIdle,refIdle]` | **Skeleton-agnostic**: maps any rig to canonical joints (aliases cover our rig, CMU, Mixamo and Tribes). Extracts limb swing, knee and elbow flexion, whole-torso lean, head pitch, normalized hip height and foot clearance, using a heading frame derived from geometry. Aligns by the best phase shift and L/R mirror, and reports the score, per-feature diffs and generator-parameter suggestions. `--baseline` compares relative to each rig's idle pose to cancel rest-angle differences |
| Fit | `npm run assets -- motion fit <preset> --ref <motion> [--baseline …] [--adopt]` | Each round first takes **diagnosis-driven jumps** (the comparator's suggestions at 1×, ½× and ¼×), then falls back to coordinate descent with step refinement. The analyzer's quality gates are **hard constraints**. A fit resumes from its last parameters, so repeated runs keep improving. Fits against local-only references write to `reference/` unless `--adopt` is passed |
| Compare textures | `npm run assets -- texture compare <ours.png> <ref.png>` | Palette (k-means), tone, contrast, saturation, detail-frequency spectrum, edge density and tileability, with painter-layer suggestions |
| Bench | `npm run assets -- bench` | Runs `content/benchmarks/benchmarks.json`, appends to `history.jsonl`, and fails below `minScore`. References that aren't present locally are skipped |

## Validation (2026-10-24)

- **Recovery test.** A hidden target run (lean 24, armSwing 60, elbow 40, lift 0.2, cycle 0.7,
  armDown 64) was fitted from the default run preset. Similarity went from 61.3 to **97.6** in 246
  evaluations, and the parameters came back as 60 / 40 / 0.2 / 0.70 / 63 (lean 21.9). Foot slide
  stayed within gates throughout.
- **Original Tribes light-armor run.**
  - Baseline similarity was 34.5, and the fit reached about **54–55**.
  - What it learned: the original carries both arms forward and almost still (a two-handed weapon
    hold, with the right arm differing from the left), leans the torso about 21° and lifts the knees high.
  - The run was the first real use of the loop, and it found four problems in the tooling itself, each now fixed:
    1. **Euler wrap glitch:** the pelvis rotation near ±180° caused a one-frame spin. Now unwrapped in all importers.
    2. **Too short a torso-lean measure:** hips to chest was only 12 cm on our rig. Now hips to head.
    3. **No gradient beyond the error cap:** saturated error gave the fit nothing to follow. Now smooth (`tanh`).
    4. **Missing generator capabilities:** added asymmetric arm carry (`armForwardR`, `armSwingR`,
       `elbowR`), `footBias`, and neck-driven `headPitch`.
- **Remaining gaps** (the next generator extensions):
  - Hip-swing asymmetry and knee amplitude: the original's heel kick is deeper than our IK swing arc.
  - The texture comparator should mask unused atlas space (the original skin atlas has black gutters).

## Using original Tribes data

Tribes 1 is freeware, but its EULA reserves the artwork and animations, and the IP now belongs to
Hi-Rez. So the rules are:
- **Local analysis only.** Everything lands in `web/reference/`, which is gitignored.
- **Our own parsers.** The readers are clean-room implementations from published format facts.
  Nothing is copied from the leaked engine source, and the 256-entry normal table is not used.
- **No originals in the game.** Original animations, textures, skeletons and palettes never go
  into `content/`, the build, or the repo.
- **Fitted results stay local.** Anything fitted against an original reference goes to `reference/`
  by default. Adopting fitted parameters (high-level style numbers such as lean or arm carry, not
  keyframes) into `content/` is a deliberate `--adopt` decision for a human to make.
- **Shippable reference sets:** CC0 sets (Quaternius UAL, Mesh2Motion), CMU mocap (BVH via
  `motion import-bvh`), and 100STYLE (CC-BY, credit required). LAFAN1 and Bandai Namco are non-commercial.

## Next steps for the loop

1. **Heel-kick capability:** a swing-phase foot trajectory parameter, so the knee curve can match deep
   recovery kicks.
2. **Atlas-aware texture stats:** mask by alpha or non-black, and compare per region (helmet, chest, limbs).
3. **Population search:** a small CMA-ES or random-restart search when coordinate descent plateaus.
4. **Visual QA in the loop:** render `workbench.screenshot()` turntables, score them with a
   vision-model rubric (advisory), and attach them to the history.
5. **Scheduled job:** run `npm run assets -- bench` nightly. On a regression, an agent bisects the
   change and opens a fix.
