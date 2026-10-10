import { SCALE, TERRAIN_CELL } from "../src/index.ts";
import type { Order, PlayerOrders, Point, State, Unit } from "../src/index.ts";

/** Юнит; x, y — в единицах длины (умножаются на SCALE), остальные поля в пунктах. */
export function unit(id: number, owner: number, x: number, y: number, over: Partial<Unit> = {}): Unit {
  return {
    id,
    owner,
    x: Math.round(x * SCALE),
    y: Math.round(y * SCALE),
    hp: 100,
    dmg: 40,
    defense: 20,
    speed: 30,
    radius: 50,
    range: 300,
    vision: 500,
    aoe: 0,
    ...over,
  };
}

/** Мир w×h единиц длины, вся равнина, 10 тиков, группа до 6. */
export function world(w: number, h: number, units: Unit[], over: Partial<State> = {}): State {
  const W = w * SCALE;
  const H = h * SCALE;
  const tw = Math.ceil(W / TERRAIN_CELL);
  const th = Math.ceil(H / TERRAIN_CELL);
  const owners = [...new Set(units.map((u) => u.owner))].sort((a, b) => a - b);
  return {
    turn: 1,
    w: W,
    h: H,
    terrain: new Uint8Array(tw * th),
    tw,
    th,
    ticks: 10,
    maxGroup: 6,
    players: owners.map((id) => ({ id, ap: 99 })),
    units,
    ...over,
  };
}

export const pt = (x: number, y: number): Point => [Math.round(x * SCALE), Math.round(y * SCALE)];
export const move = (units: number[], ...path: Point[]): Order => ({ kind: "move", units, path });
export const attack = (units: number[], at: Point): Order => ({ kind: "attack", units, at });
export const defend = (units: number[]): Order => ({ kind: "defend", units });
export const orders = (player: number, ...list: Order[]): PlayerOrders => ({ player, orders: list });

/** Воспроизводимый ГПСЧ только для тестов и бенча; сама симуляция его не использует. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(arr: readonly T[], r: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const posOf = (s: State, id: number): Point | null => {
  const u = s.units.find((x) => x.id === id);
  return u ? [u.x, u.y] : null;
};
