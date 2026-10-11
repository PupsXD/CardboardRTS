import { MAX_PATH_POINTS } from "@cardboard/sim";
import type { Point } from "@cardboard/sim";

/** Расстояние от точки до отрезка ab (в пунктах). */
function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

interface Seg {
  i: number;
  j: number;
  /** Индекс самой далёкой от хорды точки и её расстояние. */
  worstIdx: number;
  worstDist: number;
}

function segment(raw: readonly Point[], i: number, j: number): Seg {
  let worstDist = 0;
  let worstIdx = -1;
  for (let k = i + 1; k < j; k++) {
    const d = distToSegment(raw[k]!, raw[i]!, raw[j]!);
    if (d > worstDist) {
      worstDist = d;
      worstIdx = k;
    }
  }
  return { i, j, worstIdx, worstDist };
}

/**
 * Рисованная от руки линия → маршрут приказа. Метод Рамера—Дугласа—Пекера «сверху вниз»: на каждом шаге в маршрут
 * добавляется самая далёкая от текущей хорды точка, пока отклонение больше `eps` и точек меньше `maxPts` (лимит ядра).
 * Так форма сохраняется в пределах лимита всегда: при слишком сложной кривой теряется самая мелкая деталь, а не вся форма.
 * Результат — целые координаты в пунктах.
 */
export function simplifyPath(raw: readonly Point[], eps = 40, maxPts = MAX_PATH_POINTS): Point[] {
  const round = (p: Point): Point => [Math.round(p[0]), Math.round(p[1])];
  if (raw.length <= 2) return raw.map(round);
  const keep = new Set<number>([0, raw.length - 1]);
  const open: Seg[] = [segment(raw, 0, raw.length - 1)];
  while (keep.size < maxPts) {
    let best = -1;
    for (let k = 0; k < open.length; k++) if (best < 0 || open[k]!.worstDist > open[best]!.worstDist) best = k;
    if (best < 0 || open[best]!.worstDist <= eps) break;
    const s = open.splice(best, 1)[0]!;
    keep.add(s.worstIdx);
    open.push(segment(raw, s.i, s.worstIdx), segment(raw, s.worstIdx, s.j));
  }
  return [...keep].sort((a, b) => a - b).map((i) => round(raw[i]!));
}
