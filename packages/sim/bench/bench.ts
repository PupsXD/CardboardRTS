// Грубый замер: сколько стоит ход при росте числа игроков (непрерывное пространство, групповые приказы).
// Нагрузка синтетическая: группы по 5 юнитов идут к ближайшему чужому центру масс и бьют, что в радиусе.
// Цифры — порядок величины, а не прогноз для живой игры.
//
// Запуск: npm run bench   (Node >= 24, TypeScript исполняется без сборки)
import os from "node:os";
import { botOrders, filterEventsForAll, resolveTurn, SCALE, Terrain, TERRAIN_CELL } from "../src/index.ts";
import type { Order, PlayerOrders, Point, State, Unit } from "../src/index.ts";

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
const GROUP = 5;
const AP = 8; // приказов за ход: 8 групп из 10 получают приказ
const TURNS = 16;
const CELL = 500;
const key = (cx: number, cy: number) => (cx + 1) * 8192 + (cy + 1);

function makeState(players: number, r: () => number): State {
  const side = Math.round(Math.sqrt(players * 1024)); // ~1024 ед.² на игрока, как в сеточном бенчмарке
  const W = side * SCALE;
  const tw = Math.ceil(W / TERRAIN_CELL);
  const terrain = new Uint8Array(tw * tw);
  for (let i = 0; i < terrain.length; i++) {
    const v = r();
    terrain[i] = v < 0.06 ? Terrain.Blocked : v < 0.18 ? Terrain.Road : v < 0.28 ? Terrain.Rough : Terrain.Plain;
  }
  const cols = Math.ceil(Math.sqrt(players));
  const rows = Math.ceil(players / cols);
  const units: Unit[] = [];
  const grid = new Map<number, Unit[]>();
  let id = 1;
  for (let p = 0; p < players; p++) {
    const cx = Math.floor(((p % cols) + 0.5) * (W / cols));
    const cy = Math.floor((Math.floor(p / cols) + 0.5) * (W / rows));
    let placed = 0;
    let guard = 0;
    while (placed < UNITS_PER_PLAYER && guard++ < 8000) {
      const x = cx + Math.floor((r() - 0.5) * 1300);
      const y = cy + Math.floor((r() - 0.5) * 1300);
      if (x < 100 || y < 100 || x > W - 100 || y > W - 100) continue;
      const gx = Math.floor(x / CELL);
      const gy = Math.floor(y / CELL);
      let clash = false;
      for (let ox = -1; ox <= 1 && !clash; ox++)
        for (let oy = -1; oy <= 1 && !clash; oy++)
          for (const o of grid.get(key(gx + ox, gy + oy)) ?? []) if ((o.x - x) ** 2 + (o.y - y) ** 2 < 110 * 110) clash = true;
      if (clash) continue;
      const u: Unit = { id: id++, owner: p, x, y, hp: 100, dmg: 40, defense: 20, speed: 30, radius: 50, range: 300, vision: 500, aoe: 25 };
      terrain[Math.floor(y / TERRAIN_CELL) * tw + Math.floor(x / TERRAIN_CELL)] = Terrain.Plain;
      units.push(u);
      const k = key(gx, gy);
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(u);
      placed++;
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
    maxGroup: 8,
    players: Array.from({ length: players }, (_, p) => ({ id: p, ap: AP })),
    units,
  };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]!;
const kb = (n: number) => (n / 1024).toFixed(1);

console.log(`node ${process.version}, ${os.cpus()[0]?.model.trim()} x${os.cpus().length}, ${os.platform()}`);
console.log(`${UNITS_PER_PLAYER} юнитов/игрок, группы по ${GROUP}, AP ${AP}, 10 тиков, ${TURNS} ходов подряд, ~1024 ед.² на игрока\n`);
console.log(
  "| игроков | карта, ед. | юнитов | resolve, мс (медиана / макс) | фильтр тумана на всех, мс | событий/ход (медиана) | лог игроку, КБ (сред / макс) | снимок всех юнитов, КБ | ударов за все ходы | макс. перекрытие тел, пунктов |",
);
console.log("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");

const SIZES = process.env.BENCH_PLAYERS ? process.env.BENCH_PLAYERS.split(",").map(Number) : [4, 16, 32, 64];
for (const players of SIZES) {
  const r = rng(players);
  let s = makeState(players, r);
  const side = s.w / SCALE;
  const unitsStart = s.units.length;
  const tResolve: number[] = [];
  const tFilter: number[] = [];
  const evCount: number[] = [];
  const avgBytes: number[] = [];
  const maxBytes: number[] = [];
  let snapshot = 0;
  let hits = 0;
  let overlap = 0;
  for (let t = 0; t < TURNS; t++) {
    const orders = botOrders(s, { groupSize: GROUP, ap: AP });
    const t0 = performance.now();
    const res = resolveTurn(s, orders, process.env.STATIC_YIELD ? { staticYield: Number(process.env.STATIC_YIELD) } : {});
    const t1 = performance.now();
    hits += res.stats.hits;
    overlap = Math.max(overlap, res.stats.maxOverlap);
    let total = 0;
    let max = 0;
    const logs = filterEventsForAll(s, res.events, Array.from({ length: players }, (_, p) => p));
    for (let p = 0; p < players; p++) {
      const bytes = Buffer.byteLength(JSON.stringify(logs.get(p)));
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
  }
  console.log(
    `| ${players} | ${side}×${side} | ${unitsStart} | ${median(tResolve).toFixed(1)} / ${Math.max(...tResolve).toFixed(1)} | ${median(tFilter).toFixed(0)} | ${median(evCount)} | ${kb(median(avgBytes))} / ${kb(Math.max(...maxBytes))} | ${kb(snapshot)} | ${hits} | ${overlap} |`,
  );
}
