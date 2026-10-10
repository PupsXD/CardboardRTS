import { describe, expect, it } from "vitest";
import { applyEvents, COST_SCALE, moveBudget, pathCost, reachable, resolveTurn, Terrain } from "../src/index.ts";
import type { Ev, PlayerOrders, State } from "../src/index.ts";
import { attack, defend, line, move, orders, rng, shuffled, unit, world } from "./helpers.ts";

const at = (s: State, id: number) => {
  const u = s.units.find((x) => x.id === id);
  return u ? [u.x, u.y] : null;
};

describe("рельеф и маршруты (8 направлений)", () => {
  it("дорога вдвое дешевле равнины: тот же запас хода — вдвое дальше", () => {
    const s = world(20, 1, [unit(1, 0, 0, 0, { move: 6 })]);
    expect(pathCost(s, [0, 0], line([0, 0], [3, 0]))).toBe(6 * COST_SCALE); // 3 клетки равнины
    expect(pathCost(s, [0, 0], line([0, 0], [4, 0]))).toBe(8 * COST_SCALE);
    s.terrain.fill(Terrain.Road);
    expect(pathCost(s, [0, 0], line([0, 0], [6, 0]))).toBe(6 * COST_SCALE); // 6 клеток дороги
  });

  it("диагональ стоит ×1.4 (7/5), а не ×2 как у 4 соседей", () => {
    const s = world(5, 5, [unit(1, 0, 0, 0)]);
    expect(pathCost(s, [0, 0], [[1, 1]])).toBe(2 * 7); // равнина 2 × диагональ 7
    expect(pathCost(s, [0, 0], [[1, 0]])).toBe(2 * 5);
    // 3 клетки по диагонали ≈ 4.2 клетки по прямой
    expect(pathCost(s, [0, 0], [[1, 1], [2, 2], [3, 3]])).toBe(42);
  });

  it("недопустимые шаги: прыжок, стена, срезание угла стены, за картой", () => {
    const s = world(5, 5, [unit(1, 0, 0, 0)]);
    s.terrain[1] = Terrain.Blocked; // (1,0)
    expect(pathCost(s, [0, 0], [[1, 0]])).toBeNull(); // стена
    expect(pathCost(s, [0, 0], [[1, 1]])).toBeNull(); // диагональ мимо угла стены (1,0) запрещена
    expect(pathCost(s, [0, 0], [[0, 1], [0, 3]])).toBeNull(); // разрыв
    expect(pathCost(s, [0, 0], [[-1, 0]])).toBeNull(); // за картой
    expect(pathCost(s, [0, 0], [[0, 1], [1, 2]])).not.toBeNull(); // а здесь угла стены нет
  });

  it("reachable уважает бюджет и стены", () => {
    const s = world(10, 1, [unit(1, 0, 0, 0)]);
    const { cost } = reachable(s, [0, 0], 6 * COST_SCALE);
    expect([...cost.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("зона досягаемости близка к кругу: разброс радиуса по направлениям ≤ 10%", () => {
    const s = world(41, 41, [unit(1, 0, 20, 20)]);
    const { cost } = reachable(s, [20, 20], 100); // 10 клеток равнины по прямой (по 10 за клетку)
    let min = Infinity;
    let max = 0;
    for (const i of cost.keys()) {
      const x = (i % 41) - 20;
      const y = Math.floor(i / 41) - 20;
      const d = Math.hypot(x, y);
      if (d < 4) continue;
      const c = cost.get(i)!;
      // цена за единицу евклидова расстояния: у круга одинакова по всем направлениям
      const k = c / d;
      min = Math.min(min, k);
      max = Math.max(max, k);
    }
    expect(max / min - 1).toBeLessThan(0.1);
  });
});

describe("валидация приказов и AP", () => {
  it("лишние приказы отклоняются по AP, оборона бесплатна, дубли и чужие юниты отклоняются", () => {
    const s = world(10, 10, [unit(1, 0, 0, 0), unit(2, 0, 0, 2), unit(3, 0, 0, 4), unit(9, 1, 9, 9)]);
    s.players[0]!.ap = 2;
    const r = resolveTurn(s, [
      orders(0, move(1, [[1, 0]]), move(2, [[1, 2]]), move(3, [[1, 4]]), defend(3)),
      orders(1, move(1, [[8, 9]])), // юнит 1 принадлежит игроку 0
    ]);
    const reasons = r.rejected.map((x) => `${x.player}:${x.unit}:${x.reason}`);
    expect(reasons).toContain("0:3:no-ap");
    expect(reasons).toContain("1:1:not-owner");
    expect(at(r.state, 1)).toEqual([1, 0]);
    expect(at(r.state, 2)).toEqual([1, 2]);
    // юнит 3: приказ движения не прошёл по AP, зато оборона бесплатна и принята
    expect(at(r.state, 3)).toEqual([0, 4]);
  });

  it("второй приказ одному юниту — дубль; плохой маршрут и дальняя цель отклоняются", () => {
    const s = world(10, 10, [unit(1, 0, 0, 0, { range: 2 })]);
    const r = resolveTurn(s, [
      orders(0, move(1, [[1, 0]]), attack(1, [2, 0]), move(1, [[0, 1]])),
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate", "duplicate"]);
    const r2 = resolveTurn(s, [orders(0, attack(1, [5, 0]))]);
    expect(r2.rejected[0]!.reason).toBe("out-of-range");
    const r3 = resolveTurn(s, [orders(0, move(1, line([0, 0], [5, 0])))]);
    expect(r3.rejected[0]!.reason).toBe("bad-path"); // цена 10 > запас 8
  });
});

describe("порядок разрешения: attacks-first (ГДД v0.1) против move-first", () => {
  const retreat = () => {
    // A (игрок 0) бьёт по клетке, где стоит B; B в тот же ход отступает за радиус атаки.
    const s = world(12, 1, [unit(1, 0, 0, 0, { range: 3 }), unit(2, 1, 3, 0)]);
    return [s, [orders(0, attack(1, [3, 0])), orders(1, move(2, line([3, 0], [5, 0])))]] as const;
  };

  it("attacks-first: отступление НЕ спасает от выстрела этого хода", () => {
    const [s, o] = retreat();
    const r = resolveTurn(s, o as unknown as PlayerOrders[], { order: "attacks-first" });
    expect(r.state.units.find((u) => u.id === 2)!.hp).toBe(6);
    expect(at(r.state, 2)).toEqual([5, 0]);
  });

  it("move-first: отступивший уходит от выстрела, выстрел по пустой клетке", () => {
    const [s, o] = retreat();
    const r = resolveTurn(s, o as unknown as PlayerOrders[], { order: "move-first" });
    expect(r.state.units.find((u) => u.id === 2)!.hp).toBe(10);
    expect(r.events.some((e) => e.t === "miss" && e.reason === "empty")).toBe(true);
  });

  it("стойка «Оборона» гасит урон ровно на defense (минимум 1)", () => {
    const s = world(10, 1, [unit(1, 0, 0, 0), unit(2, 1, 2, 0)]);
    const plain = resolveTurn(s, [orders(0, attack(1, [2, 0]))]);
    const guarded = resolveTurn(s, [orders(0, attack(1, [2, 0])), orders(1, defend(2))]);
    expect(plain.state.units.find((u) => u.id === 2)!.hp).toBe(6);
    expect(guarded.state.units.find((u) => u.id === 2)!.hp).toBe(8);
  });

  it("взаимное убийство: убитые успевают выстрелить", () => {
    const s = world(10, 1, [unit(1, 0, 0, 0, { hp: 4 }), unit(2, 1, 2, 0, { hp: 4 })]);
    const r = resolveTurn(s, [orders(0, attack(1, [2, 0])), orders(1, attack(2, [0, 0]))]);
    expect(r.state.units).toHaveLength(0);
  });

  it("убитый в фазе атак не двигается (attacks-first)", () => {
    const s = world(10, 1, [unit(1, 0, 0, 0), unit(2, 1, 2, 0, { hp: 3 })]);
    const r = resolveTurn(s, [orders(0, attack(1, [2, 0])), orders(1, move(2, line([2, 0], [5, 0])))]);
    expect(r.state.units.map((u) => u.id)).toEqual([1]);
    expect(r.events.some((e) => e.t === "step")).toBe(false);
  });

  it("фокус: выстрелы сверх нужного считаются как overkill", () => {
    const s = world(10, 3, [
      unit(1, 0, 0, 0),
      unit(2, 0, 0, 1),
      unit(3, 0, 0, 2),
      unit(9, 1, 2, 1, { hp: 5 }),
    ]);
    const r = resolveTurn(s, [orders(0, attack(1, [2, 1]), attack(2, [2, 1]), attack(3, [2, 1]))]);
    expect(r.state.units.find((u) => u.id === 9)).toBeUndefined();
    expect(r.stats.hits).toBe(3);
    expect(r.stats.overkill).toBe(7); // 12 урона на 5 hp
  });
});

describe("коллизии движения", () => {
  it("лоб в лоб в коридоре: оба останавливаются рядом с клеткой спора (bounce)", () => {
    const s = world(7, 1, [unit(1, 0, 0, 0), unit(2, 1, 4, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, line([0, 0], [2, 0]))), orders(1, move(2, line([4, 0], [2, 0])))]);
    expect(at(r.state, 1)).toEqual([1, 0]);
    expect(at(r.state, 2)).toEqual([3, 0]);
    expect(r.events.filter((e) => e.t === "blocked").map((e) => (e as { reason: string }).reason)).toEqual([
      "contested",
      "contested",
    ]);
  });

  it("seeded: из трёх претендентов клетку получает ровно один, детерминированно", () => {
    const mk = () =>
      world(5, 3, [unit(1, 0, 0, 1), unit(2, 1, 4, 1), unit(3, 2, 2, 0)], { seed: 777 });
    const o = [
      orders(0, move(1, line([0, 1], [2, 1]))),
      orders(1, move(2, line([4, 1], [2, 1]))),
      orders(2, move(3, line([2, 0], [2, 1]))),
    ];
    const r = resolveTurn(mk(), o, { conflict: "seeded" });
    const winners = r.state.units.filter((u) => u.x === 2 && u.y === 1);
    expect(winners).toHaveLength(1);
    const again = resolveTurn(mk(), o, { conflict: "seeded" });
    expect(again.state.units).toEqual(r.state.units);
  });

  it("радиус атаки — круг: (2,2) при range 3 допустимо (8 ≤ 9), (3,1) нет (10 > 9)", () => {
    const s = world(8, 8, [unit(1, 0, 0, 0, { range: 3 }), unit(2, 1, 2, 2), unit(3, 1, 3, 1)]);
    const ok = resolveTurn(s, [orders(0, attack(1, [2, 2]))]);
    expect(ok.rejected).toHaveLength(0);
    const far = resolveTurn(s, [orders(0, attack(1, [3, 1]))]);
    expect(far.rejected.map((r) => r.reason)).toEqual(["out-of-range"]);
  });

  it("диагональное пересечение «крестом» запрещено для обоих", () => {
    const s = world(2, 2, [unit(1, 0, 0, 0), unit(2, 1, 1, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 1]])), orders(1, move(2, [[0, 1]]))]);
    expect(at(r.state, 1)).toEqual([0, 0]);
    expect(at(r.state, 2)).toEqual([1, 0]);
    expect(r.events.filter((e) => e.t === "blocked").map((e) => (e as { reason: string }).reason)).toEqual([
      "cross",
      "cross",
    ]);
  });

  it("две параллельные диагонали не мешают друг другу", () => {
    const s = world(4, 4, [unit(1, 0, 0, 0), unit(2, 1, 0, 1)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 1]])), orders(1, move(2, [[1, 2]]))]);
    expect(at(r.state, 1)).toEqual([1, 1]);
    expect(at(r.state, 2)).toEqual([1, 2]);
  });

  it("обмен местами запрещён: оба остаются", () => {
    const s = world(3, 1, [unit(1, 0, 0, 0), unit(2, 1, 1, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 0]])), orders(1, move(2, [[0, 0]]))]);
    expect(at(r.state, 1)).toEqual([0, 0]);
    expect(at(r.state, 2)).toEqual([1, 0]);
    expect(r.events.every((e) => e.t !== "blocked" || e.reason === "swap")).toBe(true);
  });

  it("круг по часовой стрелке 2×2 блокируется целиком", () => {
    const s = world(2, 2, [unit(1, 0, 0, 0), unit(2, 1, 1, 0), unit(3, 2, 1, 1), unit(4, 3, 0, 1)]);
    const r = resolveTurn(s, [
      orders(0, move(1, [[1, 0]])),
      orders(1, move(2, [[1, 1]])),
      orders(2, move(3, [[0, 1]])),
      orders(3, move(4, [[0, 0]])),
    ]);
    expect(r.state.units.map((u) => [u.x, u.y])).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
    expect(r.events.filter((e) => e.t === "blocked")).toHaveLength(4);
  });

  it("«поезд»: цепочка юнитов едет вместе, если голова свободна", () => {
    const s = world(5, 1, [unit(1, 0, 0, 0), unit(2, 0, 1, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 0]]), move(2, [[2, 0]]))]);
    expect(at(r.state, 1)).toEqual([1, 0]);
    expect(at(r.state, 2)).toEqual([2, 0]);
  });

  it("поезд с заблокированной головой: каскадная остановка", () => {
    const s = world(5, 1, [unit(1, 0, 0, 0), unit(2, 0, 1, 0), unit(3, 1, 2, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 0]]), move(2, [[2, 0]]))]);
    expect(at(r.state, 1)).toEqual([0, 0]);
    expect(at(r.state, 2)).toEqual([1, 0]);
    const reasons = r.events.filter((e) => e.t === "blocked").map((e) => (e as { reason: string }).reason);
    expect(reasons).toEqual(["occupied", "occupied"]);
  });

  it("юнит, вышедший из клетки, освобождает её для другого в тот же подтик", () => {
    const s = world(4, 2, [unit(1, 0, 0, 0), unit(2, 1, 1, 0)]);
    const r = resolveTurn(s, [orders(0, move(1, [[1, 0]])), orders(1, move(2, [[2, 0]]))]);
    expect(at(r.state, 1)).toEqual([1, 0]);
    expect(at(r.state, 2)).toEqual([2, 0]);
  });
});

describe("свойства", () => {
  const randomScenario = (seed: number) => {
    const r = rng(seed);
    const W = 8;
    const H = 8;
    const cells = shuffled(
      Array.from({ length: W * H }, (_, i) => [i % W, Math.floor(i / W)] as const),
      r,
    );
    const units = Array.from({ length: 14 }, (_, i) =>
      unit(i + 1, i % 3, cells[i]![0], cells[i]![1], { move: 6, range: 3, hp: 1 + Math.floor(r() * 10) }),
    );
    const s = world(W, H, units, { seed: Math.floor(r() * 1e9) });
    for (let i = 0; i < s.terrain.length; i++) {
      const v = r();
      s.terrain[i] = v < 0.1 ? Terrain.Blocked : v < 0.3 ? Terrain.Road : Terrain.Plain;
    }
    // юниты не стоят на стенах
    for (const u of units) if (s.terrain[u.y * W + u.x] === Terrain.Blocked) s.terrain[u.y * W + u.x] = Terrain.Plain;
    const perPlayer: PlayerOrders[] = [0, 1, 2].map((p) => ({ player: p, orders: [] }));
    for (const u of units) {
      const roll = r();
      if (roll < 0.55) {
        const { cost, prev } = reachable(s, [u.x, u.y], moveBudget(u));
        const reach = [...cost.keys()].filter((k) => k !== u.y * W + u.x);
        if (reach.length === 0) continue;
        const dest = reach[Math.floor(r() * reach.length)]!;
        const path: [number, number][] = [];
        let cur = dest;
        while (cur !== u.y * W + u.x) {
          path.push([cur % W, Math.floor(cur / W)]);
          cur = prev.get(cur)!;
        }
        perPlayer[u.owner]!.orders.push(move(u.id, path.reverse()));
      } else if (roll < 0.8) {
        const dx = Math.floor(r() * 7) - 3;
        const dy = Math.floor(r() * 7) - 3;
        const tx = u.x + dx;
        const ty = u.y + dy;
        if (dx * dx + dy * dy >= 1 && dx * dx + dy * dy <= 9 && tx >= 0 && ty >= 0 && tx < W && ty < H)
          perPlayer[u.owner]!.orders.push(attack(u.id, [tx, ty]));
      } else if (roll < 0.9) {
        perPlayer[u.owner]!.orders.push(defend(u.id));
      }
    }
    return { s, perPlayer, r };
  };

  const canon = (res: ReturnType<typeof resolveTurn>) => JSON.stringify({ s: res.state.units, e: res.events, x: res.stats });

  for (const conflict of ["bounce", "seeded"] as const) {
    for (const order of ["attacks-first", "move-first"] as const) {
      it(`результат не зависит от порядка входных массивов (${conflict}, ${order}), 300 случайных ходов`, () => {
        for (let seed = 1; seed <= 300; seed++) {
          const { s, perPlayer, r } = randomScenario(seed);
          const base = resolveTurn(s, perPlayer, { conflict, order });
          const s2 = { ...s, units: shuffled(s.units, r) };
          const o2 = shuffled(perPlayer, r);
          const other = resolveTurn(s2, o2, { conflict, order });
          expect(canon(other), `seed ${seed}`).toBe(canon(base));
        }
      });
    }
  }

  it("лог полон: applyEvents(начальное состояние, лог) == итоговое состояние (300 случайных ходов)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      for (const order of ["attacks-first", "move-first"] as const) {
        const res = resolveTurn(s, perPlayer, { order });
        expect(applyEvents(s, res.events).units, `seed ${seed} ${order}`).toEqual(res.state.units);
      }
    }
  });

  it("после каждого хода не больше одного юнита на клетку", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      const res = resolveTurn(s, perPlayer);
      const seen = new Set(res.state.units.map((u) => u.y * s.w + u.x));
      expect(seen.size, `seed ${seed}`).toBe(res.state.units.length);
    }
  });

  it("в одном подтике у двух шагов нет общей середины: нет ни обмена местами, ни креста (300 ходов)", () => {
    let crossesSeen = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      for (const conflict of ["bounce", "seeded"] as const) {
        const res = resolveTurn(s, perPlayer, { conflict });
        const mids = new Map<string, number>();
        for (const e of res.events) {
          if (e.t === "blocked" && e.reason === "cross") crossesSeen++;
          if (e.t !== "step" || !e.from || !e.to) continue;
          const key = `${e.tick}:${e.from[0] + e.to[0]},${e.from[1] + e.to[1]}`;
          expect(mids.has(key), `seed ${seed} ${conflict}: шаги ${mids.get(key)} и ${e.unit} делят середину ${key}`).toBe(false);
          mids.set(key, e.unit);
        }
      }
    }
    // страховка от «зелёного по пустоте»: правило креста должно реально срабатывать на этих сценариях
    expect(crossesSeen).toBeGreaterThan(0);
  });

  it("повторный запуск даёт байт-в-байт тот же результат", () => {
    const { s, perPlayer } = randomScenario(42);
    expect(canon(resolveTurn(s, perPlayer))).toBe(canon(resolveTurn(s, perPlayer)));
  });
});

// чтобы импорт Ev не считался неиспользуемым при verbatimModuleSyntax
export type _Ev = Ev;
