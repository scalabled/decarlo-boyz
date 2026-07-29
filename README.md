# DECARLO BOYZ — Steel City

> **[▶ Play it](https://scalabled.github.io/decarlo-boyz/)** — runs in the browser, no install. Desktop recommended; mobile will chug.

An open-world third-person action game in the browser. Three.js r180 + WebGL2.

**There are no art assets.** Every texture, mesh, animation and sound is generated
procedurally at load time from code. No models, no HDRIs, no image files, no audio
files. The only runtime dependency is `three`.

![Downtown from the Mt. Washington clifftop](screenshots/skyline.png)

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

More frames in [`screenshots/`](screenshots/). Nothing in them was painted — the
skyline, the wet asphalt, the cars and the three brothers are all generated at
runtime.

## What it took to build

| | |
|---|---|
| Wall-clock span | **51.3 hours** |
| Agents run | **996** — 812 in orchestrated workflows, 184 standalone |
| Workflows | **15** |
| Tokens, excluding cache reads | **264.2 M** |
| Tokens, including cache reads | **9.94 B** |
| Output tokens | **28.8 M** |
| Tool calls | **35,772** |
| Model round-trips | **57,804** |

Which produced **180,426 lines** of runtime source across 19 subsystems, plus
**10,801 lines** of automated gates — roughly one line of test harness for every
eleven lines of game.

**61% of all tool calls were `Bash`**, at about five per `Edit`. That ratio is the
whole method: almost every one of them was a measurement — booting the game
headless, driving real key presses, casting rays at the emitted geometry, diffing
before against after. Full breakdown in [`METRICS.md`](METRICS.md).

## The game

Steel City — a Pittsburgh of three rivers, forty bridges, hillside inclines and a
dying mill economy. You play the **DeCarlo brothers** and switch between them:

- **Carson**, the eldest — river hand. Runs freight on the water. Toughest, slowest.
- **Aidan**, the middle — body man. Owns the shop on Butler Street. Best all-rounder.
- **Dylan**, the youngest — courier. Fastest thing on the hill, no impulse control.

Eight story chapters each, their own turf, their own rivals — the Harbormaster on
the water, Duke Marrow on Butler Street, Viper Lane on the incline.

`DESIGN.md` is the content bible: districts, rivers, landmarks, vehicles, weapons,
missions, radio stations, art direction.
`ARCHITECTURE.md` is the engine contract: subsystem interface, directory
ownership, the world/road-graph API, the cross-subsystem event vocabulary, and
the quality bar. It carries 13 hard rules, each enforced by a gate.
`METRICS.md` records what it cost to build.

## Subsystems

| id | what it does |
|---|---|
| `render` | HDR pipeline, cascaded shadow maps, MRT depth/normal/velocity prepass, GTAO, TAA, motion blur, bloom, GPU EV100 metering, procedural grade LUT, AgX composite, aerial perspective |
| `materials` | GPU texture forge — procedural PBR surfaces, seamless periodic noise, height→normal, parallax occlusion, triplanar, curvature edge wear, car paint, a global wetness system |
| `sky` | Atmospheric scattering, day/night cycle, weather states, rain, volumetric fog and light shafts, PMREM environment generation |
| `world` | The city plan: terrain, the road-network graph, rivers and bridges, districts, lot subdivision, tile streaming, static collision |
| `buildings` | Procedural buildings from lots — facades, shopfronts, roofs, LOD chain, landmarks, interiors |
| `props` | Street furniture, vegetation, signage, wires, litter, graffiti, road decals |
| `vehicles` | Vehicle dynamics, procedural car/bike/truck/boat meshes, damage deformation, lights |
| `traffic` | AI drivers on the road graph — lanes, junctions, lights, parking |
| `peds` | Pedestrian crowds, sidewalk navigation, reactions, ragdolls |
| `police` | Wanted level 1-5, cop AI, pursuit, roadblocks on the bridges |
| `physics` | From scratch, no library. Binned-SAH BVH, swept-capsule character controller, impulse rigid bodies with CCD, PBD ragdolls |
| `player` | Third-person movement state machine, the camera rig, enter/exit vehicle, health/armour |
| `weapons` | Improvised industrial arsenal — nail gun, flare gun, harpoon, EMP coil |
| `fx` | GPU particles, decals, tracers, tyre smoke, skid marks, rain splash, explosions |
| `ui` | HUD — the Slag Ring minimap that heats to molten orange with the wanted level |
| `audio` | Web Audio synthesis, six generative radio stations, spatialisation, reverb |
| `game` | Character switching, 24 story chapters, economy, save/load |

## Tooling

The harness is what makes the quality loop work.

| tool | purpose |
|---|---|
| `tools/capture.mjs` | Screenshot one named shot via GPU-backed headless Chromium. Accepts inline JSON as the shot name to frame an arbitrary camera |
| `tools/shotset.mjs` | The whole review set in one session |
| `tools/baseline.mjs` | **Reproducible** capture: each shot in an isolated page, fixed frame budget, bit-identical across runs |
| `tools/imagediff.mjs` | Per-pixel gate. Exits non-zero if any pixel moved |
| `tools/ab.mjs` | **Blind** A/B composites: two builds side by side in randomised order, with the key written where the critic can't see it |
| `tools/profile.mjs` | Frame-time distribution at real device pixel ratio, with hitch attribution via per-frame WebGL program counts |
| `tools/playtest.mjs` | Scripted movement/fire smoke test |

Beyond those there are 66 gate files under `src/`, one per subsystem area, wired
into three tiers: `npm run gate` (~13 s, the line every change pays),
`npm run handoff` (adds the browser probes) and `npm run soak` (everything).

The rule they all obey is worth stating here, because it is the one that keeps
them honest: **a gate must not re-use the code's own inputs.** Nine gates in this
project were found to be asserting against the very value the implementation had
just produced, and every one of them was green while the thing it guarded was
broken.

## Credits

Created by [@mrinreality1](https://x.com/mrinreality1).

The engine core, render pipeline, material forge, physics, sky and FX are forked
from [Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty) by mshumer (MIT —
see `LICENSE.upstream`) and transformed from a corridor shooter into a streamed
open city. The game design, world and characters come from the original
single-file prototype it grew out of.
