import { cellIndex, inBounds, manhattan, pathCost } from "./grid.ts";
import type {
  BlockReason,
  Cell,
  Ev,
  PlayerOrders,
  Reject,
  RejectReason,
  ResolveOptions,
  ResolveResult,
  ResolveStats,
  State,
  Unit,
  UnitId,
} from "./types.ts";

/** Целочисленный хеш: общий сид + ход + подтик + id юнита. Не зависит от порядка входных массивов. */
export function mix(a: number, b: number, c: number, d: number): number {
  let h = (0x9e3779b9 ^ a) | 0;
  for (const v of [b, c, d]) {
    h = Math.imul(h ^ v, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

interface Mover {
  u: Unit;
  path: Cell[];
  i: number;
  stopped: boolean;
}

const byId = (a: { u: Unit }, b: { u: Unit }) => a.u.id - b.u.id;

/**
 * Разрешение одного хода.
 *
 * Свойства, которые держат тесты:
 *  - результат и лог не зависят от порядка юнитов и приказов во входных массивах (кроме порядка
 *    приказов ВНУТРИ списка одного игрока — он решает, какие приказы не влезли в AP);
 *  - один юнит на клетку после каждого подтика;
 *  - applyEvents(initial, events) == итоговое состояние.
 */
export function resolveTurn(state: State, allOrders: PlayerOrders[], opts: ResolveOptions = {}): ResolveResult {
  const conflict = opts.conflict ?? "bounce";
  const order = opts.order ?? "attacks-first";

  const units = new Map<UnitId, Unit>();
  for (const u of state.units) units.set(u.id, { ...u });

  const events: Ev[] = [];
  const rejected: Reject[] = [];
  const stats: ResolveStats = { hits: 0, overkill: 0, blocked: 0, ticks: 0 };

  // ---- 0. Валидация и учёт AP -------------------------------------------------------------
  const apLeft = new Map<number, number>(state.players.map((p) => [p.id, p.ap]));
  const used = new Set<UnitId>();
  const moves: Mover[] = [];
  const attacks: { u: Unit; at: Cell }[] = [];
  const defending = new Set<UnitId>();

  for (const po of allOrders) {
    for (const o of po.orders) {
      const fail = (reason: RejectReason) => rejected.push({ player: po.player, unit: o.unit, reason });
      const u = units.get(o.unit);
      if (!u) {
        fail("unknown-unit");
        continue;
      }
      if (u.owner !== po.player) {
        fail("not-owner");
        continue;
      }
      if (used.has(u.id)) {
        fail("duplicate");
        continue;
      }
      if (o.kind === "defend") {
        used.add(u.id);
        defending.add(u.id); // бесплатно (предложение ГДД)
        continue;
      }
      if ((apLeft.get(po.player) ?? 0) < 1) {
        fail("no-ap");
        continue;
      }
      if (o.kind === "move") {
        if (o.path.length === 0 || (pathCost(state, [u.x, u.y], o.path) ?? Infinity) > u.move) {
          fail("bad-path");
          continue;
        }
        moves.push({ u, path: o.path, i: 0, stopped: false });
      } else {
        const [ax, ay] = o.at;
        if (!inBounds(state, ax, ay)) {
          fail("bad-target");
          continue;
        }
        const d = manhattan(u.x, u.y, ax, ay);
        if (d < 1 || d > u.range) {
          fail("out-of-range");
          continue;
        }
        attacks.push({ u, at: o.at });
      }
      used.add(u.id);
      apLeft.set(po.player, apLeft.get(po.player)! - 1);
    }
  }

  const occupancy = (): Map<number, Unit> => {
    const m = new Map<number, Unit>();
    for (const u of units.values()) m.set(cellIndex(state, u.x, u.y), u);
    return m;
  };

  // ---- Атаки: одновременно, по позициям на момент вызова -----------------------------------
  const doAttacks = (tick: number) => {
    const occ = occupancy();
    const dealt = new Map<UnitId, number>();
    attacks.sort((a, b) => a.u.id - b.u.id);
    for (const a of attacks) {
      if (!units.has(a.u.id)) continue; // убит до выстрела (только в move-first нельзя, в attacks-first все живы)
      const from: Cell = [a.u.x, a.u.y];
      const t = occ.get(cellIndex(state, a.at[0], a.at[1]));
      if (!t) {
        events.push({ t: "miss", tick, attacker: a.u.id, from, at: a.at, reason: "empty" });
      } else if (t.owner === a.u.owner) {
        events.push({ t: "miss", tick, attacker: a.u.id, from, at: a.at, reason: "friendly" });
      } else {
        const dmg = Math.max(1, a.u.dmg - (defending.has(t.id) ? t.defense : 0));
        events.push({ t: "attack", tick, attacker: a.u.id, target: t.id, from, at: a.at, dmg });
        dealt.set(t.id, (dealt.get(t.id) ?? 0) + dmg);
        stats.hits++;
      }
    }
    // Урон применяется ПОСЛЕ расчёта всех выстрелов: убитые успевают выстрелить (взаимное убийство).
    for (const id of [...dealt.keys()].sort((a, b) => a - b)) {
      const u = units.get(id)!;
      const sum = dealt.get(id)!;
      u.hp -= sum;
      if (u.hp <= 0) {
        stats.overkill += -u.hp;
        events.push({ t: "death", tick, unit: id, at: [u.x, u.y] });
        units.delete(id);
      }
    }
  };

  // ---- Движение: подтики по одной клетке, симметричное разрешение конфликтов ---------------
  const doMovement = (): number => {
    let tick = 0;
    for (;;) {
      const cand = moves.filter((m) => units.has(m.u.id) && !m.stopped && m.i < m.path.length);
      if (cand.length === 0) break;
      tick++;
      const occ = occupancy();
      const moving = new Set<Mover>(cand);
      const reasons = new Map<Mover, BlockReason>();
      const target = (m: Mover): Cell => m.path[m.i]!;

      for (;;) {
        // Решения принимаются по снимку множества `moving` на начало прохода: порядок обхода не влияет.
        const byUnit = new Map<UnitId, Mover>();
        const claims = new Map<number, Mover[]>();
        for (const m of moving) {
          byUnit.set(m.u.id, m);
          const [tx, ty] = target(m);
          const ti = cellIndex(state, tx, ty);
          const list = claims.get(ti);
          if (list) list.push(m);
          else claims.set(ti, [m]);
        }
        const inCycle = (m: Mover): boolean => {
          let cur = m;
          for (let k = 0; k <= moving.size; k++) {
            const o = occ.get(cellIndex(state, target(cur)[0], target(cur)[1]));
            if (!o) return false;
            const om = byUnit.get(o.id);
            if (!om) return false;
            cur = om;
            if (cur === m) return true;
          }
          return false;
        };
        const winnerOf = (list: Mover[]): Mover => {
          let best = list[0]!;
          let bh = mix(state.seed, state.turn, tick, best.u.id);
          for (const m of list) {
            const h = mix(state.seed, state.turn, tick, m.u.id);
            if (h < bh || (h === bh && m.u.id < best.u.id)) {
              best = m;
              bh = h;
            }
          }
          return best;
        };

        const blockedNow = new Map<Mover, BlockReason>();
        for (const m of moving) {
          const [tx, ty] = target(m);
          const ti = cellIndex(state, tx, ty);
          const o = occ.get(ti);
          let reason: BlockReason | undefined;
          if (o) {
            const om = byUnit.get(o.id);
            if (!om) reason = "occupied";
            else if (target(om)[0] === m.u.x && target(om)[1] === m.u.y) reason = "swap";
            else if (inCycle(m)) reason = "cycle";
          }
          if (!reason) {
            const list = claims.get(ti)!;
            if (list.length > 1 && (conflict === "bounce" || winnerOf(list) !== m)) reason = "contested";
          }
          if (reason) blockedNow.set(m, reason);
        }
        if (blockedNow.size === 0) break;
        for (const [m, r] of blockedNow) {
          moving.delete(m);
          reasons.set(m, r);
        }
      }

      for (const m of [...reasons.keys()].sort(byId)) {
        m.stopped = true; // путь брошен: юнит остановился рядом с препятствием
        events.push({ t: "blocked", tick, unit: m.u.id, at: [m.u.x, m.u.y], reason: reasons.get(m)! });
        stats.blocked++;
      }
      const going = [...moving].sort(byId);
      for (const m of going) events.push({ t: "step", tick, unit: m.u.id, from: [m.u.x, m.u.y], to: target(m) });
      for (const m of going) {
        const [tx, ty] = target(m);
        m.u.x = tx;
        m.u.y = ty;
        m.i++;
      }
    }
    return tick;
  };

  if (order === "attacks-first") {
    doAttacks(0);
    stats.ticks = doMovement();
  } else {
    stats.ticks = doMovement();
    doAttacks(stats.ticks + 1);
  }

  return {
    state: {
      ...state,
      turn: state.turn + 1,
      units: [...units.values()].sort((a, b) => a.id - b.id),
    },
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
