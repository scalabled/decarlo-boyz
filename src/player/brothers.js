/**
 * The three DeCarlo brothers — the only content table `player` owns.
 *
 * Every number here comes straight out of DESIGN.md's stat table. One rig,
 * three skins: `build` reshapes the same procedural body (shoulder width, mass,
 * height, limb thickness), `palette` recolours the same procedural materials,
 * and the gameplay block feeds movement + health.
 *
 *   | build     | Carson heaviest/slowest/toughest · Aidan middle · Dylan light
 *   | hp/armour | 130/60 · 115/75 · 100/55
 *   | run       | 6.4 · 6.9 · 7.9  m/s  (this is the SPRINT speed)
 */

export const BROTHERS = {
  carson: {
    id: 'carson',
    name: 'Carson',
    role: 'River hand · eldest',
    accent: 0x2ea6a0,
    accent2: 0x7bf0d8,

    health: 130,
    armour: 60,
    runSpeed: 6.4,
    vehicleGrip: 1.06,
    boatSpeed: 1.25,

    /** Physical build. `scale` multiplies the whole skeleton. */
    build: {
      scale: 1.035, // tallest
      shoulder: 1.11, // deltoid span
      chest: 1.1,
      waist: 1.13,
      limb: 1.09, // limb girth
      neck: 1.12,
      headScale: 1.02,
      jaw: 1.1, // heavy jaw
      brow: 1.15,
      nose: 1.02,
      hair: 'crop', // short, receding
      stubble: 0.55,
    },
    palette: {
      skin: 0xf0cdae,
      skinShadow: 0xb07a5c,
      shirt: 0x1f6f6a,
      shirtDark: 0x11413e,
      pants: 0x26303c,
      hair: 0x3b2a1c,
      shoe: 0x2a2018,
      belt: 0x35281c,
      eye: 0x4d6b63,
      accent: 0x7bf0d8,
    },
  },

  aidan: {
    id: 'aidan',
    name: 'Aidan',
    role: 'Body man · middle',
    accent: 0xff6a12,
    accent2: 0xffc93c,

    health: 115,
    armour: 75,
    runSpeed: 6.9,
    vehicleGrip: 1.12,
    boatSpeed: 1.0,

    build: {
      scale: 1.0,
      shoulder: 1.04,
      chest: 1.02,
      waist: 1.0,
      limb: 1.02,
      neck: 1.04,
      headScale: 1.0,
      jaw: 1.0,
      brow: 1.02,
      nose: 1.08,
      hair: 'sweep',
      stubble: 0.3,
    },
    palette: {
      skin: 0xf4d4b6,
      skinShadow: 0xb98763,
      shirt: 0xc2410c,
      shirtDark: 0x7a2707,
      pants: 0x1f2733,
      hair: 0x8a5a2a,
      shoe: 0x30251b,
      belt: 0x2a2119,
      eye: 0x6b5230,
      accent: 0xffc93c,
    },
  },

  dylan: {
    id: 'dylan',
    name: 'Dylan',
    role: 'Courier · youngest',
    accent: 0xc07cff,
    accent2: 0x5fd0ff,

    health: 100,
    armour: 55,
    runSpeed: 7.9,
    vehicleGrip: 1.22,
    boatSpeed: 1.05,

    build: {
      scale: 0.965, // shortest
      shoulder: 0.94,
      chest: 0.93,
      waist: 0.9,
      limb: 0.92,
      neck: 0.94,
      headScale: 0.99,
      jaw: 0.9,
      brow: 0.9,
      nose: 0.95,
      hair: 'mop', // longest
      stubble: 0.12,
    },
    palette: {
      skin: 0xeec9a8,
      skinShadow: 0xa87a5c,
      shirt: 0x7c3aed,
      shirtDark: 0x4a1f96,
      pants: 0x1a1f2b,
      hair: 0x221812,
      shoe: 0x1e1a1a,
      belt: 0x241d18,
      eye: 0x36302c,
      accent: 0x5fd0ff,
    },
  },
};

export const BROTHER_IDS = ['carson', 'aidan', 'dylan'];

export function brother(id) {
  return BROTHERS[id] ?? BROTHERS.carson;
}
