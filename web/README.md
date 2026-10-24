# Vastlands (browser)

A Tribes-like for the browser: skiing, jetpacks, spinfusors, CTF, vehicles, Annihilation-style
call-downs, destructible bases and permanent terraforming. Three.js + TypeScript. It's built to be
extended by agents: levels are JSON, and every change is checked by headless bot playtests.

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

See [DESIGN.md](DESIGN.md) for the game, [docs/AGENTIC_PIPELINE.md](docs/AGENTIC_PIPELINE.md) for the
agent-driven production plan, [docs/CHARACTER_TOOLCHAIN.md](docs/CHARACTER_TOOLCHAIN.md) and
[docs/ANIME_PIPELINE.md](docs/ANIME_PIPELINE.md) for characters, and [AGENTS.md](AGENTS.md) for the agent playbook.
The asset workbench is at `/workbench.html`.

```bash
npm run validate                      # check every level in content/levels
npm run playtest -- all --minutes 10  # headless bot matches with quality gates
npm run check                         # typecheck + validate + playtests
```

## Controls

| Key | Action |
|---|---|
| WASD | Move |
| Space | Jump. **Hold to ski** (frictionless, so gravity along the slope accelerates you) |
| Right mouse / Shift | Jetpack (uses energy, builds heat; cools fastest low over ice or water) |
| Left mouse | Fire |
| 1–5, Q, wheel | Weapons |
| E | Use inventory station / vehicle station / enter or exit vehicle |
| I | Loadout (near a powered inventory station, or while dead) |
| B | Build menu (needs the Constructor pack). 1-0 / `-` / `[` `]` to choose, **wheel to rotate**, **R to tilt** walls (ramp/floor), hold **Alt** to skip snapping, LMB to drop. Turrets dropped on walls merge into batteries. Grade Road takes two clicks: start, then end |
| R | Reload (outside build mode) |
| F (hold) | Repair beam (Repair pack): fixes damage and rebuilds blown-out panels for materiel |
| G | Deploy / pack up the Havoc APC's inventory station |
| C / Ctrl | Descend (APC) |
| V | Toggle third person |
| Tab | Scoreboard |

## Debugging

`window.game` is the live `Game`. `window.startMatch({ biome: 'tundra' | 'archipelago' | 'badlands', seed, teamSize })`
skips the menu. The sim is fixed-step, so you can fast-forward headlessly, e.g.
`for (let i = 0; i < 60 * 600; i++) game.frame(1 / 60)` runs ten minutes of bot play.
