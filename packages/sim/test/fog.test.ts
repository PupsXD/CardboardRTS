import { describe, expect, it } from "vitest";
import { filterEventsFor, resolveTurn, visibleUnits } from "../src/index.ts";
import { attack, line, move, orders, unit, world } from "./helpers.ts";

describe("туман войны: фильтр лога", () => {
  const base = () => world(30, 1, [unit(1, 0, 0, 0, { vision: 3 }), unit(2, 1, 12, 0)], { seed: 1 });

  it("далёкое движение врага не попадает в лог игрока вообще", () => {
    const s = base();
    const r = resolveTurn(s, [orders(1, move(2, line([12, 0], [9, 0])))]);
    expect(r.events.length).toBeGreaterThan(0);
    expect(filterEventsFor(s, r.events, 0)).toEqual([]);
  });

  it("враг входит в обзор: видна только видимая часть, невидимый конец вырезан", () => {
    const s = world(30, 1, [unit(1, 0, 0, 0, { vision: 3 }), unit(2, 1, 6, 0, { move: 12 })], { seed: 1 });
    // враг идёт (6)->(5)->(4)->(3)->(2): обзор игрока 0 — клетки x<=3
    const r = resolveTurn(s, [orders(1, move(2, line([6, 0], [2, 0])))]);
    const f = filterEventsFor(s, r.events, 0);
    const steps = f.filter((e) => e.t === "step");
    // шаги 6->5 и 5->4 целиком вне обзора, 4->3 уже частично виден
    expect(steps.map((e) => e.t === "step" && e.tick)).toEqual([3, 4]);
    const first = steps[0]!;
    expect(first.t === "step" && first.from).toBeNull(); // «появился» из тумана
    expect(first.t === "step" && first.to).toEqual([3, 0]);
  });

  it("события со своим юнитом идут целиком, даже в тумане", () => {
    const s = world(30, 1, [unit(1, 0, 0, 0, { vision: 1, range: 3 }), unit(2, 1, 3, 0)]);
    const r = resolveTurn(s, [orders(1, attack(2, [0, 0]))]);
    const f = filterEventsFor(s, r.events, 0);
    const hit = f.find((e) => e.t === "attack");
    expect(hit).toBeDefined();
    expect(hit!.t === "attack" && hit!.from).toEqual([3, 0]); // свой юнит ранен — стрелок известен
  });

  it("бой вдали от игрока 0 невидим для него, но виден участнику", () => {
    const s = world(40, 1, [unit(1, 0, 0, 0), unit(2, 1, 30, 0), unit(3, 2, 32, 0)]);
    const r = resolveTurn(s, [orders(1, attack(2, [32, 0]))]);
    expect(filterEventsFor(s, r.events, 0)).toEqual([]);
    expect(filterEventsFor(s, r.events, 2).some((e) => e.t === "attack")).toBe(true);
  });

  it("visibleUnits: чужие в обзоре видны, дальние — нет, свои всегда", () => {
    const s = world(30, 1, [unit(1, 0, 0, 0, { vision: 3 }), unit(2, 1, 3, 0), unit(3, 1, 4, 0), unit(4, 0, 29, 0, { vision: 0 })]);
    expect(visibleUnits(s, 0).map((u) => u.id)).toEqual([1, 2, 4]);
  });
});
