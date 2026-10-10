import type { Cell, Order, PlayerOrders, State, Unit } from "../src/index.ts";

export function unit(id: number, owner: number, x: number, y: number, over: Partial<Unit> = {}): Unit {
  return { id, owner, x, y, hp: 10, dmg: 4, defense: 2, move: 8, range: 3, vision: 4, ...over };
}

export function world(w: number, h: number, units: Unit[], over: Partial<State> = {}): State {
  const owners = [...new Set(units.map((u) => u.owner))].sort((a, b) => a - b);
  return {
    turn: 1,
    seed: 12345,
    w,
    h,
    terrain: new Uint8Array(w * h), // всё равнина
    players: owners.map((id) => ({ id, ap: 99 })),
    units,
    ...over,
  };
}

/** Прямой маршрут по горизонтали или вертикали, без стартовой клетки. */
export function line(from: Cell, to: Cell): Cell[] {
  const out: Cell[] = [];
  let [x, y] = from;
  while (x !== to[0] || y !== to[1]) {
    if (x !== to[0]) x += Math.sign(to[0] - x);
    else y += Math.sign(to[1] - y);
    out.push([x, y]);
  }
  return out;
}

export const move = (unitId: number, path: Cell[]): Order => ({ kind: "move", unit: unitId, path });
export const attack = (unitId: number, at: Cell): Order => ({ kind: "attack", unit: unitId, at });
export const defend = (unitId: number): Order => ({ kind: "defend", unit: unitId });
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
