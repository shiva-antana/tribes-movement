# Agentic production pipeline

**Goal:** a near-AAA browser Tribes-like that coding agents can extend and maintain. Agents add
levels, assets, balance changes and fixes; players add and vote on levels; and every change passes
automatic gates before it reaches anyone.

Tooling research was done 2026-10-24. Items marked *(verify)* could not be confirmed against
primary sources, so check them before relying on them.

---

## 1. Principles

1. **Content is data, never code.** Levels, assets, loadouts and call-downs are JSON validated by a
   schema. An agent (or player) can add content without touching engine code, and user content is
   safe to load because it can't execute anything.
2. **Every change is gated headlessly.** The sim runs in Node with bots in every seat. A change
   that crashes, slows the sim, strands bots or kills flag pressure fails CI.
3. **Deterministic first, generative second.** Seeded procedural generators (terrain,
   Blender Geometry Nodes buildings, baked materials) are cheap, consistent in style, licence-clean and
   reproducible. Use generative 3D and audio APIs only where procedural work is weak: organic,
   characters and hero props.
4. **Provenance on every asset.** Each asset records its source, licence, prompt or seed, and the
   tool versions used. Some free tiers are CC-BY or non-commercial, so licence tracking is a gate, not a
   note.
5. **Humans curate, agents produce.** Community votes decide what enters the map rotation. Agents
   generate, test and fix.

## 2. The loop

```
 idea / vote / telemetry
        │
        ▼
 ┌─ agent proposes change (level JSON, asset manifest, config tweak, fix)
 │      │
 │      ▼
 │  generate ── Blender (headless bpy / MCP) · Meshy/Tripo · ElevenLabs · own generators
 │      │
 │      ▼
 │  validate ── npm run validate · asset budgets (gltf-transform inspect) · licence check
 │      │
 │      ▼
 │  playtest ── npm run playtest (headless bot matches + gates)
 │      │
 │      ▼
 │  visual QA ── Playwright screenshots (real GPU) + VLM rubric (advisory)
 │      │
 │      ▼
 │  pull request ── CI re-runs everything, posts the report
 │      │
 │      ▼
 │  community vote / maintainer merge ── level enters the "fresh" pool
 │      │
 └──────┘  telemetry (cap rate, death causes, quit points) feeds the next round
```

## 3. What exists today (v0.2)

| Piece | Where | Agent usage |
|---|---|---|
| Level schema + validator | `src/content/level.ts` | Write `content/levels/<id>.json`, then `npm run validate` |
| Level catalog in the game menu | `src/content/catalog.ts` | Automatic: any valid file appears in the menu |
| Headless sim | `Game(..., { headless: true })` | Import the game from Node scripts and tests |
| Bot playtest + gates | `scripts/playtest.ts` | `npm run playtest -- <id> --minutes 10 [--seed N] [--json]` |
| One-shot check | `npm run check` | Typecheck, validate, and a 5-minute playtest of every level |
| Match stats | `game.stats` | Kills, deaths by cause, grabs, caps, structures built and destroyed, panels destroyed, roads, earth moved, materiel mined |

| Character toolchain | `src/anim`, `src/character`, `src/paint`, `scripts/assets.ts`, `/workbench.html` | Skeleton → interpretable motions → procedural skinned characters → layered PBR textures → GLB. See [CHARACTER_TOOLCHAIN.md](CHARACTER_TOOLCHAIN.md) |

Gates (in `scripts/playtest.ts`): **no-crash**, **sim-perf** (p95 < 8 ms/frame), **combat**
(kills > 0), **flag-pressure** (≥ ~1 grab per 5 min), **mobility** (< 20% stuck samples) and
**economy** (materiel mined > 0). Tighten them as the game matures; every gate is a line of code.

## 4. Assets: the plan

### 4.1 Asset manifest (next step)

`content/assets/<id>.json` describes one asset. The engine loads the glTF if it's present and
otherwise falls back to today's procedural blueprint, so art can replace placeholders piece by
piece.

```jsonc
{
  "id": "bunker-panel-a",
  "kind": "structure-piece",            // structure-piece | structure | vehicle | character | prop | weapon
  "gltf": "bunker-panel-a.glb",         // optional; omit = procedural fallback
  "fallback": "box",                    // which procedural blueprint to use if gltf missing
  "scale": 1,
  "colliders": [{ "center": [0,5,0], "half": [5,5,0.6] }],   // OBBs; physics never uses render meshes
  "sockets": { "turretMount": [0, 10.6, 0] },
  "teamColorMaterial": "Trim",          // material slot tinted per team
  "damageStates": ["intact", "cracked", "destroyed"],        // optional mesh swaps
  "lods": ["bunker-panel-a.lod1.glb", "bunker-panel-a.lod2.glb"],
  "budget": { "tris": 4000, "textureKB": 1024 },
  "provenance": { "source": "blender-bpy", "script": "tools/blender/bunker_panel.py", "seed": 7, "license": "own", "tool": "blender 5.1" }
}
```

### 4.2 Sources by category (recommended defaults)

| Category | Default | Alternatives | Why |
|---|---|---|---|
| Bases, towers, generators, vehicles (hard-surface) | **Headless Blender** (`blender -b --python`) with agent-written bpy + Geometry Nodes, exporting GLB | Blender MCP for interactive work: [ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) (MIT; its socket has no auth, so keep it on localhost) or the [official Blender Lab MCP server](https://www.blender.org/lab/mcp-server/) (Blender 5.1+; runs LLM code unsandboxed, so use a VM) | Deterministic, CI-friendly, clean low-poly topology, consistent kit style, and no licence questions. MCP's `look` renders let an agent see what it built. |
| Characters, creatures, organic props | **Meshy API** (low-poly / topology mode; one REST API for generate → remesh → UV → rig → animate) | **Tripo** P2 (native quads, ≤50k faces, Mixamo-compatible rig spec); **Hyper3D Rodin** Gen-2.5 (Quad mode, Business plan for API); self-hosted **TRELLIS.2** (MIT, ≥24 GB VRAM, dense output that needs remeshing) | Meshy's free tier output is CC BY, and paid tiers give ownership. Tripo's free tier is non-commercial *(verify)*. Hunyuan3D 2.1's licence excludes the EU, UK and South Korea. |
| Rigging + walk/run/jet cycles | **Meshy or Tripo rig API** + **Quaternius Universal Animation Library** (CC0) | UniRig (MIT, self-hosted, rigs any mesh); HY-Motion text-to-motion *(verify licence)* | **Mixamo has no API** and AccuRIG is GUI-only, so neither is agent-usable. **Retarget in Blender** and bake clips. three.js `retargetClip` is unreliable. |
| Materials / textures | **Poly Haven CC0** + **procedural Blender materials baked to PBR** (headless Cycles bake) | Material Maker 1.5 CLI (MIT, `.ptex` graphs, *(verify flags)*); Meshy/Tripo retexture for generated meshes | Deterministic and licence-clean. Keep today's shader look as the style guide. |
| SFX / music | **ElevenLabs Sound Effects API** (loopable, 0.1–30 s) | Eleven Music / Stable Audio 2.5; today's WebAudio synthesis as fallback | Check commercial terms per plan *(verify)*. |
| Web optimization | **glTF-Transform** (`optimize --compress meshopt --texture-compress ktx2`, `simplify` into LOD chains, `instance`, `inspect` for budgets) | gltfpack | Meshopt decodes faster than Draco and also compresses animation. Use `InstancedMesh` for repeated parts. |

### 4.3 Build our own (where it's cheaper and better)

* **Kitbash structure generator.** Today's `blueprint()` already emits structures as part lists.
  Promote it to data (`content/blueprints/*.json`: parts, piece HP, sockets) and add a bpy exporter
  that turns the same blueprint into a bevelled, UV'd, trim-sheet-textured GLB. One source of
  truth gives both gameplay colliders and render mesh.
* **Map builder.** Levels already take biome overrides, base and deposit placement. Next come
  `terrainOps` stamps (ridge, crater, mesa, channel, plateau) so agents compose maps from intent:
  "a shallow strait between two plateaus with a motherlode shoal".
* **Material presets.** Name the shader graph parameters (palette, panel scale, wear) so agents tune
  a look without writing GLSL.

### 4.4 Visual QA

* **Playwright** screenshots of fixed camera bookmarks per level and per asset turntable. Assert the
  real GPU renderer via `WEBGL_debug_renderer_info`, because headless Chromium silently falls back
  to SwiftShader.
* Pixel-diff with a tolerance against approved baselines.
* A **VLM judge** scores silhouette, seams, scale and style consistency against a rubric. It is
  **advisory only**: on VideoGameQA-Bench the best visual-regression accuracy was about 45%. Hard
  gates stay numeric (tris, texture KB, non-blank canvas, FPS floor).

## 5. Community levels and voting

**Phase 1: zero backend (start here).**
- Levels are PRs adding `content/levels/<id>.json`.
- CI runs `npm run check` and posts the playtest report and screenshots on the PR.
- Votes come from reactions or Discussions, read through the GitHub API.
- The best fit for an early, trusted community.

**Phase 2: in-game.**
- Use Cloudflare Workers + **D1** (`levels`, and `votes(level_id, user_id, value)` with a unique key)
  and **R2** for level JSON and thumbnails. Durable Objects handle live lobbies and rate limiting.
- Supabase (Postgres + RLS + auth) is an equally good alternative.
- Flow: submissions are unlisted → automatic playtest gates → visible in "Fresh" → promoted to
  rotation by Wilson-score votes with a recency boost.

**Moderation.**
- Levels are schema-validated data with bounded counts and sizes.
- Titles and descriptions go through a moderation model.
- A report button with an auto-hide threshold.
- Per-account rate limits.

## 6. Self-maintenance jobs (scheduled agents)

| Job | Trigger | What it does |
|---|---|---|
| Nightly regression | cron | `npm run check` across several seeds. On failure, an agent bisects and opens a fix PR with the failing report attached. |
| Balance tuner | weekly + telemetry | Reads playtest and live stats (cap rate, death causes, armor pick rates). Proposes bounded `config.ts` changes and proves them with A/B headless runs. |
| Level curator | on vote threshold | Promotes or demotes levels in rotation, and regenerates thumbnails. |
| Asset backfill | on manifest gap | Picks the next procedural placeholder, generates a GLB through the pipeline, runs budgets and VLM review, and opens a PR. |
| Dependency hygiene | weekly | Updates pins and runs `npm audit` plus the full check. |

## 7. Next tasks, in order

0. ✅ **Character toolchain** (v0.3): gait generator + analyzer, BVH import, surface-nets characters with bone-glow skinning, layered painter, workbench, GLB export, and in-game animated characters.
1. **Asset manifest + glTF loader** with procedural fallback, OBB colliders from the manifest, and team-colour slot. Characters can already load from `public/generated/characters/*.glb`.
2. **Blender headless toolchain** (`tools/blender/*.py`): blueprint JSON → bevelled GLB; turntable renders; `gltf-transform` optimize + budgets in CI.
3. **Hero characters:** compare our procedural scout with a Meshy/Tripo-generated one rigged to the same 21-bone skeleton, and import Quaternius CC0 clips into the motion format.
4. **`terrainOps` stamps** in the level schema, plus a level-generator agent prompt template.
5. **GitHub CI workflow** running `npm run check`, plus a Playwright screenshot job that posts to the PR.
6. **Netcode** (see DESIGN.md roadmap): it unlocks real community play and telemetry.
