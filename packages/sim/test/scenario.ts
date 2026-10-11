import { SCALE, Terrain, TERRAIN_CELL } from "../src/index.ts";
import type { PlayerOrders } from "../src/index.ts";
import { attack, defend, move, pt, rng, shuffled, unit, world } from "./helpers.ts";

/** Случайный разреженный сценарий: 3 игрока по 8 юнитов, группы 1–3, случайный рельеф. Воспроизводим по seed. */
export const DEFAULT_MAP = 30;
export const randomScenario = (seed: number, apLimit = 99, MAP = DEFAULT_MAP) => {
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
