/**
 * ===========================================================================
 * HUD SANDBOX — `ui`'s own harness
 * ===========================================================================
 *
 * Mounts JUST this subsystem against a stub `ctx`, over a painted backplate,
 * so the HUD can be reviewed without booting the whole engine. A syntax error
 * anywhere in the other sixteen directories stops the real page booting, and
 * the HUD still has to be
 * iterable. It is also ~40x faster than a full capture, which is what makes
 * "capture, look, fix, repeat" actually affordable.
 *
 *   /src/ui/sandbox.html?state=combat&bg=day
 *   /src/ui/sandbox.html?state=wanted5&bg=night
 *
 * `bg` paints a deliberately hostile backdrop: `day` is a blown-out noon sky
 * with white concrete (the worst case for light HUD type), `night` is a wet
 * black street with sodium pools (the worst case for dark plates). If a widget
 * survives both it survives the game.
 */

import * as THREE from 'three';
import { UiSystem, DEBUG_STATES } from './index.js';

/* ------------------------------------------------------------------ rng --- */

/** Tiny xorshift matching the shape of ctx.rng (float/range/int/fork). */
function makeRng(seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  const api = {
    float: next,
    range: (a, b) => a + next() * (b - a),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    bool: (p = 0.5) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    fork: () => makeRng((s = (s * 1664525 + 1013904223) >>> 0)),
  };
  return api;
}

/* --------------------------------------------------------------- events --- */

function makeEvents() {
  const map = new Map();
  return {
    on(type, fn) {
      let l = map.get(type);
      if (!l) map.set(type, (l = new Set()));
      l.add(fn);
      return () => l.delete(fn);
    },
    off(type, fn) {
      map.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const l = map.get(type);
      if (!l) return;
      for (const fn of l) fn(payload);
    },
  };
}

/* ----------------------------------------------------------- background --- */

/**
 * The backplate. Not a flat colour: a HUD reviewed over #333 always looks
 * fine, and then falls apart over a real frame.
 */
function paintBackdrop(canvas, mode, rng) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (canvas.width = Math.round(innerWidth * dpr));
  const H = (canvas.height = Math.round(innerHeight * dpr));
  const g = canvas.getContext('2d');
  const u = W / 1920;

  if (mode === 'night') {
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#080c14');
    sky.addColorStop(0.42, '#0d1520');
    sky.addColorStop(0.55, '#161d26');
    sky.addColorStop(1, '#05070a');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    // wet road: sodium pools reflected down the frame
    for (let i = 0; i < 14; i++) {
      const x = rng.range(0, W);
      const y = rng.range(H * 0.5, H);
      const r = rng.range(60, 260) * u;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,168,64,.42)');
      grd.addColorStop(0.5, 'rgba(255,140,40,.12)');
      grd.addColorStop(1, 'rgba(255,140,40,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
      g.fill();
    }
    // lit windows on a black skyline
    g.fillStyle = '#03050a';
    for (let i = 0; i < 22; i++) {
      const bw = rng.range(70, 190) * u;
      const bx = rng.range(-60, W);
      const bh = rng.range(H * 0.14, H * 0.5);
      g.fillRect(bx, H * 0.52 - bh, bw, bh);
      for (let wx = bx + 8 * u; wx < bx + bw - 10 * u; wx += 16 * u) {
        for (let wy = H * 0.52 - bh + 10 * u; wy < H * 0.52 - 8 * u; wy += 22 * u) {
          if (rng.float() > 0.68) {
            g.fillStyle = rng.float() > 0.7 ? 'rgba(255,214,140,.85)' : 'rgba(190,214,255,.5)';
            g.fillRect(wx, wy, 7 * u, 11 * u);
            g.fillStyle = '#03050a';
          }
        }
      }
    }
  } else {
    // blown noon sky + white concrete: the worst case for light HUD type
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#8fb6dd');
    sky.addColorStop(0.4, '#cfe2f2');
    sky.addColorStop(0.58, '#f4f7fa');
    sky.addColorStop(1, '#b9bfc4');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const sun = g.createRadialGradient(W * 0.72, H * 0.2, 0, W * 0.72, H * 0.2, H * 0.72);
    sun.addColorStop(0, 'rgba(255,255,248,1)');
    sun.addColorStop(0.3, 'rgba(255,252,235,.55)');
    sun.addColorStop(1, 'rgba(255,250,230,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, H);
    // pale concrete blocks
    for (let i = 0; i < 18; i++) {
      const bw = rng.range(90, 240) * u;
      const bx = rng.range(-60, W);
      const bh = rng.range(H * 0.12, H * 0.46);
      g.fillStyle = `rgba(${230 - rng.range(0, 40) | 0},${232 - rng.range(0, 40) | 0},${228 - rng.range(0, 40) | 0},1)`;
      g.fillRect(bx, H * 0.6 - bh, bw, bh);
    }
    g.fillStyle = '#c9ccc9';
    g.fillRect(0, H * 0.6, W, H * 0.4);
  }

  // grain — a clean gradient is never what a rendered frame looks like
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.float() - 0.5) * 12;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ boot -- */

const params = new URLSearchParams(location.search);
const STATE = params.get('state') ?? 'combat';
const BG = params.get('bg') ?? 'day';

const bgCanvas = document.getElementById('bg');
const rng = makeRng(0x5eed1234);
paintBackdrop(bgCanvas, BG, makeRng(0xc0ffee));

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3000);
// Grant Street, Golden Triangle, facing the Steel Tower. Dry land inside the
// densest district — the worst case for the radar and therefore the right one.
camera.position.set(-248, 8, 62);
camera.lookAt(-208, 40, -80);
camera.updateMatrixWorld(true);

const events = makeEvents();
const registry = new Map();

const ctx = {
  scene: new THREE.Scene(),
  camera,
  viewScene: new THREE.Scene(),
  viewCamera: camera,
  canvas: bgCanvas,
  config: { q: {}, sensitivity: 0.0022, fov: 60 },
  events,
  rng,
  time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 120, alpha: 0, scale: 1, frame: 0 },
  input: {
    enabled: false,
    frozen: true,
    pointerLocked: false,
    look: { x: 0, y: 0 },
    ads: false,
    action: () => false,
    actionPressed: () => false,
    held: () => false,
    pressed: () => false,
    released: () => false,
  },
  get: (id) => registry.get(id) ?? null,
  peek: (id) => registry.get(id) ?? null,
  has: (id) => registry.has(id),
};

const ui = new UiSystem();
await ui.init(ctx);
registry.set('ui', ui);
window.__UI__ = ui;
window.__STATES__ = DEBUG_STATES;

ui.debugState(STATE);
ui.resize(innerWidth, innerHeight, ctx);

addEventListener('resize', () => {
  paintBackdrop(bgCanvas, BG, makeRng(0xc0ffee));
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  ui.resize(innerWidth, innerHeight, ctx);
});

let last = performance.now();
let frame = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  ctx.time.raw += dt;
  ctx.time.elapsed += dt * ctx.time.scale;
  ctx.time.dt = dt * ctx.time.scale;
  ctx.time.frame = ++frame;
  ui.lateUpdate(ctx.time.dt, ctx);
  window.__FRAMES__ = frame;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.__READY__ = true;
