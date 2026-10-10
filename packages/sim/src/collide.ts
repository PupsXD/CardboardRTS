import { isqrt } from "./geom.ts";
import { MAX_RADIUS } from "./types.ts";

export interface Body {
  id: number;
  x: number;
  y: number;
  r: number;
  /** Двигалось ли тело в этот тик по своему приказу. Стоящее смещается только по уступчивости staticYield. */
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

/** Твёрдые клетки рельефа: тело выталкивается из них так же, как из других тел. */
export interface Walls {
  cell: number;
  tw: number;
  th: number;
  blocked(cx: number, cy: number): boolean;
}

/** Подвижность движущегося тела; подвижность стоящего — staticYield (0..4). */
const MOVER_MOBILITY = 4;

/**
 * Расталкивание перекрывшихся тел. Итерации в стиле Якоби: смещения всех пар считаются по позициям на начало
 * итерации и применяются разом, суммы целые, поэтому порядок тел во входном массиве не влияет на результат.
 *
 * У каждого тела есть «подвижность»: у движущегося 4, у стоящего staticYield. Смещение пары делится пропорционально
 * подвижностям (тело с большей подвижностью уступает больше). Две движущиеся — поровну, стоящее при staticYield = 0
 * не сдвигается вовсе («стена»).
 *
 * Пара обрабатывается, если хотя бы одно тело «активно»: движется или уже было сдвинуто в этом расталкивании.
 * Так толчок передаётся по цепочке стоящих тел (иначе сдвинутый стоящий мог бы встать на другого стоящего).
 * Сдвинутое стоящее тело дальше проверяется и на стены.
 *
 * Совпадающие центры (d = 0) разводятся по id: единственная асимметрия, и она не зависит от порядка массива.
 */
export function separate(bodies: readonly Body[], iterations: number, walls?: Walls, staticYield = 1): void {
  if (!bodies.some((b) => b.mover)) return;
  const n = bodies.length;
  const index = new Map<Body, number>();
  bodies.forEach((b, i) => index.set(b, i));
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const touched = new Uint8Array(n); // стоящие, которые уже сдвинули: дальше они толкают соседей
  const mobility = bodies.map((b) => (b.mover ? MOVER_MOBILITY : staticYield));
  let grid = buildGrid(bodies);

  for (let it = 0; it < iterations; it++) {
    dx.fill(0);
    dy.fill(0);
    if (it > 0) grid = buildGrid(bodies); // позиции изменились
    let any = false;

    for (let i = 0; i < n; i++) {
      const a = bodies[i]!;
      if (!a.mover && !touched[i]) continue;
      const cx = Math.floor(a.x / CELL);
      const cy = Math.floor(a.y / CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const list = grid.get(key(cx + ox, cy + oy));
          if (!list) continue;
          for (const b of list) {
            if (b === a) continue;
            const j = index.get(b)!;
            const bActive = b.mover || touched[j] === 1;
            if (bActive && b.id < a.id) continue; // пару активных считаем один раз
            const ma = mobility[i]!;
            const mb = mobility[j]!;
            if (ma + mb === 0) continue;
            const p = push(a, b);
            if (!p) continue;
            const ax = Math.trunc((p[0] * ma) / (ma + mb));
            const ay = Math.trunc((p[1] * ma) / (ma + mb));
            const bx = Math.trunc((p[0] * mb) / (ma + mb));
            const by = Math.trunc((p[1] * mb) / (ma + mb));
            dx[i] += ax;
            dy[i] += ay;
            dx[j] -= bx;
            dy[j] -= by;
            if (ax !== 0 || ay !== 0 || bx !== 0 || by !== 0) any = true;
          }
        }
      }
    }
    if (walls) {
      for (let k = 0; k < n; k++) {
        const b = bodies[k]!;
        if (!b.mover && !touched[k]) continue;
        const p = pushFromWalls(b, walls);
        if (p) {
          dx[k] += p[0];
          dy[k] += p[1];
          any = true;
        }
      }
    }
    if (!any) break;
    for (let k = 0; k < n; k++) {
      if (dx[k] === 0 && dy[k] === 0) continue;
      const b = bodies[k]!;
      b.x += dx[k]!;
      b.y += dy[k]!;
      if (!b.mover) touched[k] = 1;
    }
  }

  if (walls) {
    for (let k = 0; k < n; k++) {
      const b = bodies[k]!;
      if (b.mover || !touched[k]) continue;
      const p = pushFromWalls(b, walls);
      if (p) {
        b.x += p[0];
        b.y += p[1];
      }
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
