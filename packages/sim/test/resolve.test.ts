import { describe, expect, it } from "vitest";
import { applyEvents, previewMove, resolveTurn, SCALE, Terrain, TERRAIN_CELL } from "../src/index.ts";
import type { AttackTiming, PlayerOrders, State } from "../src/index.ts";
import { attack, defend, move, orders, posOf, pt, rng, shuffled, unit, world } from "./helpers.ts";

describe("движение: скорость, рельеф, маршрут", () => {
  it("за ход юнит проходит speed × тики пунктов по равнине", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10)]);
    const r = resolveTurn(s, [orders(0, move([1], pt(20, 10)))]);
    expect(posOf(r.state, 1)).toEqual([1300, 1000]);
  });

  it("дорога вдвое быстрее, бездорожье медленнее (60%)", () => {
    const road = world(40, 40, [unit(1, 0, 10, 10)]);
    road.terrain.fill(Terrain.Road);
    expect(posOf(resolveTurn(road, [orders(0, move([1], pt(30, 10)))]).state, 1)).toEqual([1600, 1000]);
    const rough = world(40, 40, [unit(1, 0, 10, 10)]);
    rough.terrain.fill(Terrain.Rough);
    // 30 × 60% = 18 пунктов за тик, 10 тиков
    expect(posOf(resolveTurn(rough, [orders(0, move([1], pt(30, 10)))]).state, 1)).toEqual([1180, 1000]);
  });

  it("ломаная: излом проходится без потери скорости; недоход останавливает ровно на бюджете", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10)]);
    const r = resolveTurn(s, [orders(0, move([1], pt(11, 10), pt(11, 12)))]); // 100 + 200 = 300 = бюджет
    expect(posOf(r.state, 1)).toEqual([1100, 1200]);
    const far = resolveTurn(s, [orders(0, move([1], pt(11, 10), pt(11, 30)))]);
    expect(posOf(far.state, 1)).toEqual([1100, 1200]); // дальше хода не прошёл
  });

  it("превью маршрута совпадает с исполнением для одинокого юнита", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10)]);
    s.terrain.fill(Terrain.Plain);
    const path = [pt(14, 10), pt(14, 14)];
    const trace = previewMove(s, s.units, path)[0]!;
    const r = resolveTurn(s, [orders(0, move([1], ...path))]);
    expect(trace[trace.length - 1]).toEqual(posOf(r.state, 1));
    expect(trace).toHaveLength(11); // начальная точка + 10 тиков
  });

  it("стена — твёрдое тело: юнит упирается в неё вплотную (радиус 50), сквозь не проходит", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10)]);
    for (let y = 0; y < s.th; y++) s.terrain[y * s.tw + 6] = Terrain.Blocked; // x ∈ [1200, 1400)
    const r = resolveTurn(s, [orders(0, move([1], pt(30, 10)))]);
    expect(posOf(r.state, 1)).toEqual([1150, 1000]);
  });

  it("центр оказался в непроходимой клетке из-за собственного шага: остановка и событие blocked", () => {
    // скорость 400 за тик перепрыгивает зону выталкивания; центр попадает в стену — юнит останавливается
    const s = world(40, 40, [unit(1, 0, 10, 10, { speed: 150, radius: 10 })]);
    for (let y = 0; y < s.th; y++) s.terrain[y * s.tw + 6] = Terrain.Blocked; // x ∈ [1200, 1400)
    const r = resolveTurn(s, [orders(0, move([1], pt(30, 10)))]);
    const b = r.events.find((e) => e.t === "blocked");
    expect(b).toMatchObject({ unit: 1, reason: "terrain" });
    expect(posOf(r.state, 1)![0]).toBeLessThan(1200);
  });
});

describe("валидация приказов, группы и AP", () => {
  it("плохие маршруты: пустой, за картой, слишком много точек", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10)]);
    const reasons = (path: ReturnType<typeof pt>[]) =>
      resolveTurn(s, [orders(0, move([1], ...path))]).rejected.map((x) => x.reason);
    expect(reasons([])).toEqual(["bad-path"]);
    expect(reasons([pt(50, 10)])).toEqual(["bad-path"]);
    expect(reasons(Array.from({ length: 17 }, (_, i) => pt(11 + (i % 3), 10)))).toEqual(["bad-path"]);
  });

  it("группа из 5 стоит 1 AP; второй приказ при ap=1 отклоняется; оборона бесплатна", () => {
    const us = Array.from({ length: 6 }, (_, i) => unit(i + 1, 0, 10 + i * 2, 10));
    const s = world(60, 40, us);
    s.players[0]!.ap = 1;
    const r = resolveTurn(s, [orders(0, move([1, 2, 3, 4, 5], pt(15, 20)), move([6], pt(20, 20)), defend([6]))]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["no-ap"]);
    expect(posOf(r.state, 6)).toEqual(pt(20, 10)); // приказ движения не прошёл, юнит стоит
  });

  it("группа больше maxGroup, чужие и дубли отклоняются целиком", () => {
    const us = [...Array.from({ length: 8 }, (_, i) => unit(i + 1, 0, 5 + i * 2, 5)), unit(20, 1, 30, 30)];
    const s = world(60, 60, us);
    const run = (...o: PlayerOrders[]) => resolveTurn(s, o).rejected.map((x) => x.reason);
    expect(run(orders(0, move([1, 2, 3, 4, 5, 6, 7], pt(10, 20))))).toEqual(["group-too-big"]);
    expect(run(orders(0, move([1, 20], pt(10, 20))))).toEqual(["not-owner"]);
    expect(run(orders(0, move([1, 1], pt(10, 20))))).toEqual(["duplicate"]);
    expect(run(orders(0, move([1, 2], pt(10, 20)), attack([2], pt(8, 5))))).toEqual(["duplicate"]);
    expect(run(orders(0, move([], pt(10, 20))))).toEqual(["empty-group"]);
    expect(run(orders(0, move([99], pt(10, 20))))).toEqual(["unknown-unit"]);
    expect(run(orders(0, attack([1], pt(30, 5))))).toEqual(["out-of-range"]);
  });

  it("группа сохраняет построение и идёт со скоростью самого медленного", () => {
    const us = [unit(1, 0, 10, 10), unit(2, 0, 11.5, 10, { speed: 20 }), unit(3, 0, 10, 11.5), unit(4, 0, 11.5, 11.5)];
    const s = world(60, 40, us);
    const r = resolveTurn(s, [orders(0, move([1, 2, 3, 4], pt(25, 11)))]);
    // все прошли по 200 (20 × 10 тиков), построение сохранено в точности
    expect(r.state.units.map((u) => [u.x, u.y])).toEqual([
      [1200, 1000],
      [1350, 1000],
      [1200, 1150],
      [1350, 1150],
    ]);
  });
});

describe("тела расталкиваются, а не проходят друг сквозь друга", () => {
  it("лоб в лоб строго по прямой: оба остановились вплотную, симметрично, никто не прошёл", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10), unit(2, 1, 14, 10)]);
    const r = resolveTurn(s, [orders(0, move([1], pt(14, 10))), orders(1, move([2], pt(10, 10)))]);
    const a = posOf(r.state, 1)!;
    const b = posOf(r.state, 2)!;
    expect(a[0] + b[0]).toBe(2400); // зеркально относительно середины
    expect(a[0]).toBeLessThan(b[0]);
    expect(b[0] - a[0]).toBeGreaterThanOrEqual(98); // вплотную: сумма радиусов 100
    expect(a[1]).toBe(1000);
    expect(r.stats.maxOverlap).toBeLessThanOrEqual(2);
  });

  it("движущийся упирается в стоящего, стоящий не сдвигается ни на пункт", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10), unit(2, 1, 12, 10)]);
    const r = resolveTurn(s, [orders(0, move([1], pt(16, 10))), orders(1, defend([2]))]);
    expect(posOf(r.state, 2)).toEqual(pt(12, 10));
    expect(posOf(r.state, 1)![0]).toBeLessThanOrEqual(1100 + 2);
  });

  it("со смещением в полрадиуса тела скользят друг мимо друга и не остаются внутри друг друга", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10), unit(2, 1, 14, 10.3)]);
    const r = resolveTurn(s, [orders(0, move([1], pt(14, 10))), orders(1, move([2], pt(10, 10.3)))]);
    expect(r.stats.maxOverlap).toBeLessThanOrEqual(10);
  });
});

describe("атака: время залпа решает, можно ли уйти от выстрела", () => {
  // A (игрок 0) бьёт по точке (12,10), где стоит B; B за ход уходит на юг на 3 единицы.
  const setup = () =>
    world(40, 40, [unit(1, 0, 10, 10, { aoe: 25 }), unit(2, 1, 12, 10)]);
  const plan = [orders(0, attack([1], pt(12, 10))), orders(1, move([2], pt(12, 15)))];
  const hpOf = (s: State, id: number) => s.units.find((u) => u.id === id)!.hp;

  it("start: уйти нельзя, полный урон начала хода", () => {
    const r = resolveTurn(setup(), plan, { attackTiming: "start" });
    expect(hpOf(r.state, 2)).toBe(60);
  });

  it("end: ушедший не пострадал, выстрел «мимо»", () => {
    const r = resolveTurn(setup(), plan, { attackTiming: "end" });
    expect(hpOf(r.state, 2)).toBe(100);
    expect(r.events.some((e) => e.t === "miss")).toBe(true);
  });

  it("zone: цель, прошедшая зону, получает часть урона (3 тика × 4 из 10)", () => {
    const r = resolveTurn(setup(), plan, { attackTiming: "zone" });
    expect(hpOf(r.state, 2)).toBe(88);
  });

  it("zone: оборона режет урон на тик (4 → 2), а стоящий в зоне весь ход получает 10 попаданий", () => {
    const stay = world(40, 40, [unit(1, 0, 10, 10), unit(2, 1, 12, 10)]);
    const open = resolveTurn(stay, [orders(0, attack([1], pt(12, 10)))], { attackTiming: "zone" });
    const guarded = resolveTurn(stay, [orders(0, attack([1], pt(12, 10))), orders(1, defend([2]))], { attackTiming: "zone" });
    expect(hpOf(open.state, 2)).toBe(60);
    expect(hpOf(guarded.state, 2)).toBe(80);
  });

  it("start: взаимное убийство — убитые успевают выстрелить", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10, { hp: 30 }), unit(2, 1, 12, 10, { hp: 30 })]);
    const r = resolveTurn(s, [orders(0, attack([1], pt(12, 10))), orders(1, attack([2], pt(10, 10)))], { attackTiming: "start" });
    expect(r.state.units).toHaveLength(0);
  });

  it("start: фокус тремя стрелками по юниту с 50 hp — 70 урона зря (overkill)", () => {
    const s = world(40, 40, [
      unit(1, 0, 10, 10),
      unit(2, 0, 10, 12),
      unit(3, 0, 10, 14),
      unit(9, 1, 12, 12, { hp: 50, aoe: 0 }),
    ]);
    const r = resolveTurn(s, [orders(0, attack([1], pt(12, 12)), attack([2], pt(12, 12)), attack([3], pt(12, 12)))], {
      attackTiming: "start",
    });
    expect(r.state.units.find((u) => u.id === 9)).toBeUndefined();
    expect(r.stats.hits).toBe(3);
    expect(r.stats.overkill).toBe(70);
  });

  it("убитый в зоне больше не двигается и не стреляет", () => {
    const s = world(40, 40, [unit(1, 0, 10, 10, { dmg: 400 }), unit(2, 1, 12, 10, { hp: 30 })]);
    const r = resolveTurn(s, [orders(0, attack([1], pt(12, 10))), orders(1, move([2], pt(12, 20)))], { attackTiming: "zone" });
    expect(r.state.units.map((u) => u.id)).toEqual([1]);
    expect(r.events.some((e) => e.t === "step")).toBe(false);
  });
});

describe("свойства (случайные сценарии)", () => {
  const MAP = 30;
  const randomScenario = (seed: number, apLimit = 99) => {
    const r = rng(seed);
    const players = 3;
    const us = [] as ReturnType<typeof unit>[];
    let id = 1;
    for (let p = 0; p < players; p++) {
      let placed = 0;
      let guard = 0;
      while (placed < 8 && guard++ < 500) {
        const x = 1 + r() * (MAP - 2);
        const y = 1 + r() * (MAP - 2);
        if (us.some((u) => (u.x - x * SCALE) ** 2 + (u.y - y * SCALE) ** 2 < 110 * 110)) continue;
        us.push(
          unit(id++, p, x, y, {
            hp: 20 + Math.floor(r() * 130),
            speed: 20 + Math.floor(r() * 21),
            aoe: Math.floor(r() * 40),
          }),
        );
        placed++;
      }
    }
    const s = world(MAP, MAP, us, { maxGroup: 4 });
    for (let i = 0; i < s.terrain.length; i++) {
      const v = r();
      s.terrain[i] = v < 0.08 ? Terrain.Blocked : v < 0.28 ? Terrain.Road : v < 0.38 ? Terrain.Rough : Terrain.Plain;
    }
    for (const u of us) s.terrain[Math.floor(u.y / TERRAIN_CELL) * s.tw + Math.floor(u.x / TERRAIN_CELL)] = Terrain.Plain;
    for (const p of s.players) p.ap = apLimit;

    const perPlayer: PlayerOrders[] = [];
    for (let p = 0; p < players; p++) {
      const mine = shuffled(us.filter((u) => u.owner === p), r);
      const list: PlayerOrders["orders"] = [];
      while (mine.length) {
        const g = mine.splice(0, 1 + Math.floor(r() * 3));
        const ids = g.map((u) => u.id);
        const roll = r();
        if (roll < 0.55) {
          const n = 1 + Math.floor(r() * 3);
          const path = Array.from({ length: n }, () => pt(r() * MAP, r() * MAP));
          list.push(move(ids, ...path));
        } else if (roll < 0.8) {
          const first = g[0]!;
          const at: [number, number] = [first.x + Math.round((r() - 0.5) * 400), first.y + Math.round((r() - 0.5) * 400)];
          list.push(attack(ids, at));
        } else if (roll < 0.9) {
          list.push(defend(ids));
        }
      }
      perPlayer.push({ player: p, orders: list });
    }
    return { s, perPlayer, r };
  };

  const canon = (res: ReturnType<typeof resolveTurn>) =>
    JSON.stringify({ u: res.state.units, e: res.events, x: res.stats, rj: [...res.rejected].map((q) => [q.player, q.reason, [...q.units].sort()]).sort() });

  const TIMINGS: AttackTiming[] = ["start", "zone", "end"];

  for (const timing of TIMINGS) {
    it(`результат не зависит от порядка входных массивов (${timing}), 150 случайных ходов`, () => {
      for (let seed = 1; seed <= 150; seed++) {
        const { s, perPlayer, r } = randomScenario(seed);
        const base = resolveTurn(s, perPlayer, { attackTiming: timing });
        // тасуем юнитов и приказы между игроками; порядок приказов ВНУТРИ списка игрока сохраняем
        const other = resolveTurn({ ...s, units: shuffled(s.units, r) }, shuffled(perPlayer, r), { attackTiming: timing });
        expect(canon(other), `seed ${seed}`).toBe(canon(base));
      }
    });
  }

  it("лог полон: applyEvents(начальное, лог) == итоговое состояние (150 ходов × 3 режима)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      for (const timing of TIMINGS) {
        const res = resolveTurn(s, perPlayer, { attackTiming: timing });
        expect(applyEvents(s, res.events).units, `seed ${seed} ${timing}`).toEqual(res.state.units);
      }
    }
  });

  it("все юниты остаются в карте, вне стен и почти не перекрываются (разреженные сценарии)", () => {
    let worst = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      const res = resolveTurn(s, perPlayer);
      worst = Math.max(worst, res.stats.maxOverlap);
      for (const u of res.state.units) {
        expect(u.x >= u.radius && u.y >= u.radius && u.x <= s.w - u.radius && u.y <= s.h - u.radius, `seed ${seed}`).toBe(true);
      }
    }
    // допуск: в плотных схватках остаётся небольшое остаточное перекрытие (четыре прохода расталкивания)
    expect(worst).toBeLessThanOrEqual(40);
  });

  it("лимит AP: при ap=3 принято не больше трёх платных приказов на игрока, порядок входа не важен", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { s, perPlayer, r } = randomScenario(seed, 3);
      const res = resolveTurn(s, perPlayer);
      for (const po of perPlayer) {
        const paid = po.orders.filter((o) => o.kind !== "defend").length;
        const rejected = res.rejected.filter((q) => q.player === po.player).length;
        expect(paid - rejected, `seed ${seed} player ${po.player}`).toBeLessThanOrEqual(3);
      }
      const other = resolveTurn({ ...s, units: shuffled(s.units, r) }, shuffled(perPlayer, r));
      expect(canon(other), `seed ${seed}`).toBe(canon(res));
    }
  });

  it("повторный запуск даёт тот же результат бит в бит", () => {
    const { s, perPlayer } = randomScenario(42);
    expect(canon(resolveTurn(s, perPlayer))).toBe(canon(resolveTurn(s, perPlayer)));
  });
});
