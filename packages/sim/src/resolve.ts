import { maxOverlap, separate } from "./collide.ts";
import type { Walls } from "./collide.ts";
import type { Body } from "./collide.ts";
import { advance, clamp, dist2, inMap, terrainSpeed } from "./geom.ts";
import { MAX_PATH_POINTS, Terrain, TERRAIN_CELL } from "./types.ts";
import type {
  Ev,
  PlayerOrders,
  Point,
  Reject,
  RejectReason,
  ResolveOptions,
  ResolveResult,
  ResolveStats,
  State,
  Unit,
  UnitId,
} from "./types.ts";

/** Сколько проходов расталкивания за тик. Остаточное перекрытие после них измеряется в stats.maxOverlap. */
const SEPARATION_PASSES = 4;
/** Ячейка быстрого поиска целей залпа. Должна быть не меньше радиус тела + aoe. */
const TARGET_CELL = 500;

interface Mover {
  u: Unit;
  wps: Point[];
  wi: number;
  speed: number;
  stopped: boolean;
}

const bodyKey = (cx: number, cy: number): number => (cx + 1) * 8192 + (cy + 1);

/**
 * Разрешение одного хода в непрерывном пространстве.
 *
 * Ход = state.ticks тиков. В каждом тике: залп (если пора по `attackTiming`) по позициям на начало тика,
 * затем одновременное движение всех, затем расталкивание тел. Всё целочисленное.
 *
 * Свойства, которые держат тесты:
 *  - результат и лог не зависят от порядка юнитов и приказов во входных массивах (кроме порядка приказов
 *    ВНУТРИ списка одного игрока — он решает, какие приказы не влезли в AP);
 *  - applyEvents(начальное состояние, лог) == итоговое состояние;
 *  - повторный запуск даёт тот же результат бит в бит.
 */
export function resolveTurn(state: State, allOrders: PlayerOrders[], opts: ResolveOptions = {}): ResolveResult {
  const timing = opts.attackTiming ?? "zone";
  const T = state.ticks;

  const units = new Map<UnitId, Unit>();
  for (const u of state.units) units.set(u.id, { ...u });

  const events: Ev[] = [];
  const rejected: Reject[] = [];
  const stats: ResolveStats = { hits: 0, overkill: 0, blocked: 0, maxOverlap: 0 };

  const walls: Walls = {
    cell: TERRAIN_CELL,
    tw: state.tw,
    th: state.th,
    blocked: (cx, cy) => state.terrain[cy * state.tw + cx] === Terrain.Blocked,
  };

  // ---- Валидация и учёт AP ----------------------------------------------------------------
  const apLeft = new Map<number, number>(state.players.map((p) => [p.id, p.ap]));
  const used = new Set<UnitId>();
  const movers: Mover[] = [];
  const shooters: { u: Unit; at: Point }[] = [];
  const defending = new Set<UnitId>();

  for (const po of allOrders) {
    for (const o of po.orders) {
      const fail = (reason: RejectReason) => rejected.push({ player: po.player, units: [...o.units], reason });
      if (o.units.length === 0) {
        fail("empty-group");
        continue;
      }
      if (o.units.length > state.maxGroup) {
        fail("group-too-big");
        continue;
      }
      const group: Unit[] = [];
      const seen = new Set<UnitId>();
      let bad: RejectReason | undefined;
      for (const id of o.units) {
        const u = units.get(id);
        if (!u) bad = "unknown-unit";
        else if (u.owner !== po.player) bad = "not-owner";
        else if (used.has(id) || seen.has(id)) bad = "duplicate";
        if (bad) break;
        seen.add(id);
        group.push(u!);
      }
      if (bad) {
        fail(bad);
        continue;
      }
      if (o.kind === "defend") {
        for (const u of group) {
          used.add(u.id);
          defending.add(u.id); // бесплатно (предложение ГДД)
        }
        continue;
      }
      if ((apLeft.get(po.player) ?? 0) < 1) {
        fail("no-ap");
        continue;
      }
      if (o.kind === "move") {
        if (o.path.length === 0 || o.path.length > MAX_PATH_POINTS || o.path.some((p) => !inMap(state, p))) {
          fail("bad-path");
          continue;
        }
        let sx = 0;
        let sy = 0;
        let speed = Infinity;
        for (const u of group) {
          sx += u.x;
          sy += u.y;
          speed = Math.min(speed, u.speed);
        }
        const cx = Math.trunc(sx / group.length);
        const cy = Math.trunc(sy / group.length);
        for (const u of group) {
          const ox = u.x - cx;
          const oy = u.y - cy;
          const wps: Point[] = o.path.map((p) => [clamp(p[0] + ox, 0, state.w), clamp(p[1] + oy, 0, state.h)]);
          movers.push({ u, wps, wi: 0, speed, stopped: false });
        }
      } else {
        if (!inMap(state, o.at)) {
          fail("bad-target");
          continue;
        }
        if (group.some((u) => dist2(u.x, u.y, o.at[0], o.at[1]) > u.range * u.range)) {
          fail("out-of-range");
          continue;
        }
        for (const u of group) shooters.push({ u, at: o.at });
      }
      for (const u of group) used.add(u.id);
      apLeft.set(po.player, apLeft.get(po.player)! - 1);
    }
  }

  // ---- Залп: все выстрелы считаются по позициям на момент вызова, урон применяется разом --------
  const volley = (tick: number, perTick: boolean) => {
    const live = shooters.filter((s) => units.has(s.u.id)).sort((a, b) => a.u.id - b.u.id);
    if (live.length === 0) return;
    const grid = new Map<number, Unit[]>();
    for (const u of units.values()) {
      const k = bodyKey(Math.floor(u.x / TARGET_CELL), Math.floor(u.y / TARGET_CELL));
      const list = grid.get(k);
      if (list) list.push(u);
      else grid.set(k, [u]);
    }
    const dealt = new Map<UnitId, number>();
    for (const s of live) {
      const a = s.u;
      const from: Point = [a.x, a.y];
      const cx = Math.floor(s.at[0] / TARGET_CELL);
      const cy = Math.floor(s.at[1] / TARGET_CELL);
      const targets: Unit[] = [];
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const t of grid.get(bodyKey(cx + ox, cy + oy)) ?? []) {
            if (t.owner === a.owner) continue;
            const reach = t.radius + a.aoe;
            if (dist2(t.x, t.y, s.at[0], s.at[1]) <= reach * reach) targets.push(t);
          }
        }
      }
      targets.sort((p, q) => p.id - q.id);
      if (targets.length === 0) {
        if (!perTick) events.push({ t: "miss", tick, attacker: a.id, from, at: s.at });
        continue;
      }
      for (const t of targets) {
        const base = perTick ? Math.max(1, Math.floor(a.dmg / T)) : a.dmg;
        const cut = defending.has(t.id) ? (perTick ? Math.floor(t.defense / T) : t.defense) : 0;
        const dmg = Math.max(1, base - cut);
        events.push({ t: "attack", tick, attacker: a.id, target: t.id, from, at: s.at, dmg });
        dealt.set(t.id, (dealt.get(t.id) ?? 0) + dmg);
        stats.hits++;
      }
    }
    // Урон применяется ПОСЛЕ расчёта всех выстрелов: убитые успевают выстрелить (взаимное убийство).
    for (const id of [...dealt.keys()].sort((a, b) => a - b)) {
      const u = units.get(id)!;
      u.hp -= dealt.get(id)!;
      if (u.hp <= 0) {
        stats.overkill += -u.hp;
        events.push({ t: "death", tick, unit: id, at: [u.x, u.y] });
        units.delete(id);
      }
    }
  };

  // ---- Тики -------------------------------------------------------------------------------
  for (let tick = 1; tick <= T; tick++) {
    if (timing === "zone" || (timing === "start" && tick === 1)) volley(tick, timing === "zone");

    const startPos = new Map<UnitId, Point>();
    for (const u of units.values()) startPos.set(u.id, [u.x, u.y]);

    const moved = new Set<UnitId>();
    const stopped: Ev[] = [];
    for (const m of movers) {
      const u = m.u;
      if (m.stopped || m.wi >= m.wps.length || !units.has(u.id)) continue;
      const budget = Math.floor((m.speed * terrainSpeed(state, u.x, u.y)) / 100);
      const [nx, ny, nwi] = advance(u.x, u.y, m.wps, m.wi, budget);
      if (terrainSpeed(state, nx, ny) === 0) {
        m.stopped = true;
        stopped.push({ t: "blocked", tick, unit: u.id, at: [u.x, u.y], reason: "terrain" });
        stats.blocked++;
        continue;
      }
      m.wi = nwi;
      if (nx !== u.x || ny !== u.y) {
        u.x = nx;
        u.y = ny;
        moved.add(u.id);
      }
    }

    // Порядок событий не должен зависеть от порядка приказов во входе: сортируем по id юнита.
    stopped.sort((a, b) => (a as { unit: number }).unit - (b as { unit: number }).unit);
    events.push(...stopped);

    if (moved.size > 0) {
      const bodies: Body[] = [];
      for (const u of units.values()) bodies.push({ id: u.id, x: u.x, y: u.y, r: u.radius, mover: moved.has(u.id) });
      const before = new Map<UnitId, Point>();
      for (const b of bodies) if (b.mover) before.set(b.id, [b.x, b.y]);
      separate(bodies, SEPARATION_PASSES, walls);
      for (const b of bodies) {
        if (!b.mover) continue;
        const u = units.get(b.id)!;
        const nx = clamp(b.x, u.radius, state.w - u.radius);
        const ny = clamp(b.y, u.radius, state.h - u.radius);
        if (terrainSpeed(state, nx, ny) === 0) {
          const p = before.get(b.id)!; // вытолкнуло в стену: остаёмся на месте до расталкивания
          u.x = p[0];
          u.y = p[1];
        } else {
          u.x = nx;
          u.y = ny;
        }
      }
    }

    for (const id of [...units.keys()].sort((a, b) => a - b)) {
      const u = units.get(id)!;
      const p = startPos.get(id)!;
      if (u.x !== p[0] || u.y !== p[1]) events.push({ t: "step", tick, unit: id, from: p, to: [u.x, u.y] });
    }
  }
  if (timing === "end") volley(T + 1, false);

  stats.maxOverlap = maxOverlap([...units.values()].map((u) => ({ id: u.id, x: u.x, y: u.y, r: u.radius, mover: false })));

  return {
    state: { ...state, turn: state.turn + 1, units: [...units.values()].sort((a, b) => a.id - b.id) },
    events,
    rejected,
    stats,
  };
}

/** Применить лог к состоянию. Нужен клиенту для анимации и тесту полноты лога. */
export function applyEvents(state: State, events: readonly Ev[]): State {
  const units = new Map<UnitId, Unit>();
  for (const u of state.units) units.set(u.id, { ...u });
  for (const e of events) {
    if (e.t === "attack") units.get(e.target)!.hp -= e.dmg;
    else if (e.t === "death") units.delete(e.unit);
    else if (e.t === "step" && e.to) {
      const u = units.get(e.unit)!;
      u.x = e.to[0];
      u.y = e.to[1];
    }
  }
  return { ...state, turn: state.turn + 1, units: [...units.values()].sort((a, b) => a.id - b.id) };
}

/**
 * Куда дойдёт группа по маршруту за ход, если ей никто не мешает (для превью в клиенте и тестов).
 * Использует то же движение, что и resolveTurn, но без других юнитов и залпов.
 */
export function previewMove(state: State, group: readonly Unit[], path: readonly Point[]): Point[][] {
  let sx = 0;
  let sy = 0;
  let speed = Infinity;
  for (const u of group) {
    sx += u.x;
    sy += u.y;
    speed = Math.min(speed, u.speed);
  }
  const cx = Math.trunc(sx / group.length);
  const cy = Math.trunc(sy / group.length);
  return group.map((u) => {
    const wps: Point[] = path.map((p) => [clamp(p[0] + (u.x - cx), 0, state.w), clamp(p[1] + (u.y - cy), 0, state.h)]);
    let x = u.x;
    let y = u.y;
    let wi = 0;
    const trace: Point[] = [[x, y]];
    for (let t = 0; t < state.ticks; t++) {
      const budget = Math.floor((speed * terrainSpeed(state, x, y)) / 100);
      const [nx, ny, nwi] = advance(x, y, wps, wi, budget);
      if (terrainSpeed(state, nx, ny) === 0) break;
      x = nx;
      y = ny;
      wi = nwi;
      trace.push([x, y]);
    }
    return trace;
  });
}
