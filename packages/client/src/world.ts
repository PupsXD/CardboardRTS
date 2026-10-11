import { SCALE, Terrain, TERRAIN_CELL } from "@cardboard/sim";
import type { State, Unit } from "@cardboard/sim";

/** Пикселей на пункт симуляции: 1 единица длины (диаметр юнита) = 20 пикселей. */
export const PX = 0.2;
export const toPx = (v: number): number => v * PX;
export const toPt = (px: number): number => Math.round(px / PX);

/** Цвета ручек игроков: синяя, красная, зелёная, чёрная. */
export const PEN = [0x1f4fbf, 0xc0392b, 0x2e8b57, 0x22252b] as const;
export const PEN_CSS = ["#1f4fbf", "#c0392b", "#2e8b57", "#22252b"] as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WorldOptions {
  /** Сторона карты в единицах длины. */
  size: number;
  unitsPerPlayer: number;
  players: number;
  maxGroup: number;
  ap: number;
  seed: number;
}

export const DEFAULT_WORLD: WorldOptions = { size: 60, unitsPerPlayer: 125, players: 4, maxGroup: 8, ap: 8, seed: 7 };

/**
 * Стартовое состояние для прототипа: игроки по углам, вокруг каждого плотный лагерь; на карте несколько «кляксов»
 * непроходимого и тяжёлого рельефа и пара дорог. Всё случайное — от seed, поэтому воспроизводимо.
 */
export function createWorld(opt: WorldOptions = DEFAULT_WORLD): State {
  const r = mulberry32(opt.seed);
  const W = opt.size * SCALE;
  const tw = Math.ceil(W / TERRAIN_CELL);
  const terrain = new Uint8Array(tw * tw);

  const blob = (cx: number, cy: number, rad: number, kind: number) => {
    for (let y = 0; y < tw; y++)
      for (let x = 0; x < tw; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < rad * (0.75 + 0.5 * r())) terrain[y * tw + x] = kind;
      }
  };
  for (let i = 0; i < 6; i++) blob(r() * tw, r() * tw, 1.5 + r() * 2, Terrain.Blocked);
  for (let i = 0; i < 8; i++) blob(r() * tw, r() * tw, 2 + r() * 3, Terrain.Rough);
  // две дороги крест-накрест через центр
  const mid = Math.floor(tw / 2);
  for (let i = 0; i < tw; i++) {
    terrain[mid * tw + i] = Terrain.Road;
    terrain[i * tw + mid] = Terrain.Road;
  }

  const corners = [
    [0.22, 0.22],
    [0.78, 0.22],
    [0.22, 0.78],
    [0.78, 0.78],
  ];
  const units: Unit[] = [];
  const placed: [number, number][] = [];
  let id = 1;
  for (let p = 0; p < opt.players; p++) {
    const [fx, fy] = corners[p]!;
    const cx = fx * W;
    const cy = fy * W;
    let n = 0;
    let guard = 0;
    while (n < opt.unitsPerPlayer && guard++ < 20000) {
      const ang = r() * Math.PI * 2;
      const rad = Math.sqrt(r()) * 900;
      const x = Math.round(cx + Math.cos(ang) * rad);
      const y = Math.round(cy + Math.sin(ang) * rad);
      if (x < 60 || y < 60 || x > W - 60 || y > W - 60) continue;
      if (placed.some(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < 110 * 110)) continue;
      placed.push([x, y]);
      terrain[Math.floor(y / TERRAIN_CELL) * tw + Math.floor(x / TERRAIN_CELL)] = Terrain.Plain;
      units.push({
        id: id++,
        owner: p,
        x,
        y,
        hp: 100,
        dmg: 40,
        defense: 20,
        speed: 50,
        radius: 50,
        range: 300,
        vision: 500,
        aoe: 25,
      });
      n++;
    }
  }

  return {
    turn: 1,
    w: W,
    h: W,
    terrain,
    tw,
    th: tw,
    ticks: 10,
    maxGroup: opt.maxGroup,
    players: Array.from({ length: opt.players }, (_, p) => ({ id: p, ap: opt.ap })),
    units,
  };
}
