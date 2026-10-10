import type { Cell, State, Unit } from "./types.ts";
import { Terrain } from "./types.ts";

/**
 * Метрика движения: 8 направлений, диагональ дороже в √2 (7/5 = 1.4, ошибка 1%).
 * Очки движения юнита (`Unit.move`) умножаются на COST_SCALE, чтобы всё считалось целыми.
 * Проверено расчётом: разброс «путь по сетке / прямая» 8.2% против 41% у 4 соседей и 15.5% у гекса.
 */
export const COST_SCALE = 5;
const ORTHO = 5;
const DIAG = 7;

/** Очки движения за вход в клетку (до умножения на ORTHO/DIAG). Дорога вдвое дешевле равнины. */
const TERRAIN_COST: Record<number, number> = {
  [Terrain.Plain]: 2,
  [Terrain.Road]: 1,
  [Terrain.Rough]: 3,
};

export const cellIndex = (s: Pick<State, "w">, x: number, y: number): number => y * s.w + x;

export const inBounds = (s: Pick<State, "w" | "h">, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < s.w && y < s.h;

/** Цена входа в клетку (в единицах рельефа) или null, если клетка непроходима / за картой. */
export function terrainCost(s: State, x: number, y: number): number | null {
  if (!inBounds(s, x, y)) return null;
  return TERRAIN_COST[s.terrain[cellIndex(s, x, y)]!] ?? null;
}

const isWall = (s: State, x: number, y: number): boolean =>
  inBounds(s, x, y) && s.terrain[cellIndex(s, x, y)] === Terrain.Blocked;

/** Квадрат евклидова расстояния: радиусы атаки и обзора — круги, а не ромбы. */
export const dist2 = (ax: number, ay: number, bx: number, by: number): number =>
  (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

/** Цена шага из (px,py) в соседнюю клетку (x,y) в масштабированных единицах или null, если шаг невозможен.
 *  Диагональ запрещена, если любая из двух боковых клеток — стена (нельзя срезать угол). */
export function stepCost(s: State, px: number, py: number, x: number, y: number): number | null {
  const dx = x - px;
  const dy = y - py;
  if ((dx === 0 && dy === 0) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return null;
  const base = terrainCost(s, x, y);
  if (base === null) return null;
  if (dx !== 0 && dy !== 0) {
    if (isWall(s, px + dx, py) || isWall(s, px, py + dy)) return null;
    return base * DIAG;
  }
  return base * ORTHO;
}

/** Полная цена маршрута (в масштабированных единицах) или null, если он разрывный / через стену / за картой. */
export function pathCost(s: State, from: Cell, path: readonly Cell[]): number | null {
  let px = from[0];
  let py = from[1];
  let total = 0;
  for (const [x, y] of path) {
    const c = stepCost(s, px, py, x, y);
    if (c === null) return null;
    total += c;
    px = x;
    py = y;
  }
  return total;
}

/** Бюджет движения юнита в масштабированных единицах. */
export const moveBudget = (u: Pick<Unit, "move">): number => u.move * COST_SCALE;

const NEIGHBORS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/**
 * Дейкстра по корзинам (цены — малые целые). Порядок соседей фиксирован, поэтому при равной цене
 * всегда выбирается один и тот же маршрут. `budget` — в масштабированных единицах (см. moveBudget).
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
        const sc = stepCost(s, cx, cy, nx, ny);
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
