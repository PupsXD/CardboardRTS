import { isqrt } from "./geom.ts";
import { MAX_RADIUS } from "./types.ts";

export interface Body {
  id: number;
  x: number;
  y: number;
  r: number;
  /** Двигалось ли тело в этот тик по своему приказу. Стоящие тела расталкивать нельзя: они «тяжёлые». */
  mover: boolean;
}

const CELL = 2 * MAX_RADIUS;
const key = (cx: number, cy: number): number => (cx + 1) * 8192 + (cy + 1);

function buildGrid(bodies: readonly Body[]): Map<number, Body[]> {
  const g = new Map<number, Body[]>();
  for (const b of bodies) {
    const k = key(Math.floor(b.x / CELL), Math.floor(b.y / CELL));
    const list = g.get(k);
    if (list) list.push(b);
    else g.set(k, [b]);
  }
  return g;
}

/**
 * Расталкивание перекрывшихся тел. Итерации в стиле Якоби: смещения всех пар считаются по позициям на начало
 * итерации и применяются разом, суммы целые, поэтому порядок тел во входном массиве не влияет на результат.
 *
 *  - двигавшееся против стоящего: смещается только двигавшееся (стоящий — «стена»);
 *  - двигавшееся против двигавшегося: поровну (симметрично, без приоритета);
 *  - стоящее против стоящего: ничего.
 *
 * Совпадающие центры (d = 0) разводятся по id: единственная асимметрия, и она не зависит от порядка массива.
 */
/** Твёрдые клетки рельефа: движущееся тело выталкивается из них так же, как из других тел. */
export interface Walls {
  cell: number;
  tw: number;
  th: number;
  blocked(cx: number, cy: number): boolean;
}

export function separate(bodies: readonly Body[], iterations: number, walls?: Walls): void {
  const movers = bodies.filter((b) => b.mover);
  if (movers.length === 0) return;
  const statics = bodies.filter((b) => !b.mover);
  const sgrid = buildGrid(statics);
  const index = new Map<Body, number>();
  movers.forEach((b, i) => index.set(b, i));
  const dx = new Float64Array(movers.length);
  const dy = new Float64Array(movers.length);

  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    const mgrid = buildGrid(movers);
    let any = false;

    for (let i = 0; i < movers.length; i++) {
      const a = movers[i]!;
      const cx = Math.floor(a.x / CELL);
      const cy = Math.floor(a.y / CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const k = key(cx + ox, cy + oy);
          const sl = sgrid.get(k);
          if (sl) {
            for (const b of sl) {
              const p = push(a, b);
              if (p) {
                dx[i] += p[0];
                dy[i] += p[1];
                any = true;
              }
            }
          }
          const ml = mgrid.get(k);
          if (ml) {
            for (const b of ml) {
              if (b.id <= a.id) continue; // каждую пару движущихся считаем один раз
              const p = push(a, b);
              if (p) {
                const hx = Math.trunc(p[0] / 2);
                const hy = Math.trunc(p[1] / 2);
                const j = index.get(b)!;
                dx[i] += hx;
                dy[i] += hy;
                dx[j] -= hx;
                dy[j] -= hy;
                if (hx !== 0 || hy !== 0) any = true;
              }
            }
          }
        }
      }
    }
    if (walls) {
      for (let i = 0; i < movers.length; i++) {
        const p = pushFromWalls(movers[i]!, walls);
        if (p) {
          dx[i] += p[0];
          dy[i] += p[1];
          any = true;
        }
      }
    }
    if (!any) break;
    for (let i = 0; i < movers.length; i++) {
      movers[i]!.x += dx[i]!;
      movers[i]!.y += dy[i]!;
    }
  }
}

/** Вектор, на который надо сдвинуть `a`, чтобы убрать перекрытие с `b` (полный, делить пополам — дело вызывающего). */
function push(a: Body, b: Body): [number, number] | null {
  let ddx = a.x - b.x;
  let ddy = a.y - b.y;
  const R = a.r + b.r;
  const d2 = ddx * ddx + ddy * ddy;
  if (d2 >= R * R) return null;
  let d: number;
  if (d2 === 0) {
    ddx = a.id < b.id ? 1 : -1;
    ddy = 0;
    d = 0;
  } else {
    d = isqrt(d2);
    if (d === 0) d = 1;
  }
  const overlap = R - d;
  const dd = d === 0 ? 1 : d;
  return [Math.trunc((ddx * overlap) / dd), Math.trunc((ddy * overlap) / dd)];
}

/**
 * Вектор выталкивания тела из твёрдых клеток рельефа вокруг него. По каждой оси берётся НАИБОЛЬШЕЕ выталкивание
 * в каждую сторону, а не сумма: тело на стыке двух клеток одной сплошной стены не должно выталкиваться вдвое сильнее.
 */
function pushFromWalls(a: Body, w: Walls): [number, number] | null {
  const C = w.cell;
  const cx0 = Math.max(0, Math.floor((a.x - a.r) / C));
  const cx1 = Math.min(w.tw - 1, Math.floor((a.x + a.r) / C));
  const cy0 = Math.max(0, Math.floor((a.y - a.r) / C));
  const cy1 = Math.min(w.th - 1, Math.floor((a.y + a.r) / C));
  let right = 0; // выталкивание в +x
  let left = 0; // выталкивание в −x (величина)
  let down = 0;
  let up = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      if (!w.blocked(cx, cy)) continue;
      const x0 = cx * C;
      const y0 = cy * C;
      const nx = Math.min(Math.max(a.x, x0), x0 + C);
      const ny = Math.min(Math.max(a.y, y0), y0 + C);
      const ddx = a.x - nx;
      const ddy = a.y - ny;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 >= a.r * a.r) continue;
      if (d2 === 0) {
        // центр внутри твёрдой клетки: выталкиваем через ближайший край (при равенстве порядок осей фиксирован)
        const l = a.x - x0;
        const r = x0 + C - a.x;
        const u = a.y - y0;
        const d = y0 + C - a.y;
        const m = Math.min(l, r, u, d);
        if (m === l) left = Math.max(left, l + a.r);
        else if (m === r) right = Math.max(right, r + a.r);
        else if (m === u) up = Math.max(up, u + a.r);
        else down = Math.max(down, d + a.r);
      } else {
        const d = isqrt(d2) || 1;
        const overlap = a.r - d;
        const px = Math.trunc((ddx * overlap) / d);
        const py = Math.trunc((ddy * overlap) / d);
        if (px > 0) right = Math.max(right, px);
        else left = Math.max(left, -px);
        if (py > 0) down = Math.max(down, py);
        else up = Math.max(up, -py);
      }
    }
  }
  const px = right - left;
  const py = down - up;
  return px === 0 && py === 0 ? null : [px, py];
}

/** Наибольшее перекрытие тел, пунктов (для проверок и бенчмарка). */
export function maxOverlap(bodies: readonly Body[]): number {
  const grid = buildGrid(bodies);
  let worst = 0;
  for (const a of bodies) {
    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const b of grid.get(key(cx + ox, cy + oy)) ?? []) {
          if (b.id <= a.id) continue;
          const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
          const R = a.r + b.r;
          if (d2 < R * R) worst = Math.max(worst, R - isqrt(d2));
        }
      }
    }
  }
  return worst;
}
