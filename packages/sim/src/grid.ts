import type { Cell, State, Unit } from "./types.ts";
import { Terrain } from "./types.ts";

/** Очки движения за вход в клетку. Дорога вдвое дешевле равнины — это и есть «дороги увеличивают эффективность Движения». */
const STEP_COST: Record<number, number> = {
  [Terrain.Plain]: 2,
  [Terrain.Road]: 1,
  [Terrain.Rough]: 3,
};

export const cellIndex = (s: Pick<State, "w">, x: number, y: number): number => y * s.w + x;

export const inBounds = (s: Pick<State, "w" | "h">, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < s.w && y < s.h;

/** Цена входа в клетку или null, если клетка непроходима / за картой. */
export function stepCost(s: State, x: number, y: number): number | null {
  if (!inBounds(s, x, y)) return null;
  return STEP_COST[s.terrain[cellIndex(s, x, y)]!] ?? null;
}

export const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(ax - bx) + Math.abs(ay - by);

/** Полная цена маршрута или null, если он разрывный / идёт через стену / за картой. */
export function pathCost(s: State, from: Cell, path: readonly Cell[]): number | null {
  let px = from[0];
  let py = from[1];
  let total = 0;
  for (const [x, y] of path) {
    if (manhattan(px, py, x, y) !== 1) return null;
    const c = stepCost(s, x, y);
    if (c === null) return null;
    total += c;
    px = x;
    py = y;
  }
  return total;
}

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Дейкстра по корзинам (цены — малые целые). Порядок обхода соседей фиксирован,
 * поэтому при равной цене всегда выбирается один и тот же маршрут.
 * `blocked` — клетки, которые планировщик считает занятыми (известные юниты).
 */
export function reachable(
  s: State,
  from: Cell,
  budget: number,
  blocked?: (idx: number) => boolean,
): { cost: Map<number, number>; prev: Map<number, number> } {
  const cost = new Map<number, number>();
  const prev = new Map<number, number>();
  const start = cellIndex(s, from[0], from[1]);
  cost.set(start, 0);
  const buckets: number[][] = Array.from({ length: budget + 1 }, () => []);
  buckets[0]!.push(start);
  for (let c = 0; c <= budget; c++) {
    const bucket = buckets[c]!;
    for (let i = 0; i < bucket.length; i++) {
      const cur = bucket[i]!;
      if (cost.get(cur) !== c) continue; // устаревшая запись
      const cx = cur % s.w;
      const cy = (cur - cx) / s.w;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        const sc = stepCost(s, nx, ny);
        if (sc === null) continue;
        const ni = cellIndex(s, nx, ny);
        if (blocked?.(ni)) continue;
        const nc = c + sc;
        if (nc > budget) continue;
        const old = cost.get(ni);
        if (old === undefined || nc < old) {
          cost.set(ni, nc);
          prev.set(ni, cur);
          buckets[nc]!.push(ni);
        }
      }
    }
  }
  return { cost, prev };
}

export function pathTo(s: State, prev: Map<number, number>, from: Cell, to: number): Cell[] {
  const out: Cell[] = [];
  const start = cellIndex(s, from[0], from[1]);
  let cur = to;
  while (cur !== start) {
    const x = cur % s.w;
    out.push([x, (cur - x) / s.w]);
    const p = prev.get(cur);
    if (p === undefined) return [];
    cur = p;
  }
  return out.reverse();
}

export const unitCell = (u: Unit): Cell => [u.x, u.y];
