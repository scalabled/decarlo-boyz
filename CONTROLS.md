# Controls & interaction model

How the player touches the game: what every key and every touch control does,
and the interaction model those bindings serve. `DESIGN.md` is the authority on
content (chapters, dialogue, weapon stats, map).

## The principle that makes it work

**One contextual action button.** A single action control is wired to one
function whose label rewrites itself by context — `EXIT` while you are in a
vehicle, `COMMANDEER THE CRUISER` beside a police car. There is no separate enter key, exit key, or carjack key. Every
context-sensitive thing the player can do funnels through that one control, and
the HUD says what it will do right now.

That is the model to follow. Our current build has interactions scattered across
several unbound keys, which is why a playability probe found the sixteen-weapon
arsenal unreachable from the keyboard.

## Desktop

| key | action |
|---|---|
| `W A S D` / arrows | move · drive · **helicopter: `W`/`S` tilt the disc fore/aft, `A`/`D` are the tail pedals** |
| `Shift` | sprint on foot · nitro in a car · **helicopter: DESCEND** |
| `Space` | jump on foot · handbrake in a car · **helicopter: CLIMB** |
| `Ctrl` / `C` | crouch |
| **`F`** | **the contextual action** — enter / exit / carjack / swap vehicle / sleep at a safehouse / interact |
| `E` / `Q` | next / previous weapon |
| `R` | reload |
| `V` | cycle camera |
| `H` | horn |
| `LMB` | fire (a melee weapon swings — melee is a WEAPON, not a separate key) |
| `RMB` | aim |
| `M` | map · `Tab` weapon wheel · `X` character switch · `P` phone · `N` radio station |
| `Esc` | pause |

Mouse drag rotates the camera; wheel zooms the chase distance (radius clamped
8–30, pitch 0.35–1.42 rad).

## Flying the Riverhop

The helicopter is the one vehicle whose controls do not read off the table
above, so it gets its own. **A player who has only read the table must be able
to get off the ground**, which is why the collective is spelled out here rather
than folded into "handbrake in a vehicle".

| key | in the helicopter |
|---|---|
| **`Space`** | **COLLECTIVE UP — climb.** Held. Same key as jump on foot: `Space` is "up" in both contexts |
| **`Shift`** | **COLLECTIVE DOWN — descend.** Held. Hold it all the way to the ground to land |
| neither | **holds the altitude it is at.** Let go and it hovers — it does not sink |
| `W` / `S` | cyclic: tilts the disc nose-down / nose-up. **This is how it moves.** `W` does not make it go up, it makes it go *forward* |
| `A` / `D` | tail pedals — yaw, which is how you point it |
| `F` | get in / get out. Getting out at altitude is a fall, not a landing |

Three things that surprise people, all of them deliberate:

- **There is a four-and-a-half second wind-up.** The rotor is a governed head,
  so thrust goes as the square of a spool that starts at zero. Nothing happens
  when you first pull the collective on a cold machine; that is the governor,
  not a dead key.
- **`W` is not a throttle.** A helicopter accelerates by tilting its disc, so
  holding `W` noses over and the machine leans into the direction it is going.
  It also does not stop when you let go.
- **It sags in a hard turn.** A banked disc puts less of its thrust into
  holding the machine up. Feed in some `Space` through the turn.

> The binding used to be the other way round — `Shift` up, `Space` down. `Space`
> climbs now: it is what every other game with a flyable vehicle does, and what
> the on-foot `Space` already means. See the header of
> `src/vehicles/heli.js` for the measurement that came with the change: the old
> `Shift`-to-climb had never worked at all, because the sprint control is
> routed through the nitro bottle and a helicopter has no throttle to open it.

**`Shift`-to-descend is not live yet, and this is the same defect, unfixed.**
`Space` climbs today because `handbrake` reaches the vehicle raw. `Shift` still
goes through the nitro bottle, which needs an open throttle to fill and a
helicopter has none — measured, a pilot at 87.7 m holding the descend control
for 25 seconds ended up at 93.0 m. **He cannot land.** The fix is four lines in
`VehicleHandler._stepDrive` (`src/player/vehicle.js`), which `src/vehicles`
does not own; the patch is written out in the handoff for this change. With it
applied the same pilot lands, four skid points down. Until then the collective
is one-way and this table is describing the intent, not the build.

## Mobile / touch — the part we do not have at all

`isTouch()`: `'ontouchstart' in window || navigator.maxTouchPoints > 0 || innerWidth <= 760`.

**Layout**
- **Left: virtual joystick** (`#joy` + `#joyKnob`). Knob clamps to the pad radius,
  reports `x`/`y` in −1..1. Tracks a specific `touch.identifier` so a second
  finger elsewhere cannot steal it. Resets to centre on `touchend`/`touchcancel`.
- **Right: a camera drag zone** (`#camZone`) covering the rest of the screen.
  Drag to orbit — `camTargetAlpha` from x, `camBeta` from y, clamped 0.35–1.42.
  Also identifier-tracked, and `passive: true` because it never needs to
  `preventDefault`.
- **Held buttons** (`down`/`up`, with a `.held` CSS class for feedback):
  `bFire`, `bRun` (sprint), `bBrake`.
  - `src/ui/touch.js` synthesises key codes rather than a second input path, so
    `bRun` is `ShiftLeft` and `bBrake` is `Space`. **In the helicopter that
    means BRAKE climbs and RUN descends** — the buttons work, the labels lie.
    They want a flight context: `bBrake` → `CLIMB`, `bRun` → `DESCEND`.
    `src/ui/` owns that.
- **Tap buttons**: `bAct` (the contextual action — relabels to `EXIT` in a
  vehicle), `bWep` (cycle weapon).
- **HUD taps**: radio, map, missions, settings, and the weapon box itself cycles
  on tap.
- **Overlay buttons**: respawn, busted, retry mission, continue, end.

**Two mobile traps we must not miss**
1. `document.addEventListener('gesturestart', e => e.preventDefault())` — kills
   iOS pinch-zoom over the canvas.
2. A double-tap guard: swallow a `touchend` within 300 ms of the previous one
   *unless* the target is inside `#settings`, `#mapModal` or `.overlay` — so
   menus stay usable while the game surface never zooms.

Every touch handler that calls `preventDefault` is registered `{passive:false}`;
the ones that don't are `{passive:true}`. Getting that wrong costs scroll
performance or breaks the control outright.

## Interaction rules worth copying

- `tryEnterExit()` uses a **5.5 m** radius and toasts "No vehicle nearby" on a
  miss — the player always gets feedback, even for a no-op.
- Stealing a **police** car raises the wanted level immediately.
- **The crew hops in with you**: allies within 30 m board the vehicle and are
  hidden; a toast says so. This is a signature of the DeCarlo-brothers premise.
- **Bikes keep the rider visible** (`setRidePose`) — the player mesh stays and is
  posed onto the bike, rather than being hidden as it is in a car.
- Entering swaps the vehicle meters into the HUD and changes the camera radius by
  vehicle class (bus 22, aircraft 24, default 18).
- Exiting probes around the car for a spot that is not inside a building and not
  in water before placing you.
- Everything the player does produces a **toast** in the character's accent
  colour. Feedback on every action, always.

## Test / cheat menu

Not part of the shipped control scheme — a tool for whoever is testing the game.

**`` ` ``** (backquote) or **F8**, the button on the left edge of the HUD, or
**CHEATS** on the touch nav. Six tabs:

| tab | what it does |
|---|---|
| VEHICLES | spawn any class, or spawn and get straight in; clear what you spawned |
| WEAPONS | give any of the 16, unlock everything, refill, infinite ammo |
| TELEPORT | the map waypoint, 12 districts, 6 landmarks, ~56 service POIs |
| WORLD | time of day, **day length**, weather, wanted level |
| PLAYER | switch brother, heal, armour, godmode, cash |
| MISSIONS | jump to any chapter for the active brother, or abort |

Every list is **enumerated from the owning subsystem at runtime** — the vehicle
tab picked up the bus, bicycle and helicopter with no edit — so it cannot go
stale the way a hardcoded list does.

Five ways out (`` ` ``, Escape, the button, ✕, CLOSE), and it never writes
`time.scale` itself: `ui._updateModalPause` stays the single owner of the clock,
because a sticky overlay pinning the sim at zero once hung the whole test suite
for 74 minutes.

**Hidden under `?capture=1` and for `navigator.webdriver`**, so it can never
appear in a review capture or a marketing screenshot. `?cheats=1` forces it on
for probes. Gated by `npm run cheats` (52/52).
