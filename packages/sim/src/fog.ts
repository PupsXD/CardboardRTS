import type { Cell, Ev, PlayerId, State, Unit, UnitId } from "./types.ts";

/** Маска клеток, которые видит игрок (круг евклидова радиуса вокруг каждого его юнита). */
export function fillVision(w: number, h: number, units: Iterable<Unit>, player: PlayerId, out: Uint8Array): void {
  out.fill(0);
  for (const u of units) {
    if (u.owner !== player) continue;
    const r = u.vision;
    for (let dy = -r; dy <= r; dy++) {
      const y = u.y + dy;
      if (y < 0 || y >= h) continue;
      const span = Math.floor(Math.sqrt(r * r - dy * dy));
      const x0 = Math.max(0, u.x - span);
      const x1 = Math.min(w - 1, u.x + span);
      out.fill(1, y * w + x0, y * w + x1 + 1);
    }
  }
}

/** Юниты, которых игрок видит в данном состоянии (свои — всегда). */
export function visibleUnits(state: State, player: PlayerId): Unit[] {
  const mask = new Uint8Array(state.w * state.h);
  fillVision(state.w, state.h, state.units, player, mask);
  return state.units.filter((u) => u.owner === player || mask[u.y * state.w + u.x] === 1);
}

/**
 * Лог хода, каким его видит игрок. Правила:
 *  - события со своим юнитом (как стороной или целью) идут целиком;
 *  - чужие события — только если хотя бы одна их клетка в зоне видимости игрока в начале или конце подтика;
 *  - невидимый конец редактируется в null (юнит «исчез»/«появился»), чтобы не выдавать клетку за краем обзора.
 */
export function filterEventsFor(initial: State, events: readonly Ev[], player: PlayerId): Ev[] {
  const w = initial.w;
  const h = initial.h;
  const pos = new Map<UnitId, Unit>();
  for (const u of initial.units) pos.set(u.id, { ...u });
  const own = (id: UnitId) => pos.get(id)?.owner === player;

  const m0 = new Uint8Array(w * h);
  const m1 = new Uint8Array(w * h);
  const out: Ev[] = [];

  let i = 0;
  while (i < events.length) {
    const tick = events[i]!.tick;
    let j = i;
    while (j < events.length && events[j]!.tick === tick) j++;
    const group = events.slice(i, j);
    i = j;

    fillVision(w, h, pos.values(), player, m0);
    // Позиции после группы: двигаем юнитов; погибших убираем только после расчёта маски,
    // чтобы свои погибшие ещё «видели» выстрел.
    for (const e of group) {
      if (e.t === "step" && e.to) {
        const u = pos.get(e.unit)!;
        u.x = e.to[0];
        u.y = e.to[1];
      }
    }
    fillVision(w, h, pos.values(), player, m1);
    const vis = (c: Cell | null): boolean => c !== null && (m0[c[1] * w + c[0]] === 1 || m1[c[1] * w + c[0]] === 1);

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
