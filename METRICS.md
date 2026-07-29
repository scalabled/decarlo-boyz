# Metrics

What it cost to build **DeCarlo Boyz / Steel City** — an open-world game in
Three.js where every asset is generated at runtime: no art files, no textures on
disk, no CDN, no network.

Figures are read from the build session's own transcripts, not estimated.
Window: **26–29 July 2026**.

---

## Headline

| | |
|---|---|
| Wall-clock span | **51.3 hours** (2 d 3 h 20 m, including idle time) |
| Agents run | **996** — 812 inside orchestrated workflows, 184 standalone |
| Workflows | **15** |
| Tokens, excluding cache reads | **264.2 M** |
| Tokens, including cache reads | **9.94 B** |
| Output tokens (text actually generated) | **28.8 M** |
| Tool calls | **35,772** |
| Billed model round-trips | **57,804** |

Cache reads dominate by two orders of magnitude, which is the shape you would
expect: agents re-read a large, stable codebase far more than they write to it.
The honest "work done" number is the 28.8 M of output tokens.

### Split: orchestrator vs agents

| | main session | subagents | total |
|---|---|---|---|
| Round-trips | 2,550 | 55,254 | 57,804 |
| Output tokens | 2,744,989 | 26,104,775 | 28,849,764 |
| Cache creation | 20,068,585 | 214,258,069 | 234,326,654 |
| Cache reads | 1,191,902,250 | 8,488,291,160 | 9,680,193,410 |
| Non-cache-read total | 22,818,625 | 241,342,265 | **264,160,890** |
| Tool calls | 1,299 | 34,473 | 35,772 |

The orchestrator is **9.5%** of output tokens and **3.6%** of tool calls. Almost
everything was done by delegated agents; the main loop's job was deciding what
to delegate, and refusing results that did not hold up.

---

## Where the tool calls went

| tool | main | subagents | total |
|---|---|---|---|
| Bash | 750 | 21,099 | 21,849 |
| Read | 100 | 7,344 | 7,444 |
| Edit | 177 | 4,326 | 4,503 |
| Write | 40 | 625 | 665 |
| StructuredOutput | — | 825 | 825 |
| Agent / Workflow | 106 | 10 | 116 |

**Bash is 61% of all tool calls**, and that is the single most telling number
here. It is not shell plumbing — it is measurement: booting the game headless,
driving real key sequences, casting rays at the emitted geometry, and diffing
before against after. The ratio of Bash to Edit is roughly **5:1**, i.e. about
five acts of verification per act of writing.

---

## Workflows

15 orchestrated runs. The five largest:

| run | agents | what it did |
|---|---|---|
| `wf_116d395d` | 186 | Gameplay-parity audit — 11 readers over 3,932 lines, then one refuter per claimed gap |
| `wf_3babe999` | 97 | Subsystem build wave |
| `wf_7460ba4d` | 95 | Subsystem build wave |
| `wf_28400688` | 78 | Subsystem build wave |
| `wf_8a338095` | 78 | Subsystem build wave |
| `wf_d7cc521d` | 70 | Subsystem build wave |
| `wf_73c12340` | 66 | Subsystem build wave |
| `wf_b99687d3` | 56 | Subsystem build wave |

Measured wall-clock for three runs where it was recorded: the parity audit took
**1.41 h**, the first parity fix wave **3.90 h**, and the single agent that fixed
the floating-vehicle bug **2.39 h** on its own.

---

## What came out

| | |
|---|---|
| Runtime source | **280 files, 180,426 lines** |
| Comment lines in `src/` | **49,240** (~27% of the source) |
| Automated gates | **66 files, 10,801 lines** |
| Build/capture harnesses | **33 files, 5,314 lines** |
| Subsystems | **19**, registry-wired and topo-sorted |
| `npm` scripts | **87** |
| Production bundle | **3.2 MB** (1.05 MB gzipped), 269 modules |
| Art assets on disk | **0** |

Roughly **one line of test harness for every 11 lines of runtime code**, and
about **one comment line for every 3.7 lines of source** — high, deliberately.
The comments carry the reasons behind constants that were expensive to discover,
which is the part that does not survive in the code itself.

---

## What the process actually caught

The two mechanisms that earned their cost:

**Adversarial verification.** Every claimed gap and every claimed fix went to an
independent agent whose only instruction was to refute it, including rebuilding
the original broken state by hand and re-running the new gate against it.

- **174 gaps claimed → 13 upheld, 161 refuted.** Auditors over-claim by roughly
  9 to 1; without this stage the audit would have been 92% noise.
- It killed a "fix" whose build was **bit-for-bit identical** to the original in
  every measured digit.
- It caught a gate whose passing residual was an **algebraic identity** — it
  compared the solver's input against that same input re-read.
- It found three fixes whose defect survived in a state the gate never reached.

**Rule 12 — a gate must not re-use the code's own inputs.** Nine gates in this
project were found to be measuring nothing at all:

1. Ambient occlusion emitting `1.0` since the day it was written
2. A walkable-height probe sampling the exact points the mesh was built from
3. A skyline gate asserting a base against its own placement input
4. A ground sweep reporting 0 holes while the player spawned 2 m underground
5. An unlock resolver making the weapon probe measure fists
6. A probe printing PASS on a zero-pixel footprint
7. A drive probe's water guard reading two properties the object never had
8. A camera gate re-reading the very matrix the camera solver consumes
9. An erase-save probe passing on a build where the button did nothing — because
   a fresh profile already satisfied the postcondition

Number 9 is the instructive one. The obvious test — click erase, assert progress
is zero — cannot fail on a fresh save. The gate now asserts *the seed actually
loaded* first, and everything else hangs off that.

The general lesson, recorded in `ARCHITECTURE.md`: **a guard whose whole job is
to reject bad test conditions is the last place anyone re-reads, because when it
is broken everything looks fine.**

---

## Method notes

- **Directory ownership** was the coordination mechanism for parallel agents.
  Each agent owned a directory or an explicit file list and reported patches it
  needed elsewhere rather than applying them. Cross-file wiring was collected and
  run as its own pass.
- **Subsystems never import each other.** They resolve through a registry via
  `ctx.get(id)` / `ctx.peek(id)`, so an agent could rewrite one subsystem without
  reading the others.
- **Every fix required a negative control**: break the fix deliberately, watch
  the new gate go red, restore. A gate never observed failing is not a gate.
- **`npm run gate` is the fast line** every change pays — 13 steps, ~13 s.
  `npm run handoff` adds the browser probes; `npm run soak` runs everything.

---

*Generated from session transcripts. Token figures are the sum of per-message
usage across 938 agent transcripts plus the orchestrator's own.*
