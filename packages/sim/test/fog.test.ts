import { describe, expect, it } from "vitest";
import { filterEventsFor, resolveTurn, visibleUnits } from "../src/index.ts";
import { attack, move, orders, pt, unit, world } from "./helpers.ts";

describe("туман войны: фильтр лога", () => {
  it("далёкое движение врага не попадает в лог игрока вообще", () => {
    const s = world(60, 20, [unit(1, 0, 1, 10), unit(2, 1, 40, 10)]);
    const r = resolveTurn(s, [orders(1, move([2], pt(35, 10)))]);
    expect(r.events.length).toBeGreaterThan(0);
    expect(filterEventsFor(s, r.events, 0)).toEqual([]);
  });

  it("враг входит в обзор: видна только видимая часть, невидимое начало вырезано в null", () => {
    // игрок 0 стоит в (5,10), обзор 5 единиц (500). Враг идёт с x=12 к x=9 по 30 пунктов за тик.
    const s = world(60, 20, [unit(1, 0, 5, 10), unit(2, 1, 12, 10)]);
    const r = resolveTurn(s, [orders(1, move([2], pt(8, 10)))]);
    const f = filterEventsFor(s, r.events, 0);
    const steps = f.filter((e) => e.t === "step");
    // позиции после тика k: 1200 − 30k; граница обзора x ≤ 1000 достигается на тике 7 (990)
    expect(steps.map((e) => e.tick)).toEqual([7, 8, 9, 10]);
    const first = steps[0]!;
    expect(first.t === "step" && first.from).toBeNull();
    expect(first.t === "step" && first.to).toEqual([990, 1000]);
  });

  it("события со своим юнитом идут целиком, даже когда стрелок в тумане", () => {
    const s = world(60, 20, [unit(1, 0, 5, 10, { vision: 100 }), unit(2, 1, 8, 10, { aoe: 25 })]);
    const r = resolveTurn(s, [orders(1, attack([2], pt(5, 10)))], { attackTiming: "start" });
    const hit = filterEventsFor(s, r.events, 0).find((e) => e.t === "attack");
    expect(hit).toBeDefined();
    expect(hit!.t === "attack" && hit!.from).toEqual(pt(8, 10)); // свой ранен — стрелок известен
  });

  it("бой вдали от игрока 0 невидим для него, но виден участнику", () => {
    const s = world(80, 20, [unit(1, 0, 2, 10), unit(2, 1, 50, 10), unit(3, 2, 52, 10)]);
    const r = resolveTurn(s, [orders(1, attack([2], pt(52, 10)))], { attackTiming: "start" });
    expect(filterEventsFor(s, r.events, 0)).toEqual([]);
    expect(filterEventsFor(s, r.events, 2).some((e) => e.t === "attack")).toBe(true);
  });

  it("visibleUnits: чужие в круге обзора видны, дальние нет, свои всегда", () => {
    const s = world(60, 20, [unit(1, 0, 5, 10), unit(2, 1, 9, 10), unit(3, 1, 11, 10), unit(4, 0, 55, 10, { vision: 0 })]);
    expect(visibleUnits(s, 0).map((u) => u.id)).toEqual([1, 2, 4]);
  });
});
