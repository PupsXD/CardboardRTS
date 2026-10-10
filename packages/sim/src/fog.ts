import { dist2 } from "./geom.ts";
import { MAX_VISION } from "./types.ts";
import type { Ev, PlayerId, Point, State, Unit, UnitId } from "./types.ts";

const key = (cx: number, cy: number): number => (cx + 1) * 8192 + (cy + 1);

/** Индекс обзора игрока: его юниты, разложенные по сетке шага MAX_VISION. */
type VisionIndex = Map<number, Unit[]>;

function buildIndex(units: Iterable<Unit>, player: PlayerId): VisionIndex {
  const idx: VisionIndex = new Map();
  for (const u of units) {
    if (u.owner !== player) continue;
    const k = key(Math.floor(u.x / MAX_VISION), Math.floor(u.y / MAX_VISION));
    const list = idx.get(k);
    if (list) list.push(u);
    else idx.set(k, [u]);
  }
  return idx;
}

function sees(idx: VisionIndex, x: number, y: number): boolean {
  const cx = Math.floor(x / MAX_VISION);
  const cy = Math.floor(y / MAX_VISION);
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) {
      for (const u of idx.get(key(cx + ox, cy + oy)) ?? []) {
        if (dist2(u.x, u.y, x, y) <= u.vision * u.vision) return true;
      }
    }
  }
  return false;
}

/** Юниты, которых игрок видит в данном состоянии (свои — всегда). Зона обзора — круги вокруг его юнитов. */
export function visibleUnits(state: State, player: PlayerId): Unit[] {
  const idx = buildIndex(state.units, player);
  return state.units.filter((u) => u.owner === player || sees(idx, u.x, u.y));
}

/**
 * Лог хода глазами игрока. Правила:
 *  - события со своим юнитом (как стороной или целью) идут целиком;
 *  - чужие — только если хотя бы одна их точка в зоне обзора игрока в начале или конце тика;
 *  - невидимый конец вырезается в null (юнит «исчез» / «появился»), чтобы не выдавать точку за краем обзора.
 */
export function filterEventsFor(initial: State, events: readonly Ev[], player: PlayerId): Ev[] {
  const pos = new Map<UnitId, Unit>();
  for (const u of initial.units) pos.set(u.id, { ...u });
  const own = (id: UnitId) => pos.get(id)?.owner === player;
  const out: Ev[] = [];

  let i = 0;
  while (i < events.length) {
    const tick = events[i]!.tick;
    let j = i;
    while (j < events.length && events[j]!.tick === tick) j++;
    const group = events.slice(i, j);
    i = j;

    const idx0 = buildIndex(pos.values(), player);
    // Позиции после тика: двигаем; погибших убираем только после расчёта индекса, чтобы свои погибшие «видели» выстрел.
    for (const e of group) {
      if (e.t === "step" && e.to) {
        const u = pos.get(e.unit)!;
        u.x = e.to[0];
        u.y = e.to[1];
      }
    }
    const idx1 = buildIndex(pos.values(), player);
    const vis = (p: Point | null): boolean => p !== null && (sees(idx0, p[0], p[1]) || sees(idx1, p[0], p[1]));

    for (const e of group) {
      switch (e.t) {
        case "step": {
          if (own(e.unit)) {
            out.push(e);
            break;
          }
          const fv = vis(e.from);
          const tv = vis(e.to);
          if (!fv && !tv) break;
          out.push({ ...e, from: fv ? e.from : null, to: tv ? e.to : null });
          break;
        }
        case "attack": {
          if (own(e.attacker) || own(e.target)) {
            out.push(e);
            break;
          }
          if (!vis(e.from) && !vis(e.at)) break;
          out.push({ ...e, from: vis(e.from) ? e.from : null });
          break;
        }
        case "miss": {
          if (own(e.attacker)) {
            out.push(e);
            break;
          }
          if (!vis(e.from) && !vis(e.at)) break;
          out.push({ ...e, from: vis(e.from) ? e.from : null });
          break;
        }
        case "death":
        case "blocked": {
          if (own(e.unit) || vis(e.at)) out.push(e);
          break;
        }
      }
    }
    for (const e of group) if (e.t === "death") pos.delete(e.unit);
  }
  return out;
}
