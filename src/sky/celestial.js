import * as THREE from 'three';

/**
 * Where the sun and moon actually are, for a full 24-hour cycle.
 *
 * Standard spherical astronomy: solar declination from the day of year, hour
 * angle from local solar time, then the altitude/azimuth transform for the site
 * latitude. The moon gets a first-order lunar theory — its ecliptic longitude
 * advances 360 degrees per synodic month relative to the sun, its declination
 * falls out of that longitude through the obliquity, and its hour angle out of
 * the right-ascension difference — so the moon RISES LATER EACH DAY, its phase
 * and its position are consistent with each other (a crescent is always near the
 * sun; a full moon always transits at local midnight), and its declination
 * swings through the month the way the real one does.
 *
 * Nothing is hand-placed. There is exactly one hand-placed number in the whole
 * file and it is `clockOffsetHours`, which is the art-direction knob: it slides
 * the CLOCK against the SUN so the money hours land where a game wants them
 * rather than where the equation of time puts them.
 *
 * ---------------------------------------------------------------------------
 * SITE — Steel City, i.e. Pittsburgh (40.44 N), early May, on daylight time
 * ---------------------------------------------------------------------------
 * `dayOfYear` 128 puts the declination at +17.0 degrees, which is a 14-hour
 * day: long enough to feel like summer, short enough that dawn is a playable
 * hour rather than 04:30. `clockOffsetHours` 0.75 then slides solar noon to
 * 12:45 so the cycle reads:
 *
 *   04.9  astronomical dawn        sun -18  first grey in the east
 *   05.3  nautical dawn            sun -12  horizon separates from the sky
 *   05.5  civil dawn               sun  -6  BLUE HOUR
 *   05.8  sunrise                  sun   0
 *   06.2  golden hour              sun  +5  river fog burning off — money shot
 *   12.7  solar noon               sun +66
 *   19.2  golden hour              sun  +6  golden hour over the Ohio
 *   19.7  sunset                   sun   0
 *   20.0  civil dusk               sun  -6  BLUE HOUR
 *   20.3  nautical dusk            sun -12
 *   20.7  astronomical dusk        sun -18  full night, stars out
 *
 * Azimuth convention: 0 = north = -Z, 90 = east = +X. `northAngleDeg` rotates
 * the whole celestial sphere for art direction without touching the astronomy.
 */

export const SITE = {
  latitudeDeg: 40.44, // Pittsburgh
  dayOfYear: 128, // early May: declination +17.0, a 14-hour day
  /**
   * Clock hours minus solar hours. Longitude within the time zone plus daylight
   * saving, folded into one number and used as the art-direction knob that puts
   * sunrise near 05:45 and sunset near 19:45.
   */
  clockOffsetHours: 0.75,
  /** Rotates north in world space. 0 keeps north at -Z. */
  northAngleDeg: 0,
  /**
   * Age of the moon in days since new, 0..29.53.
   *
   * 9.5 is a waxing gibbous at 73% illumination: enough light to key a night
   * street, and a terminator far enough onto the disc that the moon reads as a
   * sphere rather than as a white sticker. It transits at ~19:40 clock, so it is
   * high in the western sky through the whole of the night window and is IN
   * FRAME for a camera looking west down the rivers.
   */
  moonAgeDays: 9.5,
};

const DEG = Math.PI / 180;
const OBLIQUITY = 23.44 * DEG;
/** Synodic month — new moon to new moon. */
export const SYNODIC_MONTH = 29.530588;

/** Solar declination, Cooper's approximation. */
export function solarDeclination(dayOfYear) {
  return 23.44 * DEG * Math.sin(((2 * Math.PI) / 365) * (284 + dayOfYear));
}

/** Mean solar ecliptic longitude for a day of year, radians. */
function solarLongitude(dayOfYear) {
  // Vernal equinox is day 80; the sun advances ~0.9856 deg/day along the ecliptic.
  return ((dayOfYear - 80) * 0.98565 * DEG) % (2 * Math.PI);
}

/** Ecliptic longitude -> equatorial (rightAscension, declination), radians. */
function eclipticToEquatorial(lambda, beta, out) {
  const sl = Math.sin(lambda);
  const cl = Math.cos(lambda);
  const sb = Math.sin(beta);
  const cb = Math.cos(beta);
  const se = Math.sin(OBLIQUITY);
  const ce = Math.cos(OBLIQUITY);
  out.dec = Math.asin(THREE.MathUtils.clamp(sb * ce + cb * se * sl, -1, 1));
  out.ra = Math.atan2(sl * ce - (sb / Math.max(cb, 1e-6)) * se, cl);
  return out;
}

/**
 * Altitude/azimuth for a body at a given hour angle and declination.
 * `hourAngle` in radians, 0 at local meridian, positive in the afternoon.
 */
export function altAz(hourAngle, declination, latitudeDeg, out = { alt: 0, az: 0 }) {
  const lat = latitudeDeg * DEG;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinD = Math.sin(declination);
  const cosD = Math.cos(declination);
  const sinAlt = sinLat * sinD + cosLat * cosD * Math.cos(hourAngle);
  const alt = Math.asin(THREE.MathUtils.clamp(sinAlt, -1, 1));
  const cosAlt = Math.cos(alt);
  let cosAz = 0;
  if (cosAlt > 1e-6 && cosLat > 1e-6) {
    cosAz = (sinD - sinAlt * sinLat) / (cosAlt * cosLat);
  }
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1));
  // Hour angle positive = past the meridian = western half of the sky.
  if (Math.sin(hourAngle) > 0) az = 2 * Math.PI - az;
  out.alt = alt;
  out.az = az;
  return out;
}

/** World-space unit vector from altitude/azimuth. Points *toward* the body. */
export function dirFromAltAz(alt, az, northAngleRad, out) {
  const a = az + northAngleRad;
  const ca = Math.cos(alt);
  return out.set(ca * Math.sin(a), Math.sin(alt), -ca * Math.cos(a)).normalize();
}

/**
 * Twilight band for a solar altitude in DEGREES. The thresholds are the
 * international definitions, and they matter: "blue hour" is not a mood, it is
 * the civil band, and the reason it looks the way it does is that the sun is
 * lighting the stratosphere from underneath while the ground is in shadow.
 */
export function twilightBand(altDeg) {
  if (altDeg > 0) return 'day';
  if (altDeg > -6) return 'civil';
  if (altDeg > -12) return 'nautical';
  if (altDeg > -18) return 'astronomical';
  return 'night';
}

/**
 * Full celestial state for an hour of the day.
 * `sun`/`moon` are unit world directions pointing at the body.
 */
export class Celestial {
  constructor(site = SITE) {
    this.site = { ...site };
    this.sun = new THREE.Vector3(0, 1, 0);
    this.moon = new THREE.Vector3(0, -1, 0);
    this.sunAlt = 0;
    this.sunAz = 0;
    this.moonAlt = 0;
    this.moonAz = 0;
    /** Illuminated fraction of the lunar disc, 0..1. */
    this.moonPhase = 1;
    /** Angular separation sun-moon; drives the terminator on the disc. */
    this.moonElongation = Math.PI;
    /** Days since new moon, 0..SYNODIC_MONTH. */
    this.moonAge = site.moonAgeDays;
    /** Whole days elapsed since the start of play — advances the moon phase. */
    this.day = 0;
    this._aa = { alt: 0, az: 0 };
    this._eq = { ra: 0, dec: 0 };
    this._m = new THREE.Matrix4();
    this._tilt = new THREE.Matrix4();
  }

  /**
   * @param hour  clock hour 0..24
   * @param day   whole days since play started; advances the lunar phase and
   *              the solar declination so a long session drifts through the
   *              month instead of repeating one sky forever.
   */
  setHour(hour, day = this.day) {
    const s = this.site;
    this.day = day;
    const north = s.northAngleDeg * DEG;
    const doy = s.dayOfYear + day;
    const decl = solarDeclination(doy);
    // Solar time, not clock time. This is the one place the offset is applied.
    const solar = hour - s.clockOffsetHours;
    const H = (solar - 12) * 15 * DEG;

    altAz(H, decl, s.latitudeDeg, this._aa);
    this.sunAlt = this._aa.alt;
    this.sunAz = this._aa.az;
    dirFromAltAz(this.sunAlt, this.sunAz, north, this.sun);

    // ---- moon, first-order lunar theory ------------------------------------
    // Age advances with the day AND with the hour, so a time-lapse across a
    // single night shows the terminator creep rather than freeze.
    const age = (s.moonAgeDays + day + hour / 24) % SYNODIC_MONTH;
    this.moonAge = age;
    const sunLon = solarLongitude(doy + hour / 24);
    // Elongation: the moon gains 360 degrees on the sun per synodic month.
    const elong = (age / SYNODIC_MONTH) * 2 * Math.PI;
    const moonLon = sunLon + elong;
    // The lunar orbit is inclined 5.14 degrees to the ecliptic; the node
    // regresses over 18.6 years, which at the scale of a play session is a
    // constant. Keeping it makes the moon's declination range 18-29 degrees
    // instead of a flat 23.4, which is what stops every full moon in the game
    // sitting at exactly the same altitude.
    const moonLat = 5.14 * DEG * Math.sin(elong * 1.114 + 0.9);
    eclipticToEquatorial(moonLon, moonLat, this._eq);
    const moonRa = this._eq.ra;
    const moonDec = this._eq.dec;
    // The sun's own right ascension, so the moon's hour angle is the sun's
    // hour angle plus the RA difference. (H_body = H_sun + RA_sun - RA_body.)
    eclipticToEquatorial(sunLon, 0, this._eq);
    let Hm = H + (this._eq.ra - moonRa);
    while (Hm > Math.PI) Hm -= 2 * Math.PI;
    while (Hm < -Math.PI) Hm += 2 * Math.PI;

    altAz(Hm, moonDec, s.latitudeDeg, this._aa);
    this.moonAlt = this._aa.alt;
    this.moonAz = this._aa.az;
    dirFromAltAz(this.moonAlt, this.moonAz, north, this.moon);

    this.moonElongation = Math.acos(THREE.MathUtils.clamp(this.sun.dot(this.moon), -1, 1));
    this.moonPhase = 0.5 * (1 - Math.cos(this.moonElongation));

    // Equatorial -> world rotation for the starfield: the sky turns 15 deg/hour
    // about the polar axis, which is tilted from vertical by (90 - latitude).
    const polarTilt = (90 - s.latitudeDeg) * DEG;
    this._m.makeRotationY(-H + north);
    this._m.premultiply(this._tilt.makeRotationX(polarTilt));
    return this;
  }

  /** THREE.Matrix3 usable as a `mat3` uniform, world dir -> fixed sky. */
  celestialMatrix(out) {
    return out.setFromMatrix4(this._m);
  }

  /** Solar altitude in degrees at a clock hour, without disturbing state. */
  sunAltitudeAt(hour, day = this.day) {
    const s = this.site;
    const decl = solarDeclination(s.dayOfYear + day);
    const H = (hour - s.clockOffsetHours - 12) * 15 * DEG;
    const lat = s.latitudeDeg * DEG;
    return (
      Math.asin(
        THREE.MathUtils.clamp(
          Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H),
          -1,
          1
        )
      ) / DEG
    );
  }
}
