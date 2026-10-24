import { Simplex2, clamp, smoothstep, lerp } from '../noise';

export type BiomeId = 'tundra' | 'archipelago' | 'badlands';

export interface Biome {
  id: BiomeId;
  name: string;
  blurb: string;
  seaLevel: number;
  frozen: boolean;         // water surface is solid ice
  coldness: number;        // ambient jet-cooling multiplier
  windBase: number;        // steady wind m/s
  katabatic: number;       // downslope wind strength m/s (cold air sliding off highlands)
  gust: number;            // gust amplitude m/s
  fogColor: number;
  fogDensity: number;
  skyTop: number;
  skyHorizon: number;
  sunColor: number;
  sunDir: [number, number, number];
  ambient: number;
  palette: { low: number; mid: number; high: number; rock: number; shore: number; scorch: number };
  waterColor: number;
  particles: 'snow' | 'dust' | 'spray';
  basesUnderwater: boolean;
  height(s: Simplex2, u: number, v: number): number; // u,v in [0,1]
}

const edge = (u: number, v: number) => {
  const dx = Math.abs(u - 0.5) * 2, dz = Math.abs(v - 0.5) * 2;
  return Math.max(dx, dz);
};

export const BIOMES: Record<BiomeId, Biome> = {
  tundra: {
    id: 'tundra',
    name: 'Katabatic Shelf',
    blurb: 'Frozen highlands. Cold air pours off the ridges — aircraft beware. Jet low over the ice to stay cool.',
    seaLevel: 38, frozen: true, coldness: 2.2, windBase: 6, katabatic: 34, gust: 14,
    fogColor: 0xc6d2dc, fogDensity: 0.00042, skyTop: 0x6e8aa6, skyHorizon: 0xd6dee6,
    sunColor: 0xfff2e0, sunDir: [0.35, 0.32, 0.25], ambient: 0.55,
    palette: { low: 0xe6eef4, mid: 0xc9d5df, high: 0xf8fbff, rock: 0x5a6068, shore: 0x9fb4c4, scorch: 0x1a1a1e },
    waterColor: 0xa9cfe6, particles: 'snow', basesUnderwater: false,
    height(s, u, v) {
      const plateau = s.fbm(u * 2.2, v * 2.2, 5) * 0.5 + 0.5;
      const ridges = s.ridged(u * 3.5 + 7, v * 3.5 - 3, 6);
      const glacier = smoothstep(0.35, 0.9, s.fbm(u * 1.3 + 11, v * 1.3, 3) * 0.5 + 0.5);
      let h = 30 + plateau * 70 + ridges * ridges * 210 * (0.35 + glacier);
      // Lakes carved where the low plateau dips.
      const lake = smoothstep(0.55, 0.75, s.fbm(u * 4 + 50, v * 4 - 20, 3) * 0.5 + 0.5);
      h = lerp(h, 26, lake * 0.8);
      const e = edge(u, v);
      h += smoothstep(0.78, 1.0, e) * 320;
      return h;
    },
  },
  archipelago: {
    id: 'archipelago',
    name: 'Shattered Archipelago',
    blurb: 'Island chain over a deep sea. Bases sit on the seabed. Bridge the straits to bring siege tanks across.',
    seaLevel: 60, frozen: false, coldness: 1.2, windBase: 9, katabatic: 6, gust: 7,
    fogColor: 0x9db7c4, fogDensity: 0.00038, skyTop: 0x3f77a8, skyHorizon: 0xbfd6e2,
    sunColor: 0xfff0d0, sunDir: [-0.4, 0.55, 0.3], ambient: 0.5,
    palette: { low: 0x6f8f4e, mid: 0x587a3d, high: 0x8c8a7a, rock: 0x625b52, shore: 0xd9c99a, scorch: 0x1d1a16 },
    waterColor: 0x1f6f8b, particles: 'spray', basesUnderwater: true,
    height(s, u, v) {
      const isl = s.fbm(u * 3.2, v * 3.2, 5) * 0.5 + 0.5;
      // A "spine" of islands along the axis between the bases, with straits.
      const spine = Math.exp(-Math.pow((v - 0.5) * 3.2, 2));
      const islands = smoothstep(0.42, 0.7, isl * 0.8 + spine * 0.32);
      const peaks = s.ridged(u * 6 + 3, v * 6 + 9, 5);
      let h = 10 + islands * 70 + islands * peaks * 120;
      h += s.fbm(u * 12, v * 12, 3) * 6;
      const e = edge(u, v);
      h = lerp(h, 5, smoothstep(0.75, 0.98, e));
      return h;
    },
  },
  badlands: {
    id: 'badlands',
    name: 'Rust Badlands',
    blurb: 'Hot mesas and long ski-slopes. Jets cool slowly — manage your heat. Classic Tribes country.',
    seaLevel: 12, frozen: false, coldness: 0.65, windBase: 4, katabatic: 4, gust: 5,
    fogColor: 0xc9a98a, fogDensity: 0.0004, skyTop: 0x6c87a8, skyHorizon: 0xe2c8a6,
    sunColor: 0xffe2b8, sunDir: [0.5, 0.45, -0.3], ambient: 0.5,
    palette: { low: 0xb5734a, mid: 0xa0613d, high: 0xd2a070, rock: 0x6e3f2a, shore: 0xc8a272, scorch: 0x221510 },
    waterColor: 0x3d6f6a, particles: 'dust', basesUnderwater: false,
    height(s, u, v) {
      const base = s.fbm(u * 2.5, v * 2.5, 6) * 0.5 + 0.5;
      // Terraced mesas: quantize then soften.
      const t = base * 6;
      const terr = (Math.floor(t) + smoothstep(0.7, 1.0, t - Math.floor(t))) / 6;
      const hills = s.fbm(u * 5 + 13, v * 5, 4) * 0.5 + 0.5;
      let h = 15 + terr * 150 + hills * 40;
      const e = edge(u, v);
      h += smoothstep(0.8, 1.0, e) * 260;
      return clamp(h, 0, 600);
    },
  },
};
