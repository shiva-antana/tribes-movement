// Data tables: armors, weapons, packs, call-downs, vehicles.
// Tuning lives here so gameplay can be balanced without touching systems code.

export const GRAVITY = 20; // m/s^2 — Tribes-style floaty-but-fast arcs

export type ArmorId = 'light' | 'medium' | 'heavy';
/** Which generated character (content/characters) represents each armor. */
export const ARMOR_CHARACTER: Record<ArmorId, string> = { light: 'scout', medium: 'assault', heavy: 'juggernaut' };
export type WeaponId = 'spinfusor' | 'grenade' | 'chaingun' | 'mortar' | 'blaster';
export type PackId = 'energy' | 'repair' | 'constructor' | 'shield';

export interface ArmorDef {
  id: ArmorId;
  name: string;
  mass: number;
  health: number;
  energy: number;
  energyRegen: number;   // per second
  jetAccel: number;      // upward accel while jetting (must beat GRAVITY)
  jetSideAccel: number;  // horizontal control while jetting
  jetEnergy: number;     // energy/sec while jetting
  jetHeat: number;       // heat/sec while jetting
  runSpeed: number;
  runAccel: number;
  airControl: number;
  jumpSpeed: number;
  radius: number;
  height: number;
  weaponSlots: number;
  allowed: WeaponId[];
}

export const ARMORS: Record<ArmorId, ArmorDef> = {
  light: {
    id: 'light', name: 'Scout', mass: 90, health: 80, energy: 100, energyRegen: 14,
    jetAccel: 34, jetSideAccel: 14, jetEnergy: 17, jetHeat: 21,
    runSpeed: 13, runAccel: 70, airControl: 7, jumpSpeed: 8,
    radius: 0.5, height: 1.9, weaponSlots: 3,
    allowed: ['spinfusor', 'grenade', 'chaingun', 'blaster'],
  },
  medium: {
    id: 'medium', name: 'Assault', mass: 130, health: 120, energy: 100, energyRegen: 12,
    jetAccel: 29, jetSideAccel: 10, jetEnergy: 18, jetHeat: 23,
    runSpeed: 11, runAccel: 55, airControl: 5, jumpSpeed: 7,
    radius: 0.6, height: 2.1, weaponSlots: 4,
    allowed: ['spinfusor', 'grenade', 'chaingun', 'blaster'],
  },
  heavy: {
    id: 'heavy', name: 'Juggernaut', mass: 200, health: 200, energy: 120, energyRegen: 10,
    jetAccel: 25, jetSideAccel: 6, jetEnergy: 21, jetHeat: 26,
    runSpeed: 8.5, runAccel: 40, airControl: 3, jumpSpeed: 6,
    radius: 0.75, height: 2.4, weaponSlots: 5,
    allowed: ['spinfusor', 'grenade', 'chaingun', 'mortar', 'blaster'],
  },
};

export interface WeaponDef {
  id: WeaponId;
  name: string;
  speed: number;
  gravity: number;       // multiplier on GRAVITY
  inherit: number;       // fraction of shooter velocity inherited
  damage: number;        // at center of blast (or direct for non-explosive)
  radius: number;        // splash radius (0 = direct only)
  impulse: number;       // kinetic push at center (N·s) — enables disc/grenade jumping
  reload: number;
  ammo: number;
  energyCost: number;
  bounce: boolean;
  fuse: number;          // seconds before auto-detonation (0 = on impact)
  spread: number;
  color: number;
  structureMult: number; // damage multiplier against structures
  // --- realism (all optional; defaults keep turret/vehicle weapons simple) ---
  magazine?: number;     // rounds per magazine (ammo = total carried)
  reloadTime?: number;   // seconds to reload a magazine
  drag?: number;         // air drag (1/s) on velocity relative to the wind — slow rounds drift in gales
  recoil?: number;       // camera kick (radians) per shot
  spinUp?: number;       // seconds to reach full fire rate (chaingun)
  bloom?: number;        // spread added per shot (decays over time)
  falloff?: [number, number, number]; // [full-damage range, zero-falloff range, min multiplier]
  headshot?: number;     // damage multiplier for direct head hits
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  spinfusor: {
    id: 'spinfusor', name: 'Spinfusor', speed: 70, gravity: 0, inherit: 0.75, damage: 55, radius: 7,
    impulse: 2600, reload: 1.1, ammo: 20, energyCost: 0, bounce: false, fuse: 6, spread: 0,
    color: 0x9fe8ff, structureMult: 1, magazine: 3, reloadTime: 1.8, drag: 0.04, recoil: 0.035,
  },
  grenade: {
    id: 'grenade', name: 'Grenade Launcher', speed: 48, gravity: 1, inherit: 0.6, damage: 45, radius: 8,
    impulse: 2000, reload: 0.8, ammo: 25, energyCost: 0, bounce: true, fuse: 1.6, spread: 0,
    color: 0xffd27a, structureMult: 1.2, magazine: 6, reloadTime: 2.4, drag: 0.18, recoil: 0.045,
  },
  chaingun: {
    id: 'chaingun', name: 'Chaingun', speed: 340, gravity: 1, inherit: 0.5, damage: 7, radius: 0,
    impulse: 40, reload: 0.07, ammo: 300, energyCost: 0, bounce: false, fuse: 1.6, spread: 0.008,
    color: 0xffffaa, structureMult: 0.3, magazine: 100, reloadTime: 3, drag: 0.03, recoil: 0.006,
    spinUp: 0.5, bloom: 0.0035, falloff: [70, 240, 0.35], headshot: 1.6,
  },
  mortar: {
    id: 'mortar', name: 'Fusion Mortar', speed: 42, gravity: 1, inherit: 0.5, damage: 110, radius: 16,
    impulse: 5000, reload: 2.2, ammo: 10, energyCost: 0, bounce: true, fuse: 2.5, spread: 0,
    color: 0x8cff6a, structureMult: 2, magazine: 2, reloadTime: 3, drag: 0.12, recoil: 0.09,
  },
  blaster: {
    id: 'blaster', name: 'Blaster', speed: 140, gravity: 0, inherit: 0.4, damage: 14, radius: 0,
    impulse: 120, reload: 0.3, ammo: Infinity, energyCost: 6, bounce: false, fuse: 2, spread: 0.004,
    color: 0xff6a9c, structureMult: 0.5, recoil: 0.012, bloom: 0.004, falloff: [60, 200, 0.5], headshot: 1.5,
  },
};

export interface PackDef { id: PackId; name: string; desc: string; }
export const PACKS: Record<PackId, PackDef> = {
  energy: { id: 'energy', name: 'Energy Pack', desc: '+60% energy regen, cooler jets' },
  repair: { id: 'repair', name: 'Repair Pack', desc: 'Hold F to repair structures/self' },
  constructor: { id: 'constructor', name: 'Constructor', desc: 'Call down structures (B)' },
  shield: { id: 'shield', name: 'Shield Pack', desc: 'Energy absorbs damage' },
};

export type StructureKind =
  | 'generator' | 'inventory' | 'turret' | 'aaTurret' | 'wall' | 'extractor'
  | 'skyPlatform' | 'beacon' | 'bridge' | 'vehicleStation' | 'uplink' | 'flagStand' | 'bunker' | 'sensor'
  // Contextual merges (Tiny Glade-style): turret on a wall → battery, AA on a wall → flak tower; wall junctions get posts.
  | 'battery' | 'flakTower' | 'post';

export interface CalldownDef {
  kind: StructureKind | 'outpost' | 'siegeDrop' | 'gunshipDrop' | 'road' | 'prefab';
  name: string;
  cost: number;
  desc: string;
  key: string;
  requires?: 'uplink';
  crew?: number; // friendly players required near the beacon to complete the call-down
  minEnemyDist?: number;
}

export const CALLDOWNS: CalldownDef[] = [
  { kind: 'wall', name: 'Barrier Wall', cost: 15, key: '1', desc: 'Force-wall segment. Blocks shots & vehicles.' },
  { kind: 'turret', name: 'Plasma Turret', cost: 60, key: '2', desc: 'Automated tower defense.' },
  { kind: 'aaTurret', name: 'AA Battery', cost: 80, key: '3', desc: 'Flak against aircraft & jetters. Guards airspace.' },
  { kind: 'inventory', name: 'Remote Inventory', cost: 70, key: '4', desc: 'Change armor & loadout away from base.' },
  { kind: 'extractor', name: 'Extractor', cost: 50, key: '5', desc: 'Mine a resource vent. +materiel. Fragile.' },
  { kind: 'bridge', name: 'Bridge Span', cost: 120, key: '6', desc: '110m span along your aim. Gets tanks across water.' },
  { kind: 'skyPlatform', name: 'Sky Platform', cost: 150, key: '7', desc: 'Platform 220m up + beam-up beacon below.', minEnemyDist: 700 },
  { kind: 'outpost', name: 'Outpost Drop', cost: 220, key: '8', desc: 'Generator + inventory + turret. A remote base.' },
  { kind: 'uplink', name: 'Command Uplink', cost: 250, key: '9', desc: 'Unlocks capital call-downs for your tribe.' },
  { kind: 'siegeDrop', name: 'Siege Tank Drop', cost: 300, key: '0', desc: 'Needs uplink + 2 tribemates at beacon.', requires: 'uplink', crew: 2 },
  { kind: 'prefab', name: 'Prefab', cost: 0, key: '=', desc: 'Drop a saved fortification layout as one unit (P cycles layouts; K saves the structures around your aim as a new layout). Cost = sum of its pieces −10%.' },
  { kind: 'road', name: 'Grade Road', cost: 15, key: '-', desc: 'Click start, then end (≤220m). Permanently cuts/fills a 12m highway; fills shallow water into causeways. Tanks run 60% faster on roads. Cost scales with earth moved.' },
];

/** Materiel per m³ of earth moved when grading roads. */
export const ROAD_COST_PER_M3 = 0.006;

/** Max deployable structures alive per team: a complexity budget (performance and readability). */
export const BUILD_LIMIT = 80;

/** Materiel value of each structure kind (merged kinds = the parts that made them). Used for prefab pricing. */
export const STRUCTURE_COST: Partial<Record<StructureKind, number>> = {
  wall: 15, turret: 60, aaTurret: 80, inventory: 70, extractor: 50, bridge: 120, skyPlatform: 150, uplink: 250,
  battery: 75, flakTower: 95, post: 0, generator: 100, sensor: 30,
};

export const STRUCTURE_HP: Record<StructureKind, number> = {
  // Piecewise structures (bunker, wall, bridge, sky platform, flag stand) sum their panels' hp instead.
  generator: 900, inventory: 400, turret: 350, aaTurret: 350, wall: 500, extractor: 250,
  skyPlatform: 0, beacon: 150, bridge: 0, vehicleStation: 600, uplink: 800, flagStand: Infinity,
  bunker: 0, sensor: 200, battery: 950, flakTower: 950, post: 600,
};

export type VehicleKind = 'gravcycle' | 'shrike' | 'tank' | 'transport';
export interface VehicleDef {
  kind: VehicleKind; name: string; cost: number; health: number; mass: number;
  flies: boolean; maxSpeed: number; windArea: number; desc: string;
}
export const VEHICLES: Record<VehicleKind, VehicleDef> = {
  gravcycle: { kind: 'gravcycle', name: 'Turbograv', cost: 25, health: 180, mass: 400, flies: false, maxSpeed: 75, windArea: 0.3, desc: 'Fast hover scout. Crosses water.' },
  shrike: { kind: 'shrike', name: 'Shrike', cost: 70, health: 300, mass: 900, flies: true, maxSpeed: 110, windArea: 1.6, desc: 'Fighter. Twin blasters. Wind-sensitive.' },
  tank: { kind: 'tank', name: 'Siege Tank', cost: 140, health: 1100, mass: 6000, flies: false, maxSpeed: 22, windArea: 0.1, desc: 'Ground-bound artillery. Cannot cross deep water.' },
  transport: { kind: 'transport', name: 'Havoc APC', cost: 110, health: 800, mass: 4000, flies: true, maxSpeed: 55, windArea: 2.2, desc: 'Transport. Press G landed to deploy an inventory station.' },
};

export const TEAM_COLORS = [0x4aa3ff, 0xff5a3c];
export const TEAM_NAMES = ['Starwolf', 'Children of the Phoenix'];
export const START_MATERIEL = 200;
export const KILL_SPOILS = 20;
