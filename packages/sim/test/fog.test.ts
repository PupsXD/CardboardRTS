import { describe, expect, it } from "vitest";
import { filterEventsFor, filterEventsForAll, resolveTurn, visibleUnits } from "../src/index.ts";
import { attack, move, orders, pt, unit, world } from "./helpers.ts";
import { randomScenario } from "./scenario.ts";

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

describe("туман: общий проход и неинтерференция", () => {
  const players = [0, 1, 2];

  it("filterEventsForAll совпадает с filterEventsFor для каждого игрока (150 случайных ходов × 3 режима)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const { s, perPlayer } = randomScenario(seed);
      for (const timing of ["start", "zone", "end"] as const) {
        const res = resolveTurn(s, perPlayer, { attackTiming: timing });
        const all = filterEventsForAll(s, res.events, players);
        for (const p of players) {
          expect(all.get(p), `seed ${seed} ${timing} игрок ${p}`).toEqual(filterEventsFor(s, res.events, p));
        }
      }
    }
  });

  /** Позиции всех юнитов на каждом тике (индекс 0 — начало хода). */
  const snapshots = (s: ReturnType<typeof randomScenario>["s"], events: ReturnType<typeof resolveTurn>["events"]) => {
    const cur = new Map(s.units.map((u) => [u.id, [u.x, u.y] as [number, number]]));
    const out = [new Map(cur)];
    const ticks = Math.max(0, ...events.map((e) => e.tick));
    for (let t = 1; t <= ticks; t++) {
      for (const e of events) if (e.tick === t && e.t === "step" && e.to) cur.set(e.unit, [e.to[0], e.to[1]]);
      out.push(new Map(cur));
    }
    return out;
  };

  it("неинтерференция: приказы далёких невидимых юнитов не меняют ни лог игрока, ни видимое им состояние", () => {
    let trials = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const { s, perPlayer } = randomScenario(seed, 99, 70); // карта больше, чтобы нашлись далёкие юниты
      const base = resolveTurn(s, perPlayer);
      const snaps = snapshots(s, base.events);
      const ownerOf = new Map(s.units.map((u) => [u.id, u.owner]));
      const visionOf = new Map(s.units.map((u) => [u.id, u.vision]));

      for (const p of players) {
        const mine = s.units.filter((u) => u.owner === p).map((u) => u.id);
        // юнит X «далёкий» для игрока p: на всех тиках дальше (обзор + 700) от каждого юнита p на любом тике
        const remote = (x: number): boolean =>
          ownerOf.get(x) !== p &&
          snaps.every((a) =>
            mine.every((m) =>
              snaps.every((b) => {
                const xa = a.get(x);
                const mb = b.get(m);
                if (!xa || !mb) return true;
                const lim = visionOf.get(m)! + 700;
                return (xa[0] - mb[0]) ** 2 + (xa[1] - mb[1]) ** 2 > lim * lim;
              }),
            ),
          );
        let dropped = 0;
        const modified = perPlayer.map((po) => ({
          player: po.player,
          orders: po.orders.filter((o) => {
            if (o.kind === "defend") return true;
            if (o.units.every(remote)) {
              dropped++;
              return false; // юниты остаются на месте
            }
            return true;
          }),
        }));
        if (dropped === 0) continue;
        trials++;
        const mod = resolveTurn(s, modified);
        expect(filterEventsFor(s, mod.events, p), `seed ${seed} игрок ${p}: лог`).toEqual(filterEventsFor(s, base.events, p));
        const view = (st: typeof s) => visibleUnits(st, p).map((u) => [u.id, u.x, u.y, u.hp]);
        expect(view(mod.state), `seed ${seed} игрок ${p}: состояние`).toEqual(view(base.state));
      }
    }
    expect(trials).toBeGreaterThan(40); // страховка от «зелёного по пустоте»
  });
});
