# DECARLO BOYZ — engine contract

**Read this before writing code.** It is the contract every subsystem is held to,
and the rules below are enforced by gates rather than by convention.

Target: a browser **open-world third-person action game** whose *visual and tactile
quality* stands next to **Grand Theft Auto V**. WebGL2 + Three.js r180, no external
art assets — all textures, meshes, animation and audio are generated procedurally
at load time.

The engine, render pipeline, procedural material forge, physics, sky and FX are
forked from [Claude-of-Duty](https://github.com/mshumer/Claude-of-Duty) (MIT,
© 2026 mshumer) and are being transformed from a 120 m corridor shooter into a
streamed open city. See `LICENSE.upstream`.

## GTA V is the QUALITY BAR. The city is PITTSBURGH.

Read that twice, because getting it backwards produces the wrong game.

**We are not building Los Santos.** The map is **Steel City** — a Pittsburgh of
three rivers meeting at The Point, forty bridges, hillside inclines, a downtown
triangle hemmed in by water, Mt. Washington rising 120 m off the south bank, and a
dying mill economy. Every district, landmark, river and street in `DESIGN.md` is
Pittsburgh geography. Los Santos is a sprawling coastal Los Angeles; nothing about
its layout, its climate or its palette applies here.

What we take from GTA V is the **standard of execution**, nothing else:

- **Scale you can drive.** Kilometres of connected road at 180 km/h, not a block.
  Draw distance to a visible downtown skyline and hills beyond it.
- **A living street.** Traffic that obeys lanes and lights, pedestrians on
  sidewalks that react, police that escalate. Emptiness reads as "tech demo".
- **Weight in the driving.** Body roll, weight transfer under brakes, tyre
  squeal, suspension travel visible on the wheels, a chase camera that lags and
  settles. If the car feels like a floating box, the shot does not count.
- **Density of authored detail.** Kerbs, drains, road paint that wears at
  junctions, wires, aircon units, fire escapes, litter, graffiti, shopfronts with
  distinct signage. Nothing tiles visibly, nothing repeats in a line.
- **Systems that hold together.** One contextual action, one objective marker,
  feedback on every input, and a sim that refuses to break. See `GAMEPLAY.md`.

### The look is Pittsburgh's, and it is the opposite of Los Santos's

Do not reach for the Rockstar sun-bleached pastel. `DESIGN.md` is the authority:
**sodium-lamp amber, molten slag orange, river teal and cold steel over a wet
grey-brown rustbelt base.** Overcast leanings, river fog at dawn, rain that makes
asphalt mirror the sodium lamps, steam off grates and mill stacks. Colder, heavier
and more industrial than Los Santos — and that contrast is the point of the
project, not a compromise. The money shots are golden hour over the Ohio and a wet
downtown night, not a beach.

Where this document or a review says "does it look like GTA V", it means *would
this survive being paused next to a shipped AAA frame* — never *does it look like
Los Angeles*.

## Hard rules

1. **Keep changes inside one subsystem's directory.** A change that has to
   reach across directories is a design smell: publish an API instead.
2. **Never import another subsystem's module.** Get it at runtime:
   `const veh = ctx.get('vehicles')`. This is what keeps subsystems separable —
   any one of them can be rewritten without reading the others.
3. **No new npm dependencies.** `three` only. No CDN fetches, no external
   images/HDRIs/models/audio files — the game must run fully offline.
4. **No `Math.random()` in gameplay or visuals.** Use `ctx.rng` (see
   `src/core/rng.js`) or a `ctx.rng.fork()` you keep. Capture reproducibility
   depends on it.
5. **Allocate nothing per-frame.** Preallocate vectors, matrices and arrays in
   `init()` and reuse. A `new THREE.Vector3()` inside `update()` is a bug.
6. **Dispose what you create.** Geometries, materials, textures and render
   targets get freed in `dispose()`.
7. **Instance everything repeated.** A city is hundreds of thousands of objects.
   Kerb sections, windows, lamps, trees, parked cars, road paint: `InstancedMesh`
   or merged geometry per tile. A per-object draw call is a bug at city scale.
8. **Respect the streaming budget.** Never build more than
   `ctx.config.q.tileBuildBudgetMs` of geometry in one frame. Amortise across
   frames with the job queue in `ctx.get('world').schedule(fn)`.

   **Exception, deliberate: under `config.deterministic` (capture mode) the
   budget is denominated in WORK, not milliseconds** — a fixed number of jobs
   per frame, never branching on the clock. Same shape as `engine.js` skipping
   its wall-clock `FIXED_STEP_BUDGET_MS`, and for the same reason: how much a
   millisecond buys is machine- and load-dependent, so a wall-clock budget means
   a loaded machine photographs less city than an idle one.

   MEASURED before the fix: three captures of one unchanged shot gave 2959 /
   4074 / 4096 draw calls and 8.26M / 10.94M / 10.96M triangles. After: every
   capture is **byte-identical** (identical md5, RMSE 0 across all pairs, idle
   and under 20 spinners alike). Negative control with the fix disabled: no pair
   reaches 0 and one run in six is a clear outlier, regardless of load.

   A non-obvious consequence worth knowing, because it silently changed what was
   IN the picture: a millisecond budget leaves `deferred > 0`, which keeps
   `staticWorld.dirty` true, and `props` refuses to run its wall-dressing pass
   against a stale BVH. So on a loaded machine the frame simply had no ghost
   signs, no ivy, no flyposting and no aerosol — content missing for a reason
   with nothing to do with content.
9. `npm run build` must pass and `node tools/capture.mjs --shot=hero` must
   produce a frame after your change. If you break the boot, nobody else can work.

   Run **`npm run gate`** before you hand work back. MEASURED, wall clock, one
   machine, in chain order: `lint` 0.2 s, `syntaxcheck` 3.3 s, `damageprobe`
   0.2 s, `wreckprobe` 0.4 s, `sparkprobe` 0.1 s, `blastprobe` 0.1 s,
   `copfireprobe` 0.1 s, `gaitprobe` 0.1 s, `crowdprobe` 1.1 s, `colprobe`
   3.3 s, `headprobe` 5.1 s, `persistprobe` 0.2 s — **14.2 s for the lot.**
   Kept out of `build` only because the seconds add up over a working day, not
   because it is optional.

   **Every one of those is a NODE process that never opens a browser.** That is
   the entry price for `gate`, and it is the whole reason `gate` is worth
   running: it is short enough that nobody games it. A probe that boots vite
   goes in `handoff` or `soak` instead. Do not put a browser probe in `gate`.

   **If you touched `src/player/`, `src/vehicles/`, the camera, the pause path
   or anything a person walks into, run `npm run handoff`** — `gate` + `face` +
   `camtest` + `drivetest` + `groundprobe` + `feeltest` + `meleeprobe` +
   `camlagtest` + `pausearbiterprobe` + `pausefreeroamprobe` +
   `weapons/pauseprobe` + `clockownerprobe` + `coverprobe` + `bootaudioprobe`.
   The behaviour benches are deliberately NOT in `gate`: `feeltest` alone boots
   vite and the whole engine and steps ~9 000 frames — 50 s, of which 12 s is
   boot. Putting that on every gate run is a tax paid all day, every day.

   **`handoff` MEASURED END TO END is 960 s — sixteen minutes.** That is not
   what the per-probe list above suggests, and the gap is the point. Every
   member, measured individually on one idle machine:

   | member | s | | member | s |
   |---|---|---|---|---|
   | `gate` | 13 | | `pausegate` | 44 |
   | `face` | 7 | | `pausefree` | 30 |
   | `cam` | 1 | | `pauseweap` | 51 |
   | `drive` | <1 | | `clockowner` | 47 |
   | **`ground`** | **357** | | `cover` | 42 |
   | `feel` | 45 | | `bootaudio` | 11 |
   | `melee` | 45 | | `camlag` | 22 |

   **`ground` alone is 357 s — more than half the chain, and it had never been
   costed here at all.** For years this section named `feeltest` as the
   expensive one ("50 s, of which 12 s is boot"); `feeltest` measures 45 s and
   that was always right, but it was never the problem. The rule two paragraphs
   up already says what to do — *if one of these grows past a minute, split the
   chain rather than dropping the probe* — and `src/vehicles/groundprobe.mjs` is
   eight times past that line. Whoever owns `src/vehicles/` should split it.

   Note how this was found: not by reading the list, which looked fine, but by
   running `npm run handoff` with a clock on it. **A chain's cost is not the sum
   of the costs you wrote down; it is what happens when you run the chain.**
   Same rule-12 shape as everything else in this document — the intermediate you
   already have is not the measurement.

   **A probe with no `package.json` entry is not a gate, it is a file.** Six
   once landed with no way to invoke them at all. When you
   add a probe, add its script in the same change, and say in your handoff
   whether it is green — an entry pointing at a red probe is fine and useful,
   but it does not go in the `handoff` chain until it passes, because a chain
   that fails for someone else's reason teaches people to skip the chain.

   **This has now been swept exhaustively once.** Every `*probe*.mjs` /
   `*test*.mjs` under `src/` and `tools/` has an entry, and the invariant is
   mechanically checkable — this one-liner must print nothing:

   ```sh
   node -e 'const p=require("./package.json"),a=Object.values(p.scripts).join(" ");
     require("child_process").execSync("find src tools -name \"*.mjs\"").toString()
       .trim().split("\n").filter(f=>/probe|test/i.test(f.split("/").pop())&&!a.includes(f))
       .forEach(f=>console.log("ORPHAN",f))'
   ```

   Run it when you add a probe. **It caught five more orphans that landed WHILE
   the sweep was running** — `src/ui/controlsprobe.mjs`, `src/peds/seatprobe.mjs`,
   `src/player/blockblastprobe.mjs`, `src/vehicles/laneprobe.mjs`,
   `src/vehicles/toughprobe.mjs` — five in about two hours. That is the actual
   half-life of the problem, and it is why the detector matters more than the
   sweep: one exhaustive pass buys you a couple of hours, and a one-liner in a
   pre-handoff habit buys you the rest.

   **WHICH CHAIN DOES MY PROBE GO IN?** Three tiers, and the boundary between
   them is COST, not importance. Pick by measuring, not by how much you like
   your probe.

   | tier | what goes in | budget | when |
   |---|---|---|---|
   | `gate` | node-only, green, **under ~3.5 s each** | 13 s MEASURED | every hand-back, no exceptions |
   | `handoff` | + browser probes for movement / camera / pause / anything a person walks into | **960 s MEASURED**, and 357 s of that is one probe — see below | you touched `src/player/`, `src/vehicles/`, the camera or the pause path |
   | `soak` | + every other green probe in the tree | ~30 min, estimated from the per-probe table below and NOT yet measured end to end — treat it as a lower bound | end of a wave, or a change too broad to reason about |

   Those budgets are measurements, not intentions. Where a number says
   "estimated", it is a number nobody has earned yet; replace it when you run
   the chain, and do not quote it as though it were measured.

   Two rules keep the tiers honest, and both have been broken before:

   - **A RED probe never goes in a chain.** Wire it, run it, report it — but a
     chain that fails for somebody else's reason is a chain people learn to
     skip, and then the green ones stop protecting anything either. The
     currently-red set is listed below.
   - **A FLAKY probe never goes in a chain either**, and flaky is worse than
     red: red gets fixed, flaky gets ignored along with everything chained
     after it. If you cannot say whether a failure is your change or the
     harness, it is not chain material yet.

   **`diag:*` scripts are NOT gates and must never be chained.** They print a
   report and exit 0 whatever they find — `diag:body`, `diag:smoke`, `diag:hdr`,
   `diag:clear`, `diag:enter`, `diag:chase`, `diag:beam`. They have entries so
   they are discoverable and so nobody re-writes one; `diag:body`
   (`src/player/playtest.mjs`) exits non-zero only if the harness itself throws,
   which is exactly the shape of a gate that measures nothing. Read them with
   your eyes.

   The green probes wired in that sweep, MEASURED, so the next person routing
   one has a scale to compare against:

   | script | file | cost | result | tier |
   |---|---|---|---|---|
   | `tough` | `src/vehicles/toughprobe.mjs` | 0.2 s | 16/16 | gate |
   | `spark` | `src/fx/sparkprobe.mjs` | 0.1 s | 15/15 | gate |
   | `blast` | `src/peds/blastprobe.mjs` | 0.1 s | 20/20 | gate |
   | `copfire` | `src/police/copfireprobe.mjs` | 0.1 s | 7/7 | gate |
   | `gait` | `src/peds/gaitprobe.mjs` | 0.1 s | PASS | gate |
   | `crowd` | `src/peds/crowdprobe.mjs` | 1.1 s | PASS | gate |
   | `col` | `src/physics/colprobe.mjs` | 3.3 s | 34/34 | gate |
   | `face` | `src/peds/faceprobe.mjs` | 6.2 s | 20/20 | handoff |
   | `pauseweap` | `src/weapons/pauseprobe.mjs` | 76 s | PASS | handoff |
   | `clockowner` | `src/ui/clockownerprobe.mjs` | 71 s | PASS | handoff |
   | `worldgate` | `src/world/probe.mjs` | 12 s | ALL PASSED | soak |
   | `solid` | `src/buildings/solidprobe.mjs` | 29 s | 4/4 | soak |
   | `skyline` | `src/buildings/skyprobe.mjs` | 29 s | PASSED | soak |
   | `pedpose` | `src/peds/poseprobe.mjs` | 28 s | PASS | soak |
   | `wind` | `src/buildings/windprobe.mjs` | 38 s | PASSED | soak |
   | `shotgate` | `src/render/shotprobe.mjs` | 44 s | PASS | soak |
   | `keylight` | `src/sky/keyprobe.mjs` | 47 s | PASS | soak |
   | `touch` | `src/ui/touchprobe.mjs` | 51 s | PASS | soak |
   | `blockblast` | `src/player/blockblastprobe.mjs` | 52 s | 8/8 | soak |
   | `pedlight` | `src/peds/lightprobe.mjs` | 66 s | PASS | soak |
   | `live` | `src/vehicles/liveprobe.mjs` | 81 s | PASS | soak |
   | `pauseui` | `src/ui/pauseprobe.mjs` | 93 s | PASS | soak |
   | `dossier` | `src/game/dossierprobe.mjs` | 107 s | 32/32 | soak |
   | `spawn` | `src/game/spawnprobe.mjs` | 135 s | 23/23 | soak |
   | `street` | `src/peds/streetprobe.mjs` | 195 s | PASS | soak |
   | `pedshadow` | `src/peds/shadowprobe.mjs` | 213 s | PASS | soak |

   Browser costs above were measured three-at-a-time on one machine and are
   therefore pessimistic; the ordering is what matters.

   **Runnable but deliberately NOT chained, and for two DIFFERENT reasons —
   the distinction is the point:**

   - `npm run stolen` (`src/police/stolenprobe.mjs`, 53-87 s) is **RED and
     deterministic**: 9/10, failing "the player really drives the stolen
     cruiser" at exactly `1.2 m under throttle in ~3.3 s` on both runs. That is
     a real defect in emitted behaviour, and it stays out of the chain only
     until somebody in `src/police` / `src/vehicles` fixes it. Put it in.
   - `npm run audio` (`src/audio/probe.mjs`, 63-88 s) is **FLAKY**: 3 passes
     and 1 failure in 4 runs of one unchanged build, always the same check —
     "the radio never advanced a bar" (`radio.bar < 1`, `probe.mjs:209`), i.e.
     the bar counter had not ticked yet when the sample was taken. Same
     judgement as `playprobe` below: a chained `&&` that fails one run in four
     teaches people to ignore the whole chain. Either the check needs to wait
     on the scheduler instead of racing it, or the scheduler has a real stall —
     nobody has separated those two yet, and the probe cannot tell you which
     because a pass and a fail look identical apart from one integer.

   **The rest of the RED set, as measured in the sweep that wired all of these.**
   Each belongs to whoever owns the directory; none is in a chain, and none was
   touched while wiring it up, deliberately — a probe edited by someone with an
   interest in it going green is not a probe any more (rule 13).

   | script | file | cost | state |
   |---|---|---|---|
   | `npm run corpse` | `src/peds/corpseprobe.mjs` | 4.9 s, node | `FAIL: REACH 1.16 > 1.15`, a RATCHET missed by 0.01. Worst BBOX 1.35x, 95/96 asleep by 5 s |
   | `npm run vehdrive` | `src/vehicles/drivetest.mjs` | 3.9 s, node | 619/629 drive assertions |
   | `npm run lane` | `src/vehicles/laneprobe.mjs` | 0.5 s, node | 28/29 keyboard lane keeping. Landed mid-sweep |
   | `npm run seat` | `src/peds/seatprobe.mjs` | 3.0 s, node | **green at 18:2x, red at 18:41, deterministically (2/2)** — "sports @LOD2: far-crowd driver is inside the car, tightest capsule clearance 0.011 m". Both it and `src/peds/index.js` were rewritten between the two runs. It was chained into `handoff` on the strength of the first run and pulled out again on the second, which is the correct outcome and also the argument for measuring the chain END TO END after you edit it |
   | `npm run cutscene` | `src/ui/cutsceneprobe.mjs` | 39 s | 44/46 — the typewriter dumps the whole 45-char line on the first sample, 999 cps against a reference 46 |
   | `npm run stuck` | `src/physics/stuckprobe.mjs` | 90 s | 2/5 sites did not move; the probe itself attributes both to physics, not the drivetrain — chassis inside a collider reporting 0 contacts |
   | `npm run contact` | `src/render/contactprobe.mjs` | 118 s | 4/5 on the `fixed` arm |
   | `npm run playtest` | `src/game/playtest.mjs` | 103 s | chapters 24/24, systems 39/40 |
   | `npm run meleehit` | `src/weapons/meleetest.mjs` | 121 s | 28/34 swings connected with the player fallback disabled |
   | `npm run arsenal` | `src/weapons/arsenalprobe.mjs` | 247 s | 161/162 — the single red is `vehicle` 4/5; every other area is clean |
   | `npm run move` | `src/player/moveprobe.mjs` | **873 s** | 9/11 — sprint does not re-engage after ADS (67%) or on a direction change with Shift held (0%), and holding Shift does not make the car faster (gains −0.09 / −0.61 / −1.37 m/s over three matched runs) |
   | `npm run crew` | `src/peds/crewtest.mjs` | **623 s** | 88/92. Car-avoidance overshoots (5.64 m closest approach with it on vs 0.38 m off, want < 4), a brother trails 17.97 m, and 37.5 µs/ped with the crew vs 25.0 without — though that last one is 8 peds against a 100 µs timer quantum and may be measuring the clock, not the crew |
   | `npm run controls` | `src/ui/controlsprobe.mjs` | 29 s | 21/24 — `J` is bound nowhere, and the "every key we name is read by a live subsystem" check is red. Landed mid-sweep |
   | `npm run cheats` | `src/ui/cheatprobe.mjs` | 61 s | **was already wired and already red, and nobody had noticed** — `open false, time.scale 0` twice: the cheat panel closes and the clock stays stopped. That is a `claim`/`release` leak, i.e. an instance of the pause contract below, not a cheat-menu bug |

   **`move` at 873 s and `crew` at 623 s are on their own the reason `soak`
   exists and the reason neither is in it.** Ten to fifteen minutes for one
   probe is past the point where anyone will wait, green or red; if they go
   green they still want splitting before they are chained. Cost is a
   correctness property of a gate, not a comfort one — an unaffordable gate is
   an unrun gate, and an unrun gate is the file it started as.

   `npm run interact` (`src/game/interactprobe.mjs`, ~84 s) is GREEN, 38/38,
   and is the deep gate on the contextual-action chain in `src/game/freeroam.js`
   — every branch of `F`, driven through the real key path and the real DOM
   prompt. Run it when you touch `src/game/`. It is out of `handoff` on cost
   alone; `pausefree` (20 s) is in the chain and covers the half of it that
   every subsystem can break.

   **Green when you wired it is not green when you hand it back.** `seat` above
   went red 20 minutes after it was measured, because its owner shipped work in
   between — and it took `handoff` down with it at the second step. So the last
   thing you do before handing back is **run the chain you edited, whole**, not
   the probes you added one at a time. A chain is a claim about the tree at a
   moment; re-measure it at the moment you make the claim.

   **A boot break somewhere else looks exactly like your regression.**
   Two of the runs behind these numbers died on `page.waitForFunction: Timeout`
   with `[boot] init failed` — once `ReferenceError: GUARD is not defined` in
   `src/player/anim/animator.js`, once `Cannot set properties of undefined` in
   `src/ui/menu.js` — neither in a file the probe touches. Both cleared on a
   re-run with no source change at all. Before
   you debug a browser-probe failure, **read the first lines of the log**: if
   it is `init failed`, the engine never booted and the probe measured nothing
   about your change.

   **`playprobe` and `playtest --quick` are deliberately NOT chained into
   `handoff`.** MEASURED over 8 runs of one unchanged build: playprobe scored
   28/28 five times and 25-27 three times, across three unrelated symptom
   families, and an A/B of the reverted arm failed the same way 1 run in 5. A
   chained `&&` that fails two runs in five teaches people to ignore the whole
   chain, which costs more than the flake does. Run them, read them, and A/B
   before blaming your own change.

   `headprobe` exists because the character's hairline has now regressed
   **twice**, and the second regression was caused by the fix for the first: the
   fringe was lifted out of the nose and brow, which pulled the cap up and left
   bare scalp across both temples and the whole back of the skull. Measured bare
   cranium rays before the second fix: carson 1365, aidan 766, dylan 363.
   It ray-casts the real emitted geometry and gates five properties at once —
   no bare cranium, no facial feature buried by the fringe, eyebrows still
   visible, ears not swallowed, head verts rigid on the head bone. Its target
   hairline is deliberately looser than what `mesh.js` builds, so it cannot pass
   by simply agreeing with whatever the code currently does.

   The general lesson, which is not about hair: when a fix moves a shared
   boundary, the thing to verify is the WHOLE boundary, not the side you were
   asked about. The first fix was verified only from the front.

12. **A gate must not re-use the code's own inputs.** If it does, it compares a
    number to itself, always passes, and is worse than no gate — because it
    reports a guarantee it never checked.

    This has now bitten this project three times, each time producing confident
    numbers that were meaningless:

    - `skyline` asserted "every visible impostor's base is exactly on terrain"
      by re-sampling `heightAt` at **the same x/z the placement used**. It
      passed while 53 of 57 visible impostors in one frame had up to 28 m of
      daylight under them, because both the code and the gate asked about a
      single centre point of a box up to 71 m across. On a hillside the downhill
      half hung in the air and the uphill half was buried to the eaves — leaving
      just a roof and its plant in the sky, which is what everyone kept
      reporting as "a floating water tank". The gate now samples a grid over the
      EMITTED GEOMETRY'S OWN BOUNDS, which is a different and tighter set than
      the placement arithmetic uses.
    - `playprobe` asserted the car drove by reading `velocity.length()`, which
      is unsigned. It scored 20/20 on a build where the player could only travel
      in reverse.
    - `playprobe` counted grounded wheels as `w.grounded || w.contact`, and
      `w.contact` is a preallocated Vector3 — always truthy. Every "4 wheels
      down" reading ever printed, including in two frozen-car investigations,
      was meaningless.
    - `playprobe`'s site guard — "still on drivable ground before the brake
      test", which exists precisely so a river bank is not scored as a gearbox —
      read `rig.surface !== 'water'`, and `rig.surface` was
      `v.surface ?? v.groundSurface ?? null`. **A `Vehicle` has neither
      property.** It was `null !== 'water'` on every run the probe has ever
      made, so the one check written to stop the harness manufacturing ghosts
      could not fire, and the harness went on manufacturing them: a captured run
      scored that guard PASS with `inWater: true, submerged 0.59` and then filed
      the buoyancy as a drivetrain defect (`rpm 6319, throttle 1, gear 1,
      wheelsDown 0, fwd 1.03 m/s`). It now reads the surface tag off the wheels'
      EMITTED contacts, reports `air` rather than `null` when nothing is
      touching, and the drive phase stops at the verge instead of 400 frames
      later in the Allegheny. Note the shape of it: **a guard whose whole job is
      to reject bad test conditions is the last place anyone re-reads, because
      when it is broken everything looks fine.** That is the general lesson, and
      it has now been paid for twice — the water guard above, and a `Vehicle`
      water check in a probe that read properties a `Vehicle` has never had.
    - A **camera gate that re-read the solver's own matrix.** It asserted the
      camera was correctly placed by reading back the very matrix the camera
      solver consumes, so its residual could not have been anything but zero.
      It scored a perfect result on every build it was ever run against,
      including the ones with the defect. `src/player/camlagtest.mjs` now
      measures the DRAWN pose — where the car's `model.root` actually is in
      camera space, across frames, at two speeds — and carries three negative
      controls. Its predecessor is the sixth gate this project has shipped that
      measured nothing.
    - **A damage gate that stubbed the FX exit to a NOOP.**
      `src/vehicles/damageprobe.mjs` builds its fake physics with
      `{ spawnDebris: NOOP, emitImpact: NOOP }` (`damageprobe.mjs:146`). That is
      a reasonable-looking harness convenience and it blinded the gate to an
      entire axis of the thing it is named after: every round and every swing on
      every car in the city was emitting the IDENTICAL maximal spark burst,
      because both vehicle-hit call sites handed `fx` the number they had just
      given `vehicles.damage()` — vehicle points, 90-3000 — into a slot whose
      knee saturates at 55 actor points. Measured on the emitted particles: the
      flash intensity of nailgun, SMG, rivet gun, speargun, harpoon, pipe,
      crowbar and wrench on a car was 17.000 for all eight, the ceiling, while
      the same rounds on concrete still ranged 9.9 to 17.0. The damage gate was
      green throughout, and correctly so — it had unplugged the wire the defect
      travelled down. `src/fx/sparkprobe.mjs` (`npm run spark`) now measures
      that wire: every assertion is a RATIO OF TWO EMITTED FLASHES taken at
      `fx.emitAdd`, four subsystems downstream, and it names in its header every
      module it leaves as production code. Note the generalisation, because
      "stub the bits I don't care about" is the most natural harness instinct
      there is: **a stub is an assertion that nothing downstream of it can be
      wrong.** Write that assertion down where the next reader will see it, or
      leave the path real.

    **Count them: seven.** That is not seven unlucky accidents, it is a
    systematic pull, and it has one cause — the intermediate the code already computed is
    always the easiest value to reach, and it is always the wrong one. Reaching
    for the emitted artefact is more work every single time. Do it anyway.

    A fourth, subtler instance is worth studying because the number LOOKED like
    independent evidence: the analytic `heightAt` field and the drawn terrain
    mesh "agree within about 2.4 m at 2.4 km", reported as reassurance that the terrain surface was sound. It was not
    evidence of anything: **the terrain mesh is built by point-sampling
    `heightAt` at its own vertices**, so it is exact at every point a naive
    comparison checks and free to be wrong by up to 62 m in between. The real
    error was found by asking a different question — what the mesh does BETWEEN
    its samples — which exposed per-LOD DC offsets of -0.60 m vs +0.31 m, a rim
    octave running at 0.46 cycles per sample (+/-29 m), and a per-quad diagonal
    choice worth up to 53.9 m at the quad centre.

    Sampling a function at the points where another thing was built from that
    same function is the same mistake as re-reading your own input. It just
    hides better, because it produces a plausible non-zero number instead of an
    obviously circular one.

    **The same disease has a spatial form: two subsystems deciding the same
    fact.** The Point Fountain was at (-712, 32) in `buildings` and (-452, 46)
    in `world` — and the first is 8.7 m UNDER the Ohio. Separately, `buildings`
    DISCOVERED the Duquesne Incline's uphill bearing by probing terrain, while
    `world` decided the reserved footprint; reserving the ground changed the
    terrain by the 0.55 m every road corridor sinks it, the 48-bearing scan
    flipped, and the trestle swung **30 degrees straight out of its own reserved
    capsule**. Neither subsystem was wrong on its own terms. One fact, one owner:
    `world.landmarks[].site` is now the source of truth for both WHERE a landmark
    is and WHICH WAY it faces, and `buildings` adopts it rather than re-deriving
    it.

    The test to apply before trusting any gate: **what input would make this
    fail?** If you cannot name one, or if the answer is "the same value the
    production code already computed", the gate is decorative. Prefer asserting
    against the emitted artefact — geometry, pixels, the signed physical
    quantity — rather than against the intermediate the code used to make it.

    Corollary: a gate that has never failed is not evidence of correctness. Give
    every gate a negative control — revert the fix and confirm it goes red. The
    vehicle gate scores 208/208 fixed and 130/208 reverted, which is what makes
    the 208 mean something.

13. **Mark a threshold RATCHET when it records where you got to, not where the
    bar is.** Quality work lands in passes, and a gate written after one pass
    usually encodes that pass's result. That is fine and useful — it stops a
    regression — but it is not the goal, and the next person cannot tell the
    difference unless you say so.

    So label it, put the real goal and your diagnosis next to it, and state the
    rule: **lower a RATCHET when you improve it; never raise one to make a run
    go green.** Raising it is how a gate quietly becomes a record of decay.

    Live examples: `src/peds/gaitprobe.mjs` and `src/peds/streetprobe.mjs` carry
    RATCHET thresholds for foot slide (in-game 1.92 -> 0.86 m; the goal is ~0)
    with the remaining cause written beside them — jog and run share the walk's
    knee and ankle lobe shapes, so a run has no flight phase, which is content
    work rather than maths.
10. **Never put a backtick inside a GLSL template literal.** Shaders live in
    ``const FRAG = /* glsl */ `...` `` and it is natural to write a comment that
    quotes an identifier `` `likeThis` ``. That backtick CLOSES the template.
    Everything after it is parsed as JavaScript, and you get a `ReferenceError:
    someGlslVariable is not defined` at runtime pointing at a line of shader
    code that is completely valid. Same for a stray `${` in shader text — it
    becomes an interpolation. Quote identifiers in shader comments with plain
    text or single quotes.

    This applies to **CSS template literals too**, not just GLSL. It has now
    broken the boot in three separate subsystems — `src/sky/clouds.js`
    (`uViewPos`), `src/materials/shader.js` (`owUpFace`), `src/ui/style.js`
    (`.ow-hud`) — and each one took down every capture at once, because a red
    boot is a global outage, not a local bug.

    **This is now gated mechanically.** `npm run build` runs
    `node tools/lintticks.mjs` first and refuses to build on a finding. Run it
    directly (`npm run lint`) before you hand work back — it takes under a
    second and it is much cheaper than the ten minutes this costs everyone else.
    `node tools/lintticks.mjs --selftest` proves the scanner still catches all
    three historical breaks without firing on legal code.

    **The rule has a SECOND HABITAT, and it is nastier.** Every headless harness
    sends page snippets as template literals — `page.evaluate(\`...\`)` with real
    code inside. A backtick in a comment in one of those closes it exactly the
    same way, and the file stops parsing. But `lintticks` only reads `src/**.js`,
    and `vite build` never bundles a harness — so **the build stays green, the
    gate stays green, and the check silently stops running.** A harness that will
    not parse is worse than a failing one, because nothing tells you it is gone.

    `npm run gate` therefore also runs `node tools/syntaxcheck.mjs`, which
    `node --check`s every `.mjs` file under `src/` and `tools/` (114 as of this
    writing — it prints the count, so do not trust a number in prose). It catches
    the backtick case and every other syntax error, which matters because the
    next instance of this will not necessarily be a backtick.
11. **A fullscreen-quad pass must use `new THREE.OrthographicCamera(-1,1,1,-1,0,1)`,
    never a bare `new THREE.Camera()`.** `render` runs a reversed-Z depth buffer,
    and three's `setProgram` reacts to that by calling
    `camera.updateProjectionMatrix()` on whatever camera it was handed — a method
    the base `Camera` class does not have. The throw unwinds through the composite
    loop, so every pass after yours is skipped and **the whole screen goes black**.
    See the write-up in `src/sky/fullscreen.js`.

## Subsystem interface

```js
export class MySystem {
  static id = 'mysystem';       // unique; how others reach you
  static deps = ['render'];     // ids that must init before you

  async init(ctx) {}            // build resources; may await
  fixedUpdate(h, ctx) {}        // optional, 120 Hz, deterministic gameplay
  update(dt, ctx) {}            // optional, once per frame
  cameraUpdate(dt, ctx) {}      // optional, CAMERAS ONLY — see below
  lateUpdate(dt, ctx) {}        // optional, after all update()
  resize(w, h, ctx) {}          // optional
  dispose() {}                  // optional
}
```

The phases run in exactly that order, once per frame, for every registered
subsystem in topo order (`src/core/engine.js:250-255`).

**`cameraUpdate` is a PHASE, not a hook for late work.** It runs after ALL
`update()` and before ALL `lateUpdate()`, and the only thing that belongs in it
is camera placement. It exists because a camera has to be composed against the
transforms the renderer is about to draw, and several of those are written in
another subsystem's `update()`: a chase camera solved from `player.update()`
reads the car's render transform one whole frame late — **measured 0.245 m at
54 km/h and 0.373 m at 108 km/h**, which is one frame of travel, not a fixed
error.

Two things about it are worth knowing before you touch it:

- **On its own it moves the camera by zero.** A build with the phase and a
  build without it agree to every printed digit. Its value is that it makes the
  pose-source fix in `src/player/camera.js` (reading `v.model?.root` rather
  than `v.position`) legal — that line only works from `cameraUpdate`, and with
  the fix in place but the phase removed the camera sits a full frame BEHIND
  the car, which is strictly worse than the original bug. **The two land
  together or not at all.** Anyone reading "this phase does nothing, delete it"
  off a diff is reading a true sentence and drawing the wrong conclusion; the
  four-build table is in `src/core/engine.js`.

  **This has now survived a deliberate re-litigation.** The phase was
  independently re-measured by someone who had not added it, precisely because
  the zero looks like dead weight on a diff, and it was KEPT — not because the
  re-measurement found a delta (it found the same zero) but because the second
  and third rows of the four-build table are the whole argument, and neither of
  them is visible from a one-build measurement:

  | phase | pose source | result |
  |---|---|---|
  | absent | `v.position` | the original bug — one frame of lag |
  | absent | `v.model.root` | **worse than the bug** — a full frame behind |
  | present | `v.position` | identical to the original bug |
  | present | `v.model.root` | correct |

  So the honest one-line summary is: *the phase is a PRECONDITION, not an
  improvement.* Measuring it alone can only ever return zero, and a zero is
  exactly what you would expect from a precondition whose beneficiary you did
  not also install. Do not delete it, and do not re-measure it in isolation and
  conclude anything — if you want to know whether it earns its keep, flip the
  pose source in `src/player/camera.js` at the same time and read all four
  cells. `npm run camlag` (`src/player/camlagtest.mjs`) is that gate, and its
  three negative controls are exactly the off-diagonal rows above.
- Anything that MOVES a rendered transform belongs in `update()`. Anything that
  must observe the FINAL camera belongs in `lateUpdate()`. Four subsystems
  still read the camera from their own `update()` and so see last frame's —
  they are named and costed in `src/core/engine.js`.

`node src/player/camlagtest.mjs` (`npm run camlag`) is the gate: two
independent checks at two speeds plus three negative controls.

`ctx` provides: `scene`, `camera`, `viewScene`, `viewCamera`, `canvas`,
`config`, `events`, `input`, `time`, `rng`, `get(id)`, `peek(id)`, `has(id)`.

- `scene` / `camera` — the world. `viewScene` / `viewCamera` — overlay scene
  drawn after the world with a cleared depth buffer (first-person arms, in-car
  interior detail that must never clip).
- `time` — `{ elapsed, raw, dt, fixed, alpha, scale, frame }`. Use `alpha` to
  interpolate rendered transforms between physics steps.
- `config.q` — the active quality preset (see `src/core/config.js`). Respect
  `q.taa`, `q.gtao`, `q.ssr`, `q.volumetrics`, `q.shadowMapSize`,
  `q.particleBudget`, `q.decalBudget`, `q.streamRadius`, `q.trafficBudget`,
  `q.pedBudget`, `q.tileBuildBudgetMs`, `q.lightSlots`. Never exceed a budget.

## Ownership map

| id | directory | owns |
|---|---|---|
| `render` | `src/render/` | WebGLRenderer, HDR pipeline, all post-processing, CSM shadows, aerial perspective, the final composite |
| `materials` | `src/materials/` | procedural PBR texture generation, the shared material library, triplanar/detail mapping, car paint, road surfaces, foliage, wet/dry variants |
| `sky` | `src/sky/` | physical sky, sun/moon, time of day, weather state, **falling rain + lightning**, IBL/env map generation, volumetric fog & light shafts |
| `world` | `src/world/` | **the city plan**: terrain, the road-network graph, districts, block/lot subdivision, tile streaming, static collision, water |
| `buildings` | `src/buildings/` | procedural building geometry from `world` lots: facades, shopfronts, roofs, LOD chain, skyline landmarks, enterable interiors |
| `props` | `src/props/` | street furniture, vegetation, signage, wires, litter, graffiti, parked-car dressing, road decals |
| `vehicles` | `src/vehicles/` | vehicle dynamics, procedural car/bike/truck meshes, damage deformation, lights, wheels, engine state |
| `traffic` | `src/traffic/` | AI drivers on the road graph, lanes, junctions, traffic lights, parking, reactions to the player |
| `peds` | `src/peds/` | pedestrian crowds, sidewalk navigation, animation, reactions, panic, ragdoll death |
| `police` | `src/police/` | wanted level, cop AI, pursuit driving, roadblocks, escalation, spawn director |
| `physics` | `src/physics/` | broadphase, raycasts, character controller collision, rigid bodies, vehicle constraint support, ragdolls, penetration |
| `player` | `src/player/` | third-person movement state machine, camera rig, aim mode, enter/exit vehicle, health/armour |
| `weapons` | `src/weapons/` | weapon meshes, third-person + ADS rigs, recoil, reload animation, ballistics |
| `fx` | `src/fx/` | GPU particles, muzzle flash, tracers, impacts, decals, tyre smoke, skid marks, sparks, explosions, and **everything rain does on arrival**: splashes, ripples, ledge drips, windscreen droplets, and the road spray thrown from moving wheels |
| `ui` | `src/ui/` | HUD: street minimap, wanted stars, health/armour arcs, weapon wheel, mission text, phone, menus |
| `audio` | `src/audio/` | synthesized engine/weapon/foley audio, radio stations, city ambience, spatialisation, reverb |
| `game` | `src/game/` | mission flow, objectives, economy, save/load, spawn director, day cycle rules, score |

Shared, owned by the lead (do not edit): `src/core/`, `src/main.js`,
`src/dev/`, `tools/`, `vite.config.js`, `ARCHITECTURE.md`.

## The world contract (read this even if you don't own `world`)

`world` is the authority on where everything is. It exposes:

```js
const w = ctx.get('world');

w.CITY_SIZE                   // metres, square, origin-centred
w.heightAt(x, z)              // terrain height, metres
w.surfaceAt(x, z)             // 'asphalt' | 'sidewalk' | 'dirt' | 'grass' | 'water' | 'sand'
w.roads                       // RoadGraph (see below)
w.districtAt(x, z)            // { id, name, density, wealth, palette }
w.lotsInTile(tx, tz)          // Lot[] for building generation
w.schedule(fn, priority)      // amortised build job, respects the frame budget
w.tileOf(x, z)                // { tx, tz }
w.isWater(x, z)
w.streamingIdle()             // true when the amortised build queue has drained
w.walkableHeightAt(x, z, y?)  // the surface a man or a car STANDS on — analytic,
                              // always available, city-wide
```

### `heightAt` is NOT the ground. Use `walkableHeightAt`.

`heightAt` returns the TERRAIN, and the terrain is sunk 0.55 m under every road
corridor with the kerb 15 cm above that — so `heightAt` on a pavement is most of a
metre below the pavement. `groundHeight()` routes through `walkableHeightAt`, and
so should anything else that wants a surface to stand on.

### The collision contract, in two layers

`world` keeps real triangle collision within `TCOL_HALF` (320 m) of the camera,
**plus an always-resident coarse ground shell over the whole city on
`LAYER.CLIP`** (25 m grid, 32 768 tris, built once).

`CLIP` is in `MASK.CHARACTER` and `MASK.DEBRIS` and in **neither** `MASK.WORLD`
nor `MASK.BULLET`. So capsules and ragdolls always land on something, while
bullets, cameras, cover queries, decals and `groundHeight` never see it. Each
shell vertex takes the *minimum* terrain over the cells it corners, so the sheet
is provably at or below real ground and can never win against real geometry.

That combination took capsule floor coverage from 11.6% to 100% while leaving the
ray path unchanged (p95 error 0.06 m, hits-below-ground 0.27%). Putting the shell
on `STATIC` instead would have traded that 0.27% for ~90%.

Bullet rays beyond the triangle radius are closed separately: `physics.raycast`
falls back to solving against `walkableHeightAt` analytically (sphere-traced march
+ bisection, no triangles, no BVH cost) and is proven never to pre-empt a real
triangle. Ray ground coverage is 100% city-wide.

`streamingIdle()` is REQUIRED. `tools/capture.mjs` polls it (via
`window.__SETTLED__`) and refuses to press the shutter until it returns true —
a shot teleports the camera kilometres, so without it every capture photographs
a half-built city and every critic reports defects that are really just a
premature screenshot. Return false while any tile in the stream radius still has
queued build work, in `world` or in any subsystem that builds off
`world:tile:load`.

`RoadGraph` is the spine of traffic, police, peds and the minimap:

```js
roads.nodes                   // { id, x, z, y, kind: 'junction'|'bend', links:[edgeId] }
roads.edges                   // { id, a, b, lanes, width, kind:'highway'|'arterial'|'street'|'alley', oneway }
roads.laneCenter(edgeId, lane, t, out)  // Vector3 at parameter t along a lane
roads.nearestEdge(x, z)                 // { edge, t, lane, dist }
roads.route(fromNodeId, toNodeId)       // nodeId[] — A*, used by traffic + police
roads.sampleSpawn(rng, nearXZ, minDist, maxDist)  // a legal spawn pose on a lane
```

A `Lot` is what `buildings` consumes:

```js
{ id, tx, tz, footprint: [x,z][], // CCW polygon, metres, world space
  frontage: [ [ax,az],[bx,bz] ],  // the street-facing edge
  district, height, floors, kind: 'tower'|'block'|'shop'|'house'|'industrial'|'park'|'lot',
  seed }                          // deterministic per-lot rng seed
```

Streaming events on `ctx.events`:

| event | payload | meaning |
|---|---|---|
| `world:tile:load` | `{ tx, tz, lots, bounds }` | build geometry for this tile now (amortised) |
| `world:tile:unload` | `{ tx, tz }` | free everything you built for it |
| `world:ready` | `{}` | first ring of tiles around the player is built |

`buildings` and `props` MUST build only in response to `world:tile:load` and MUST
free in `world:tile:unload`. Nothing may build the whole city up front.

## The wetness contract

Rain is a headline feature, so wetness is a first-class global, not a per-material
flag. `sky` owns the value and `materials` owns what it does:

```js
ctx.get('materials').setWetness(w)   // w in 0..1, pushed by `sky` at up to 4 Hz
```

Wetness must darken albedo, drop roughness, fill crevices **from the height map
first** so puddles collect in the low spots rather than uniformly, and add a
specular sheen. It is an *integral*, not a state: `sky` models asymmetric attack
and decay (~2.5 min to soak, 4–8 min to dry), so it arrives as a smoothly varying
number and has to read correctly at intermediate values, not just 0 and 1.

The value also rides on every `weather:change` payload and is readable as
`sky.wetness`, but `setWetness` is the primary path.

## The pause contract — ONE clock owner, and the invariant everyone gets wrong

`ctx.time.scale` has exactly one writer: the pause arbiter in `src/ui/index.js`.
Nothing else may assign it. Before that was true, four features each banked
their own "previous scale" and restored it unconditionally, and the shipped
build could put the player in the pause menu with controls disabled and the
city running at FULL SPEED — traffic moving, the wanted timer ticking, cops
shooting a man who could not move — after nothing more exotic than holding TAB
and pressing ESC.

```js
const ui = ctx.peek('ui');            // OPTIONAL — benches boot without it

ui.pause.claim('hitstop', 0.12)       // register or refresh a named claim
ui.pause.release('hitstop')           // drop it
ui.pause.release()                    // NO ARGUMENT — full teardown, for dispose()
ui.isPaused()                         // is the world STOPPED (not merely slowed)
```

Three properties are the whole design, and each one is load-bearing:

- **The resolved scale is a pure function of WHICH claims are live** — the
  lowest wins. A `0` can therefore never be out-voted by a `0.12` or a `0.22`,
  in any arrival or release order. Nobody banks a private previous value.
- **`scale` is an ABSOLUTE target, not a factor of the current clock.** Mixing
  absolutes and multipliers would make the answer depend on arrival order,
  which is precisely the property being bought. `hitstop` asks for 0.12 and
  gets 0.12 even if free play was running at 0.28 under the demo driver.
- **`base` is never sampled at claim time.** It used to be, and a modal opened
  one frame into a 0.12 hitstop banked 0.12 and ran the world at 0.12 *for
  ever*. The arbiter now watches the clock while it holds nothing and adopts a
  value only after it has stood for `FREE_PLAY_SETTLE` (0.25 s of `time.raw`,
  comfortably past `HITSTOP_MAX` = 0.15 s).

`ui`'s own claims (`menu`, `ending`, `cheats`, `story`, `map`, `phone`, `card`,
`cut` at 0; `wheel` at bullet time) are DERIVED every frame from a freshly built
wants record, so they cannot leak — there is no release call to forget. Only
subsystems outside `ui` use `claim` / `release`, because `ui` may not import
them (rule 2). While nothing is claiming, the arbiter does not touch `scale` at
all, so `tools/capture.mjs` and `tools/demo-driver.js` keep the clock in free
play.

**"Cannot leak" is a property of the design, not a fact about the build.**
`npm run cheats` (`src/ui/cheatprobe.mjs`) is red on the tree right now, twice,
with `open false, time.scale 0, any modal false` — the cheat panel is down,
every derived want reads false, and the world is still stopped. Something is
holding the clock that the wants record does not know about. Whoever owns
`src/ui/` should read that as a pause-contract defect and not as a cheat-menu
one: the failing assertion is about `time.scale`, and the panel is incidental.
It had a `package.json` entry and was red before this sweep — nobody was
running it.

### THE INVARIANT: `time.scale = 0` does NOT stop `update()`

Write it on the wall. **A stopped clock stops SIMULATED TIME. It does not stop
the frame loop, it does not stop your `update()` being called, and it does not
stop input edges arriving at full rate.** `input.pressed('KeyF')` is an edge off
the real keyboard, sampled per frame, and a frame still happens sixty times a
second behind a pause menu.

So: **every subsystem that reads input must gate on `ui.isPaused()` itself.**

This exact mistake has now been found and fixed in THREE separate subsystems —
`game` (`src/game/index.js:760`), `weapons` (`src/weapons/index.js:769`) and
`game/freeroam` (`src/game/freeroam.js:_usePressed`). Three independent authors,
same wrong assumption, and the failure is silent every time: no error, no log,
just a weapon switched or a car boarded from behind a menu the player is reading.
Assume the fourth instance is already in the tree.

Four rules for writing the gate, all of them paid for:

1. **Reach `ui` through `ctx.peek('ui')`, never an import** (rule 2), and treat
   it as OPTIONAL. The model-preview page and every headless bench boot without
   `ui`. **No `ui` means nothing is paused** — that is the correct answer for a
   build with no menus, not a reason to throw. Duck-type it:
   `ui?.isPaused?.() === true`.
2. **Gate the READ, not just the effect,** and put the check FIRST — above the
   input reads, so it also covers the `actionPressed()` path a touch build
   takes.
3. **`isPaused()` is "stopped", not "an overlay is up".** The weapon wheel
   claims bullet time, not a freeze, so `isPaused()` is false under it and the
   number row goes on working while it is open — which is the entire point of a
   radial selector. Gating on "any overlay is visible" instead breaks TAB;
   `src/ui/pauseprobe.mjs` has a check that fails if anyone tries it.
4. **Gate in BOTH the caller and the callee.** `game._update` already declines
   to call `freeroam.update(dt)` while paused, and that works — and it is one
   `if` away from not working, because `_update`'s ordering is edited often and
   `freeroam.update` is not obviously input-bearing from outside. Belt and
   braces is correct here; the redundant check costs one property read.

Every one of those gates carries a `debugIgnorePause` switch so its probe can
run the negative control against the LIVE code with no edit
(`src/game/freeroam.js:162`, `src/weapons/index.js:192`). Keep the pattern: a
pause gate whose failure mode is invisible needs a control that proves the gate
is what is stopping the key, and not the harness failing to press it.

**Five probes cover this, and they are deliberately not the same probe.** The
split is worth understanding before you add a sixth:

| script | file | what it proves |
|---|---|---|
| `npm run pausegate` | `src/ui/pausearbiterprobe.mjs` | the world really is stopped while the player is IN a modal, and the claim algebra is order-independent |
| `npm run pauseui` | `src/ui/pauseprobe.mjs` | the player can get back OUT. It **shims pointer lock**, because headless Chromium never grants it — `document.pointerLockElement` stays null under `--headless=new`, after a real gesture, with every flag. The entire "ESC menu will not close, I have to refresh" bug lived in that path, which is exactly how it shipped past every other probe |
| `npm run clockowner` | `src/ui/clockownerprobe.mjs` | the EXTERNAL `claim`/`release` door — who hands the clock back and at what speed. Asserts on `(Δtime.elapsed / Δtime.raw)`, simulated seconds per real second, and never on `held` / `base` / `frozen` / `isPaused()`: a build with a perfect claim table that forgot the clock fails every case |
| `npm run pausefree` | `src/game/pausefreeroamprobe.mjs` | `F` cannot board a car from behind the menu |
| `npm run pauseweap` | `src/weapons/pauseprobe.mjs` | the number row cannot switch weapons from behind the menu, **and still works under the wheel's bullet time** |

If you are tempted to merge them: `pausegate` and `pauseui` are the two halves
of the same door and both have shipped broken independently, and the last two
are per-subsystem instances of the invariant above, which is exactly the thing
that recurs. The one that would actually be redundant is a sixth that re-reads
`ui._wants`.

## Cross-subsystem events

Emit and listen via `ctx.events`. Payloads are plain objects. The canonical set:

| event | payload | emitted by |
|---|---|---|
| `weapon:fire` | `{ weapon, origin: Vector3, dir: Vector3, seed }` | weapons |
| `weapon:reload` | `{ weapon, phase: 'start'\|'magout'\|'magin'\|'end' }` | weapons |
| `weapon:shell` | `{ position, velocity }` | weapons |
| `bullet:impact` | `{ point, normal, surface, incident, damage }` | physics |
| `bullet:tracer` | `{ from, to, speed }` | weapons |
| `damage:dealt` | `{ target, amount, headshot, killed, point }` + optional `{ melee, source, from, incident, part }` | peds / police / physics / weapons / player |
| ↳ | means *damage dealt **to** `target`*. `target` is the local player when a round connects (`'player'`, the player system, or anything with `isPlayer === true`) — filter it out before drawing a hitmarker. Damage is applied by the target's own listener, never by the emitter as well. | |
| ↳ | **`melee: true`** marks a hit that came from a swing rather than a round (`src/player/melee.js:187,193` — both the swing and the riposte payload carry it). **`source`** is the actor that dealt it, so a listener can tell who swung: the player system for a player swing, the `Ped` for `peds.onPedPunch` (`src/peds/index.js:1305`). Both are OPTIONAL — most emitters omit them, so branch on presence, never assume the field is there. | |
| `damage:taken` | `{ amount, from: Vector3, health }` | player |
| `actor:death` | `{ actor, point, impulse, headshot }` | peds / police |
| ↳ | **Never raised for a brother.** `police` prices this (`killPed` / `killCop`), `game` counts it and `ui` draws it, so emitting it for the player's own crew would charge a wanted star and a kill notification every time one of them went down — `src/peds/ped.js:1175` guards on `!this.crew`. Mission enemies are ordinary pedestrians and DO raise it. | |
| `player:land` | `{ velocity, surface }` | player |
| `player:footstep` | `{ position, surface, running }` | player |
| `player:state` | `{ stance, sprinting, aiming, inVehicle }` | player |
| `explosion` | `{ position, radius, damage }` | any |
| `resize` | `{ width, height }` | engine |
| `vehicle:enter` | `{ vehicle, actor, seat }` | player / peds |
| `vehicle:exit` | `{ vehicle, actor }` | player / peds |
| `vehicle:collision` | `{ vehicle, other, point, normal, impulse, speed }` | vehicles |
| `vehicle:skid` | `{ vehicle, wheel, point, normal, slip, surface }` | vehicles |
| `vehicle:engine` | `{ vehicle, rpm, throttle, gear, load, speed }` | vehicles |
| `vehicle:destroyed` | `{ vehicle, point }` | vehicles |
| `vehicle:horn` | `{ vehicle, on, position }` — edges only | vehicles |
| `vehicle:fuel` | `{ vehicle, fuel, dry, player }` — edges only. Only the PLAYER's car burns fuel; AI traffic stranding itself in a junction is a blocked road, not a mechanic | vehicles |
| `wanted:change` | `{ level, prev }` | police |
| `wanted:heat` | `{ position, radius }` | police |
| `weather:change` | `{ state, wetness, rain, wind }` | sky |
| `time:hour` | `{ hour }` | sky |
| `mission:start` \| `mission:complete` \| `mission:fail` | `{ id }` | game |
| `money:change` | `{ amount, total, reason }` | game |
| `ui:map` | `{ open }` | ui |
| `ui:waypoint` | `{ x, z, cleared }` | ui |
| `ui:weapon` | `{ id }` | ui — player picked from the weapon wheel |
| `ui:character` | `{ id }` | ui — player picked a brother from the switch wheel |
| `ui:station` | `{ id }` | ui — radio station changed |
| `ui:pause` \| `ui:quality` \| `ui:sensitivity` \| `ui:fov` \| `ui:setting` | varies | ui |
| `ui:action` | `{ source, verb, available }` — the contextual action button fired. `source` is `'touch'` or `'key'` | ui |
| `game:unlock` | `{ kind, id, label }` | game |
| `game:action` | `{ id, short, label, sub, key, available, target }` — the resolved contextual action changed. THE single source of truth for what `F` / the ACT button will do right now | game |
| `game:service` | `{ kind, progress, done }` — a passive service (refuel, repair, heal, save) is running or finished | game |
| `game:action:blocked` | `{ id, reason }` — an action was attempted and refused, so `ui` can say why | game |
| `game:character` | `{ id, from }` | game — active brother changed |
| `police:busted` | `{ position, officer }` | police — an arrest completed |
| `crew:spawn` | `{ id, name }` | peds |
| `crew:down` | `{ id, name, ward, noRevive, x, z }` | peds |
| `crew:revive` | `{ id, name }` | peds |
| `crew:hurt` | `{ id, amount, hp, maxHp }` | peds |
| `crew:board` | `{ count, vehicle, caught }` | peds |
| `crew:exit` | `{ count, vehicle }` | peds |
| `crew:line` | `{ id, line }` | peds — a scripted line, in his own colour |
| `crew:friendlyfire` | `{ id, amount }` | peds — a round of the PLAYER'S landed on a brother. Already attenuated when it fires |

### Cross-subsystem methods worth knowing about

Reached through `ctx.get(id)` / `ctx.peek(id)` — never an import (rule 2).
These are the ones a caller in another directory is likely to want and unlikely
to guess.

**`police`** is a subscriber to `vehicle:enter`, and the handler runs last, so
every other listener has had its turn before the fleet is touched.

| method | contract |
|---|---|
| `police.releaseVehicle(v)` | this cruiser is not ours any more. Drops the unit and returns its officers to the pedestrian population; **despawns nothing**. Returns `true` if a unit actually owned the car. This is the difference between an escapable wanted level and a permanent one — a cruiser the player has stolen must stop being a police unit, or the fleet keeps chasing a car it thinks it owns. |
| `police.isPlayerCar(v)` | is the player in it or driving it. The guard on **every** despawn path in `police`, so a car the player is sitting in can never be retired out from under him. Checks the player system's own vehicle, `v.driver`, every entry in `v.occupants`, and the quarry last. |

**`peds`** owns mission enemies as well as the crowd — `game/hostiles.js` is an
adapter over these, not a second population.

| method | contract |
|---|---|
| `peds.spawnHostile(position, opts)` | `opts` is `{hp,dmg,ranged,range,speed,scale,tag,leash}`. Returns the `Ped`, and that object IS the handle. |
| `peds.despawnHostile(ped)` / `peds.clearHostiles()` | remove one / all |
| `peds.hurtHostile(ped, amount, headshot?, point?)` | |
| `peds.hostileCount` | enemies on their feet |

**A mission enemy is a real pedestrian.** It carries a
`physics.createCharacter()` capsule — the only population in `peds` that
resolves its own movement against the world, because it is the only one that
walks at you rather than down a pavement — and it raises `actor:death` and
`damage:dealt` like any other ped. So anything already listening for a ped
death (`police` pricing it, `game` counting it, `ui` drawing it) picks up
mission kills for free, and anything that filters peds must decide whether it
means hostiles too. `npm run cover` is the gate on the movement half.

**The crew is a THIRD population** — the two brothers you are not playing —
and it is neither the crowd nor the hostiles. `game` and `player` drive it
through these:

| method | contract |
|---|---|
| `peds.spawnCrew(ids?)` | the two brothers you are NOT playing, by default; pass ids to override |
| `peds.despawnCrew()` | a solo chapter, a cutscene, a title card |
| `peds.crewState()` | `[{id,name,colour,x,z,up,hp,maxHp,inCar,…}]` — a **REUSED array**, for the minimap and the HUD. Do not retain it across frames |
| `peds.crewAlive()` | ids of the brothers on their feet |
| `peds.setCrewGuard(id, x, z)` | pin one in place; `(id, null)` releases |
| `peds.setCrewWard(id, opts)` / `peds.clearCrewWard()` | designate a `protect` ward (`noRevive`) |
| `peds.crewSay(id, line)` | a scripted line, in his own colour |
| `peds.downCrew(id)` / `peds.reviveCrew(id)` | |
| `peds.crew` | the manager, for anything else |

The crew raises the whole `crew:*` event family listed above — **and
deliberately does NOT raise `actor:death`** (`src/peds/ped.js:1175` guards on
`!this.crew`). A brother going down would otherwise charge a wanted star and
draw a kill notification, because `police` prices `actor:death` and `ui` draws
it. `crew:down` is the event for that, and it is not interchangeable.

Its budget contract is the mirror image of the bug `police` had. **It pays**
(`_targetPopulation` subtracts `crew.members.length` from the ambient target, so
two brothers are two fewer strangers and a quality preset means what it says);
**it never borrows** (companions live in `crew.pool`, a separate array, and
`_freePed()` — what `attachDriver()` hands `traffic` and `police` — only scans
`this.peds`, so the crew can never starve `spawnCop` the way `police` starved it
by borrowing bodies and not giving them back); and **it keeps its bodies**
(`maxBodies = ambientBodies + CREW_MAX`, so a brother is never demoted to a
far-LOD capsule to make room for a stranger, and is never streamed or
distance-culled). `npm run crew` (`src/peds/crewtest.mjs`, group `roster`) is
the gate on all three.

### `ACTOR_TO_VEHICLE` — the one damage currency conversion

`vehicles` publishes it: `export const ACTOR_TO_VEHICLE = 10`
(`src/vehicles/index.js:157`), and republishes it per-instance as
`veh.actorDamageScale` so no other subsystem has to hard-code our HP scale.

**There are two damage currencies in this engine and they differ by 10x.**

| currency | scale | who speaks it |
|---|---|---|
| **actor points** | ~100 HP reference body | weapons (`def.damage`: nail 20, SMG 16, rivet 40, harpoon 90), peds, the player, `explosion.damage`, `fx`'s impact knee |
| **vehicle points** | 900-3000 HP bodies | `Vehicle.health`, `vehicles.damage()`, `DamageModel.impact`, `game/tracks.js` scripted damage, `police/tune.js`'s `vehicleScale` |

Multiply by `ACTOR_TO_VEHICLE` **exactly once**, on the way into
`vehicles.damage()`, and only if the number you hold is in actor points.
Anything already speaking vehicle points must NOT be multiplied again.

It has been mis-applied in both directions, and both are worth knowing:

- **Missing on the way in.** All seven Scrap Rockets fired point blank left a
  sedan alive (11 measured to wreck one), and a wrecked car did ~3% of its
  neighbour's health, so the chain detonation `vehicles` has always listened for
  could never fire. Compounding it, `BLAST_TRANSFER` was 0.5 *on top of* the
  missing factor of ten — which is how the epicentre of a 140-point car wreck
  came to be worth 70 points against a 900-point sedan.
- **Applied and then leaked sideways, ON THE FX AXIS.** Both vehicle-hit call
  sites handed `fx.onImpact` the number they had just given `vehicles.damage()`
  — i.e. vehicle points — into a slot whose knee is
  `clamp(0.7 + damage / 55, 0.7, 1.7)`, authored in actor points and saturating
  at ~55. Every round and every swing on every car in the city therefore threw
  the identical maximal spark burst: measured 17.000 for all eight weapons,
  while the same rounds on concrete still ranged 9.9 to 17.0. Nothing threw and
  nothing logged; the fault was 300 lines away in `weapons/vehiclehit.js`.

  `fx.onImpact` deliberately does **not** clamp, rescale or sanity-check the
  incoming number, and must not be "hardened" to do so: **a slot that quietly
  absorbs a 10x error is how the error survives.** Emitters carry their own
  scale. `npm run spark` gates it on the emitted particles.

**Do not tie it to `REFERENCE_BODY_HP`** (also 100, also in
`src/vehicles/index.js`). That one is the yardstick the panel-dent COEFFICIENTS
were authored against — "what would this have been on a reference car" before
being turned into millimetres of sheet metal. One constant is about how much
health a bullet takes, the other about how big the hole looks; tying them
together made the crater a function of a bookkeeping constant.

### Two API footguns, both found the expensive way

- **`police.wanted` is the `WantedModel` OBJECT, not the star count. The integer
  is `police.level`.** Reading the wrong one is silent: it made `game`'s `escape`
  chapters uncompletable, and when the value was published it serialised the
  whole engine graph over the debug protocol.
- **`_sub(id)` in `src/ui/` returns a subsystem's `getHudState()`, not the
  subsystem.** `sky` does not implement one, so `_sub('sky')` is always null —
  which is why the HUD clock sat frozen at 17:23 through several review rounds
  and led two critic panels to conclude the night shot was "provably the same
  daylight scene". Use `ctx.peek(id)` when you want the system itself.

If you need an event that is not listed, add a row here in the same commit.

## Surface types

Shared vocabulary for impact FX, decals, audio, footsteps and tyre grip. Physics
tags every collider with one of: `concrete`, `asphalt`, `sidewalk`, `metal`,
`wood`, `dirt`, `sand`, `grass`, `gravel`, `glass`, `water`, `foliage`, `fabric`,
`flesh`, `rubber`, `plaster`, `carpaint`.

## Render integration

`render` exposes these to other subsystems:

```js
const r = ctx.get('render');
r.renderer            // THREE.WebGLRenderer — do not change its state outside a frame
r.registerPass(pass)  // insert a custom post pass
r.addLight(light)     // register a punctual light so it participates in culling/budgets
r.requestEnvMap()     // PMREM env map currently in use
r.screenSize          // { width, height } of the internal render target
r.depthTexture        // linear depth, for soft particles / SSR
r.velocityTexture     // motion vectors, for TAA / motion blur

r.submitLight(x,y,z,color,intensity,range,priority,key)
                      // per-frame candidate for one of q.lightSlots REAL point
                      // lights. The ONLY safe way to have many lights in a city:
                      // the pool's visible count never changes, so no submission
                      // can trigger a shader recompile. Use for headlights,
                      // muzzle flash, the nearest practicals.
r.registerCullGroup(root, { center, radius, maxDistance })
                      // hierarchical cull for ONE streamed tile. Returns an
                      // unregister fn. Call on world:tile:load / :unload.
r.unregisterCullGroup(root)
r.stats               // { draw, cullGroups, cullVisible, lods, lightSlots, ... }
r.lightBudget         // { slots, submitted, overflow }
```

`THREE.LOD` is supported natively — author level distances for a 1080p/60° frame
in metres and `render` rescales them by `q.lodBias`, FOV and resolution.
`mesh.userData.owStatic = true` skips per-frame velocity bookkeeping for geometry
that never moves. `mesh.userData.owLodScale` biases one object.

**`world`, `buildings` and `props` MUST adopt `registerCullGroup` and `THREE.LOD`.**
`r.stats` currently reports `cullGroups: 0, lods: 0` in every capture, and draw
calls (up to 3.8k) plus triangle count (8-13 M) are now the binding cost of the
whole frame — ultra sits at ~45 fps instead of 60 purely because of this. It
cannot be fixed from inside `src/render/`.

### `receiveShadow` — the bug that made the whole city look unlit

For a long stretch, nothing in the world received the cascade shadow or the
contact shadow, silently, while the cascades rendered perfectly and were sampled
by nobody. The injected sun-shadow term was gated on three's `receiveShadow`
uniform, and **`Object3D.receiveShadow` defaults to `false`** — and this document
said `owNoShadow` was "the ONLY shadow-caster switch" while saying nothing about
receivers, so no subsystem had any reason to set it.

That is exactly what the critic panel measured as "sunlit sand (178,165,145) and
its own cast shadow (133,131,131), a perfectly neutral grey — shadows are being
composited as a grey multiply". It was not a grey multiply. It was not a shadow
at all.

**Receivers are now unconditional: you do not need to set `receiveShadow`, and
setting it to `false` does nothing.** `owNoShadow` remains the only caster
switch. If you are ever debugging "my geometry looks flat and unlit", check
whether the shadow term is reaching it before you touch your material.

Anything drawn into `viewScene` is composited after the world with a cleared
depth buffer.

Per-object opt-outs, honoured every frame by `render._collect`:

```js
mesh.userData.owNoPrepass = true  // keep out of the depth/normal/velocity prepass
mesh.userData.owNoShadow  = true  // do not cast into the CSM cascades
```

`owNoShadow` is the ONLY shadow-caster switch: the cascades draw with
`scene.overrideMaterial` and never consult `mesh.castShadow`.

### The point-light count is a shader permutation key

A night city is thousands of lamps. Three bakes the number of **visible** point
lights into every material's program cache key, so one lamp crossing a threshold
recompiles every lit material in the scene — measured at +33 to +36 programs and
640-900 ms on that single frame. It is baked into the key of programs that never
read a light at all, including `csm-depth` and `ow-prepass`.

> **Corrected.** This section used to say the distance cull sets
> `light.visible = false` once the fade reaches zero. **It does not, and never
> did** — `render._cullLights` deliberately leaves `visible` alone. Because
> `world._stabiliseLightCount` sized its ballast top-up from the *fade* count
> while three counts the *visible* count, the routine whose entire job was to
> hold the number steady became the sole source of the variation. Measured: the
> count oscillated 14 -> 15 -> 16 in play, and the first crossing cost **1291 ms
> and 61 programs**. Firing a shot after walking somewhere new was enough.
>
> `render` now pins the count to whatever the pre-warm compiled at
> (`_enforceLightCount`, `?owNoLightLock=1` to disable for an A/B). Measured over
> seven counterbalanced runs, no overlap between arms: mean programs compiled
> mid-play 156 -> 49, worst single stall 1091 ms -> 293 ms.
>
> The lesson worth keeping: a stabiliser that measures a different quantity from
> the one it is stabilising is worse than nothing, because it manufactures the
> instability while looking like the defence against it.

Anything that registers distance-culled point lights must keep the **visible**
count constant. Two ways, both pixel-exact:

- drive `intensity` to 0 and leave `visible` true (what `src/fx/lights.js` does), or
- park zero-intensity "ballast" lights and top the count up to a fixed slot
  budget every `lateUpdate` (what `src/world` does — see `_stabiliseLightCount`).

**At city scale, punctual lights are not the answer for street lighting.** Use
emissive materials + bloom for the lamp itself and a small fixed pool of real
lights reserved for what is near the camera (headlights, muzzle flash, the two
nearest lamps). Budget: `q.lightSlots`.

### Pre-warm

`src/core/prewarm.js` runs before the first frame and calls
`prewarmMaterials(ctx)` on every subsystem that implements it. The contract:
**build and compile every material the subsystem can produce, without spawning
gameplay objects, drawing a gameplay frame, or touching the clock/RNG.**
`renderer.compileAsync(scene, camera)` alone only reaches the forward lit variant
— not the CSM depth pass, the MRT prepass, or the post chain. Two traps:

- A render target must be bound while compiling. `outputColorSpace` and
  `toneMapping` are part of the cache key and are read off the *currently bound*
  target, so compiling with the canvas bound warms the wrong variant.
- `fx` is excluded and self-warms on frame 2: its key depends on the visible
  light count, which is only settled inside the first rendered frame.

If you add a new subsystem that creates materials, implement `prewarmMaterials`.

## Quality bar

Every visual subsystem is reviewed by an adversarial critic against real GTA V
frames, **blind and side by side**. Non-negotiables:

- **No flat/untextured surfaces.** Every material needs albedo variation, a
  normal map, roughness variation, and a detail layer visible at 0.5 m.
- **No uniform lighting.** Contact shadows, bounce, ambient occlusion, and a
  clear key/fill/rim separation.
- **Physically plausible values.** Albedo in 0.02–0.9, metals are 0 or 1,
  real-world light intensities, exposure-driven not multiplier-driven.
- **Nothing perfectly straight, clean, or repeated.** Edge wear, grime in
  crevices, subtle warp, varied instance rotation/scale. Kerbs settle, road paint
  wears through at the wheel line, buildings are not axis-perfect clones.
- **Every action has weight.** Recoil, camera shake, screen-space impulse, audio
  transient, and a visual FX on every impact. Cars squat under power and dive
  under brakes.
- **The horizon must be earned.** Distance needs aerial perspective, haze
  gradient, and silhouette variety — not fog that hides a missing city.
- **Density.** A GTA V street frame contains dozens of distinct authored objects.
  If a critic can count the object types in your frame on two hands, add more.
