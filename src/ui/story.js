/**
 * ===========================================================================
 * THE STORY — chapter overview modal + the ending sequencer
 * ===========================================================================
 *
 * StoryOverview is the mission overview: every chapter listed with its status,
 * teaser and cash reward. Completed rows say REPLAY and start that chapter
 * again; the current row starts the next one; locked rows are visible but dim —
 * the road map sells the ride, which is why this screen deliberately opens
 * before the first chapter.
 *
 * EndingSequencer is the ending overlay: a multi-slide
 * full-screen sequence — icon, title, a giant neon year, an epilogue message —
 * ending on PLAY FREE ROAM. It listens for nothing itself; `ui` feeds it from
 * the `ending:play` event and drives it with UNSCALED time, because the sim is
 * frozen underneath it (that is the point of an ending card).
 *
 * Both are dumb readers of data handed to them. Neither imports anything from
 * `src/game/` — `ui/index.js` normalises whatever `game.getStoryOverview()`
 * returns (or assembles a fallback) before calling `show()`, so a missing or
 * differently-shaped producer degrades to fewer rows, never to a crash.
 */

import { el, svg, setText, setStyle, clamp01, damp, ease } from './util.js';

/** Small stroked glyphs for row status and ending scenes. No image assets. */
const GLYPHS = {
  check: 'M5 12.5l4.5 4.5L19 7',
  play: 'M8 5.5v13l10-6.5z',
  lock: 'M7 11V8a5 5 0 0110 0v3M6 11h12v9H6zM12 15v2.5',
  flag: 'M6 21V4M6 5h11l-2.5 3.5L17 12H6',
  star: 'M12 3.4l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.8l6-.8L12 3.4z',
  respect: 'M7 4h10v4a5 5 0 01-10 0V4M7 5H4v2a3 3 0 003 3M17 5h3v2a3 3 0 01-3 3M12 13v4M8 20h8M10 17h4',
  ring: 'M12 8.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM9.5 8.5L12 3.5l2.5 5',
  map: 'M9 4L3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4zM9 4v13M15 6.5v13',
  home: 'M4 11l8-7 8 7M6 10v10h12V10M10 20v-6h4v6',
};

function icon(parent, name, cls) {
  const s = svg('svg', { viewBox: '0 0 24 24', class: cls ?? '' }, parent);
  svg('path', {
    d: GLYPHS[name] ?? GLYPHS.star, fill: 'none', 'stroke-width': '1.7',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }, s);
  return s;
}

/** click AND touchend — a synthesized click is not guaranteed once anything
 *  in the stack preventDefaults a touch. Same pattern as the pause menu. */
function press(node, fn) {
  node.addEventListener('click', fn);
  node.addEventListener('touchend', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, { passive: false });
}

/* ------------------------------------------------------------- overview --- */

export class StoryOverview {
  constructor(parent) {
    this.root = el('div', 'ow-story ow-modal', parent);
    const card = el('div', 'ow-story-card', this.root);
    this.eyebrow = el('div', 'eyebrow', card, 'THE STORY SO FAR');
    this.title = el('h2', null, card);
    this.title.textContent = 'THE STORY';
    this.summary = el('div', 'sub', card, '');
    this.list = el('div', 'ow-story-list', card);
    this.note = el('div', 'ow-story-note', card,
      'Finish every chapter to unlock the whole arsenal and reach the ending. '
      + 'Cash and respect carry over — completed chapters can be replayed any time.');
    const btns = el('div', 'ow-btns', card);
    this.rideBtn = el('button', 'ow-btn primary', btns, "Let's ride");
    this.rideBtn.type = 'button';
    press(this.rideBtn, () => this.hide());

    this.closeBtn = el('button', 'ow-modal-x', this.root, '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close');
    press(this.closeBtn, () => this.hide());

    this.open = false;
    this.a = 0;
    this.index = 0;
    this.rows = [];
    /** Called with the chapter index when a playable row is activated. */
    this.onPick = null;
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {?object} data  normalised by ui._storyData():
   *   { title, summary, rows: [{ index, no, name, teaser, cash, status }] }
   *   status is 'done' | 'current' | 'locked'. Null data still shows the
   *   frame with an honest "no chapters yet" line — never a crash, never a
   *   blank screen.
   */
  show(data) {
    this.open = true;
    setStyle(this.root, 'display', '');
    this.list.textContent = '';
    this.rows.length = 0;
    this.index = 0;

    setText(this.title, data?.title ?? 'THE STORY');
    setText(this.summary, data?.summary ?? '');
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (!rows.length) {
      const none = el('div', 'ow-story-none', this.list,
        'No chapters on the board yet — cruise the city, work will find you.');
      setStyle(none, 'display', '');
      return;
    }

    for (const r of rows) {
      const st = r.status === 'done' ? 'done' : r.status === 'current' ? 'current' : 'locked';
      const playable = st !== 'locked';
      const row = el('div', 'ow-story-row ' + st + (playable ? ' playable' : ''), this.list);
      const ic = el('span', 'ic', row);
      icon(ic, st === 'done' ? 'check' : st === 'current' ? 'play' : 'lock');
      const col = el('div', 'col', row);
      el('div', 'name', col, `${r.no ?? ''} — ${r.name ?? ''}`);
      if (r.teaser) el('div', 'teaser', col, r.teaser);
      const side = st === 'done' ? 'REPLAY'
        : r.cash ? '$' + Number(r.cash).toLocaleString('en-US') : '';
      el('span', 'side', row, side);
      if (playable) {
        const i = r.index;
        press(row, () => this.onPick?.(i));
      }
      this.rows.push({ row, playable, index: r.index, status: st });
      if (st === 'current') this.index = this.rows.length - 1;
    }
    this._paintSel();
  }

  hide() {
    this.open = false;
  }

  toggle(data) {
    if (this.open) this.hide();
    else this.show(data);
  }

  /** Keyboard: arrows walk the playable rows, Enter activates. */
  move(d) {
    if (!this.rows.length) return;
    const n = this.rows.length;
    let i = this.index;
    for (let k = 0; k < n; k++) {
      i = (i + d + n) % n;
      if (this.rows[i].playable) break;
    }
    this.index = i;
    this._paintSel();
  }

  activate() {
    const r = this.rows[this.index];
    if (r?.playable) this.onPick?.(r.index);
  }

  _paintSel() {
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].row.classList.toggle('sel', i === this.index);
    }
  }

  update(rawDt) {
    this.a = damp(this.a, this.open ? 1 : 0, 15, rawDt);
    if (!this.open && this.a < 0.005) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'opacity', ease.outQuad(this.a).toFixed(3));
    return this.a;
  }

  dispose() {
    this.root.remove();
  }
}

/* ------------------------------------------------------------- ending ---- */

/** Seconds a non-final slide holds — a 5400 ms beat. */
const SLIDE_HOLD = 5.4;

export class EndingSequencer {
  constructor(parent) {
    this.tint = el('div', 'ow-end-tint', parent);
    this.root = el('div', 'ow-end ow-modal', parent);
    this.scene = el('div', 'ow-end-scene', this.root);
    this.title = el('h1', 'ow-end-title', this.root, '');
    this.year = el('div', 'ow-end-year', this.root, '');
    this.msg = el('p', 'ow-end-msg', this.root, '');
    const btns = el('div', 'ow-btns', this.root);
    this.btn = el('button', 'ow-btn primary', btns, 'Play free roam');
    this.btn.type = 'button';
    press(this.btn, () => this.close());

    this.active = false;
    this.slides = [];
    this.idx = 0;
    this.t = 0;
    /** Called once when the sequence ends, however it ends. */
    this.onDone = null;
    setStyle(this.root, 'display', 'none');
    setStyle(this.tint, 'display', 'none');
  }

  /**
   * @param {Array} slides  [{ icon, title, year, msg }] — any field optional,
   *   any extra field ignored. A malformed slide renders what it has.
   */
  play(slides) {
    const list = Array.isArray(slides) ? slides.filter((s) => s && typeof s === 'object') : [];
    if (!list.length) return false;
    this.slides = list;
    this.idx = 0;
    this.t = 0;
    this.active = true;
    setStyle(this.root, 'display', '');
    setStyle(this.tint, 'display', '');
    this._apply();
    return true;
  }

  _apply() {
    const s = this.slides[this.idx] ?? {};
    this.scene.textContent = '';
    icon(this.scene, s.icon && GLYPHS[s.icon] ? s.icon : 'star');
    setText(this.title, (s.title ?? '').toString().toUpperCase());
    setText(this.year, s.year != null ? String(s.year) : '');
    setStyle(this.year, 'display', s.year != null ? '' : 'none');
    setText(this.msg, s.msg ?? s.text ?? '');
    const last = this.idx >= this.slides.length - 1;
    setStyle(this.btn.parentElement, 'display', last ? '' : 'none');
  }

  /** ESC. First press jumps to the last slide; on the last slide it closes —
   *  a sequencer with no way out is a trap, however good the epilogue is. */
  skip() {
    if (!this.active) return;
    if (this.idx < this.slides.length - 1) {
      this.idx = this.slides.length - 1;
      this.t = 0;
      this._apply();
    } else {
      this.close();
    }
  }

  close() {
    if (!this.active) return;
    this.active = false;
    setStyle(this.root, 'display', 'none');
    setStyle(this.tint, 'display', 'none');
    this.onDone?.();
  }

  /** Driven with UNSCALED time — the sim is frozen while this is up. */
  update(rawDt) {
    if (!this.active) return 0;
    this.t += rawDt;
    if (this.t > SLIDE_HOLD && this.idx < this.slides.length - 1) {
      this.idx++;
      this.t = 0;
      this._apply();
    }
    // Slide entrance: title wipes up, year blooms.
    const inA = ease.outCubic(clamp01(this.t / 0.7));
    setStyle(this.title, 'opacity', inA.toFixed(3));
    setStyle(this.title, 'transform', `translateY(${((1 - inA) * 14).toFixed(1)}px)`);
    const yA = ease.outCubic(clamp01((this.t - 0.25) / 0.8));
    setStyle(this.year, 'opacity', yA.toFixed(3));
    setStyle(this.year, 'transform', `scale(${(0.92 + 0.08 * yA).toFixed(3)})`);
    setStyle(this.msg, 'opacity', clamp01((this.t - 0.5) / 0.6).toFixed(3));
    return 1;
  }

  dispose() {
    this.root.remove();
    this.tint.remove();
  }
}
