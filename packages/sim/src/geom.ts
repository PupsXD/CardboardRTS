import type { Point, State } from "./types.ts";
import { TERRAIN_CELL, TERRAIN_SPEED } from "./types.ts";

export const dist2 = (ax: number, ay: number, bx: number, by: number): number =>
  (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

/** Целый корень (floor). Math.sqrt даёт приближение, поэтому результат проверяется целочисленно. */
export function isqrt(n: number): number {
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const inMap = (s: Pick<State, "w" | "h">, p: Point): boolean =>
  Number.isInteger(p[0]) && Number.isInteger(p[1]) && p[0] >= 0 && p[1] >= 0 && p[0] <= s.w && p[1] <= s.h;

/** Скорость движения (проценты) в точке; вне карты — 0. */
export function terrainSpeed(s: Pick<State, "terrain" | "tw" | "th" | "w" | "h">, x: number, y: number): number {
  const cx = Math.floor(x / TERRAIN_CELL);
  const cy = Math.floor(y / TERRAIN_CELL);
  if (x < 0 || y < 0 || x > s.w || y > s.h) return 0;
  const ix = Math.min(cx, s.tw - 1);
  const iy = Math.min(cy, s.th - 1);
  return TERRAIN_SPEED[s.terrain[iy * s.tw + ix]!] ?? 0;
}

/**
 * Пройти по ломаной не больше `budget` пунктов. Только целочисленная арифметика (деление затем trunc —
 * детерминированно по IEEE 754). Возвращает новую позицию и индекс следующей точки маршрута.
 */
export function advance(
  x: number,
  y: number,
  wps: readonly Point[],
  wi: number,
  budget: number,
): [x: number, y: number, wi: number] {
  while (budget > 0 && wi < wps.length) {
    const [tx, ty] = wps[wi]!;
    const dx = tx - x;
    const dy = ty - y;
    const d = isqrt(dx * dx + dy * dy);
    if (d <= budget) {
      x = tx;
      y = ty;
      budget -= d;
      wi++;
    } else {
      x += Math.trunc((dx * budget) / d);
      y += Math.trunc((dy * budget) / d);
      budget = 0;
    }
  }
  return [x, y, wi];
}
