# Character toolchain: skeleton → motion → character → paint → GLB

Every stage is **data in, data out**, scriptable from the command line, and checked with numbers.
An agent can generate a walk cycle, verify that the feet don't slide, build a skinned
high-poly character, paint it, and export a GLB without opening a GUI. The workbench
(`/workbench.html`) shows the same thing to humans and to browser-driving agents.

```
content/skeletons/humanoid.json ──► content/motions/*.json ──┐
          │  (bones + body volumes)      (per-bone Euler keys) │
          ▼                                                    ▼
content/characters/*.json ──► buildCharacter() ──► SkinnedMesh ──► game / workbench / GLB
          │                     surface nets + bone-glow weights      (public/generated/)
          ▼
content/materials/*.json ──► bakeMaterial() ──► albedo · normal · ORM · height · emissive
                               (layer stack)      (height also displaces the mesh)
```

## 1. Skeleton (`content/skeletons/<id>.json`)

- **Bones:** `name`, `parent` and `offset` (meters from the parent). The rest pose is a T-pose with
  identity joint orientations. Y is up, the character faces -Z, and its left side is -X.
- **Volumes:** tapered capsules in bone-local space (`a`, `b`, `r0`, `r1`). These sculpt the body.
  Add a volume to change the silhouette, for example a thicker neck or a backpack bulge on the body itself.

## 2. Motion (`content/motions/<id>.json`): interpretable vectors

```jsonc
{ "id": "run", "fps": 60, "duration": 0.62, "loop": true, "speed": 6.5,
  "tracks": { "thighL": { "rot": [[0, 34.2, 0, -0.4], [0.0167, 31.9, 0, -0.4], ...] },   // [t, x°, y°, z°] Euler XYZ
              "hips":   { "pos": [[0, 0, -0.07, 0], ...] } },                          // meters added to rest offset
  "contacts": { "footL": [[0, 0.149]], "footR": [[0.31, 0.459]] },
  "params": { ... generator parameters ... } }
```

- **Gait generator** (`src/anim/gait.ts`): feet follow explicit trajectories, planted during contact and
  arcing during swing. Legs reach them with analytic two-bone IK. The hips auto-crouch when a foot
  would be out of reach, so planted feet don't slide by construction. Presets: `idle walk run ski jet fall`.
  Every parameter can be overridden: `--stride`, `--lean`, `--armSwing`, `--crouch` and so on.
- **BVH import** (`src/anim/bvh.ts`, uses three's BVHLoader): maps CMU or Mixamo bone names onto our
  skeleton, scales by hip height, and strips root travel to make the clip in-place (recorded as `speed`).
- **Analyzer** (`src/anim/analyze.ts`):
  - foot slide while planted (m/s)
  - contact height error
  - ground penetration
  - stride, cadence, L/R symmetry
  - loop seam
  - knee hyperextension
- **Vectors:** `motion vectors <id> --csv` dumps every frame's local Euler angles and world joint
  positions, either for inspection or as features for learned motion models later.

## 3. Character (`content/characters/<id>.json`)

- **Body:** the skeleton volumes (+ per-character extras, `bulk`, `radiusScale`) are smooth-unioned into
  an SDF, meshed with **surface nets** at `voxel` resolution, projected onto the surface, and given
  normals from the field gradient. The defaults give 22k–27k body triangles.
- **Skin weights:** analytic "bone glow". Each vertex is weighted by how close it is to each bone's
  volumes relative to the nearest one, keeping the top 4 normalized influences.
- **UVs:** a per-bone cylindrical atlas, one tile per bone, shared with the painter's `regions` masks.
  Vertices are split where regions meet so tiles never bleed.
- **Armor:** rounded boxes, capsules and spheres rigidly bound to bones, with box-projected UVs at constant texel
  density. `mirror: true` places the L/R twin. `material: "glow"` is for visors and thruster glows.
- **Spring bones** (`src/character/springs.ts`): hair clumps and armor pieces with `spring: true` (or
  `spring: { bones, stiffness, drag, gravity, radius, colliders }`) get bone chains appended to the skeleton
  at build time (`hair<i>_<j>`, `cloth<i>_<j>`; the ranger has 61 bones). Clump vertices are skinned along their
  chain by `uv.v`, and spring armor along its local -y axis (spring boxes are subdivided so they bend).
  `SpringRig` is a verlet chain per clump: inertia minus `drag`, a pull back toward the animated rest shape
  (`stiffness`, per 1/60 s step), `gravity`, fixed bone lengths, and capsule colliders taken from the body
  volumes of the bones listed in `colliders` (hair: head, neck, chest, shoulders, upper arms; cloth: hips,
  thighs, shins). Particles that start inside a collider (roots in the scalp) get a shrunken radius, so the
  rest shape is never pushed. `hair.spring: false` makes hair rigid to the head again. `BuildResult.springs` holds the chain and collider data.
- **Displacement:** the body material's height map pushes vertices along their normals
  (`displacement` in meters). This is baked tessellation; WebGL has no hardware tessellation.
- **Budgets** (checked by `character build`): ≤120k triangles, weights sum to 1, ≤4 influences, height 1.6–2.4 m.

## 4. Painter (`content/materials/<id>.json`)

The layer types are `fill noise panels stripes scratches decal stroke`.
- **Masks:** `regions` (bone names, on atlas materials), `rect`, `noise` (procedural masks), and `invert`.
- **Team colour:** `"$team"` resolves to the team colour at bake time.
- **Tiling:** `tiling: true` makes noise and strokes wrap, for repeating surfaces like armor plates.
- **Outputs:** sRGB albedo, an OpenGL tangent-space normal map from height (`normalStrength`), ORM
  (R occlusion from height cavity, G roughness, B metalness, the glTF packing), height and emissive.
- **Painted strokes are data:** a stroke records UV points, radius, colour and height. Painting in
  the workbench appends `stroke` layers you can download, review, and commit back into `content/materials/`.

## 5. Commands

```bash
npm run assets -- help
npm run assets -- motion gen run --lean 18 --armSwing 50      # regenerate with tweaks
npm run assets -- motion analyze all                          # exit 1 if any motion has issues
npm run assets -- motion vectors run --csv > run.csv
npm run assets -- motion import-bvh path/to/02_01.bvh --id cmu-walk --map cmu
npm run assets -- paint bake all                              # PNGs → public/generated/textures/
npm run assets -- character build all --glb                   # GLB + textures + all motions → public/generated/characters/
npm run assets:check                                          # skeleton + motions + characters (part of npm run check)
```

Generated files go to `public/generated/` and are gitignored, because everything there can be rebuilt from `content/`.

## 6. Workbench (`npm run dev` → `/workbench.html`)

- **View:** orbit the model, pick a character, motion and team colour, and toggle the skeleton or wireframe.
  The floor grid scrolls at the motion's speed and foot markers turn green while planted, so slipping is
  visible at a glance. The motion report and mesh stats sit in the side panel.
- **Paint:** click and drag on the model. Changes re-bake live. Edit the material JSON and apply,
  undo strokes, or download the JSON.
- **Export:** download a GLB with all animations, or a screenshot.
- **Springs and face:** a "Spring bones" toggle, and for toon heroes a FACE section with a slider per
  expression, auto-blink, "Face cam" (a front close-up of the head) and "Neutral". On the treadmill the springs
  are told the motion's speed, so hair and coat tails lag as if the character really ran.
- **Agent API (`window.workbench`):** `setCharacter`, `setMotion`, `setTime`, `setCamera`, `addLayers`,
  `material`, `analyze`, `screenshot()` (PNG data URL for visual QA), `exportGLB`, `stats`, `mesh`, plus
  `setExpression(name, weight)`, `expressions()`, `clearExpressions()`, `setAutoBlink(on)`, `setSprings(on)`,
  `faceCam(dist?)` and `settle(seconds)`. `settle` steps the mixer and springs at 60 Hz by hand. Use it before
  screenshots, because `requestAnimationFrame` doesn't run while the browser tab is hidden.

## 7. In the game

`src/character/library.ts` builds one mesh per armor at game LOD (voxel 0.021, about 20k triangles), bakes
team-tinted materials, and gives each player an `AnimationMixer`. The animation state comes from physics:
- `jet` while jetting
- `fall` when airborne
- `ski` while skiing at speed
- `run` while moving, with playback rate set by ground speed ÷ the motion's authored speed
- `idle` otherwise

`CharacterInstance.update(dt)` then runs the spring chains (from the player's real world motion) and the
face rig (auto-blink). `instance.setExpression(name, weight)` sets expressions. Each toon instance gets its own
body material copy (shared textures), so expressions are per player.

The armor-to-character mapping is `ARMOR_CHARACTER` in `config.ts`. Headless playtests skip characters entirely.

## 8. Open-source landscape (researched 2026-10-24)

The table shows what we use or could adopt, and what to avoid on licensing grounds. Licenses were
checked from repo LICENSE files.

| Need | Use / adopt | Avoid |
|---|---|---|
| Motion data | **Quaternius Universal Animation Library** (CC0, glTF), **Mesh2Motion assets** (CC0), **CMU mocap BVH** (free for commercial use per CMU), **100STYLE** (CC-BY 4.0: attribution) | **LAFAN1** (CC BY-NC-ND), **Bandai Namco motion dataset** (CC BY-NC) |
| IK / retargeting | three.js `BVHLoader`, `CCDIKSolver` (MIT). **sketchpunklabs/ossos** (MIT, TS: IK-rig retargeting and procedural animation) is the best upgrade path. Motion-matching reference: orangeduck/Motion-Matching (MIT). | `SkeletonUtils.retargetClip` is known-buggy, so retarget offline instead |
| Parametric humans | **naver/anny** (Apache-2.0 code, CC0 MakeHuman assets; keep the default topology) and **MPFB2/MakeHuman** (GPL/AGPL code, CC0 assets, output not encumbered) for realistic base bodies | **SMPL/SMPL-X** (non-commercial), **CharMorph MB-Lab** characters (AGPL propagates to output) |
| Meshing / SDF | Our surface nets. **manifold-3d** `levelSet` (Apache-2.0, wasm) gives watertight meshes and booleans when we need hard-surface CSG. | SignedDistanceFieldJS (conflicting GPL/ISC license) |
| Skin weights | Our analytic bone glow; **Mesh2Motion** (MIT, browser auto-skin) as a reference; Blender headless bone-heat as a fallback; **UniRig** (MIT) for arbitrary meshes (its training-data provenance is mixed) | RigNet, brignet (GPL-3.0) |
| Textures / UV | Our painter. **xatlas-three** (MIT) for unwrapping arbitrary meshes. **NormalMap-Online** (MIT) filters. **Material Maker** (MIT) for offline hero materials. | — |
| GLB / validation | **@gltf-transform/core** (MIT, already used for CLI export). **gltf-validator** (Apache-2.0) for CI. `gltf-transform optimize` for meshopt/KTX2. | three `GLTFExporter` in Node (needs FileReader and canvas polyfills) |

**Suggested next adoptions:**
1. Quaternius UAL clips imported via a glTF→motion converter (same JSON format).
2. ossos for foot-locking IK at runtime on uneven terrain.
3. gltf-validator plus meshopt/KTX2 compression in `character build --glb`. The scout GLB is 9.7 MB, mostly PNG textures.
4. A cache of baked game textures (IndexedDB or prebuilt PNGs) to cut the ~3 s character bake at game start.

## 9. Heads, hair and references (v0.4)

- **Sculpted heads.** `replaceVolumes: ["head"]` drops the skeleton's capsule head, and the character
  then lists named head volumes: cranium, forehead, brow ridge, cheekbones, jaw, chin, mouth, nose,
  nostrils, ears, skull base, plus `op: "subtract"` eye sockets. Volumes now support `scale`
  (ellipsoids), `op: "subtract"` (smooth carving) and per-volume blend `k` (crisp features).
  See `content/characters/ranger.json`.
- **Face texture space.** The head gets a 2×2 block of the atlas and is front-projected:
  `FACE_UV.uv(x, y)` turns head-bone meters into head-tile UV (`u = 0.5 + x/0.3`, `v = (y + 0.05)/0.3`).
  Place decals with `in: "head"` at those coordinates. The back of the head reuses the projection,
  which is fine because hair covers it.
- **Layered hair** (`hair.preset: "layered"`). Roots sit in rows inside a hairline that is high at the
  forehead, dips at the sideburns and drops low at the nape. Clumps flow away from the crown, hug the
  scalp ellipsoid until it narrows, then fall, staying outside the head and neck. Lengths come from
  `bangs` / `sides` / `back`, and bangs stop above the brows. A skull-tight underlayer fills any gaps.
  Clumps longer than 17 cm get spring chains.
- **Outline.** Thinned to 30% on head-weighted vertices, so the nose and lips don't get heavy rings.
- **References in the workbench.**
  - **Loading:** drop a GLB, glTF, VRM, OBJ or FBX model, or a PNG, JPG or WebP image, on the
    viewport or use the panel. Agents can call `workbench.loadReference(url, 'front' | 'side')`.
  - **Display:** models are scaled to our height and grounded. They play their first animation and
    can be turned with `turnReference(180)`.
  - **Modes:** *side by side* or *overlay* (a ghost with adjustable opacity), with *body* or *head* framing.
  - **Silhouette score:** `workbench.silhouetteScore('front' | 'side', 'body' | 'head')` renders
    orthographic masks and returns their IoU. Images are segmented against their border colour or
    alpha. This is the number to optimise head and body volumes against.
  - **Image framing:** use straight-on images. Body framing assumes head to feet; head framing assumes
    crown to neck.
  - **Local files:** put references in `web/public/reference/` (gitignored) and load them as
    `/reference/<file>`. Never commit references you don't have rights to.

### Auto-fit head to reference images

In the workbench: load a **front** and/or **side** head reference (an image whose name contains
"side" is treated as a side view; there's also the panel selector), then press **Auto-fit head**.

**What it adjusts.** The fitter (`src/workbench/headfit.ts`) tunes 18 interpretable knobs:
- **Head:** head size; skull width, height and depth; jaw width and fullness; chin height and
  projection; cheekbones; nose projection and height; forehead slope; neck width.
- **Hair:** volume, bangs length, side length, back length, hairline height.

**How it works.**
- Each evaluation is a fast head-and-shoulders build (about 5 per second), so you can watch it converge live.
- It maximises the mean IoU of normalised front and side silhouettes. Masks are aligned by crown
  and skull width, so the reference's crop and scale don't matter.
- Background is taken as the most common border colour (or alpha), so use plain backgrounds.
- **Apply fitted head** rebuilds at full quality as an edited copy. **Download character JSON**
  (or `workbench.characterJSON()`) gives the definition to commit to `content/characters/`.

**Validated on a synthetic reference** (`workbench.syntheticReference()`). Identity scores 97%,
and the fit went from 88% to 98.3%. It recovered head size, chin drop and hair volume exactly,
and got neck, bangs and sides in the right direction. Jaw and cheek width can't be seen in a
silhouette when hair covers the jawline.

Agent API: `syntheticReference(values?)`, `fitHead(rounds)`, `stopFit()`, `applyFit()`,
`fitResult`, `characterJSON()`.
