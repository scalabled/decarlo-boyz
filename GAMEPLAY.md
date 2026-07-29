# Gameplay architecture — what makes the game cohesive

Read after `DESIGN.md` (content) and `CONTROLS.md` (input). This is the *systems*
spec.

A pile of systems is not a game. Cohesion — the sense that the city is one place
rather than nine subsystems sharing a camera — comes from six small decisions,
not from a longer feature list. They are the subject of this document.

---

## 1. The game is DATA, the engine is a reader

Everything story- and flavour-specific lives in one `GAME_DEFS` object, and the
engine only ever reads it. There are **three selectable games** — Aidan's World,
Carson's Crew, Dylan's — sharing one engine. Per game:

```
hero      { name, color, accent, wantedDecay, dmg, speed, vehSpeed, nitro, armor }
crew      { <id>: {name, color} }        allyIds[]      partnerId
rivalName  enemyName   zoneNames[]
theme     { css vars, lamp colours, window tints, shopSign, shopName, rivalSign }
weapons   makeWeapons({ id: "flavour name" })   // shared engine ids, per-game names
stations  [{ name, scale, bpm, wave }]
advice    { <allyId>: [line, ...] }
story     [ 8 × chapter ]
ending    [ card, card, card ]
freeToast
```

The weapon *ids* are engine-level (`fists`, `wrench`, `nailgun`, …) and only the
**names** change per game — "Wrench" for Aidan the body man, "Framing Hammer" for
Carson the builder. Same for radio stations and zone names. That is how one
engine carries three stories without a branch anywhere in the logic.

**What this means for us:** our content is scattered across `src/game/data.js`,
`DESIGN.md` and hardcoded values in several subsystems. It should be one
definition object that the engine reads.

## 2. ONE mission object, ONE update function

```js
G.mission = { text, prog, goal, cash, respect, track,
              _story, chapter, phase, timer, timerActive }
```

That is the entire mission state. Everything else is derived. `phase` is what
makes multi-step missions work without a state-machine class:

> deliver — phase 0: *get in the glowing car* → phase 1: *drive it to the ring*

`updateMissionProgress(dt)` is a single `switch (m.track)` doing the spatial and
timer checks for every track, story and free-roam. `missionEvent(type, data)` is
the generic hook that non-spatial things (a theft, a pickup, a top speed) call
into.

**Story tracks:** `deliver · goons · timedDeliver · recover · protect · partner ·
boss · final`
**Free-roam tracks:** `steal · speed · explore · pickup · escape · fly · kill ·
copkill · delivery · recoverOne`

## 3. One objective marker, one glow

- `G.missionMarker = {x, z}` — a single point the HUD arrow and both maps aim at.
  Reassigned as the phase changes. Nothing else needs to know anything.
- `markVehicle(v, colour)` sets the body material's emissive so the objective car
  literally glows; `unmarkVehicle` clears it. Green = fetch it, amber = timed.

This is why the objective is never confusing: there is exactly one thing lit up
and one arrow pointing at it.

## 4. The crew is the heart of it

`updateAllies(dt)` — allies follow at 5 m, engage a hostile within 20 m, and
**"chip in but never carry the fight"** (7 damage on a 1.5 s cycle). They go down
rather than die, and self-revive after 8 s with a line. A `guard` anchor pins one
in place for `protect` chapters, with `noRevive` so failing is possible.

**The advice system is the best idea in the build.** Every 18–32 s an ally has a
55% chance to say a line from `ADVICE[allyId]`. Those lines are simultaneously:

- tutorial — *"The minimap shows pickups, cops, everything. Use it."*
- mechanics teaching — *"Nitro's your friend. Hold RUN and fly dahn the Boulevard."*
- characterisation — *"Mom called — Kali says dinner Sunday, no excuses."*

It teaches the game without a tutorial mode, and it is why the crew feels present
rather than decorative. We have three brothers and they currently never speak
outside missions.

`dialogue(id, line, dur)` resolves the speaker from the game def — crew member,
`"boss"` (the rival), or the hero — and colours the name accordingly. Chapters
schedule their `intro` lines at `900 + i*3600` ms and `done` lines at
`300 + i*3200` ms.

## 5. Everything gives feedback, immediately

- A **toast** on every single action, in the character's accent colour — cash,
  health, armour, ammo, nitro, recovery progress, "No vehicle nearby" on a *failed*
  interaction.
- The **body-shop ring**: stand in it and your car repairs, refuels and you heal,
  with a throttled toast every 2.2 s. No button.
- **Pickups** bob and rotate, and the collection radius grows from 2.2 m on foot
  to **3.5 m in a vehicle** so you can grab them while driving. Respawn 6 s later.
- Context-aware tutorial text: *"Walk to the glowing vehicle, then "* + `tap
  ENTER` or `press F` depending on `isTouch()`.

## 6. It refuses to break

```js
try { update(dt); }
catch (e) { if (!G._simErr) { G._simErr = true; console.error("sim error:", e); } }
scene.render();
```

A simulation exception logs **once** and the frame keeps rendering. Alongside it:
`restartCurrentMission()` fully recovers from any state including wrecked or
dead — clears cops, restores health, exits the vehicle, restarts the chapter.
`completeStoryChapter` never regresses the story frontier
(`Save.data.chapter = Math.max(saved, current + 1)`), so replaying an old chapter
cannot cost you progress.

UI is throttled deliberately: minimap/HUD at 0.08 s, interaction prompt at 0.25 s.

---

## Mechanics we do not have at all

| mechanic | what it does |
|---|---|
| **Nitro** | vehicle boost on the sprint control, refilled by a pickup. `hero.nitro` is a per-character multiplier |
| **Crew that follows and fights** | allies at your side in free roam, not just in missions |
| **Advice lines** | ambient tutorial + characterisation on a 18–32 s timer |
| **Partner missions** | Gabby / Lauren — a rescue-and-repair chapter with a timed approach then a stand-still repair |
| **Protect / ward** | defend a named ally through waves, with his health bar in the HUD |
| **Glowing objective vehicles** | emissive marking |
| **Pickups** | cash / health / armour / ammo / nitro, bobbing, bigger radius from a car |
| **Body-shop ring** | passive repair + refuel + heal by standing in it |
| **Free-roam job board** | ten generated mission types so free roam always has something to do |
| **Three selectable stories** | one engine, three data-driven games |
| **Zone names** | on-screen district identity, used by missions ("Cruise out to …") |

## The order to build them in

1. **The mission object and `updateMissionProgress`** — one object, one switch,
   `phase`, `missionMarker`, glowing objective vehicles. Everything else hangs
   off this.
2. **Toasts and prompts everywhere**, including on failed interactions.
3. **The crew**: follow, chip in, go down and revive, and the advice timer.
4. **Pickups and the body-shop ring** — the passive economy that makes the map
   worth driving around.
5. **Nitro**, because it changes how the car feels immediately.
6. **The free-roam job board**, so the world has content after the story.
7. **Data-driven game defs**, once the systems above read from one place anyway.
