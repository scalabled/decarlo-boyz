/**
 * Weapon silhouettes, drawn as canvas paths.
 *
 * No art assets exist in this project, so the weapon wheel earns its
 * "reads instantly" by shape alone: each glyph is authored in a 100x100 box
 * with the barrel horizontal, filled as one solid silhouette (an outline
 * drawing would vanish against the wheel's dark plate at 40 px). The improvised
 * arsenal is the point — these are meant to look like a pipe, a nail gun and a
 * paint sprayer, not like military hardware.
 */

/** @param {CanvasRenderingContext2D} g  draws into a 100x100 box at the origin. */
export function drawWeaponGlyph(g, glyph, size, colour) {
  g.save();
  g.translate(-size * 0.5, -size * 0.5);
  g.scale(size / 100, size / 100);
  g.fillStyle = colour;
  g.strokeStyle = colour;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = 8;

  switch (glyph) {
    case 'fist':
      // knuckles + thumb
      g.beginPath();
      g.moveTo(22, 40);
      g.lineTo(74, 34);
      g.quadraticCurveTo(86, 36, 86, 50);
      g.lineTo(86, 62);
      g.quadraticCurveTo(86, 76, 72, 76);
      g.lineTo(30, 76);
      g.quadraticCurveTo(18, 76, 18, 62);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,.42)';
      for (let i = 0; i < 3; i++) {
        g.fillRect(34 + i * 15, 40, 4, 22);
      }
      break;

    case 'bar': // dock pipe
      g.beginPath();
      g.moveTo(12, 44);
      g.lineTo(88, 40);
      g.lineTo(88, 58);
      g.lineTo(12, 62);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,.4)';
      g.fillRect(78, 40, 4, 18);
      g.fillRect(20, 44, 4, 18);
      break;

    case 'wrench':
      g.beginPath();
      g.moveTo(30, 46);
      g.lineTo(76, 42);
      g.lineTo(76, 58);
      g.lineTo(30, 62);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(76, 30);
      g.lineTo(94, 30);
      g.lineTo(94, 44);
      g.lineTo(84, 44);
      g.lineTo(84, 56);
      g.lineTo(94, 56);
      g.lineTo(94, 70);
      g.lineTo(76, 70);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(24, 54, 13, 0, Math.PI * 2);
      g.fill();
      break;

    case 'crow':
      g.beginPath();
      g.moveTo(16, 66);
      g.quadraticCurveTo(48, 62, 78, 40);
      g.lineTo(90, 30);
      g.lineTo(96, 40);
      g.lineTo(84, 50);
      g.quadraticCurveTo(52, 76, 18, 80);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(90, 26);
      g.lineTo(100, 22);
      g.lineTo(98, 36);
      g.closePath();
      g.fill();
      break;

    case 'pistol': // nail gun / tack cannon
      g.beginPath();
      g.moveTo(14, 36);
      g.lineTo(78, 36);
      g.lineTo(78, 46);
      g.lineTo(96, 46);
      g.lineTo(96, 54);
      g.lineTo(50, 54);
      g.lineTo(42, 74);
      g.lineTo(24, 74);
      g.lineTo(30, 52);
      g.lineTo(14, 52);
      g.closePath();
      g.fill();
      // magazine of nails
      g.fillRect(52, 24, 24, 12);
      break;

    case 'smg':
      g.beginPath();
      g.moveTo(10, 38);
      g.lineTo(70, 38);
      g.lineTo(70, 44);
      g.lineTo(98, 44);
      g.lineTo(98, 52);
      g.lineTo(58, 52);
      g.lineTo(52, 70);
      g.lineTo(34, 70);
      g.lineTo(38, 52);
      g.lineTo(10, 52);
      g.closePath();
      g.fill();
      g.fillRect(56, 52, 12, 30);
      g.fillRect(6, 32, 8, 26);
      break;

    case 'shotgun': // paint cannon — fat barrel, hopper on top
      g.beginPath();
      g.moveTo(16, 42);
      g.lineTo(96, 38);
      g.lineTo(96, 60);
      g.lineTo(16, 58);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(40, 42);
      g.lineTo(46, 18);
      g.lineTo(66, 18);
      g.lineTo(70, 42);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(24, 58);
      g.lineTo(34, 58);
      g.lineTo(30, 80);
      g.lineTo(16, 80);
      g.closePath();
      g.fill();
      break;

    case 'rifle': // rivet gun
      g.beginPath();
      g.moveTo(8, 40);
      g.lineTo(64, 40);
      g.lineTo(64, 46);
      g.lineTo(100, 46);
      g.lineTo(100, 54);
      g.lineTo(56, 54);
      g.lineTo(50, 72);
      g.lineTo(32, 72);
      g.lineTo(36, 54);
      g.lineTo(8, 54);
      g.closePath();
      g.fill();
      g.fillRect(60, 28, 10, 12);
      g.fillRect(86, 40, 6, 6);
      break;

    case 'flare':
      g.beginPath();
      g.moveTo(20, 42);
      g.lineTo(70, 42);
      g.lineTo(70, 56);
      g.lineTo(20, 56);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(30, 56);
      g.lineTo(44, 56);
      g.lineTo(38, 80);
      g.lineTo(20, 80);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(84, 49, 13, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,.45)';
      g.beginPath();
      g.arc(84, 49, 5, 0, Math.PI * 2);
      g.fill();
      break;

    case 'spear': // spear gun / harpoon
      g.beginPath();
      g.moveTo(4, 46);
      g.lineTo(78, 46);
      g.lineTo(78, 54);
      g.lineTo(4, 54);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(78, 36);
      g.lineTo(100, 50);
      g.lineTo(78, 64);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(22, 54);
      g.lineTo(36, 54);
      g.lineTo(30, 78);
      g.lineTo(14, 78);
      g.closePath();
      g.fill();
      break;

    case 'tube': // nitro launcher / scrap rocket
      g.beginPath();
      g.moveTo(8, 38);
      g.lineTo(84, 38);
      g.lineTo(84, 60);
      g.lineTo(8, 60);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(84, 32);
      g.lineTo(100, 49);
      g.lineTo(84, 66);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(30, 60);
      g.lineTo(44, 60);
      g.lineTo(38, 82);
      g.lineTo(22, 82);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,.4)';
      g.fillRect(46, 30, 18, 8);
      break;

    case 'drum': // depth charge
      g.beginPath();
      g.moveTo(26, 26);
      g.lineTo(74, 26);
      g.lineTo(74, 74);
      g.lineTo(26, 74);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(0,0,0,.4)';
      g.fillRect(26, 38, 48, 6);
      g.fillRect(26, 56, 48, 6);
      g.fillStyle = colour;
      g.fillRect(42, 14, 16, 12);
      break;

    case 'coil': // EMP coil
      g.beginPath();
      g.arc(50, 50, 26, 0, Math.PI * 2);
      g.lineWidth = 9;
      g.stroke();
      g.beginPath();
      g.moveTo(54, 30);
      g.lineTo(40, 52);
      g.lineTo(52, 52);
      g.lineTo(46, 72);
      g.lineTo(62, 46);
      g.lineTo(50, 46);
      g.closePath();
      g.fill();
      break;

    default:
      g.beginPath();
      g.arc(50, 50, 22, 0, Math.PI * 2);
      g.fill();
      break;
  }
  g.restore();
}

/**
 * Brother portraits.
 *
 * The character wheel needs three faces that are distinguishable at 90 px, and
 * the DESIGN.md body palette (skin / shirt / hair) is the only description of
 * them that exists. So: a flat, high-contrast bust in each brother's own
 * colours, lit from the left, on his signature backdrop. Silhouette does the
 * work — Carson broad and hooded, Aidan square with a cap, Dylan narrow with a
 * mess of hair.
 */
export function drawPortrait(g, boy, size) {
  const s = size / 100;
  g.save();
  g.scale(s, s);
  const b = boy.body;

  // backdrop
  const grd = g.createLinearGradient(0, 0, 0, 100);
  grd.addColorStop(0, shade(boy.colour, -0.62));
  grd.addColorStop(1, '#080b0f');
  g.fillStyle = grd;
  g.fillRect(0, 0, 100, 100);

  // shoulders
  g.fillStyle = b.shirt;
  g.beginPath();
  if (boy.id === 'carson') {
    g.moveTo(6, 100);
    g.quadraticCurveTo(12, 66, 50, 62);
    g.quadraticCurveTo(88, 66, 94, 100);
  } else if (boy.id === 'aidan') {
    g.moveTo(10, 100);
    g.quadraticCurveTo(16, 70, 50, 64);
    g.quadraticCurveTo(84, 70, 90, 100);
  } else {
    g.moveTo(16, 100);
    g.quadraticCurveTo(22, 74, 50, 68);
    g.quadraticCurveTo(78, 74, 84, 100);
  }
  g.closePath();
  g.fill();

  // neck
  g.fillStyle = shade(b.skin, -0.22);
  g.fillRect(42, 54, 16, 16);

  // head
  g.fillStyle = b.skin;
  g.beginPath();
  const hw = boy.id === 'carson' ? 20 : boy.id === 'aidan' ? 19 : 17;
  g.ellipse(50, 38, hw, 23, 0, 0, Math.PI * 2);
  g.fill();

  // key light from the left
  g.fillStyle = 'rgba(255,240,220,.16)';
  g.beginPath();
  g.ellipse(43, 35, hw * 0.62, 19, 0, 0, Math.PI * 2);
  g.fill();

  // hair
  g.fillStyle = b.hair;
  g.beginPath();
  if (boy.id === 'carson') {
    // watch cap
    g.moveTo(30, 30);
    g.quadraticCurveTo(50, 6, 70, 30);
    g.lineTo(70, 22);
    g.quadraticCurveTo(50, 2, 30, 22);
    g.closePath();
    g.fill();
    g.fillStyle = shade(b.shirt, 0.1);
    g.beginPath();
    g.moveTo(29, 22);
    g.quadraticCurveTo(50, 0, 71, 22);
    g.lineTo(71, 30);
    g.quadraticCurveTo(50, 12, 29, 30);
    g.closePath();
    g.fill();
  } else if (boy.id === 'aidan') {
    // flat cap with a peak
    g.moveTo(29, 26);
    g.quadraticCurveTo(50, 4, 71, 26);
    g.lineTo(71, 30);
    g.lineTo(29, 30);
    g.closePath();
    g.fill();
    g.fillStyle = shade(b.hair, -0.3);
    g.beginPath();
    g.moveTo(30, 29);
    g.quadraticCurveTo(56, 27, 76, 31);
    g.quadraticCurveTo(56, 35, 30, 34);
    g.closePath();
    g.fill();
  } else {
    // long fringe
    g.moveTo(31, 34);
    g.quadraticCurveTo(30, 8, 52, 10);
    g.quadraticCurveTo(72, 12, 69, 36);
    g.lineTo(64, 24);
    g.quadraticCurveTo(50, 32, 38, 22);
    g.closePath();
    g.fill();
  }

  // eyes + brow — enough to read as a face, no more
  g.fillStyle = 'rgba(10,12,16,.85)';
  g.fillRect(41, 38, 5, 3);
  g.fillRect(55, 38, 5, 3);
  g.fillStyle = 'rgba(10,12,16,.55)';
  g.fillRect(40, 34, 7, 2);
  g.fillRect(54, 34, 7, 2);
  g.fillStyle = shade(b.skin, -0.34);
  g.fillRect(45, 48, 10, 2);

  // rim light in the brother's signature colour
  g.strokeStyle = boy.accent;
  g.globalAlpha = 0.5;
  g.lineWidth = 2.4;
  g.beginPath();
  g.ellipse(50, 38, hw, 23, 0, -0.5, 1.5);
  g.stroke();
  g.globalAlpha = 1;
  g.restore();
}

/** Lighten (t>0) or darken (t<0) a #rrggbb by a fraction. */
export function shade(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let gg = (n >> 8) & 255;
  let b = n & 255;
  if (t >= 0) {
    r += (255 - r) * t;
    gg += (255 - gg) * t;
    b += (255 - b) * t;
  } else {
    r *= 1 + t;
    gg *= 1 + t;
    b *= 1 + t;
  }
  return `rgb(${r | 0},${gg | 0},${b | 0})`;
}
