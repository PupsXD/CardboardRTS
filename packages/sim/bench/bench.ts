// Грубый замер: сколько стоит ход при росте числа игроков.
// Нагрузка синтетическая (боты идут к ближайшему чужому центру масс и бьют, что в радиусе),
// поэтому цифры — порядок величины, а не прогноз для живой игры.
//
// Запуск: npm run bench   (Node >= 24, TypeScript исполняется без сборки)
import os from "node:os";
import { filterEventsFor, reachable, resolveTurn, Terrain, visibleUnits } from "../src/index.ts";
import type { Order, PlayerOrders, State, Unit } from "../src/index.ts";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS_PER_PLAYER = 50;
const AP = 30;
const TURNS = 12;

function makeState(players: number, r: () => number): State {
  const side = Math.round(Math.sqrt(players * 1024)); // ~1024 клеток на игрока
  const terrain = new Uint8Array(side * side);
  for (let i = 0; i < terrain.length; i++) {
    const v = r();
    terrain[i] = v < 0.08 ? Terrain.Blocked : v < 0.2 ? Terrain.Road : v < 0.3 ? Terrain.Rough : Terrain.Plain;
  }
  // центры стартов — равномерная сетка
  const cols = Math.ceil(Math.sqrt(players));
  const rows = Math.ceil(players / cols);
  const units: Unit[] = [];
  const taken = new Set<number>();
  let id = 1;
  for (let p = 0; p < players; p++) {
    const cx = Math.floor(((p % cols) + 0.5) * (side / cols));
    const cy = Math.floor((Math.floor(p / cols) + 0.5) * (side / rows));
    let placed = 0;
    let guard = 0;
    while (placed < UNITS_PER_PLAYER && guard++ < 5000) {
      const x = cx + Math.floor(r() * 13) - 6;
      const y = cy + Math.floor(r() * 13) - 6;
      if (x < 0 || y < 0 || x >= side || y >= side) continue;
      const i = y * side + x;
      if (taken.has(i)) continue;
      taken.add(i);
      terrain[i] = Terrain.Plain;
      units.push({ id: id++, owner: p, x, y, hp: 10, dmg: 4, defense: 2, move: 6, range: 3, vision: 5 });
      placed++;
    }
  }
  return {
    turn: 1,
    seed: 20261010,
    w: side,
    h: side,
    terrain,
    players: Array.from({ length: players }, (_, p) => ({ id: p, ap: AP })),
    units,
  };
}

function botOrders(s: State): PlayerOrders[] {
  const occ = new Map<number, Unit>();
  for (const u of s.units) occ.set(u.y * s.w + u.x, u);
  const sum = new Map<number, { x: number; y: number; n: number }>();
  for (const u of s.units) {
    const c = sum.get(u.owner) ?? { x: 0, y: 0, n: 0 };
    c.x += u.x;
    c.y += u.y;
    c.n++;
    sum.set(u.owner, c);
  }
  const centers = [...sum.entries()].map(([p, c]) => ({ p, x: c.x / c.n, y: c.y / c.n }));
  const goal = new Map<number, { x: number; y: number }>();
  for (const a of centers) {
    let best = Infinity;
    for (const b of centers) {
      if (a.p === b.p) continue;
      const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (d < best) {
        best = d;
        goal.set(a.p, b);
      }
    }
  }
  const out = new Map<number, Order[]>();
  const budget = new Map<number, number>();
  for (const u of s.units) {
    if ((budget.get(u.owner) ?? 0) >= AP) continue;
    let order: Order | undefined;
    search: for (let dy = -u.range; dy <= u.range; dy++) {
      for (let dx = -(u.range - Math.abs(dy)); dx <= u.range - Math.abs(dy); dx++) {
        if (dx === 0 && dy === 0) continue;
        const t = occ.get((u.y + dy) * s.w + (u.x + dx));
        if (t && t.owner !== u.owner) {
          order = { kind: "attack", unit: u.id, at: [t.x, t.y] };
          break search;
        }
      }
    }
    if (!order) {
      const g = goal.get(u.owner);
      if (!g) continue;
      const { cost, prev } = reachable(s, [u.x, u.y], u.move, (i) => occ.has(i));
      let bestCell = -1;
      let bestD = Math.abs(u.x - g.x) + Math.abs(u.y - g.y);
      for (const i of cost.keys()) {
        const x = i % s.w;
        const y = (i - x) / s.w;
        const d = Math.abs(x - g.x) + Math.abs(y - g.y);
        if (d < bestD) {
          bestD = d;
          bestCell = i;
        }
      }
      if (bestCell < 0) continue;
      const path: [number, number][] = [];
      let cur = bestCell;
      const start = u.y * s.w + u.x;
      while (cur !== start) {
        path.push([cur % s.w, Math.floor(cur / s.w)]);
        cur = prev.get(cur)!;
      }
      order = { kind: "move", unit: u.id, path: path.reverse() };
    }
    (out.get(u.owner) ?? out.set(u.owner, []).get(u.owner)!).push(order);
    budget.set(u.owner, (budget.get(u.owner) ?? 0) + 1);
  }
  return [...out.entries()].map(([player, orders]) => ({ player, orders }));
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const kb = (n: number) => (n / 1024).toFixed(1);

console.log(`node ${process.version}, ${os.cpus()[0]?.model.trim()} x${os.cpus().length}, ${os.platform()}`);
console.log(`${UNITS_PER_PLAYER} юнитов/игрок, AP ${AP}, ${TURNS} ходов подряд, ~1024 клетки на игрока\n`);
console.log(
  "| игроков | карта | юнитов | resolve, мс (медиана / макс) | фильтр тумана на всех, мс | событий/ход (медиана) | лог игроку, КБ (сред / макс) | снимок состояния целиком, КБ | ударов / блокировок за все ходы |",
);
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");

for (const players of [4, 16, 32, 64]) {
  const r = rng(players);
  let s = makeState(players, r);
  const mapSide = s.w;
  const unitsStart = s.units.length;
  const tResolve: number[] = [];
  const tFilter: number[] = [];
  const evCount: number[] = [];
  const avgBytes: number[] = [];
  const maxBytes: number[] = [];
  let snapshot = 0;
  let hits = 0;
  let blocked = 0;
  const why: Record<string, number> = {};
  for (let t = 0; t < TURNS; t++) {
    const orders = botOrders(s);
    const t0 = performance.now();
    const res = resolveTurn(s, orders);
    const t1 = performance.now();
    hits += res.stats.hits;
    blocked += res.stats.blocked;
    for (const e of res.events) if (e.t === "blocked") why[e.reason] = (why[e.reason] ?? 0) + 1;
    let total = 0;
    let max = 0;
    for (let p = 0; p < players; p++) {
      const bytes = Buffer.byteLength(JSON.stringify(filterEventsFor(s, res.events, p)));
      total += bytes;
      if (bytes > max) max = bytes;
    }
    const t2 = performance.now();
    tResolve.push(t1 - t0);
    tFilter.push(t2 - t1);
    evCount.push(res.events.length);
    avgBytes.push(total / players);
    maxBytes.push(max);
    snapshot = Buffer.byteLength(JSON.stringify(res.state.units));
    s = res.state;
    if (t === 0) void visibleUnits(s, 0); // прогрев
  }
  console.log(
    `| ${players} | ${mapSide}×${mapSide} | ${unitsStart} | ${median(tResolve).toFixed(1)} / ${Math.max(...tResolve).toFixed(1)} | ${median(tFilter).toFixed(0)} | ${median(evCount)} | ${kb(median(avgBytes))} / ${kb(Math.max(...maxBytes))} | ${kb(snapshot)} | ${hits} / ${blocked} |`);
  console.log(`|  | | | | | | | | причины блокировок: ${JSON.stringify(why)} |`,
  );
}
