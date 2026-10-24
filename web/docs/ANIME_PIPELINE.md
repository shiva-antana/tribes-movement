# Anime / "Genshin-like" heroes: the cheapest agent-driven pathway

**Goal:** stylised hero characters with readable faces, chunky anime hair, cel shading, outlines,
rim light, layered clothing and expressive animation. They should be produced by agents from data,
for about $0 in licenses and under $1 per hero in API spend. Research was done 2026-10-24; anything
marked *(verify)* still needs checking against primary sources.

## Decision

**Build the hero generator ourselves on top of the existing toolchain, and adopt only MIT pieces from the VRM ecosystem.**
- **Our own generator:** SDF body, procedural hair clumps, a parametric face via decals,
  toon materials and outlines. This keeps everything deterministic, licence-clean and agent-drivable.
- **What we adopt:** three-vrm's MToon and spring bones (MIT), and VRM 1.0 as an export format.

Generative 3D (Tripo or Meshy, about $0.60–1 per asset on paid plans) is only for props and armor
pieces. It isn't good enough for faces or hair, and its free tiers are CC-BY or non-commercial.

Why not the obvious shortcuts?
- **VRoid Studio:** has no scripting API, so it's human-only. Many VRoid Hub models disallow commercial use.
- **Anime image-to-3D research models:**
  - StdGEN: its weights are research-only.
  - CharacterGen: its weights have no stated license *(verify)*.
  - PAniC-3D and DrawingSpinUp: no license, or non-commercial.
  - All of them output fused meshes with baked lighting, no face blendshapes and poor hair.
- **"Genshin shader" repos:** these are built around ripped HoYoverse assets. Port techniques, never assets.

## What exists now (v0.4)

| Piece | Where | Notes |
|---|---|---|
| Toon material | `toonMaterial()` in `src/character/runtime.ts` | `MeshToonMaterial` with a 3-band ramp, flat painter albedo, soft normal map, and a fresnel **rim light** injected in the shader |
| Outline | `addOutline()` | **Inverted hull**: a back-face SkinnedMesh shell pushed along the *skinned* normals, sharing the skeleton |
| Hair | `hairGeometry()` in `src/character/builder.ts` | A scalp ellipsoid cap plus tapered, flattened clump tubes (bangs, side locks, back mass, ahoge). Presets `swept`, `spiky`, `long`, plus custom `clumps` (az/el/length/width/droop/outward/curl). UV v runs root→tip |
| Hair material | `content/materials/anime-hair.json` | Base colour, strand streaks, an **angel-ring** sheen band and tinted tips, all as painter layers |
| Face | painter decals `eye`, `brow`, `mouth`, `blush` with `in: "head"` | Anime eyes (sclera, tall iris with darker top, pupil, two specular glints, heavy upper lash), placed in the head's atlas tile. `flipX` mirrors |
| Spring bones | `src/character/springs.ts`, chains built in `buildCharacter()` | Every hair clump and every `spring: true` armor piece (the ranger's coat tails) gets a bone chain appended to the skeleton and is skinned along it. A ~200-line verlet `SpringRig` has stiffness toward the animated rest shape, drag, gravity and capsule colliders from the body volumes. Runs in the workbench (treadmill speed fed in as frame velocity) and in `CharacterInstance.update` |
| Expressions | `src/character/face.ts` | The eye/brow/mouth decals are lifted out of the toon body bake and drawn by the body shader from the same decal data, as parametric shapes. VRM 1.0 presets (`happy angry sad relaxed surprised aa ih ou ee oh blink blinkLeft blinkRight`) are morph targets over 11 shape parameters: lid openness, smile-eye curve, lid and brow tilt, iris scale, brow raise, and mouth open/width/curve/roundness. Weights blend linearly from neutral; auto-blink yields to eye-closing expressions. `workbench.setExpression(name, w)`, `CharacterInstance.setExpression` |
| Hero | `content/characters/ranger.json` | `style: "toon"`, bigger head (`radiusScale.head 1.32`), slimmer frame, swept hair, ivory-and-gold trim, spring coat tails. 44k triangles, 61 bones (21 + 15 spring chains) |

View it at `/workbench.html` → `ranger`. In game, set `ARMOR_CHARACTER.light = 'ranger'` in `config.ts`.

## Roadmap (ranked by value per effort)

1. ~~**Spring bones for hair, coat tails and capes**~~ **Done in v0.4.** We used our own verlet chains rather than
   three-vrm-springbone. Follow-ups:
   - per-chain tuning in the hero JSON (long hair wants lower stiffness)
   - cross-chain constraints, so neighbouring clumps don't separate
   - a cape preset, once clothing shells (item 5) exist
2. ~~**Expressions**~~ **Done in v0.4, as shader "decal morphs".** We didn't use vertex morph targets: the face mesh is too
   coarse (~1.3 cm voxels) for vertex-offset eyelids, and three.js morphs can't move UVs. Follow-ups:
   - lookAt, by offsetting the iris centre (one more parameter)
   - drive visemes from voice-chat amplitude
   - a VRM export, which will need the decal morphs baked to texture-swap expressions
     or to real blendshapes on a denser face patch
3. **Genshin-style face shadow** (1–2 days). An agent-baked face-shadow threshold map: rasterise
   shadow masks for N light angles over the face and merge them with a distance transform. A toon shader
   branch for the head region compares it with the light angle projected on the head's forward/right axes.
4. **Proportion controls** (1 day). Per-bone length scales in the character def (longer legs, smaller
   hands, a narrower waist) so heroes get anime proportions without a new skeleton.
5. **Clothing shells** (3–4 days). Coats, skirts and capes as offset shells of the body SDF (a
   coat = the torso and upper-leg volumes inflated, then cut by a plane), auto-skinned, with spring chains
   at the hem.
6. **VRM 1.0 export** (2 days). A GLTFExporter plugin that writes `VRMC_vrm` (humanoid map, meta and
   license fields), `VRMC_materials_mtoon` and `VRMC_springBone`. Heroes then open in any VRM tool,
   VTuber app or engine. Fallback: headless Blender with the VRM add-on's Python API.
7. **Concept-to-texture loop** (about $0.01–0.10 per hero, 3 days):
   1. A commercial-OK image model makes a turnaround or character sheet (avoid NoobAI/Illustrious
      derivatives, whose licenses ban commercialising outputs).
   2. *See-through* (Apache-2.0 code, weights *(verify)*) splits it into part layers.
   3. The painter projects them into flat-colour atlas textures and decals.
   4. Record the model, licence and prompt in each asset's provenance.
8. **Generated props** (about $0.60–1 each, 1 day of glue). Tripo (Parts, Segmentation, Smart Low-poly)
   or Meshy Pro for weapons and armor, re-materialled to toon.

**Biggest risks:** face aesthetics need iterative tuning against reference sheets (agents can score
`workbench.screenshot()` renders against a rubric), and hair silhouettes need more clump presets.

## Known issues in v0.4

- Small skin patches can poke through the top of the hair cap at some head scales, because the cap is
  an ellipsoid approximation of the capsule head. The fix is to project the cap onto the SDF surface
  plus an offset.
- The face is drawn in the shader, so `workbench.exportGLB()` of a toon hero has no face; the CLI GLB still bakes the neutral face.
- Coat tails are flat boxes, so they kink visibly at chain joints when they bend hard. Use more `bones` or a shell (item 5).
- Spring chains don't collide with each other, so clumps can interpenetrate in fast turns.
