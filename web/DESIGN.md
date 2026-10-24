# VASTLANDS — design document

A browser-native successor to *Starsiege: Tribes* / *Tribes 2*: vast, desolate worlds crossed at
hundreds of km/h by skiing and jetting, spinfusor duels, CTF and base defense, plus a modern
strategy layer of orbital call-downs, contested resource deposits, permanent terraforming and
cooperative capital drops.

The production goal is just as important: a near-AAA game that **agents can build and maintain**.
Content is data, every change is checked by headless playtests, and assets come from an
agent-driven generation pipeline. Players add and vote on levels. See
[docs/AGENTIC_PIPELINE.md](docs/AGENTIC_PIPELINE.md) and [AGENTS.md](AGENTS.md).

## Pillars

1. **Momentum is the skill.** Skiing (hold Space) is frictionless sliding where gravity along the
   slope is your engine. Jets are for getting *over* things, not for cruising. Splash weapons push
   you as well as hurt you (disc-jumping).
2. **The land is the opponent.** Each biome changes how you move: heat, wind, water and ice
   decide which routes work. Huge maps, haze, a gas giant on the horizon and wind-blown snow or
   dust sell the emptiness.
3. **Everyone can be a commander.** Any player with a Constructor pack can call down structures,
   tap resource vents, put up a sky platform or start a cooperative capital drop. There is no
   separate commander role.
4. **The world remembers.** Nothing regenerates on its own. Craters and graded roads are
   permanent. Buildings come apart panel by panel and stay broken until a player rebuilds them.
   Holding ground means maintaining it.
5. **Built by agents.** Levels are JSON, and quality gates run headlessly. Today's art is
   procedural shaders and primitives, and the asset pipeline (Blender, generative 3D, gltf-transform)
   is designed to replace it piece by piece without touching game code.

## What's in the vertical slice (v0.1)

| Vision item | Implementation |
|---|---|
| Vast, desolate worlds | 3 km × 3 km heightfield worlds per seed; height fog, haze, wispy cloud, gas giant; sparse bases and vents; wind-borne snow/dust/spray particles; synthesized wind ambience that tracks local wind speed. |
| Skiing on slopes | `game/player.ts`: holding Space removes ground friction. Contact resolution strips the into-normal velocity, so gravity along the slope remains (the same physics as the Unity demo's `GroundCharacterMover.Ski`). Hard impacts above 55 m/s into a surface hurt. |
| Jetpack + cooling | Jets cost **energy** and build **heat**. Overheat locks jets until they cool to 35%. Cooling = biome coldness × proximity bonus: up to ×3.5 when skimming within 25 m of water or ice, ×5 when submerged. Hot jets burn more energy, so staying cool stretches a trek. |
| Spinfusor & grenade launcher as kinetic weapons | `game/weapons.ts` + `config.ts`. Projectiles inherit shooter velocity. Explosions apply impulse to everyone (disc jumps, team boosts) but damage only enemies and yourself. Also chaingun, blaster and fusion mortar (heavy only). |
| CTF + base defense | Two bases per map with bunker, generator, inventory stations, turrets, AA battery, sensor, vehicle station, and flag stand. The generator powers the base: kill it and stations and turrets go offline. Disabled base assets can be repaired (Repair pack, hold F). First to 5 captures wins. |
| Free class swaps at base | Light / Medium / Heavy armors + weapons + pack at any powered inventory station (E or I). That includes remote stations you call down and the APC's deployable station. |
| Vehicles (T2-style) | Turbograv (hover, crosses water), Shrike (fighter, lift/stall model), Siege Tank (tracked, turreted, **can't cross water deeper than 2.5 m**), Havoc APC (VTOL transport that deploys a mobile inventory station). Flyers take wind as both drag and turbulence. |
| Destructible, repairable buildings | Bunkers, walls, bridges and sky platforms are **piecewise**: each wall panel, roof slab, bridge segment and deck tile has its own HP and collider. Blow a hole in the bunker to reach the generator, or drop a bridge span under a tank. Broken panels leave rubble. Functional structures (generator, turrets, stations, extractors) are disabled at 0 HP. **Nothing self-repairs.** The Repair pack (hold F) restores damage, re-enables disabled gear and **rebuilds blown-out panels for materiel** (0.06 per HP). Plating shows burn and crack damage, with a glowing seam while it's being repaired. |
| Permanent, significant terraforming | Explosion craters are permanent and stack, down to 30 m below the original surface, so sustained shelling trenches the land. **Grade Road** (call-down menu, two clicks) cuts and fills a 12 m highway of up to 220 m per segment, limited to a ~12° grade, and **fills shallow water into causeways**. It costs 0.006 materiel per m³ moved. Tanks run 60% faster on roads with no climb penalty. Roads and scorch are drawn from a 1024² surface map. |
| Contested resource deposits | Deposits are **finite**: 700 materiel standard, 2600+ for motherlodes (×3 extraction rate) in the contested middle. Deposits in open water get a shoal. Extractors drain them; a destroyed extractor drops 40% of its cost plus 30% of what it mined. The minimap shows the remaining amount. |
| Procedural textures | All surfaces are currently shader-generated (`terrainShader.ts`, `materials.ts`), with no image assets. This is a placeholder layer that the asset pipeline replaces with authored or generated glTF + PBR. |
| Procedural terrain | Seeded simplex fBm + ridged multifractal per biome, with flattened base plateaus and deposit pads. Levels (`content/levels/*.json`) can pin bases and deposits and override biome parameters. |
| Call-downs (Annihilation-style) | B with a Constructor pack: walls, plasma turrets, AA batteries, remote inventory, extractors (on vents only), bridge spans, sky platforms, outposts (generator + inventory + turret), command uplink, siege tank drop. They arrive by orbital drop pod, which crushes enemies under it. |
| Sky platforms + beam-up | A 38 m deck 220 m above a ground beacon. Step into the beam to teleport up or down. Platforms are banned within 700 m of the enemy base ("guarded airspace"). Enemy AA batteries engage anything that flies or jets more than 14 m above the ground. |
| Underwater bases in archipelagos | In the archipelago biome, bases sit on the seabed inside an **air dome**. Inside the dome is dry; outside you swim (buoyancy by armor, drag, look-direction swimming). Underwater the jetpack thrusts along your view direction (**jet-swimming**), so dive attacks on seabed flags are possible. The vehicle pad and an AA battery sit on an island shoulder. |
| Bridges for siege tanks | Bridge spans follow your aim for 110 m, stepping smoothly between banks above sea level. Tanks drive on structure tops, so a bridge is the ground route across a strait. |
| Materiel economy | Each team has a materiel pool. Kills drop salvage orbs (+20), destroyed structures and vehicles drop 40% of their cost, extractors mine 2 × richness every 4 s from finite deposits (and are fragile targets), and a capture is worth +100. Materiel pays for call-downs, vehicles, earthworks and rebuilding. |
| Icy tundra & katabatic winds | Wind = prevailing + **katabatic drainage** (cold air flowing down the large-scale terrain gradient, strongest near the surface, arriving in surges) + gusts. Shrikes and APCs get shoved around, especially low over ridges. Lakes are frozen into skiable ice that also cools jets. |
| Cooperative capital call-downs | The siege drop needs a Command Uplink. It places a beacon that only charges while **2+ tribemates hold it**. Bots answer the crew call. |
| Bots | Offense, defense, and builder roles. Bots ski downhill and jet uphill, look ahead along their velocity to clear ridges, steer by velocity to line up flag runs, lead targets with splash/gravity compensation, and manage energy/heat with hysteresis. Builders tap vents, guard them with turrets and buy uplinks. |

| Building: snapping & merges | Mouse wheel rotates pieces in 15° steps; **R** tilts walls into ramps (45°) and floor slabs (90°); hold **Alt** to place freely. Pieces **snap** via sockets: walls continue end-to-end or turn right-angle corners (a post is added at the junction), stack on top of each other, and floor slabs pivot onto wall tops to roof a room. Bridges extend from bridge ends. **Tiny Glade-style merges:** a turret dropped onto a wall top turns that wall into a **Wall Battery** (battlements, integrated gun, +height, +range), and an AA battery becomes a **Flak Tower**. The ghost preview shows the real piece in green (free), blue (snapped) or gold (merge). Colliders support full rotation (ramps are walkable). |
| Weapon realism | Projectiles feel **air drag relative to the wind**, so grenades and mortars drift in katabatic gales; chaingun rounds **drop** and lose damage with range. Weapons have **magazines and reloads** (R). The chaingun **spins up** and its spread **blooms** under sustained fire. Spread grows with your own speed and when airborne, and the crosshair shows the real cone. Weapons have **recoil** (camera and view-model kick), **muzzle flashes**, **headshot** multipliers for bullets, and **cover**: walls and ridges absorb 75% of splash damage. Sound arrives at the speed of sound, so you see a far explosion before you hear it. |
| Characters & animation | Generated, skinned, high-poly characters (scout / assault / juggernaut) built from data, wearing layered PBR materials and animated by generated motions (idle, run, ski, jet, fall) chosen from physics state. See [docs/CHARACTER_TOOLCHAIN.md](docs/CHARACTER_TOOLCHAIN.md). |

## Architecture

```
src/
  config.ts            all tuning tables (armor, weapons, call-downs, vehicles)
  noise.ts             seeded simplex / fBm / ridged noise
  world/biomes.ts      biome definitions: height functions, palette, wind, sea, cooling
  world/terrain.ts     heightfield, exact triangle queries, raycast, permanent craters, road grading, deposits, surface map
  content/level.ts     level schema + validator (agents and players author levels as JSON)
  content/catalog.ts   bundles every content/levels/*.json into the menu
  world/terrainShader.ts  shared GLSL noise, fog, terrain material
  world/environment.ts sky, sea/ice, wind field, wind particles, cold-surface proximity
  game/colliders.ts    yaw-rotated OBBs: sphere push-out, ray slab test, surface queries
  game/materials.ts    procedural plate (damage/repair-seam) + lit + glow materials
  game/player.ts       Controls intent + Tribes movement physics + firing
  game/weapons.ts      projectiles (swept vs entities/boxes/terrain/water), effects
  game/structures.ts   blueprints, piecewise destruction + rebuild, power, turrets/AA, extractors
  game/vehicles.ts     four vehicle flight/drive models
  game/build.ts        call-down validation, drop pods, bridges, road grading
scripts/
  validate.ts          level validation (npm run validate)
  playtest.ts          headless bot matches with quality gates (npm run playtest)
  game/ctf.ts          flags, swept touch tests, captures
  game/bots.ts         bot brains
  game/game.ts         orchestration: setup, fixed-step tick, combat resolution, camera, input
  ui/hud.ts, ui/menus.ts  DOM HUD, minimap, menus
  audio.ts             synthesized WebAudio
```

* **Sim/presentation split.** Players, bots and vehicles are driven only by a `Controls` intent
  struct, and the sim runs at a fixed 60 Hz. This is the seam for networking: the server runs `tick()`
  and clients send `Controls`.
* **Headless.** `new Game(setup, null, input, audio, onEnd, { headless: true })` runs the full sim in Node with
  a bot in every seat. `npm run playtest` runs every level for 5–10 simulated minutes, about 1.5 s per level.
* **Performance.** About 528k terrain triangles in one draw call, around 60 draw calls total, and
  about 5.5 ms per frame on the dev machine.

## Roadmap

### Next (playable multiplayer)
* **Netcode.** An authoritative server (Node or Deno) runs the same `Game.tick`. Clients send `Controls`
  at 60 Hz and get ghost snapshots in the style of the Tribes networking model
  (`TribesRaw/notes/netcode.pdf`): per-object priority by distance/visibility/relevance, delta-compressed
  state, client-side prediction for the local player, and interpolation for everyone else.
  Transport: WebTransport, falling back to WebSocket.
* **Multi-seat vehicles.** Tank gunner, APC passengers and a tailgunner. Bots use vehicles: cappers
  on Turbogravs, builders flying APCs to forward vents.
* **Sky platform detection.** Platforms are hidden from the minimap unless a sensor or a spotter sees
  them. Air-raid AI for bombers.

### Strategy layer
* **Tech tiers.** Uplink → Orbital Yard → Capital. Bigger cooperative drops need more crew and
  structures held: Gunship (AI-flown strafing pass), Shield Generator dome, Carrier (a mobile
  spawn point that flies).
* **Mining claims.** Extractor chains connected by conduits, which are themselves targets and raid
  objectives. A Spoils Hauler vehicle has to physically bring raw materiel home.
* **Snap-grid base building** for walls, ramps, floors and force-field doors.

### World
* **Weather events.** Katabatic storms (whiteout plus gale), sandstorms that mask sensors, tides
  that flood straits and raise the sea level.
* **More biomes.** Volcanic (hot vents that *heat* jets but give lift), gas-giant cloud-deck
  (sky platforms only), glacier crevasse fields.
* **Chunked LOD terrain** for 8–16 km worlds, plus GPU deformation.
* **Bots that terraform:** builders grade roads toward motherlodes, and siege crews drive tanks down them.

### Feel
* Heat signatures and heat-seeking missiles, a reason to jet less and ski more.
* Armor and weapon models, first-person animation, hit indicators, voice-chat-style quick
  commands (T2's V-menu).
* Settings menu: sensitivity, FOV, invert-Y, key binds.
