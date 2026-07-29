/**
 * ===========================================================================
 * THE PHONE
 * ===========================================================================
 *
 * A burner with a cracked screen. It is the shell every open-world game needs
 * for the things that are not gameplay: who you can call, what is on the radio,
 * how far through the twenty-four chapters you are.
 *
 * Three tabs, arrow keys to move, one column of rows — deliberately small. A
 * phone that tries to be an operating system is a phone nobody opens. What it
 * has to do is (a) look like an object in the world rather than a menu, and
 * (b) name the brothers and the six stations in their own colours.
 *
 * It slides in from the bottom right, so it never covers the ring or the
 * objective, and it dims the rest of the HUD while it is up.
 */

import { el, setText, setStyle, setClass, clamp, clamp01, damp, ease } from './util.js';
import { BOYZ, STATIONS, PACKAGES } from './data.js';

const TABS = ['CONTACTS', 'RADIO', 'PROGRESS'];

export class Phone {
  constructor(parent) {
    this.root = el('div', 'ow-phone', parent);
    const body = el('div', 'ow-phone-body', this.root);

    // status bar
    const bar = el('div', 'ow-phone-bar', body);
    const sig = el('div', 'ow-phone-sig', bar);
    for (let i = 0; i < 4; i++) {
      const b = el('i', null, sig);
      setStyle(b, 'height', `calc(${3 + i * 2}px * var(--k))`);
    }
    el('span', 'carrier', bar, 'STEEL CELL');
    this.clock = el('span', 'clk', bar, '17:23');
    const batt = el('div', 'ow-phone-batt', bar);
    el('i', null, batt);

    this.tabRow = el('div', 'ow-phone-tabs', body);
    this.tabEls = TABS.map((t, i) => {
      const tab = el('div', 'tab', this.tabRow, t);
      // Tabs are tap targets, not just labels — on touch the arrow keys the
      // footer used to name do not exist.
      this._press(tab, () => {
        this.tab = i;
        this.index = 0;
        this._paint();
      });
      return tab;
    });

    this.list = el('div', 'ow-phone-list', body);
    this.rows = [];
    for (let i = 0; i < 7; i++) {
      const r = el('div', 'ow-phone-row', this.list);
      const dot = el('i', null, r);
      const col = el('div', 'c', r);
      const t = el('div', 'n', col, '');
      const sub = el('div', 's', col, '');
      const val = el('div', 'v', r, '');
      setStyle(r, 'display', 'none');
      // A tap selects AND activates — one thumb, one motion, like a phone.
      this._press(r, () => {
        if (i >= this._count()) return;
        this.index = i;
        this._paint();
        const a = this.activate();
        if (a) this.onActivate?.(a);
      });
      this.rows.push({ r, dot, t, sub, val });
    }

    this.foot = el('div', 'ow-phone-foot', body, '↑ ↓ SELECT · ← → TAB · P CLOSE');
    this._footTouch = null;

    // The way out that does not need a keyboard: opening the phone hides the
    // touch layer (and the PHONE button that opened it) under the modal rule.
    this.closeBtn = el('button', 'ow-modal-x sm', this.root, '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close phone');
    this._press(this.closeBtn, () => this.hide());

    this.open = false;
    this.a = 0;
    this.tab = 0;
    this.index = 0;
    this.station = 'grease';
    this.character = 'aidan';
    this.found = 0;
    this.chapter = 4;
    this.respect = 0;
    /** Called with `activate()`'s result when a row is tapped. */
    this.onActivate = null;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'pointer-events', 'none');
    this._paint();
  }

  /** click AND touchend, the same pairing every modal control here uses. */
  _press(node, fn) {
    node.addEventListener('click', fn);
    node.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }, { passive: false });
  }

  /** The footer names the controls the player actually has. */
  setTouch(on) {
    if (this._footTouch === on) return;
    this._footTouch = on;
    setText(this.foot, on ? 'TAP A ROW · TAP A TAB · ✕ CLOSE' : '↑ ↓ SELECT · ← → TAB · P CLOSE');
  }

  show() {
    this.open = true;
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', 'auto');
    this._paint();
  }

  hide() {
    this.open = false;
    setStyle(this.root, 'pointer-events', 'none');
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  move(d) {
    const n = this._count();
    this.index = (this.index + d + n) % n;
    this._paint();
  }

  cycleTab(d) {
    this.tab = (this.tab + d + TABS.length) % TABS.length;
    this.index = 0;
    this._paint();
  }

  /** @returns {{kind:string,id:string}|null} what the highlighted row means */
  activate() {
    if (this.tab === 0) return { kind: 'character', id: BOYZ[this.index]?.id };
    if (this.tab === 1) return { kind: 'station', id: STATIONS[this.index]?.id };
    return null;
  }

  _count() {
    return this.tab === 0 ? BOYZ.length : this.tab === 1 ? STATIONS.length : 4;
  }

  _paint() {
    for (let i = 0; i < this.tabEls.length; i++) setClass(this.tabEls[i], 'on', i === this.tab);
    const n = this._count();
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (i >= n) {
        setStyle(row.r, 'display', 'none');
        continue;
      }
      setStyle(row.r, 'display', '');
      setClass(row.r, 'sel', i === this.index);
      if (this.tab === 0) {
        const b = BOYZ[i];
        setStyle(row.dot, 'background', b.colour);
        setText(row.t, b.name);
        setText(row.sub, b.role.toUpperCase());
        setText(row.val, b.id === this.character ? 'ACTIVE' : 'CALL');
        setStyle(row.val, 'color', b.id === this.character ? b.accent : '');
      } else if (this.tab === 1) {
        const st = STATIONS[i];
        setStyle(row.dot, 'background', st.colour);
        setText(row.t, st.name);
        setText(row.sub, st.genre);
        setText(row.val, st.id === this.station ? '▶ ON AIR' : st.freq);
        setStyle(row.val, 'color', st.id === this.station ? st.colour : '');
      } else {
        const rows = [
          ['CHAPTERS', `${this.chapter} / 24`, '#ffc93c'],
          ['HIDDEN PACKAGES', `${this.found} / ${PACKAGES.length}`, '#ffe36e'],
          ['SAFEHOUSES', '3 / 5', '#41e08a'],
          ['RESPECT', String(this.respect | 0), '#ff6a12'],
        ];
        setStyle(row.dot, 'background', rows[i][2]);
        setText(row.t, rows[i][0]);
        setText(row.sub, '');
        setText(row.val, rows[i][1]);
        setStyle(row.val, 'color', rows[i][2]);
      }
    }
  }

  setState(o) {
    if (o.station !== undefined) this.station = o.station;
    if (o.character !== undefined) this.character = o.character;
    if (o.found !== undefined) this.found = o.found;
    if (o.respect !== undefined) this.respect = o.respect;
    if (o.chapter !== undefined) this.chapter = o.chapter;
    if (o.hour !== undefined) {
      const h = Math.floor(o.hour) % 24;
      const m = Math.floor((o.hour % 1) * 60);
      setText(this.clock, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    }
    this._paint();
  }

  update(dt) {
    this.a = damp(this.a, this.open ? 1 : 0, 16, dt);
    if (!this.open && this.a < 0.005) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    const k = ease.outCubic(this.a);
    setStyle(this.root, 'opacity', k.toFixed(3));
    setStyle(this.root, 'transform', `translateY(${((1 - k) * 46).toFixed(1)}px)`);
    return k;
  }

  dispose() {
    this.root.remove();
  }
}
