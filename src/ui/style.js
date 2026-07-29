import { FONT_STACK, FONT_DISPLAY, FONT_MONO } from './util.js';

/**
 * ===========================================================================
 * THE STEEL CITY HUD STYLESHEET
 * ===========================================================================
 *
 * Design system
 * -------------
 *  scale     every dimension is `calc(N * var(--k))` where --k comes from the
 *            viewport height (1080p == 1.0), so the HUD holds its proportions
 *            from 720p to 4K and across 16:9 / 16:10 / 21:9 without re-authoring.
 *  spacing   4 px grid (--u). Screen margin is 7u (28 px @1080p).
 *  palette   the design tokens: sodium amber, molten slag
 *            orange, river teal, cold steel, over near-black glass. Colour is
 *            SEMANTIC and rationed — slag orange means heat (police), gold
 *            means money and objectives, teal means the river and allies, red
 *            means you are being hurt. Nothing is coloured for decoration.
 *  type      three faces. A condensed display face (--fd) for anything a
 *            player reads at a glance from the corner of their eye: money,
 *            weapon, chapter titles, WASTED. A condensed UI face (--ff) for
 *            labels. A mono (--fm) for numerals that must not jitter and for
 *            the wide-tracked eyebrows that give the whole thing its
 *            industrial register.
 *  contrast  every text run carries a synthesized outline (--o1/--o2, eight
 *            equal hard shadows) plus a soft seat, so it survives a blown-out
 *            noon sky AND a black wet street at 2 a.m. without a scrim.
 *  motion    nothing animates on a CSS transition or keyframe. Every animated
 *            value is integrated from dt in JS, which is what makes the
 *            capture harness deterministic and lets the HUD freeze on pause.
 *
 * The one deliberate exception to "rationed colour": the Slag Ring's heat. It
 * is the signature, it only appears when the police want you, and it is
 * supposed to be the brightest thing on the screen when it does.
 */

const CSS = `
.ow-hud, .ow-hud * { margin:0; padding:0; box-sizing:border-box; }

.ow-hud {
  --k: 1;
  /* The touch-control scale, driven off the SHORT screen edge (see touch.js).
     It is published on the HUD root as well as the touch layer because the
     radar dock and the weapon chip have to move out of the way of controls
     whose size it decides. 1 on desktop, where nothing moves. */
  --tkg: 1;
  --u: calc(4px * var(--k));
  --pad: calc(var(--u) * 7);

  /* ---- design tokens ---- */
  --ink0:  #080a0e;
  --ink1:  #10141c;
  --steel: #7d8ca3;
  --steel-d:#3b4658;
  --slag:  #ff6a12;
  --slag-hot:#ffb03a;
  --gold:  #ffc93c;
  --river: #2ea6a0;
  --river-l:#7bf0d8;
  --violet:#c07cff;
  --blood: #ff3b4e;
  --good:  #41e08a;
  --paper: #e8e2d4;
  --glass: rgba(10,14,20,.82);
  --line:  rgba(125,140,163,.28);
  --line-hot: rgba(255,106,18,.48);

  /* ---- derived ink levels ---- */
  --ink:   rgba(238,242,246,.96);
  --ink-2: rgba(196,209,222,.62);
  --ink-3: rgba(160,175,192,.34);
  --hair:  rgba(255,255,255,.15);
  --hair-2:rgba(255,255,255,.07);
  --amber: #ffb02a;
  --red:   #ff3b4e;
  --cyan:  #79d2ff;
  --friend:#41e08a;
  --enemy: #ff7a63;
  --ok:    #41e08a;

  --sh: 0 1px 2px rgba(0,0,0,.92), 0 0 calc(10px * var(--k)) rgba(0,0,0,.45);
  --sh-hard: 0 1px 1px rgba(0,0,0,.95);

  --oc: #05080b;
  --o1:
    calc(1.5px * var(--k)) 0 0 var(--oc), calc(-1.5px * var(--k)) 0 0 var(--oc),
    0 calc(1.5px * var(--k)) 0 var(--oc), 0 calc(-1.5px * var(--k)) 0 var(--oc),
    calc(1.1px * var(--k)) calc(1.1px * var(--k)) 0 var(--oc),
    calc(-1.1px * var(--k)) calc(1.1px * var(--k)) 0 var(--oc),
    calc(1.1px * var(--k)) calc(-1.1px * var(--k)) 0 var(--oc),
    calc(-1.1px * var(--k)) calc(-1.1px * var(--k)) 0 var(--oc);
  --o2:
    calc(2.2px * var(--k)) 0 0 var(--oc), calc(-2.2px * var(--k)) 0 0 var(--oc),
    0 calc(2.2px * var(--k)) 0 var(--oc), 0 calc(-2.2px * var(--k)) 0 var(--oc),
    calc(1.6px * var(--k)) calc(1.6px * var(--k)) 0 var(--oc),
    calc(-1.6px * var(--k)) calc(1.6px * var(--k)) 0 var(--oc),
    calc(1.6px * var(--k)) calc(-1.6px * var(--k)) 0 var(--oc),
    calc(-1.6px * var(--k)) calc(-1.6px * var(--k)) 0 var(--oc);
  --sh-o1: var(--o1), 0 0 calc(4px * var(--k)) rgba(3,6,9,.8);
  --sh-o2: var(--o2), 0 0 calc(6px * var(--k)) rgba(3,6,9,.85);

  --ff: ${FONT_STACK};
  --fd: ${FONT_DISPLAY};
  --fm: ${FONT_MONO};

  position: fixed; inset: 0;
  pointer-events: none;
  z-index: 10;
  font-family: var(--ff);
  font-weight: 600;
  color: var(--ink);
  letter-spacing: .06em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum" 1, "lnum" 1;
  -webkit-font-smoothing: antialiased;
  text-transform: uppercase;
  overflow: hidden;
  contain: layout style;
  user-select: none;
}

.ow-layer { position:absolute; inset:0; }
.ow-hud .lbl {
  font-family: var(--fm);
  font-size: calc(9.5px * var(--k));
  letter-spacing: .26em; color: var(--steel); text-shadow: var(--sh);
}
.ow-hidden { display:none !important; }

/* Rivet: the steel-fabrication motif, reused on every plate corner. */
.ow-hud .rivet, .ow-radar-rivet {
  position:absolute; width:calc(4.4px * var(--k)); height:calc(4.4px * var(--k));
  border-radius:50%;
  background: radial-gradient(circle at 34% 30%, #c8d2df, #4a5464 58%, #1b2028);
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 1px 1px rgba(0,0,0,.7);
}

/* ============================================================== crosshair */
.ow-cross { position:absolute; left:50%; top:50%; width:0; height:0; }
.ow-blade {
  position:absolute; left:0; top:0;
  width: calc(1.6px * var(--k)); height: calc(8px * var(--k));
  margin-left: calc(-0.8px * var(--k)); margin-top: calc(-4px * var(--k));
  background: linear-gradient(to top, rgba(255,255,255,.62), #fff 62%);
  box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 calc(3px * var(--k)) rgba(0,0,0,.75);
  transform-origin: 50% 50%; will-change: transform, opacity;
}
.ow-dot {
  position:absolute; left:0; top:0;
  width: calc(2.2px * var(--k)); height: calc(2.2px * var(--k));
  margin-left: calc(-1.1px * var(--k)); margin-top: calc(-1.1px * var(--k));
  background:#fff; border-radius:50%;
  box-shadow: 0 0 0 1px rgba(0,0,0,.6), 0 0 calc(4px * var(--k)) rgba(0,0,0,.7);
  will-change: opacity, transform;
}
.ow-cross-ads { position:absolute; left:0; top:0; }

/* ============================================================ hitmarkers */
.ow-hit {
  position:absolute; left:50%; top:50%;
  width: calc(56px * var(--k)); height: calc(56px * var(--k));
  margin-left: calc(-28px * var(--k)); margin-top: calc(-28px * var(--k));
  will-change: transform, opacity;
}
.ow-hit svg { width:100%; height:100%; display:block; overflow:visible; }

/* =============================================== directional damage arcs */
.ow-dmg {
  position:absolute; left:50%; top:50%;
  width: calc(340px * var(--k)); height: calc(340px * var(--k));
  margin-left: calc(-170px * var(--k)); margin-top: calc(-170px * var(--k));
  will-change: transform, opacity;
}
.ow-dmg svg { width:100%; height:100%; display:block; overflow:visible; }

/* ============================================================ hurt state */
.ow-blood { position:absolute; inset:-7%; will-change: opacity, transform; }
.ow-blood-a {
  position:absolute; inset:0;
  background:
    radial-gradient(ellipse 78% 74% at 50% 50%, rgba(0,0,0,0) 62%, rgba(122,14,10,.30) 86%, rgba(74,8,5,.60) 100%);
  filter: url(#ow-warp);
}
.ow-blood-b {
  position:absolute; inset:0; opacity:.5; mix-blend-mode:multiply;
  background:
    radial-gradient(circle at 2% 22%,  rgba(96,10,8,.75) 0, rgba(96,10,8,0) 17%),
    radial-gradient(circle at 99% 58%, rgba(96,10,8,.7) 0, rgba(96,10,8,0) 15%),
    radial-gradient(circle at 26% 101%,rgba(88,10,8,.75) 0, rgba(88,10,8,0) 19%),
    radial-gradient(circle at 74% -2%, rgba(88,10,8,.7) 0, rgba(88,10,8,0) 18%);
  filter: url(#ow-warp);
}
.ow-desat { position:absolute; inset:0; backdrop-filter: saturate(.6) contrast(1.04) brightness(.97); }
.ow-hitflash { position:absolute; inset:0;
  background: radial-gradient(ellipse 90% 86% at 50% 50%, rgba(150,16,10,.22) 40%, rgba(160,18,12,.62) 100%);
  mix-blend-mode:screen; }
.ow-lowbeat {
  position:absolute; inset:0;
  background: radial-gradient(ellipse 76% 70% at 50% 50%, rgba(0,0,0,0) 64%, rgba(150,14,10,.34) 100%);
}

/* Screen-edge heat: at four and five stars the whole frame catches the slag.
   Driven from JS as --wanted-wash 0..1. */
.ow-heat-wash {
  position:absolute; inset:0;
  background: radial-gradient(ellipse 82% 74% at 50% 52%,
    rgba(0,0,0,0) 52%, rgba(196,58,0,.30) 88%, rgba(140,36,0,.52) 100%);
  mix-blend-mode: screen;
}

/* ===================================================== THE SLAG RING ==== */
/* The dock is the bottom-left cluster. It is deliberately LARGER than the
   ring: the vitals arcs and the heat bloom both live outside the iron, and if
   the dock is the same size as the bezel they get clipped by the viewport. */
.ow-dock {
  position:absolute;
  left: calc(var(--pad) - 20px * var(--k));
  bottom: calc(var(--pad) - 12px * var(--k));
  width: calc(252px * var(--k)); height: calc(252px * var(--k));
  will-change: opacity;
}
.ow-radar { position:absolute; inset: calc(28px * var(--k)); }

/* cast iron: a conic gradient so the light wraps the ring like a turned part */
.ow-radar-ring {
  position:absolute; inset:0; border-radius:50%;
  background:
    conic-gradient(from 208deg,
      #39424f 0deg, #1b212a 62deg, #4d5764 128deg, #232a34 196deg,
      #56606e 250deg, #191f27 312deg, #39424f 360deg);
  box-shadow:
    0 calc(6px * var(--k)) calc(18px * var(--k)) rgba(0,0,0,.62),
    inset 0 0 0 1px rgba(255,255,255,.08),
    inset 0 calc(2px * var(--k)) calc(3px * var(--k)) rgba(255,255,255,.06),
    inset 0 calc(-2px * var(--k)) calc(4px * var(--k)) rgba(0,0,0,.6);
}
/* machined inner lip: separates the iron from the map disc */
.ow-radar-ring::after {
  content:''; position:absolute; inset: calc(7px * var(--k)); border-radius:50%;
  box-shadow:
    0 0 0 calc(1.4px * var(--k)) rgba(6,9,13,.9),
    inset 0 0 calc(10px * var(--k)) rgba(0,0,0,.85);
}

/* HEAT — the signature.
   --heat 0..1 tracks the wanted level and drives BOTH how far the molten front
   has travelled round the iron and how hot it is: one star lights a quarter of
   the ring dull red, five stars close the loop white-hot and throw light onto
   everything near it. A ring that just tints uniformly reads as brown at low
   levels; a ring that FILLS reads as a gauge you can check without counting
   stars, which is the point. */
.ow-radar-heat {
  position:absolute; inset: calc(-1px * var(--k)); border-radius:50%;
  pointer-events:none;
  background:
    conic-gradient(from -96deg,
      #ffd070 0turn,
      #ff9a1e calc(var(--heat,0) * .26turn),
      #ff5d05 calc(var(--heat,0) * .64turn),
      #a82400 calc(var(--heat,0) * .94turn),
      rgba(150,40,0,0) calc(var(--heat,0) * 1turn),
      rgba(150,40,0,0) 1turn);
  -webkit-mask: radial-gradient(circle, transparent 0 calc(50% - 9.5px * var(--k)), #000 calc(50% - 8.6px * var(--k)));
          mask: radial-gradient(circle, transparent 0 calc(50% - 9.5px * var(--k)), #000 calc(50% - 8.6px * var(--k)));
  filter: blur(calc(.5px * var(--k)));
  mix-blend-mode: screen;
  opacity: calc((.30 + var(--heat,0) * .70) * var(--flare, 1));
}
/* The bloom the hot iron throws on everything around it.
   It is a SEPARATE element with normal compositing: the ring itself is
   screen-blended (which is what makes the iron look lit from within), but a
   screen-blended glow over a blown-out noon sky resolves to nothing, and five
   stars have to read at midday as well as at midnight. */
.ow-radar-bloom {
  position:absolute; inset: calc(-4px * var(--k)); border-radius:50%;
  pointer-events:none;
  box-shadow:
    0 0 calc(30px * var(--k)) calc(2px * var(--k)) rgba(255,120,20, calc(var(--heat-raw,0) * .55)),
    0 0 calc(78px * var(--k)) calc(12px * var(--k)) rgba(255,80,0, calc(var(--heat-raw,0) * .34));
}
.ow-radar-inner {
  position:absolute; inset: calc(9px * var(--k)); border-radius:50%;
  overflow:hidden; background:#0a0f14;
}
.ow-radar-inner canvas { width:100%; height:100%; display:block; }

.ow-radar-rivet.r0 { left:14%;  top:14%;  }
.ow-radar-rivet.r1 { right:14%; top:14%;  }
.ow-radar-rivet.r2 { left:14%;  bottom:14%; }
.ow-radar-rivet.r3 { right:14%; bottom:14%; }

/* north pip: rides the bezel, rotates with the map */
.ow-radar-n { position:absolute; inset:0; }
.ow-radar-n i {
  position:absolute; left:50%; top: calc(-3px * var(--k));
  width:0; height:0; transform: translateX(-50%);
  border-left: calc(5px * var(--k)) solid transparent;
  border-right: calc(5px * var(--k)) solid transparent;
  border-bottom: calc(9px * var(--k)) solid var(--blood);
  filter: drop-shadow(0 0 calc(5px * var(--k)) rgba(255,59,78,.85));
}
/* The district name sits INSIDE the disc, along its bottom edge. It used to
   hang below the bezel, where the health and armour arcs run straight through
   it. Inside, it also stops the map's lower edge from ending in nothing. */
.ow-radar-tag {
  position:absolute; left:50%; bottom: calc(13px * var(--k));
  transform: translateX(-50%);
  padding: calc(2.5px * var(--k)) calc(11px * var(--k));
  background: linear-gradient(180deg,rgba(30,37,47,.95),rgba(9,12,17,.96));
  border:1px solid rgba(125,140,163,.34);
  box-shadow: 0 calc(2px * var(--k)) calc(8px * var(--k)) rgba(0,0,0,.8),
              inset 0 1px 0 rgba(255,255,255,.09);
  border-radius: calc(2px * var(--k)); white-space:nowrap;
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.22em; color: var(--paper); text-shadow: var(--sh-hard);
}
.ow-radar-street {
  position:absolute; left: calc(100% + 14px * var(--k));
  bottom: calc(4px * var(--k)); white-space:nowrap;
  font-family: var(--fd); font-size: calc(15px * var(--k)); letter-spacing:.1em;
  color: var(--ink-2); text-shadow: var(--sh-o1);
}

/* health / armour arcs — flank the bottom of the ring, meeting at 6 o'clock.
   Same box as the ring, drawn beyond it, so they never fight the map. */
.ow-vitals {
  position:absolute; inset: calc(28px * var(--k)); overflow:visible;
  filter: drop-shadow(0 calc(2px * var(--k)) calc(3px * var(--k)) rgba(0,0,0,.85));
}

/* ============================================= the top-right column ==== */
/* Money, stars, clock and objective are one stack in flow order. They used to
   be four absolutely-positioned blocks with hand-tuned tops, which collided
   the moment the objective ran to two lines. */
.ow-topright {
  position:absolute; right: var(--pad); top: var(--pad);
  display:flex; flex-direction:column; align-items:flex-end;
  gap: calc(var(--u) * 2);
  width: calc(360px * var(--k));
}

/* ========================================================= wanted stars */
.ow-wanted {
  display:flex; flex-direction:column; align-items:flex-end;
  gap: calc(var(--u) * 1.2);
  will-change: opacity;
}
.ow-stars { width: calc(166px * var(--k)); height: calc(33px * var(--k)); overflow:visible; }
.ow-stars .back { fill:#0b0f15; stroke: rgba(150,166,188,.55); stroke-width:1.5; }
.ow-stars .fill { fill: var(--gold); filter: drop-shadow(0 0 calc(7px * var(--k)) rgba(255,201,60,.9)); }
.ow-wanted-bar {
  width: calc(150px * var(--k)); height: calc(2.6px * var(--k));
  background: rgba(8,12,17,.92); box-shadow: 0 0 0 1px rgba(0,0,0,.65);
}
.ow-wanted-bar > i {
  display:block; height:100%; width:100%; transform-origin: right center;
  background: linear-gradient(90deg, var(--slag), var(--gold));
}

/* =============================================================== money */
.ow-money { text-align:right; will-change:opacity; }
.ow-money-v {
  font-family: var(--fd); font-weight:400;
  font-size: calc(46px * var(--k)); line-height:.84; letter-spacing:.005em;
  color: var(--good); text-shadow: var(--o2), 0 0 calc(24px * var(--k)) rgba(65,224,138,.4);
}
.ow-money-v.up { color:#8dffc0; }
.ow-money-d {
  font-family: var(--fm); font-size: calc(13px * var(--k)); letter-spacing:.1em;
  color: var(--good); text-shadow: var(--sh-o1); margin-top: calc(var(--u) * .8);
}
.ow-money-d.neg { color: var(--blood); }

/* ============================================================= respect */
/* The second currency, directly under the money and in its grammar: eased
   roll, delta underneath, faded out unless it just moved. */
.ow-respect { text-align:right; will-change:opacity; }
.ow-respect-row { display:flex; align-items:baseline; gap: calc(var(--u) * 1.6); justify-content:flex-end; }
.ow-respect-v {
  font-family: var(--fd); font-weight:400;
  font-size: calc(24px * var(--k)); line-height:.9; letter-spacing:.01em;
  color: var(--gold); text-shadow: var(--o1), 0 0 calc(16px * var(--k)) rgba(255,201,60,.35);
}
.ow-respect-l {
  font-family: var(--fm); font-size: calc(8.6px * var(--k));
  letter-spacing:.26em; color: var(--steel); text-shadow: var(--sh);
}
.ow-respect-d {
  font-family: var(--fm); font-size: calc(11px * var(--k)); letter-spacing:.1em;
  color: var(--gold); text-shadow: var(--sh-o1); margin-top: calc(var(--u) * .5);
}
.ow-respect-d.neg { color: var(--blood); }

.ow-clock {
  display:flex; align-items:baseline; gap: calc(var(--u) * 2.2);
  font-family: var(--fm); letter-spacing:.16em; text-shadow: var(--sh-o1);
}
.ow-clock .t { font-size: calc(14px * var(--k)); color: var(--ink-2); }
.ow-clock .w { font-size: calc(9.5px * var(--k)); color: #a9b7c8; letter-spacing:.26em; }

/* ================================================ vehicle meter cluster */
/* Health / fuel / nitro while driving, stacked above the weapon chip. Rows
   hide individually when their producer is absent; the fuel bar's low-state
   flash is driven from dt in vitals.js, never from a CSS keyframe. */
.ow-vehm {
  position:absolute; right: var(--pad); bottom: calc(var(--pad) + 88px * var(--k));
  display:flex; flex-direction:column; gap: calc(var(--u) * 1.1);
  padding: calc(var(--u) * 1.6) calc(var(--u) * 2.2);
  background: linear-gradient(180deg, rgba(26,32,42,.72), rgba(8,11,16,.82));
  border:1px solid var(--line); border-radius: calc(4px * var(--k));
  box-shadow: 0 calc(5px * var(--k)) calc(18px * var(--k)) rgba(0,0,0,.5),
              inset 0 1px 0 rgba(255,255,255,.05);
  will-change:opacity;
}
.ow-vehm-row { display:flex; align-items:center; gap: calc(var(--u) * 1.8); }
.ow-vehm-row .k {
  font-family: var(--fm); font-size: calc(8px * var(--k)); letter-spacing:.22em;
  color: var(--steel); width: calc(30px * var(--k)); text-align:right;
}
.ow-vehm-row .bar {
  width: calc(118px * var(--k)); height: calc(4px * var(--k));
  background: rgba(5,8,12,.9); box-shadow: 0 0 0 1px rgba(0,0,0,.6);
  overflow:hidden;
}
.ow-vehm-row .bar > i {
  display:block; height:100%; width:100%; transform-origin:left;
  background: var(--steel);
}
.ow-vehm-row.vh .bar > i { background: var(--good); }
.ow-vehm-row.fu .bar > i { background: linear-gradient(90deg, var(--gold), #ffe79b); }
.ow-vehm-row.fu.low .k { color: var(--blood); }
.ow-vehm-row.no .bar > i { background: linear-gradient(90deg, #22b7e0, var(--cyan)); }
.ow-vehm-row.no.on .bar > i { box-shadow: 0 0 calc(8px * var(--k)) rgba(121,210,255,.85); }

/* ======================================================= shared modal ✕ */
/* Every full-screen modal carries the same escape hatch in the same corner:
   on a phone the touch layer (and the button that opened the modal) is hidden
   underneath it, so the ✕ is the one exit that always exists. Same physical
   minimums as the pause menu's — raw px, deliberately not scaled by --k. */
.ow-modal-x {
  position:absolute; top: calc(var(--u) * 5); right: calc(var(--u) * 5);
  width:52px; height:52px; appearance:none; cursor:pointer;
  border:1px solid var(--hair); background: rgba(8,10,14,.72);
  color: var(--ink); font-family: var(--ff); font-size:20px; line-height:1;
  display:flex; align-items:center; justify-content:center;
  pointer-events:auto; touch-action: manipulation;
  transition: background .12s, border-color .12s;
  z-index:5;
}
.ow-modal-x:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.45); }
.ow-modal-x.sm { width:44px; height:44px; top: calc(var(--u) * 1.5); right: calc(var(--u) * 1.5); font-size:16px; }

/* ============================================================== weapon */
.ow-weap {
  position:absolute; right: var(--pad); bottom: var(--pad);
  display:flex; align-items:center; gap: calc(var(--u) * 2.5);
  padding: calc(var(--u) * 2) calc(var(--u) * 3);
  background: linear-gradient(180deg, rgba(26,32,42,.80), rgba(8,11,16,.88));
  border:1px solid var(--line); border-radius: calc(4px * var(--k));
  box-shadow: 0 calc(6px * var(--k)) calc(22px * var(--k)) rgba(0,0,0,.55),
              inset 0 1px 0 rgba(255,255,255,.06);
  will-change:opacity;
}
.ow-weap-icon { width: calc(46px * var(--k)); height: calc(46px * var(--k)); display:block; }
.ow-weap-col { display:flex; flex-direction:column; align-items:flex-end; gap: calc(var(--u) * .5); }
.ow-weap-name {
  font-family: var(--fd); font-size: calc(19px * var(--k)); line-height:1;
  letter-spacing:.05em; color: var(--paper); text-shadow: var(--sh-o1);
}
.ow-weap-row { display:flex; align-items:baseline; gap: calc(var(--u) * 1.2); font-family: var(--fm); }
.ow-weap-ammo { font-size: calc(20px * var(--k)); line-height:1; color: var(--gold); text-shadow: var(--sh-o1); }
.ow-weap-ammo.low { color: var(--blood); }
.ow-weap-res { font-size: calc(11px * var(--k)); color: var(--steel); }
.ow-weap-bar {
  position:absolute; left: calc(var(--u) * 2); right: calc(var(--u) * 2);
  bottom: calc(var(--u) * .8); height: calc(2px * var(--k)); background: rgba(255,255,255,.14);
}
.ow-weap-bar > i {
  display:block; height:100%; width:100%; transform-origin:left;
  background: var(--slag-hot);
}

/* ============================================================ objective */
.ow-obj {
  width: 100%; text-align:right;
  margin-top: calc(var(--u) * 2);
  padding-right: calc(var(--u) * 3);
  border-right: calc(2px * var(--k)) solid var(--slag);
  will-change: opacity, transform;
}
.ow-obj-eyebrow {
  font-family: var(--fm); font-size: calc(10px * var(--k));
  letter-spacing:.3em; color: var(--slag-hot); text-shadow: var(--sh-o1);
}
.ow-obj-text {
  font-family: var(--fd); font-size: calc(26px * var(--k)); line-height:1.06;
  letter-spacing:.025em; color: var(--paper); text-shadow: var(--sh-o2);
  margin-top: calc(var(--u) * 1);
}
.ow-obj-meta { display:flex; justify-content:flex-end; align-items:baseline;
  gap: calc(var(--u) * 4); margin-top: calc(var(--u) * 1.2); }
.ow-obj-timer {
  font-family: var(--fm); font-size: calc(26px * var(--k)); line-height:1;
  letter-spacing: .04em; order: 2;
  color: var(--gold); text-shadow: var(--o1), 0 0 calc(14px * var(--k)) rgba(255,201,60,.45);
}
.ow-obj-timer.warn { color: var(--blood); text-shadow: var(--o1), 0 0 calc(16px * var(--k)) rgba(255,59,78,.6); }
.ow-obj-count { font-family: var(--fm); font-size: calc(12px * var(--k)); letter-spacing:.18em;
  color: var(--ink-2); order: 1; text-shadow: var(--sh-o1); }
.ow-obj-bar { margin-top: calc(var(--u) * 1.4); height: calc(2.6px * var(--k)); background: rgba(8,12,17,.86); }
.ow-obj-bar > i { display:block; height:100%; width:100%; transform-origin:left;
  background: linear-gradient(90deg, var(--slag), var(--gold)); }

/* ================================================================= zone */
.ow-zone {
  position:absolute; left: var(--pad);
  bottom: calc(var(--pad) + 250px * var(--k));
  will-change: opacity, transform;
}
.ow-zone-rule {
  width: calc(56px * var(--k)); height: calc(2px * var(--k));
  background: linear-gradient(90deg, var(--slag), rgba(255,106,18,0));
  transform-origin:left;
}
.ow-zone-sub {
  margin-top: calc(var(--u) * 1.2);
  font-family: var(--fm); font-size: calc(9.5px * var(--k));
  letter-spacing:.34em; color: var(--steel); text-shadow: var(--sh-o1);
}
.ow-zone-name {
  font-family: var(--fd); font-size: calc(36px * var(--k)); line-height:1.04;
  margin-top: calc(var(--u) * .6);
  letter-spacing:.02em; color: var(--paper); text-shadow: var(--sh-o2);
}

/* =========================================================== title card */
.ow-title {
  position:absolute; left: var(--pad); bottom: 31%;
  display:flex; gap: calc(var(--u) * 3.5); align-items:stretch;
  padding: calc(var(--u) * 4) calc(var(--u) * 16) calc(var(--u) * 4) 0;
  will-change: opacity;
}
/* A feathered band, so the gold gradient's dark foot survives a pale concrete
   ground. Feathers to nothing on the right and top/bottom so it never reads as
   a rectangle laid over the scene. */
.ow-title::before {
  content:''; position:absolute; inset: 0 0 0 calc(var(--pad) * -1); z-index:-1;
  background: linear-gradient(to bottom,
    rgba(4,7,10,0) 0%, rgba(4,7,10,.62) 26%, rgba(4,7,10,.62) 74%, rgba(4,7,10,0) 100%);
  -webkit-mask-image: linear-gradient(to right, #000 0%, #000 52%, rgba(0,0,0,0) 100%);
          mask-image: linear-gradient(to right, #000 0%, #000 52%, rgba(0,0,0,0) 100%);
}
.ow-title-bar {
  width: calc(3px * var(--k));
  background: linear-gradient(180deg, var(--gold), var(--slag) 60%, #8c2c00);
  transform-origin: bottom;
  box-shadow: 0 0 calc(14px * var(--k)) rgba(255,106,18,.6);
}
.ow-title-ch {
  font-family: var(--fm); font-size: calc(11px * var(--k));
  letter-spacing:.42em; color: var(--slag); text-shadow: var(--sh-o1);
}
.ow-title-name {
  font-family: var(--fd); font-size: calc(56px * var(--k)); line-height:.92;
  letter-spacing:.015em; margin-top: calc(var(--u) * 1);
  background: linear-gradient(178deg, #fff6de 6%, var(--gold) 46%, #b06a00 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter: drop-shadow(0 calc(2px * var(--k)) 0 rgba(0,0,0,.72))
          drop-shadow(0 0 calc(22px * var(--k)) rgba(255,140,30,.28));
}
.ow-title-zone {
  font-family: var(--fm); font-size: calc(10.5px * var(--k));
  letter-spacing:.28em; color: var(--steel); margin-top: calc(var(--u) * 1.6);
  text-shadow: var(--sh-o1);
}

/* ============================================================ subtitles */
.ow-subs {
  position:absolute; left:50%; bottom: calc(var(--pad) + 22px * var(--k));
  transform: translateX(-50%);
  width: min(56%, calc(760px * var(--k)));
  text-align:center; will-change: opacity;
}
.ow-subs-who {
  font-family: var(--fd); font-size: calc(17px * var(--k));
  letter-spacing:.14em; text-shadow: var(--sh-o1);
}
.ow-subs-line {
  margin-top: calc(var(--u) * .8);
  font-family: var(--ff); font-weight:600; text-transform:none;
  font-size: calc(19px * var(--k)); line-height:1.34; letter-spacing:.005em;
  color:#f2f5f8; text-shadow: var(--sh-o2);
}

/* ============================================================= big card */
.ow-card-tint { position:absolute; inset:0; will-change:opacity; }
/* Full width, not shrink-to-fit: an absolutely positioned box at left:50% is
   capped at half the viewport, which silently wrapped "MISSION PASSED" onto
   two lines the moment the scrim padding grew. */
.ow-card {
  position:absolute; left:0; right:0; top:44%; transform: translateY(-50%);
  text-align:center; will-change:opacity;
  padding: calc(var(--u) * 22) calc(var(--u) * 10);
}
/* A haze, not a box. The type needs a dark ground to survive a blown-out sky,
   but the transition has to be long enough that no edge is visible: the
   gradient is still at 46% opacity halfway out and does not reach zero until
   the very corner of a box that is deliberately far bigger than the content. */
.ow-card::before {
  content:''; position:absolute; inset:0; z-index:-1;
  background: radial-gradient(ellipse 72% 66% at 50% 44%,
    rgba(3,5,8,.76) 0%, rgba(3,5,8,.58) 34%, rgba(3,5,8,.26) 64%, rgba(3,5,8,0) 100%);
}
.ow-card-title {
  font-family: var(--fd); font-size: calc(104px * var(--k)); line-height:.86;
  letter-spacing:.02em;
  background: linear-gradient(180deg,#fff6de 4%, var(--gold) 48%, #a05e00 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter: drop-shadow(0 calc(3px * var(--k)) 0 rgba(0,0,0,.7))
          drop-shadow(0 0 calc(40px * var(--k)) rgba(255,150,40,.35));
}
.ow-card.lose .ow-card-title {
  background: linear-gradient(180deg,#ffd7db 4%, var(--blood) 48%, #6d0d1c 100%);
  -webkit-background-clip:text; background-clip:text;
  filter: drop-shadow(0 calc(3px * var(--k)) 0 rgba(0,0,0,.7))
          drop-shadow(0 0 calc(40px * var(--k)) rgba(255,59,78,.4));
}
.ow-card.busted .ow-card-title {
  background: linear-gradient(180deg,#dceaff 4%, #4c9dff 48%, #123a72 100%);
  -webkit-background-clip:text; background-clip:text;
  filter: drop-shadow(0 calc(3px * var(--k)) 0 rgba(0,0,0,.7))
          drop-shadow(0 0 calc(40px * var(--k)) rgba(76,157,255,.4));
}
.ow-card-sub {
  margin-top: calc(var(--u) * 2.4);
  font-family: var(--fm); font-size: calc(13px * var(--k));
  letter-spacing:.36em; color: var(--steel); text-shadow: var(--sh-o1);
}
.ow-card-rewards { display:flex; gap: calc(var(--u) * 4); justify-content:center; margin-top: calc(var(--u) * 6); }
.ow-card-rw {
  min-width: calc(168px * var(--k));
  padding: calc(var(--u) * 3.2) calc(var(--u) * 4);
  background: rgba(14,19,26,.82); border:1px solid var(--line);
  border-radius: calc(3px * var(--k));
}
.ow-card-rw b {
  display:block; font-family: var(--fd); font-weight:400;
  font-size: calc(38px * var(--k)); line-height:1; color: var(--gold);
  text-shadow: var(--sh-o1);
}
.ow-card-rw span {
  display:block; margin-top: calc(var(--u) * .8);
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.26em; color: var(--steel);
}

/* ================================================================= feed */
.ow-feed {
  position:absolute; left: var(--pad); top: var(--pad);
  display:flex; flex-direction:column; gap: calc(var(--u) * 1.4);
  width: calc(320px * var(--k));
}
.ow-feed-row {
  display:flex; align-items:center; gap: calc(var(--u) * 2);
  padding: calc(var(--u) * 1.6) calc(var(--u) * 2.4);
  background: linear-gradient(90deg, rgba(12,16,22,.90), rgba(12,16,22,.55));
  border-left: calc(3px * var(--k)) solid var(--slag);
  font-size: calc(11.5px * var(--k)); letter-spacing:.14em;
  text-shadow: var(--sh-hard); will-change: opacity, transform;
}
.ow-feed-row > i {
  width: calc(5px * var(--k)); height: calc(5px * var(--k));
  background: var(--slag); transform: rotate(45deg); flex:none;
}
.ow-feed-row .tx { flex:1; color: var(--ink); }
.ow-feed-row .vl { font-family: var(--fm); color: var(--gold); }
.ow-feed-row.good { border-left-color: var(--good); }
.ow-feed-row.good > i { background: var(--good); }
.ow-feed-row.bad { border-left-color: var(--blood); }
.ow-feed-row.bad > i { background: var(--blood); }
.ow-feed-row.gold { border-left-color: var(--gold); }
.ow-feed-row.gold > i { background: var(--gold); }

/* ================================================================ radio */
.ow-radio {
  position:absolute; left:50%; top: var(--pad); transform: translateX(-50%);
  display:flex; align-items:center; gap: calc(var(--u) * 3);
  padding: calc(var(--u) * 1.6) calc(var(--u) * 4);
  background: var(--glass); border:1px solid var(--line);
  border-radius: calc(3px * var(--k));
  box-shadow: 0 calc(6px * var(--k)) calc(22px * var(--k)) rgba(0,0,0,.5);
  will-change: opacity, transform;
}
.ow-radio-dial { display:flex; gap: calc(var(--u) * 1); align-items:flex-end; }
.ow-radio-dial > i {
  width: calc(3px * var(--k)); height: calc(9px * var(--k));
  background: var(--steel-d);
}
.ow-radio-dial > i.on { height: calc(17px * var(--k)); box-shadow: 0 0 calc(8px * var(--k)) currentColor; }
.ow-radio-col { display:flex; flex-direction:column; }
.ow-radio-name { font-family: var(--fd); font-size: calc(17px * var(--k)); letter-spacing:.06em; text-shadow: var(--sh-hard); }
.ow-radio-genre { font-family: var(--fm); font-size: calc(8.6px * var(--k)); letter-spacing:.26em; color: var(--steel); }
.ow-radio-freq { font-family: var(--fm); font-size: calc(12px * var(--k)); color: var(--steel); letter-spacing:.1em; }

/* ================================================================ phone */
/* A burner, not a menu: a steel chassis with a screen in it, parked in the
   bottom right where it cannot cover the ring or the objective. */
.ow-phone {
  position:absolute; right: var(--pad); bottom: calc(var(--pad) + 84px * var(--k));
  width: calc(310px * var(--k));
  padding: calc(var(--u) * 2.4);
  border-radius: calc(12px * var(--k));
  background: linear-gradient(168deg,#39424f,#1a2029 42%,#0d1116);
  border: 1px solid rgba(160,176,198,.22);
  box-shadow: 0 calc(16px * var(--k)) calc(44px * var(--k)) rgba(0,0,0,.72),
              inset 0 1px 0 rgba(255,255,255,.10);
  will-change: opacity, transform;
}
.ow-phone-body {
  background: linear-gradient(180deg,#0a1016,#070b10);
  border: 1px solid rgba(0,0,0,.7);
  border-radius: calc(5px * var(--k));
  box-shadow: inset 0 0 calc(22px * var(--k)) rgba(0,0,0,.9);
  padding: calc(var(--u) * 2);
}
.ow-phone-bar {
  display:flex; align-items:center; gap: calc(var(--u) * 1.6);
  font-family: var(--fm); font-size: calc(8.4px * var(--k));
  letter-spacing:.2em; color: var(--steel);
  padding-bottom: calc(var(--u) * 1.6);
  border-bottom: 1px solid rgba(125,140,163,.16);
}
.ow-phone-bar .carrier { flex:1; }
.ow-phone-bar .clk { color: var(--paper); }
.ow-phone-sig { display:flex; align-items:flex-end; gap: calc(1.5px * var(--k)); }
.ow-phone-sig > i { width: calc(2px * var(--k)); background: var(--river-l); }
.ow-phone-batt {
  width: calc(15px * var(--k)); height: calc(7px * var(--k));
  border:1px solid rgba(160,176,198,.5); border-radius: calc(1.5px * var(--k)); padding:1px;
}
.ow-phone-batt > i { display:block; width:62%; height:100%; background: var(--good); }
.ow-phone-tabs { display:flex; gap: calc(var(--u) * 1); margin: calc(var(--u) * 2) 0; }
.ow-phone-tabs .tab {
  flex:1; text-align:center; padding: calc(var(--u) * 1.2) 0;
  font-family: var(--fm); font-size: calc(8.4px * var(--k)); letter-spacing:.18em;
  color: var(--steel); border:1px solid rgba(125,140,163,.2);
  border-radius: calc(2px * var(--k));
}
.ow-phone-tabs .tab.on { background: var(--slag); color:#180b02; border-color: var(--slag); }
.ow-phone-list { display:flex; flex-direction:column; gap: calc(var(--u) * .8); }
.ow-phone-row {
  display:flex; align-items:center; gap: calc(var(--u) * 2);
  padding: calc(var(--u) * 1.6) calc(var(--u) * 1.6);
  border-radius: calc(2px * var(--k));
  border-left: calc(2px * var(--k)) solid transparent;
}
.ow-phone-row.sel { background: rgba(255,106,18,.13); border-left-color: var(--slag); }
.ow-phone-row > i {
  width: calc(7px * var(--k)); height: calc(7px * var(--k)); border-radius:50%;
  flex:none; box-shadow: 0 0 calc(7px * var(--k)) currentColor;
}
.ow-phone-row .c { flex:1; min-width:0; }
.ow-phone-row .n { font-family: var(--fd); font-size: calc(15px * var(--k)); letter-spacing:.05em; color: var(--paper); }
.ow-phone-row .s { font-family: var(--fm); font-size: calc(7.6px * var(--k)); letter-spacing:.2em; color: var(--steel); }
.ow-phone-row .v { font-family: var(--fm); font-size: calc(9px * var(--k)); letter-spacing:.14em; color: var(--steel); }
.ow-phone-foot {
  margin-top: calc(var(--u) * 2); padding-top: calc(var(--u) * 1.6);
  border-top: 1px solid rgba(125,140,163,.16);
  font-family: var(--fm); font-size: calc(8px * var(--k));
  letter-spacing:.16em; color: var(--steel-d); text-align:center;
}

/* =============================================================== wheels */
.ow-wheel { position:absolute; inset:0; }
.ow-wheel canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }

/* ============================================================ pause map */
.ow-map {
  position:absolute; inset:0; pointer-events:auto;
  background:#05080b; will-change:opacity;
}
.ow-map-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:crosshair; }
.ow-map-top {
  position:absolute; left: var(--pad); top: var(--pad); right: var(--pad);
  display:flex; align-items:flex-end; gap: calc(var(--u) * 6);
  pointer-events:none;
}
.ow-map-ttl .eyebrow {
  font-family: var(--fm); font-size: calc(10px * var(--k));
  letter-spacing:.34em; color: var(--slag);
}
.ow-map-ttl h2 {
  font-family: var(--fd); font-weight:400; font-size: calc(46px * var(--k));
  line-height:.92; letter-spacing:.03em;
  background: linear-gradient(178deg,#fff6de 8%, var(--gold) 52%, #a05e00 100%);
  -webkit-background-clip:text; background-clip:text; color:transparent;
  filter: drop-shadow(0 calc(2px * var(--k)) 0 rgba(0,0,0,.6));
}
.ow-map-where {
  font-family: var(--fd); font-size: calc(22px * var(--k));
  color: var(--paper); letter-spacing:.06em; text-shadow: var(--sh-o1);
  padding-bottom: calc(var(--u) * 1);
}
.ow-map-counts {
  margin-left:auto; margin-right: calc(96px * var(--k));
  font-family: var(--fm); font-size: calc(11px * var(--k));
  letter-spacing:.2em; color: var(--steel); padding-bottom: calc(var(--u) * 1.5);
}
.ow-map-legend {
  position:absolute; left: var(--pad); bottom: var(--pad);
  display:grid; grid-template-columns: 1fr 1fr; gap: calc(var(--u) * 1.4) calc(var(--u) * 5);
  padding: calc(var(--u) * 3);
  background: rgba(9,12,17,.82); border:1px solid var(--line);
  border-radius: calc(3px * var(--k)); pointer-events:none;
}
.ow-map-legend .lg {
  display:flex; align-items:center; gap: calc(var(--u) * 1.6);
  font-size: calc(10px * var(--k)); letter-spacing:.14em; color: var(--ink-2);
}
.ow-map-legend .lg > i {
  width: calc(9px * var(--k)); height: calc(9px * var(--k));
  border-radius: calc(2px * var(--k)); flex:none;
  box-shadow: 0 0 0 1px rgba(0,0,0,.6);
}
.ow-map-hint {
  position:absolute; right: var(--pad); bottom: var(--pad);
  text-align:right; font-family: var(--fm); font-size: calc(10px * var(--k));
  letter-spacing:.16em; color: var(--steel); opacity:.72;
  line-height:1.9; pointer-events:none; text-shadow: var(--sh-hard);
}

/* ========================================================= world markers */
.ow-mk {
  position:absolute; left:0; top:0;
  display:flex; flex-direction:column; align-items:center;
  will-change: transform, opacity;
}
.ow-mk-glyph { position:relative; width:calc(16px * var(--k)); height:calc(16px * var(--k)); }
.ow-mk-glyph svg { position:absolute; inset:0; width:100%; height:100%; display:block; overflow:visible;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.85)); }
.ow-mk-letter {
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-size: calc(9.5px * var(--k)); color:#08161c; font-weight:700;
}
.ow-mk-dist {
  margin-top: calc(var(--u) * .6);
  font-size: calc(10px * var(--k)); letter-spacing:.12em; color: var(--ink);
  text-shadow: var(--sh);
}
.ow-mk-name { font-size: calc(9px * var(--k)); letter-spacing:.18em; color: var(--ink-2); text-shadow:var(--sh); }
.ow-mk.threat .ow-mk-dist { color: var(--red); }

.ow-nade { position:absolute; left:0; top:0; will-change: transform, opacity; }
.ow-nade-ring {
  position:absolute; left:50%; top:50%; width:calc(30px * var(--k)); height:calc(30px * var(--k));
  margin:calc(-15px * var(--k)) 0 0 calc(-15px * var(--k));
  border: calc(1.5px * var(--k)) solid var(--red); border-radius:50%;
  will-change: transform, opacity;
}
.ow-nade-core {
  position:absolute; left:50%; top:50%; width:calc(15px * var(--k)); height:calc(15px * var(--k));
  margin:calc(-7.5px * var(--k)) 0 0 calc(-7.5px * var(--k));
}
.ow-nade-core svg { width:100%; height:100%; display:block; filter:drop-shadow(0 1px 2px rgba(0,0,0,.9)); }
.ow-nade-label {
  position:absolute; left:50%; top:calc(13px * var(--k)); transform:translateX(-50%);
  font-size: calc(9px * var(--k)); letter-spacing:.24em; color:var(--red); white-space:nowrap;
  text-shadow: var(--sh);
}

/* ======================================================== damage numbers */
.ow-dn {
  position:absolute; left:0; top:0; font-family: var(--fd);
  font-size: calc(17px * var(--k)); font-weight:700; letter-spacing:.03em;
  color: var(--ink); text-shadow: 0 1px 2px rgba(0,0,0,.95), 0 0 calc(8px * var(--k)) rgba(0,0,0,.6);
  will-change: transform, opacity;
}
.ow-dn.hs   { color: var(--gold); font-size: calc(21px * var(--k)); }
.ow-dn.kill { color: var(--red);   font-size: calc(23px * var(--k)); }
.ow-dn.armour { color: var(--cyan); }

/* ================================================================ prompt */
.ow-prompt {
  position:absolute; left:50%; top:62%;
  transform: translate(-50%,-50%);
  display:flex; align-items:center; gap: calc(var(--u) * 2.4);
  padding: calc(var(--u) * 2) calc(var(--u) * 3.4);
  background: rgba(8,11,16,.86); border:1px solid var(--line-hot);
  border-radius: calc(3px * var(--k));
  will-change: opacity, transform;
}
.ow-key {
  min-width: calc(24px * var(--k)); height: calc(24px * var(--k));
  padding: 0 calc(var(--u) * 1.4);
  display:flex; align-items:center; justify-content:center;
  font-family: var(--fm); font-size: calc(11px * var(--k)); letter-spacing:.06em;
  border: 1px solid var(--line); border-radius: calc(3px * var(--k));
  background: #1d242e; color: var(--gold);
  box-shadow: 0 1px 3px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.12);
}
.ow-prompt-txt { font-size: calc(12.5px * var(--k)); letter-spacing:.2em; text-shadow: var(--sh); }
.ow-prompt-sub { font-size: calc(9.5px * var(--k)); letter-spacing:.2em; color:var(--ink-2); }
.ow-prompt-arc { position:absolute; left:calc(-6px * var(--k)); top:50%; }

/* ================================================================ banner */
.ow-banner {
  position:absolute; left:50%; top:26%;
  transform: translate(-50%,-50%);
  text-align:center;
  padding: calc(var(--u) * 4) calc(var(--u) * 30);
  will-change: opacity, transform;
}
.ow-banner::before {
  content:''; position:absolute; inset:0; z-index:-1;
  background: linear-gradient(to bottom,
    rgba(4,7,10,0) 0%, rgba(4,7,10,.60) 20%, rgba(4,7,10,.60) 80%, rgba(4,7,10,0) 100%);
  -webkit-mask-image: linear-gradient(to right, rgba(0,0,0,0) 0%, #000 20%, #000 80%, rgba(0,0,0,0) 100%);
          mask-image: linear-gradient(to right, rgba(0,0,0,0) 0%, #000 20%, #000 80%, rgba(0,0,0,0) 100%);
}
.ow-banner-t {
  font-family: var(--fd); font-weight:400;
  font-size: calc(32px * var(--k)); letter-spacing:.24em;
  text-shadow: var(--sh-o2);
}
.ow-banner-s {
  margin-top: calc(var(--u) * 1.4);
  font-family: var(--fm); font-size: calc(11px * var(--k));
  letter-spacing:.3em; color: var(--gold);
  text-shadow: var(--sh-o1);
}
.ow-banner-rule {
  margin: calc(var(--u) * 1.4) auto 0; width: calc(120px * var(--k)); height:1px;
  background: linear-gradient(to right, transparent, rgba(255,255,255,.5), transparent);
}

/* ================================================================== menu */
.ow-menu {
  position:absolute; inset:0; pointer-events:auto;
  background: linear-gradient(105deg, rgba(4,6,8,.92) 0%, rgba(4,6,8,.74) 46%, rgba(4,6,8,.4) 100%);
  backdrop-filter: blur(calc(9px * var(--k))) saturate(.7) brightness(.8);
  opacity:0; will-change: opacity;
}
.ow-menu-inner {
  position:absolute; left: calc(var(--u) * 22); top:50%;
  transform: translateY(-50%);
  width: calc(430px * var(--k));
  padding-left: calc(var(--u) * 4.5);
  border-left: calc(2px * var(--k)) solid var(--slag);
}
.ow-menu h1 {
  font-family: var(--fd); font-weight:400;
  font-size: calc(52px * var(--k)); letter-spacing:.16em;
  text-shadow: 0 2px 6px rgba(0,0,0,.8);
}
.ow-menu .sub {
  margin-top: calc(var(--u) * 1.2); font-family: var(--fm);
  font-size: calc(10px * var(--k)); letter-spacing:.28em; color: var(--steel);
}
.ow-menu .rule {
  margin: calc(var(--u) * 5) 0 calc(var(--u) * 2); height:1px;
  background: linear-gradient(to right, rgba(255,255,255,.28), rgba(255,255,255,0));
}
.ow-row {
  display:flex; align-items:center; justify-content:space-between;
  gap: calc(var(--u) * 4); padding: calc(var(--u) * 3.2) 0;
  border-bottom: 1px solid var(--hair-2);
}
.ow-row > .name { font-size: calc(11.5px * var(--k)); letter-spacing:.2em; color: var(--ink); }
.ow-row > .val { font-family: var(--fm); font-size: calc(11px * var(--k)); color: var(--gold);
  letter-spacing:.04em; min-width: calc(46px * var(--k)); text-align:right; }
.ow-seg { display:flex; gap:0; }
.ow-seg button {
  appearance:none; border:1px solid var(--hair); border-right:0; background:rgba(255,255,255,.03);
  color: var(--ink-2); font-family:var(--ff); font-weight:600; text-transform:uppercase;
  font-size: calc(10px * var(--k)); letter-spacing:.16em;
  padding: calc(var(--u) * 1.3) calc(var(--u) * 2.2);
  cursor:pointer; position:relative; transition: color .12s, background .12s;
}
.ow-seg button:last-child { border-right:1px solid var(--hair); }
.ow-seg button:hover { color: var(--ink); background: rgba(255,255,255,.07); }
.ow-seg button.on { color:#180b02; background: var(--slag); }
.ow-slider { position:relative; width: calc(190px * var(--k)); height: calc(18px * var(--k)); }
.ow-slider .track {
  position:absolute; left:0; right:0; top:50%; height: calc(2px * var(--k));
  transform: translateY(-50%); background: rgba(255,255,255,.16);
}
.ow-slider .fill {
  position:absolute; left:0; top:50%; height: calc(2px * var(--k));
  transform: translateY(-50%); background: var(--gold);
}
.ow-slider .knob {
  position:absolute; top:50%; width: calc(9px * var(--k)); height: calc(9px * var(--k));
  background: var(--gold); transform: translate(-50%,-50%) rotate(45deg);
  box-shadow: 0 0 calc(6px * var(--k)) rgba(255,201,60,.5);
}
.ow-slider input {
  position:absolute; inset:0; width:100%; height:100%; margin:0;
  appearance:none; background:transparent; cursor:pointer; opacity:0;
}
.ow-btns { margin-top: calc(var(--u) * 5); display:flex; gap: calc(var(--u) * 2.5); }
/* THE WAY OUT IS A TAP TARGET, NOT A DESIGN ELEMENT.
   These minimums are deliberately in raw px and NOT multiplied by --k: 44 px is
   a physical finger, and it does not shrink because the viewport is short. The
   Resume button used to measure 61x24 at 1280x720 and was the ONLY exit from
   this menu on a phone, where the touch layer (and with it the MENU button that
   opened the menu) is hidden under every modal. */
.ow-btn {
  appearance:none; border:1px solid var(--hair); background: rgba(255,255,255,.04);
  color: var(--ink); font-family: var(--ff); font-weight:600; text-transform:uppercase;
  font-size: calc(11px * var(--k)); letter-spacing:.2em;
  padding: calc(var(--u) * 2.2) calc(var(--u) * 5);
  min-height: 46px; min-width: 116px;
  display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; transition: background .12s, border-color .12s;
  touch-action: manipulation;
}
.ow-btn:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.4); }
.ow-btn.primary {
  background: linear-gradient(180deg, var(--slag-hot), var(--slag) 55%, #c14400);
  border-color:#ffb974; color:#1a0d02;
}
.ow-btn.primary:hover { background: linear-gradient(180deg,#ffc776, var(--slag-hot) 55%, #d95400); }
/* The second exit. Always in the same corner, always the same size, and it is
   the one control on the menu a player finds without reading anything. */
.ow-menu-x {
  position:absolute; top: calc(var(--u) * 5); right: calc(var(--u) * 5);
  width:52px; height:52px; appearance:none; cursor:pointer;
  border:1px solid var(--hair); background: rgba(8,10,14,.65);
  color: var(--ink); font-family: var(--ff); font-size:20px; line-height:1;
  display:flex; align-items:center; justify-content:center;
  touch-action: manipulation; transition: background .12s, border-color .12s;
}
.ow-menu-x:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.45); }
.ow-menu .hint {
  margin-top: calc(var(--u) * 4); font-family: var(--fm);
  font-size: calc(9.5px * var(--k)); letter-spacing:.2em; color: var(--steel-d);
}
/* Narrow screens: the fixed 22u indent plus a 430px panel overflows a phone, so
   the settings column becomes a full-bleed sheet with room to breathe. */
@media (max-width: 760px) {
  .ow-menu-inner {
    left: calc(var(--u) * 4); right: calc(var(--u) * 4);
    width:auto; padding-left: calc(var(--u) * 3.5);
    max-height: 86vh; overflow-y: auto; overscroll-behavior: contain;
  }
  .ow-menu h1 { font-size: calc(40px * var(--k)); }
  .ow-btns { flex-wrap: wrap; }
  .ow-seg button { padding: calc(var(--u) * 2.4) calc(var(--u) * 2.6); min-height:42px; }
  .ow-menu .hint { display:none; }
}

/* ======================================================= story overview */
/* The mission overview: every chapter, its status, its teaser,
   its cash — done rows REPLAY, the current row starts, locked rows wait. */
.ow-story {
  position:absolute; inset:0; pointer-events:auto;
  background: linear-gradient(105deg, rgba(4,6,8,.94) 0%, rgba(4,6,8,.8) 52%, rgba(4,6,8,.5) 100%);
  backdrop-filter: blur(calc(9px * var(--k))) saturate(.7) brightness(.8);
  opacity:0; will-change:opacity;
}
.ow-story-card {
  position:absolute; left:50%; top:50%; transform: translate(-50%,-50%);
  width: min(calc(620px * var(--k)), calc(100vw - 24px));
  max-height: 90vh; overflow-y:auto; overscroll-behavior:contain;
  padding: calc(var(--u) * 6) calc(var(--u) * 6) calc(var(--u) * 5);
  background: linear-gradient(180deg, rgba(14,18,25,.9), rgba(7,10,14,.94));
  border:1px solid var(--line); border-top: calc(2px * var(--k)) solid var(--slag);
  box-shadow: 0 calc(22px * var(--k)) calc(60px * var(--k)) rgba(0,0,0,.75);
}
.ow-story-card .eyebrow {
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.3em; color: var(--slag-hot);
}
.ow-story-card h2 {
  font-family: var(--fd); font-weight:400; font-size: calc(34px * var(--k));
  letter-spacing:.1em; margin-top: calc(var(--u) * 1);
  text-shadow: 0 2px 6px rgba(0,0,0,.8);
}
.ow-story-card .sub {
  margin-top: calc(var(--u) * 1); font-family: var(--fm);
  font-size: calc(9.5px * var(--k)); letter-spacing:.2em; color: var(--steel);
}
.ow-story-list {
  margin-top: calc(var(--u) * 4);
  display:flex; flex-direction:column; gap: calc(var(--u) * 1);
}
.ow-story-row {
  display:flex; align-items:center; gap: calc(var(--u) * 2.6);
  padding: calc(var(--u) * 2) calc(var(--u) * 2.2);
  border:1px solid var(--hair-2);
  border-left: calc(2px * var(--k)) solid var(--steel-d);
  min-height:44px;
}
.ow-story-row .ic { width: calc(17px * var(--k)); height: calc(17px * var(--k)); flex:none; }
.ow-story-row .ic svg { width:100%; height:100%; display:block; stroke: currentColor; }
.ow-story-row .col { flex:1; min-width:0; }
.ow-story-row .name {
  font-family: var(--fd); font-size: calc(16px * var(--k)); letter-spacing:.05em;
  color: var(--paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ow-story-row .teaser {
  font-size: calc(10px * var(--k)); letter-spacing:.06em; color: var(--ink-2);
  text-transform:none; margin-top: calc(var(--u) * .5);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ow-story-row .side {
  font-family: var(--fm); font-size: calc(10px * var(--k)); letter-spacing:.14em;
  color: var(--gold); flex:none;
}
.ow-story-row.done { color: var(--good); border-left-color: var(--good); }
.ow-story-row.done .side { color: var(--river-l); }
.ow-story-row.current {
  color: var(--slag-hot); border-left-color: var(--slag);
  background: rgba(255,106,18,.08);
}
.ow-story-row.locked { opacity:.42; color: var(--steel); }
.ow-story-row.playable { cursor:pointer; }
.ow-story-row.playable:hover, .ow-story-row.sel {
  background: rgba(255,255,255,.06); border-color: var(--line);
}
.ow-story-none {
  padding: calc(var(--u) * 4); font-size: calc(11px * var(--k));
  letter-spacing:.1em; color: var(--steel); text-align:center;
}
.ow-story-note {
  margin-top: calc(var(--u) * 3.5); font-family: var(--fm);
  font-size: calc(8.6px * var(--k)); letter-spacing:.14em; line-height:1.7;
  color: var(--steel-d); text-transform:none;
}
.ow-story .ow-btns { justify-content:flex-end; }

/* =============================================================== ending */
/* Full-screen slide sequence: icon, title, giant neon year, epilogue, and
   PLAY FREE ROAM on the last slide. Driven with unscaled time in story.js —
   the sim is frozen underneath it. */
.ow-end-tint {
  position:absolute; inset:0; pointer-events:auto;
  background: radial-gradient(ellipse at 50% 42%, rgba(20,10,4,.86), rgba(3,5,8,.97) 78%);
}
.ow-end {
  position:absolute; inset:0; pointer-events:auto;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  text-align:center; padding: calc(var(--u) * 8);
}
.ow-end-scene { width: calc(64px * var(--k)); height: calc(64px * var(--k)); color: var(--slag-hot); }
.ow-end-scene svg {
  width:100%; height:100%; display:block; stroke: currentColor;
  filter: drop-shadow(0 0 calc(16px * var(--k)) rgba(255,176,58,.55));
}
.ow-end-title {
  margin-top: calc(var(--u) * 4);
  font-family: var(--fd); font-weight:400;
  font-size: calc(46px * var(--k)); letter-spacing:.14em;
  color: var(--paper); text-shadow: var(--o2), 0 0 calc(30px * var(--k)) rgba(255,140,40,.3);
  will-change: opacity, transform;
}
.ow-end-year {
  margin-top: calc(var(--u) * 2);
  font-family: var(--fd); font-weight:400;
  font-size: calc(120px * var(--k)); line-height:.9; letter-spacing:.04em;
  color: var(--slag-hot);
  text-shadow:
    0 0 calc(14px * var(--k)) rgba(255,176,58,.9),
    0 0 calc(46px * var(--k)) rgba(255,106,18,.55),
    0 0 calc(110px * var(--k)) rgba(255,106,18,.3);
  will-change: opacity, transform;
}
.ow-end-msg {
  margin-top: calc(var(--u) * 5);
  max-width: min(calc(620px * var(--k)), 86vw);
  font-size: calc(13.5px * var(--k)); letter-spacing:.05em; line-height:1.75;
  color: var(--ink-2); text-transform:none; text-shadow: var(--sh);
  will-change: opacity;
}
.ow-end .ow-btns { justify-content:center; }

/* =========================================================== responsive */
/* Ultrawide: the corner clusters drift too far apart to scan as one HUD, so
   the margins tighten as the aspect stretches. */
@media (min-aspect-ratio: 2/1) {
  .ow-hud { --pad: calc(var(--u) * 6); }
}
@media (max-height: 760px) {
  .ow-hud { --pad: calc(var(--u) * 5); }
}

/* ==========================================================================
   BOOT FLOW — loader, brother select, intro card       (see src/ui/boot.js)
   ==========================================================================
   This one block does NOT scale off --k. It lives outside .ow-hud and it is
   painted before the UI system exists, so it has no design scale to read; it
   sizes off the viewport with clamp() instead, which is also what makes it fit
   a 390 px phone and a 2560 px monitor without a second layout. */
.ow-boot {
  /* The design tokens live on '.ow-hud' and the boot overlay is deliberately
     outside it (it exists before the HUD does). It reuses '.ow-btn', so it has
     to declare the subset that button reads — without these, START rendered as
     dark text on a transparent box: invisible, and the only way into the game. */
  --k: 1;
  --u: 4px;
  --ff: ${FONT_STACK};
  --fd: ${FONT_DISPLAY};
  --fm: ${FONT_MONO};
  --ink: rgba(238,242,246,.96);
  --ink-2: rgba(196,209,222,.62);
  --hair: rgba(255,255,255,.18);
  --hair-2: rgba(255,255,255,.08);
  --slag: #ff6a12;
  --slag-hot: #ffb03a;
  --gold: #ffc93c;
  --steel: #7d8ca3;
  --steel-d: #3b4658;

  position:fixed; inset:0; z-index:60;
  background:
    radial-gradient(120% 90% at 18% 8%, rgba(255,106,18,.16), transparent 58%),
    radial-gradient(90% 80% at 88% 92%, rgba(46,166,160,.14), transparent 62%),
    linear-gradient(160deg, #05070b 0%, #0a0e15 48%, #05070b 100%);
  color:#eef2f7; font-family: var(--ff, "Inter", Arial, sans-serif);
  display:flex; align-items:center; justify-content:center;
  padding: clamp(16px, 4vw, 56px);
  opacity:1; transition: opacity .4s ease;
  overflow-y:auto; overscroll-behavior:contain;
  -webkit-font-smoothing:antialiased;
}
.ow-boot * { margin:0; padding:0; box-sizing:border-box; }
.ow-boot h1 {
  font-family: var(--fd, "Inter", Arial, sans-serif); font-weight:400;
  letter-spacing:.14em; line-height:1.02;
}
.ow-boot .eyebrow {
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(9px, 1.1vw, 12px); letter-spacing:.34em; color:#ff8a3d;
}
.ow-boot .sub {
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(9.5px, 1.05vw, 12px); letter-spacing:.2em; color:#7d8ba0;
}

/* ---- loader ---- */
.ow-boot-load { width:min(660px, 100%); text-align:left; }
.ow-boot-load h1 {
  margin: clamp(8px, 1.2vw, 14px) 0 clamp(8px, 1vw, 12px);
  font-size: clamp(38px, 7.4vw, 82px);
  text-shadow: 0 3px 22px rgba(255,106,18,.28);
}
.ow-boot-bar {
  position:relative; margin-top: clamp(26px, 4vw, 44px);
  height:4px; background: rgba(255,255,255,.1); overflow:hidden;
}
.ow-boot-bar > i {
  position:absolute; inset:0 auto 0 0; width:0%; display:block;
  background: linear-gradient(90deg, #ff6a12, #ffc93c);
  box-shadow: 0 0 14px rgba(255,150,60,.6);
}
.ow-boot-row {
  margin-top: clamp(10px, 1.4vw, 16px); display:flex;
  justify-content:space-between; gap:16px;
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(10px, 1.1vw, 12.5px); letter-spacing:.16em;
}
.ow-boot-row .stage { color:#aab6c6; }
.ow-boot-row .pct { color:#ffc93c; }

/* ---- brother select ---- */
.ow-boot-select { width:min(1180px, 100%); }
.ow-boot-select h1 {
  margin: clamp(6px,.9vw,12px) 0 clamp(6px,.8vw,10px);
  font-size: clamp(24px, 3.4vw, 44px);
}
.ow-boot-cards {
  margin-top: clamp(18px, 2.6vw, 34px);
  display:grid; grid-template-columns: repeat(3, 1fr);
  gap: clamp(10px, 1.4vw, 22px);
}
.ow-boot-card {
  --c:#ff6a12; --a:#ffc93c;
  position:relative; cursor:pointer; text-align:left;
  border:1px solid rgba(255,255,255,.13);
  border-top: 3px solid var(--c);
  background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
  transition: transform .14s ease, border-color .14s ease, background .14s ease;
  touch-action: manipulation; overflow:hidden;
}
.ow-boot-card:hover, .ow-boot-card:focus-visible {
  transform: translateY(-3px); outline:none;
  border-color: var(--a);
  background: linear-gradient(180deg, rgba(255,255,255,.1), rgba(255,255,255,.03));
}
.ow-boot-card.on { box-shadow: inset 0 0 0 1px var(--c); }
.ow-boot-card .ava { position:relative; aspect-ratio: 5 / 3; overflow:hidden; }
.ow-boot-card .ava svg { display:block; width:100%; height:100%; }
.ow-boot-card .live {
  position:absolute; left:0; bottom:0;
  padding:5px 9px; background: var(--c); color:#06090d;
  font-family: var(--fm, ui-monospace, monospace);
  font-size:9px; letter-spacing:.2em;
}
.ow-boot-card .body { padding: clamp(11px, 1.4vw, 18px); }
.ow-boot-card h3 {
  font-family: var(--fd, "Inter", Arial, sans-serif); font-weight:400;
  font-size: clamp(20px, 2.3vw, 30px); letter-spacing:.12em; color: var(--a);
}
.ow-boot-card .role {
  margin-top:4px; font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(8.5px, .85vw, 10px); letter-spacing:.22em; color:#7d8ba0;
}
.ow-boot-card .blurb {
  margin-top: clamp(8px, 1vw, 12px); font-size: clamp(11.5px, 1.05vw, 13.5px);
  line-height:1.5; color:#c3ccd8; min-height: 3em;
}
.ow-boot-card .stats { margin-top: clamp(10px, 1.2vw, 15px); display:grid; gap:6px; }
.ow-boot-card .stat {
  display:grid; grid-template-columns: 54px 1fr; align-items:center; gap:9px;
  font-family: var(--fm, ui-monospace, monospace); font-size:9px;
  letter-spacing:.18em; color:#8d99a9;
}
.ow-boot-card .stat .bar { height:3px; background: rgba(255,255,255,.11); }
.ow-boot-card .stat .bar > i {
  display:block; height:100%; background: var(--c);
}
.ow-boot-card .prog {
  margin-top: clamp(11px, 1.3vw, 16px); padding-top: clamp(9px, 1vw, 12px);
  border-top:1px solid rgba(255,255,255,.1);
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(9px, .95vw, 11px); letter-spacing:.16em; color:#ffc93c;
}
.ow-boot-hint {
  margin-top: clamp(14px, 1.8vw, 22px);
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(9px, .95vw, 11px); letter-spacing:.18em; color:#5f6b7c;
}

/* ---- erase all progress ----
   The only destructive control on this screen, and every other control here is
   one click from starting a game — so it is styled to be found on purpose and
   not on the way past. Dimmer than the hint line above it until hovered, no
   button chrome at rest, and a wide margin so a fat-fingered reach for the
   bottom card cannot land on it. It turns red only once the pointer is on it,
   which is the moment the player has actually chosen to look at it. */
.ow-boot-erase { margin-top: clamp(18px, 2.4vw, 30px); }
.ow-boot-erase-btn {
  appearance:none; background:none; border:0; padding:6px 10px;
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(8px, .85vw, 10px); letter-spacing:.2em; text-transform:uppercase;
  color:#454f5c; cursor:pointer;
  border-bottom:1px solid transparent;
  transition: color .16s ease, border-color .16s ease;
}
.ow-boot-erase-btn:hover,
.ow-boot-erase-btn:focus-visible {
  color:#d8544a; border-bottom-color: rgba(216,84,74,.5); outline:none;
}

/* ---- intro card ---- */
.ow-boot-intro { width:min(820px, 100%); }
.ow-boot-intro .card {
  --c:#ff6a12; --a:#ffc93c;
  border:1px solid rgba(255,255,255,.14);
  border-left: 4px solid var(--c);
  background:
    linear-gradient(115deg, color-mix(in srgb, var(--c) 20%, transparent), transparent 62%),
    linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015));
  padding: clamp(20px, 3.4vw, 46px);
}
.ow-boot-intro h1 {
  margin: clamp(6px,.8vw,10px) 0 6px;
  font-size: clamp(34px, 5.6vw, 64px); color: var(--a);
}
.ow-boot-intro .role {
  font-family: var(--fm, ui-monospace, monospace);
  font-size: clamp(9px, .95vw, 11px); letter-spacing:.22em; color:#8d99a9;
}
.ow-boot-intro .rule {
  margin: clamp(14px,2vw,22px) 0; height:1px;
  background: linear-gradient(to right, rgba(255,255,255,.3), transparent);
}
.ow-boot-intro .body {
  font-size: clamp(13px, 1.25vw, 16px); line-height:1.62; color:#cdd5e0;
  max-width:60ch;
}
.ow-boot-intro .facts {
  margin-top: clamp(16px, 2.2vw, 26px);
  display:grid; grid-template-columns: repeat(2, minmax(0,1fr));
  gap: clamp(8px, 1.1vw, 14px);
}
.ow-boot-intro .fact {
  display:flex; flex-direction:column; gap:4px;
  border-left:1px solid rgba(255,255,255,.14); padding-left:11px;
}
.ow-boot-intro .fact .k {
  font-family: var(--fm, ui-monospace, monospace);
  font-size:9px; letter-spacing:.24em; color:#6d798a;
}
.ow-boot-intro .fact .v {
  font-size: clamp(11.5px, 1.05vw, 13.5px); color:#e4eaf2;
}
.ow-boot-intro .tag {
  margin-top: clamp(16px, 2.2vw, 26px);
  font-family: var(--fd, "Inter", Arial, sans-serif);
  font-size: clamp(15px, 1.7vw, 22px); letter-spacing:.06em;
  color: var(--a); font-style:italic;
}
.ow-boot-btns {
  margin-top: clamp(20px, 2.8vw, 34px); display:flex; gap:12px; flex-wrap:wrap;
}
.ow-boot-btns .ow-btn {
  min-height:54px; min-width:154px; font-size:13px; letter-spacing:.24em;
}

@media (max-width: 760px) {
  .ow-boot { align-items:flex-start; padding-top: clamp(20px, 6vh, 48px); }
  .ow-boot-cards { grid-template-columns: 1fr; }
  /* One card per row on a phone means the portrait becomes a banner, and the
     three cards have to remain reachable by thumb without a long scroll. */
  .ow-boot-card { display:grid; grid-template-columns: 104px 1fr; }
  .ow-boot-card .ava { aspect-ratio:auto; height:100%; }
  .ow-boot-card .blurb { min-height:0; }
  .ow-boot-card .stats { grid-template-columns: 1fr 1fr; display:grid; gap:6px 12px; }
  .ow-boot-intro .facts { grid-template-columns: 1fr; }
}

/* ==========================================================================
   TOUCH CONTROLS
   ==========================================================================
   Two layers, deliberately on opposite sides of the HUD in the stacking order.

   .ow-tzone-layer sits BELOW every readout: it is the camera-drag surface and
   it covers the whole frame, so anything that must stay tappable (the radar,
   the weapon chip, the nav buttons, the pause menu) simply has to be above it,
   which it already is.

   .ow-touch-layer sits ABOVE: the joystick, the six buttons and the action
   label. It is display:none unless TouchControls turns it on, and the
   controls scale off --tk (the SHORT screen edge), not --k (height), because a
   thumb does not get smaller when you rotate the phone.

   Geometry, portrait 390x844 @ --tk 0.557:
     joystick   left 14,  bottom 22, 130 px  -> x  14..144
     buttons    right 12, bottom 22, ~206 px -> x 172..378, two rows ~146 tall
     action lbl right, sits directly above the button block
     radar dock lifted to clear the joystick (see .ow-touch .ow-dock below)
     weapon chip lifted to clear the button block
   -------------------------------------------------------------------------- */

.ow-tzone-layer { pointer-events: none; }
.ow-tzone {
  position: absolute; inset: 0;
  pointer-events: none;
  touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.ow-tzone.on { pointer-events: auto; }

.ow-touch-layer {
  --tk: 1;
  --tsafe-b: env(safe-area-inset-bottom, 0px);
  --tsafe-l: env(safe-area-inset-left, 0px);
  --tsafe-r: env(safe-area-inset-right, 0px);
  --tbase: calc(22px * var(--tk) + var(--tsafe-b));
  --tjoy: var(--tjoy-size, calc(208px * var(--tk)));
  --tbtn: calc(100px * var(--tk));
  --tfire: calc(124px * var(--tk));
  --trows: calc(var(--tbtn) + var(--tfire) + 15px * var(--tk));
  position: absolute; inset: 0;
  pointer-events: none;
  -webkit-tap-highlight-color: transparent;
}

/* ---------------------------------------------------------------- joystick */
.ow-tjoy {
  position: absolute;
  left: calc(14px * var(--tk) + var(--tsafe-l));
  bottom: var(--tbase);
  width: var(--tjoy); height: var(--tjoy);
  border-radius: 50%;
  pointer-events: auto; touch-action: none;
  opacity: .82;
  transition: opacity .14s;
}
.ow-tjoy.on { opacity: 1; }
.ow-tjoy-ring {
  position: absolute; inset: 0; border-radius: 50%;
  border: calc(2px * var(--tk)) solid rgba(125,140,163,.42);
  background:
    radial-gradient(circle at 50% 42%, rgba(255,255,255,.07), rgba(4,7,11,.44) 72%);
  box-shadow: 0 calc(6px * var(--tk)) calc(20px * var(--tk)) rgba(0,0,0,.5),
              inset 0 0 calc(18px * var(--tk)) rgba(0,0,0,.55);
}
.ow-tjoy-ring::after {
  content: ''; position: absolute; inset: 26%;
  border-radius: 50%; border: 1px dashed rgba(125,140,163,.24);
}
.ow-tjoy-knob {
  position: absolute; left: 50%; top: 50%;
  width: 44%; height: 44%; border-radius: 50%;
  transform: translate(-50%,-50%);
  background: radial-gradient(circle at 36% 30%, #ffd18a, var(--slag) 62%, #b53d00);
  border: calc(1.5px * var(--tk)) solid rgba(255,208,140,.55);
  box-shadow: 0 calc(4px * var(--tk)) calc(14px * var(--tk)) rgba(0,0,0,.6),
              0 0 calc(16px * var(--tk)) rgba(255,106,18,.35);
}

/* ----------------------------------------------------------------- buttons */
.ow-tbtns {
  position: absolute;
  right: calc(12px * var(--tk) + var(--tsafe-r));
  bottom: var(--tbase);
  display: flex; flex-direction: column;
  gap: calc(15px * var(--tk));
  align-items: flex-end;
}
.ow-trow { display: flex; gap: calc(15px * var(--tk)); align-items: center; }
.ow-tbtn {
  pointer-events: auto; touch-action: none;
  width: var(--tbtn); height: var(--tbtn);
  border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: calc(2px * var(--tk));
  color: var(--ink);
  border: calc(2px * var(--tk)) solid rgba(125,140,163,.42);
  background: linear-gradient(180deg, rgba(26,32,42,.72), rgba(6,9,14,.80));
  box-shadow: 0 calc(4px * var(--tk)) calc(14px * var(--tk)) rgba(0,0,0,.5),
              inset 0 1px 0 rgba(255,255,255,.07);
  opacity: .88;
}
.ow-tbtn-ic {
  width: calc(40px * var(--tk)); height: calc(40px * var(--tk));
  stroke: currentColor; display: block;
}
.ow-tbtn small {
  font-family: var(--fm); font-size: calc(15px * var(--tk));
  letter-spacing: .12em; opacity: .8; line-height: 1;
}
.ow-tbtn.held { transform: scale(.9); background: rgba(255,106,18,.32); border-color: var(--slag); }
.ow-tbtn.off { opacity: .34; }

.ow-tbtn.fire {
  width: var(--tfire); height: var(--tfire);
  color: #ffb08a; border-color: rgba(255,106,18,.62);
  background: radial-gradient(circle at 50% 40%, rgba(255,92,42,.38), rgba(6,9,14,.82) 74%);
}
.ow-tbtn.fire .ow-tbtn-ic { width: calc(50px * var(--tk)); height: calc(50px * var(--tk)); }
.ow-tbtn.brake { color: #ff9aa4; border-color: rgba(255,59,78,.5); }
.ow-tbtn.run   { color: #79d2ff; }
.ow-tbtn.aim   { color: #cfd8e4; }
.ow-tbtn.wep   { color: var(--paper); }

/* The contextual action. Deliberately the loudest control on the screen after
   FIRE — it is the one button that does everything, so it must never be
   mistaken for a modifier. */
.ow-tbtn.act {
  width: calc(116px * var(--tk)); height: calc(116px * var(--tk));
  color: #1c1004;
  border-color: #ffd98c;
  background: linear-gradient(180deg, var(--slag-hot), var(--slag) 58%, #bf4600);
  box-shadow: 0 calc(5px * var(--tk)) calc(18px * var(--tk)) rgba(0,0,0,.55),
              0 0 calc(26px * var(--tk)) rgba(255,140,40,.28),
              inset 0 1px 0 rgba(255,255,255,.35);
  opacity: 1;
}
.ow-tbtn.act small { opacity: .92; font-weight: 700; }
.ow-tbtn.act.held { background: linear-gradient(180deg,#fff0c2, var(--slag-hot) 60%, #d95400); transform: scale(.9); }
.ow-tbtn.act.off {
  color: var(--steel); border-color: rgba(125,140,163,.34); opacity: .5;
  background: linear-gradient(180deg, rgba(26,32,42,.72), rgba(6,9,14,.8));
  box-shadow: 0 calc(4px * var(--tk)) calc(12px * var(--tk)) rgba(0,0,0,.45);
}

/* The action, spelled out, directly above the cluster. */
.ow-tact-label {
  position: absolute;
  right: calc(12px * var(--tk) + var(--tsafe-r));
  bottom: calc(var(--tband-r, 170px) + var(--tsafe-b));
  max-width: 62vw;
  padding: calc(8px * var(--tk)) calc(14px * var(--tk));
  background: rgba(8,11,16,.86);
  border: 1px solid var(--line-hot);
  border-left: calc(3px * var(--tk)) solid var(--slag);
  font-size: calc(19px * var(--tk)); letter-spacing: .1em;
  color: var(--paper); text-shadow: var(--sh-hard);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0;
}
.ow-tact-label.on { opacity: 1; }

/* ------------------------------------------------------------- nav buttons */
.ow-tnav {
  position: absolute;
  left: calc(var(--pad) + var(--tsafe-l));
  top: var(--pad);
  display: flex; gap: calc(9px * var(--tk));
}
.ow-tnav-btn {
  pointer-events: auto; touch-action: none;
  width: var(--tnav, calc(68px * var(--tk))); height: var(--tnav, calc(68px * var(--tk)));
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--line);
  border-radius: calc(3px * var(--k));
  background: rgba(8,11,16,.72);
  color: var(--gold);
}
.ow-tnav-btn svg { width: 58%; height: 58%; stroke: currentColor; }
.ow-tnav-btn.held { background: rgba(255,106,18,.3); border-color: var(--slag); }

/* ---------------------------------------------------- HUD reflow for touch */
/* --tband-l / --tband-r are published from touch.js: the exact height the
   joystick and the button cluster occupy. Everything that lived in the bottom
   corners is lifted off THOSE rather than off numbers copied by hand, so a
   change to a button size here can never silently bury the minimap.

   The Slag Ring stays in the bottom-left rather than moving to another corner:
   it lifts to sit directly above the joystick, so the map is still the
   bottom-left anchor and the eye does not have to relearn the HUD between
   platforms. */
.ow-hud.ow-touch .ow-dock {
  transform-origin: bottom left;
  transform: scale(.62);
  bottom: calc(var(--tband-l, 150px) + env(safe-area-inset-bottom, 0px));
}
/* Bottom to top on the right: the buttons, the action label, the weapon chip,
   then dialogue. Each is offset from the one below it rather than from the
   screen edge, so none of them can ever land on another. */
.ow-hud.ow-touch .ow-weap {
  bottom: calc(var(--tband-r, 170px) + var(--tlabel, 46px) + env(safe-area-inset-bottom, 0px));
  pointer-events: auto;
}
/* The vehicle meters ride directly above the lifted weapon chip. */
.ow-hud.ow-touch .ow-vehm {
  bottom: calc(var(--tband-r, 170px) + var(--tlabel, 46px) + 84px * var(--k) + env(safe-area-inset-bottom, 0px));
}
.ow-hud.ow-touch .ow-zone {
  bottom: calc(var(--tband-l, 150px) + 168px * var(--k));
}
/* Dialogue has to clear the weapon chip AND the vehicle meters above it —
   hence the stacked offsets rather than a flat margin. */
.ow-hud.ow-touch .ow-subs {
  bottom: calc(var(--tband-r, 170px) + var(--tlabel, 46px) + 158px * var(--k));
  width: min(76%, calc(560px * var(--k)));
}
/* Narrow screens: the notification column and the money/stars column are each
   authored for a 1920 frame and together they are wider than a phone. The feed
   starts below BOTH the nav row and the radio strip's slot, so the two never
   land on top of each other when a station change and a pickup coincide. */
.ow-hud.ow-touch .ow-feed {
  top: calc(var(--pad) + var(--tnav, 46px) + 64px * var(--k));
  width: min(calc(320px * var(--k)), 52vw);
}
.ow-hud.ow-touch .ow-topright { width: min(calc(360px * var(--k)), 44vw); }
.ow-hud.ow-touch .ow-obj { padding-right: calc(var(--u) * 2); }
.ow-hud.ow-touch .ow-obj-text { font-size: calc(15px * var(--k)); }
.ow-hud.ow-touch .ow-money-v { font-size: calc(34px * var(--k)); }
/* The radio strip is transient and centred, which on a phone puts it straight
   through the money. It moves under the nav row, on the left, where the feed
   will be a moment later — both are short-lived and never both urgent. */
.ow-hud.ow-touch .ow-radio {
  left: var(--pad); right: auto; transform: none;
  top: calc(var(--pad) + var(--tnav, 46px) + 10px);
  padding: calc(var(--u) * 1.2) calc(var(--u) * 2.4);
}
/* The centre prompt is the DESKTOP face of the contextual action. On touch the
   ACT button and its label say the same thing far more usefully, and a centred
   panel would sit under the right thumb. */
.ow-hud.ow-touch .ow-prompt { display: none !important; }

.ow-hud.ow-touch.ow-touch-land .ow-dock { transform: scale(.5); }
.ow-hud.ow-touch.ow-touch-land .ow-feed { width: min(calc(320px * var(--k)), 34vw); }
.ow-hud.ow-touch.ow-touch-land .ow-topright { width: min(calc(360px * var(--k)), 32vw); }
.ow-hud.ow-touch.ow-touch-land .ow-title { bottom: 42%; }

.ow-touch-layer.land { --tbase: calc(13px * var(--tk) + var(--tsafe-b)); }

/* ========================================================== cheat menu */
/* The test harness (src/ui/cheats.js). It is deliberately the plainest thing
   in this stylesheet: a tester is scanning for a row name at speed, not
   admiring a panel, so it is dense, high-contrast, monospaced where it counts
   and completely still — nothing here animates except the open fade.

   It never ships in a review frame: cheatsEnabled() is off under ?capture=1
   and under navigator.webdriver, so none of this is ever constructed there.

   NOTE (ARCHITECTURE.md rule 10): this is a CSS template literal. A backtick
   in a comment here CLOSES it and takes the whole boot down. The toggle key is
   written as BACKQUOTE in the .ow-cheat-hint copy for exactly that reason. */
.ow-cheat-layer { pointer-events: none; }

/* The always-on button. Left edge, vertically centred: the top-left is the
   notification feed and the touch nav row, the bottom-left is the Slag Ring
   and the joystick, so this is the one part of that edge nothing else claims
   on either platform. 46 px minimum in RAW px — it is a finger, and it does
   not shrink because the viewport is short. */
.ow-cheat-btn {
  position:absolute; left: calc(var(--u) * 2); top: 44%;
  appearance:none; cursor:pointer; pointer-events:auto; touch-action: manipulation;
  width:52px; min-height:56px;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:3px;
  border:1px solid var(--hair); border-left-width: 3px; border-left-color: var(--violet);
  background: rgba(8,10,14,.78);
  color: var(--violet); font-family: var(--fm); font-size:7.5px; letter-spacing:.14em;
  transition: background .12s, border-color .12s;
  z-index:4;
}
.ow-cheat-btn svg { width:22px; height:22px; stroke: currentColor; fill:none; display:block; }
.ow-cheat-btn:hover { background: rgba(192,124,255,.18); border-color: var(--violet); }
/* WHILE THE PANEL IS OPEN the button parks in the bottom-left corner, beside
   the CLOSE button. On a phone the card is full-bleed, so a button floating at
   44% of the left edge sits directly on top of a row and hides its name — and
   it cannot simply be hidden, because "the same button closes it" is one of
   the five doors out. Moving it keeps both properties. */
.ow-cheat-btn.on {
  background: rgba(192,124,255,.26); color:#f0e2ff;
  top:auto; bottom: calc(var(--u) * 3); left: calc(var(--u) * 3);
}

.ow-cheat {
  position:absolute; inset:0; pointer-events:auto;
  background: linear-gradient(120deg, rgba(4,6,8,.95) 0%, rgba(4,6,8,.86) 60%, rgba(4,6,8,.62) 100%);
  backdrop-filter: blur(calc(8px * var(--k))) saturate(.7) brightness(.78);
  opacity:0; will-change:opacity;
}
.ow-cheat-card {
  position:absolute; left:50%; top:50%; transform: translate(-50%,-50%);
  /* Deliberately roomier than the other modals. This one is a LIST you scan,
     and rows-on-screen is the single thing that decides how fast it is to use. */
  width: min(calc(880px * var(--k)), calc(100vw - 20px));
  height: min(calc(960px * var(--k)), 93vh);
  display:flex; flex-direction:column;
  padding: calc(var(--u) * 4) calc(var(--u) * 4) calc(var(--u) * 3.5);
  background: linear-gradient(180deg, rgba(14,18,25,.94), rgba(7,10,14,.97));
  border:1px solid var(--line); border-top: calc(2px * var(--k)) solid var(--violet);
  box-shadow: 0 calc(22px * var(--k)) calc(60px * var(--k)) rgba(0,0,0,.8);
}
.ow-cheat-head { display:flex; align-items:flex-end; justify-content:space-between; gap: calc(var(--u) * 3); }
.ow-cheat-head .col { min-width:0; }
.ow-cheat-head .eyebrow {
  font-family: var(--fm); font-size: calc(8.4px * var(--k));
  letter-spacing:.28em; color: var(--violet);
}
.ow-cheat-head h2 {
  font-family: var(--fd); font-weight:400; font-size: calc(30px * var(--k));
  letter-spacing:.1em; margin-top: calc(var(--u) * .8); color: var(--paper);
}
.ow-cheat-head .sub {
  font-family: var(--fm); font-size: calc(8.4px * var(--k));
  letter-spacing:.2em; color: var(--steel); white-space:nowrap; padding-bottom:3px;
}

.ow-cheat-tabs {
  margin-top: calc(var(--u) * 3); display:flex; flex-wrap:wrap; gap: calc(var(--u) * 1);
}
.ow-cheat-tab {
  appearance:none; cursor:pointer; touch-action: manipulation;
  display:flex; align-items:center; gap: calc(var(--u) * 1.4);
  padding: calc(var(--u) * 1.4) calc(var(--u) * 2.4);
  min-height:40px;
  border:1px solid var(--hair-2); background: rgba(255,255,255,.03);
  color: var(--steel); font-family: var(--fm);
  font-size: calc(9px * var(--k)); letter-spacing:.18em;
}
.ow-cheat-tab svg { width:15px; height:15px; stroke: currentColor; fill:none; display:block; }
.ow-cheat-tab:hover { background: rgba(255,255,255,.08); color: var(--ink); }
.ow-cheat-tab.on {
  color:#1a0d02; background: linear-gradient(180deg, var(--slag-hot), var(--slag) 60%);
  border-color:#ffb974;
}

.ow-cheat-filter { margin-top: calc(var(--u) * 2.5); display:flex; gap: calc(var(--u) * 1.5); }
.ow-cheat-filter input {
  flex:1; min-width:0; appearance:none;
  padding: calc(var(--u) * 2) calc(var(--u) * 2.4);
  min-height:44px;
  border:1px solid var(--hair); background: rgba(4,6,9,.85);
  color: var(--paper); font-family: var(--fm);
  font-size: calc(11px * var(--k)); letter-spacing:.12em;
  /* .ow-hud sets user-select:none and text-transform:uppercase on everything.
     Both are wrong for a field you type into and select inside. */
  -webkit-user-select:text; user-select:text; text-transform:none;
}
.ow-cheat-filter input:focus { outline:none; border-color: var(--violet); }
.ow-cheat-clear {
  appearance:none; cursor:pointer; touch-action: manipulation;
  min-height:44px; min-width:70px; padding:0 calc(var(--u) * 2.5);
  border:1px solid var(--hair); background: rgba(255,255,255,.04);
  color: var(--steel); font-family: var(--fm); font-size: calc(9px * var(--k)); letter-spacing:.18em;
}
.ow-cheat-clear:hover { background: rgba(255,255,255,.1); color: var(--ink); }

.ow-cheat-list {
  flex:1; min-height:0; margin-top: calc(var(--u) * 2.5);
  overflow-y:auto; overscroll-behavior:contain;
  display:flex; flex-direction:column; gap:2px;
  border-top:1px solid var(--hair-2); padding-top: calc(var(--u) * 2);
}
.ow-cheat-head-row {
  margin-top: calc(var(--u) * 2); padding: calc(var(--u) * 1) 0;
  font-family: var(--fm); font-size: calc(8.2px * var(--k));
  letter-spacing:.26em; color: var(--steel-d);
}
.ow-cheat-head-row:first-child { margin-top:0; }
.ow-cheat-row {
  display:flex; align-items:center; gap: calc(var(--u) * 2);
  padding: calc(var(--u) * 1.4) calc(var(--u) * 1.8);
  border:1px solid transparent; border-left: 2px solid var(--steel-d);
  background: rgba(255,255,255,.02);
  min-height:44px;
}
.ow-cheat-row:hover { background: rgba(255,255,255,.06); border-color: var(--hair-2); }
.ow-cheat-row .col { flex:1; min-width:0; }
.ow-cheat-row .name {
  font-family: var(--fd); font-size: calc(14px * var(--k)); letter-spacing:.05em;
  color: var(--paper); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ow-cheat-row .name .tag {
  margin-left: calc(var(--u) * 1.5);
  font-family: var(--fm); font-size: calc(7.6px * var(--k));
  letter-spacing:.2em; color: var(--steel-d);
}
.ow-cheat-row .sub {
  margin-top:2px; font-family: var(--fm); font-size: calc(8.4px * var(--k));
  letter-spacing:.1em; color: var(--steel);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ow-cheat-row .acts { display:flex; gap: calc(var(--u) * 1); flex:none; }
/* A GREYED ROW IS AN HONEST ROW. A subsystem that is not running says so in
   the sub line and its buttons go inert — it never disappears, because a
   missing row reads as a missing feature rather than a missing producer. */
.ow-cheat-row.off { opacity:.42; border-left-color: var(--blood); }
.ow-cheat-row.off .sub { color: var(--blood); }
.ow-cheat-act {
  appearance:none; cursor:pointer; touch-action: manipulation;
  min-height:36px; padding:0 calc(var(--u) * 2.2);
  border:1px solid var(--hair); background: rgba(255,255,255,.05);
  color: var(--ink); font-family: var(--fm);
  font-size: calc(8.6px * var(--k)); letter-spacing:.16em; white-space:nowrap;
}
.ow-cheat-act:hover { background: rgba(255,255,255,.13); border-color: rgba(255,255,255,.4); }
.ow-cheat-act.primary {
  background: linear-gradient(180deg, var(--slag-hot), var(--slag) 60%);
  border-color:#ffb974; color:#1a0d02;
}
.ow-cheat-act:disabled { cursor:default; opacity:.5; }
.ow-cheat-status {
  margin-top: calc(var(--u) * 2); padding-top: calc(var(--u) * 1.5);
  border-top:1px solid var(--hair-2);
  font-family: var(--fm); font-size: calc(9px * var(--k));
  letter-spacing:.12em; color: var(--river-l);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.ow-cheat-status.bad { color: var(--blood); }
.ow-cheat .ow-btns { margin-top: calc(var(--u) * 2.5); justify-content:flex-end; }

/* Touch: fingers, not a mouse. Every control in here clears 44 px, the card
   goes edge to edge, and the tab strip is allowed to wrap onto two rows
   rather than shrinking below a thumb. */
.ow-hud.ow-touch .ow-cheat-card {
  width: calc(100vw - 12px); height: 94vh;
  padding: calc(var(--u) * 3) calc(var(--u) * 3) calc(var(--u) * 2.5);
}
.ow-hud.ow-touch .ow-cheat-act { min-height:44px; padding:0 calc(var(--u) * 2.6); }
.ow-hud.ow-touch .ow-cheat-tab { min-height:44px; }
.ow-hud.ow-touch .ow-cheat-row { min-height:52px; }
.ow-hud.ow-touch .ow-cheat-head h2 { font-size: calc(24px * var(--k)); }
.ow-hud.ow-touch .ow-cheat-head .sub { display:none; }
/* Narrow screens keep ONE row per entry — wrapping the buttons onto a second
   line halved the number of visible rows and made the list slower to scan,
   which is the only thing this panel is optimised for. The name ellipsizes
   instead; the filter box is how you find a long one. */
@media (max-width: 760px) {
  .ow-cheat-head .sub { display:none; }
  .ow-cheat-row { padding: calc(var(--u) * 1.2) calc(var(--u) * 1.4); }
  .ow-cheat-act { padding:0 calc(var(--u) * 1.8); }
  /* Room for the parked CHEATS button beside CLOSE. */
  .ow-cheat .ow-btns { padding-left: 64px; }
}
`;

const DEFS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <!-- organic edge for the blood vignette: banded turbulence displacing the
         gradient so the hurt overlay never reads as a clean radial ramp -->
    <filter id="ow-warp" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.011" numOctaves="4" seed="17" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="34" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  </defs>
</svg>`;

let installed = false;

export function installStyles() {
  if (installed && document.getElementById('ow-ui-style')) return;
  const s = document.createElement('style');
  s.id = 'ow-ui-style';
  s.textContent = CSS;
  document.head.appendChild(s);
  const d = document.createElement('div');
  d.id = 'ow-ui-defs';
  d.innerHTML = DEFS;
  document.body.appendChild(d);
  installed = true;
}

export function removeStyles() {
  document.getElementById('ow-ui-style')?.remove();
  document.getElementById('ow-ui-defs')?.remove();
  installed = false;
}
