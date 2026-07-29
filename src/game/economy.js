/**
 * GAME — cash, respect and unlocks.
 *
 * Two currencies, exactly as DESIGN.md specifies. Cash is per-brother and
 * spent on ammo, food and resprays; respect is per-brother but its unlock
 * ladder is global — the DeCarlo name is one name, so the Triangle Apartment
 * opens for all three once any of them has earned it.
 *
 * The only way money changes is through `Economy.addCash`, which is the single
 * emitter of `money:change { amount, total, reason }`. Anything that wants to
 * pay the player calls this; nothing else touches `char.cash`.
 */

import { RESPECT_UNLOCKS, WEAPON_LIB, BOY_ORDER } from './data.js';

export class Economy {
  constructor(ctx, save) {
    this.ctx = ctx;
    this.save = save;
    /** Reused so `money:change` allocates nothing per emit. */
    this._payload = { amount: 0, total: 0, reason: '' };
    this._unlockPayload = { kind: '', id: '', label: '' };
  }

  char(id = this.save.active) {
    return this.save.chars[id];
  }

  get cash() {
    return this.char().cash;
  }

  get respect() {
    return this.char().respect;
  }

  /** Highest respect any brother has reached — what the unlock ladder reads. */
  get familyRespect() {
    let r = 0;
    for (const id of BOY_ORDER) r = Math.max(r, this.save.chars[id].respect);
    return r;
  }

  /**
   * The one place money moves. Negative amounts are spends.
   *
   * Emits BOTH `money:change` (the HUD readout) and `economy:cash` (the sound:
   * `audio` voices the register on it — this module never plays audio itself,
   * and the till has to ring for every path money moves through, not just the
   * ones that remember to call a sfx).
   * @returns {boolean} false if the player could not afford a spend.
   */
  addCash(amount, reason = '') {
    const c = this.char();
    const n = Math.round(amount);
    if (n < 0 && c.cash + n < 0) return false;
    c.cash = Math.max(0, c.cash + n);
    if (n > 0) this.save.totals.cash += n;
    const p = this._payload;
    p.amount = n;
    p.total = c.cash;
    p.reason = reason;
    this.ctx.events.emit('money:change', p);
    this.ctx.events.emit('economy:cash', p);
    return true;
  }

  canAfford(amount) {
    return this.char().cash >= amount;
  }

  /** Respect only ever goes up. Returns the unlocks this award crossed. */
  addRespect(amount, reason = '') {
    const c = this.char();
    const before = this.familyRespect;
    c.respect = Math.max(0, c.respect + Math.round(amount));
    const after = this.familyRespect;
    if (after <= before) return EMPTY;
    const crossed = [];
    for (const u of RESPECT_UNLOCKS) {
      if (u.at > before && u.at <= after && !this.save.unlocks.includes(u.id ?? u.label)) {
        const key = u.id ?? u.label;
        this.save.unlocks.push(key);
        crossed.push(u);
      }
    }
    for (const u of crossed) {
      const p = this._unlockPayload;
      p.kind = u.kind;
      p.id = u.id ?? '';
      p.label = u.label;
      this.ctx.events.emit('game:unlock', p);
    }
    if (reason && crossed.length === 0) {
      /* respect gained but nothing crossed — the HUD shows it on the card */
    }
    return crossed;
  }

  hasUnlock(id) {
    return this.save.unlocks.includes(id);
  }

  /* ------------------------------------------------------------ weapons -- */

  /** Weapons this brother is carrying: his starting kit plus everything earned. */
  loadout(id = this.save.active, boy) {
    const c = this.save.chars[id];
    const out = boy ? boy.start.slice() : [];
    for (const w of c.unlocked) if (!out.includes(w)) out.push(w);
    return out;
  }

  unlockWeapon(wid, id = this.save.active) {
    const c = this.save.chars[id];
    if (!WEAPON_LIB[wid]) return false;
    if (c.unlocked.includes(wid)) return false;
    c.unlocked.push(wid);
    const def = WEAPON_LIB[wid];
    if (Number.isFinite(def.ammo)) c.ammo[wid] = Math.max(c.ammo[wid] ?? 0, def.ammo);
    return true;
  }

  hasWeapon(wid, boy, id = this.save.active) {
    if (boy?.start?.includes(wid)) return true;
    return this.save.chars[id].unlocked.includes(wid);
  }

  ammo(wid, id = this.save.active) {
    const def = WEAPON_LIB[wid];
    if (!def || !Number.isFinite(def.ammo)) return Infinity;
    return this.save.chars[id].ammo[wid] ?? 0;
  }

  addAmmo(wid, n, id = this.save.active) {
    const def = WEAPON_LIB[wid];
    if (!def || !Number.isFinite(def.ammo)) return 0;
    const c = this.save.chars[id];
    c.ammo[wid] = Math.max(0, (c.ammo[wid] ?? 0) + n);
    return c.ammo[wid];
  }

  /**
   * Refill every carried magazine to its library capacity, charging per round.
   * Returns `{ rounds, cost }` — `rounds === 0` means nothing needed buying.
   */
  priceRefill(boy, id = this.save.active) {
    const c = this.save.chars[id];
    let rounds = 0;
    let cost = 0;
    for (const wid of this.loadout(id, boy)) {
      const def = WEAPON_LIB[wid];
      if (!def || !Number.isFinite(def.ammo)) continue;
      const missing = def.ammo - (c.ammo[wid] ?? 0);
      if (missing <= 0) continue;
      rounds += missing;
      cost += missing * (def.price ?? 5);
    }
    return { rounds, cost: Math.round(cost) };
  }

  buyRefill(boy, id = this.save.active) {
    const quote = this.priceRefill(boy, id);
    if (quote.rounds === 0) return { ...quote, bought: false, reason: 'full' };
    if (!this.canAfford(quote.cost)) return { ...quote, bought: false, reason: 'broke' };
    this.addCash(-quote.cost, 'ammo');
    const c = this.save.chars[id];
    for (const wid of this.loadout(id, boy)) {
      const def = WEAPON_LIB[wid];
      if (!def || !Number.isFinite(def.ammo)) continue;
      c.ammo[wid] = def.ammo;
    }
    return { ...quote, bought: true, reason: '' };
  }
}

const EMPTY = Object.freeze([]);

/** `$1,250` — the HUD's money format, used in notifications and result cards. */
export function money(n) {
  const v = Math.round(Math.abs(n));
  return (n < 0 ? '-$' : '$') + v.toLocaleString('en-US');
}
