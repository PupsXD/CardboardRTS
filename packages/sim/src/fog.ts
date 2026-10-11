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

// ---------------------------------------------------------------------------------------------------------
// Все игроки за один проход. Результат совпадает с filterEventsFor для каждого игрока (проверено дифференциальным
// тестом), но «кто видит точку» считается один раз на событие по общему индексу всех юнитов, а не заново на игрока.
// ---------------------------------------------------------------------------------------------------------

const GCELL = 500;
type GlobalIndex = Map<number, Unit[]>;

function buildGlobal(units: Iterable<Unit>): GlobalIndex {
  const idx: GlobalIndex = new Map();
  for (const u of units) {
    const k = key(Math.floor(u.x / GCELL), Math.floor(u.y / GCELL));
    const list = idx.get(k);
    if (list) list.push(u);
    else idx.set(k, [u]);
  }
  return idx;
}

/** Добавляет в `into` владельцев, чьи юниты в этом индексе видят точку. */
function seers(idx: GlobalIndex, p: Point, into: Set<PlayerId>): void {
  const R = Math.ceil(MAX_VISION / GCELL);
  const cx = Math.floor(p[0] / GCELL);
  const cy = Math.floor(p[1] / GCELL);
  for (let ox = -R; ox <= R; ox++) {
    for (let oy = -R; oy <= R; oy++) {
      for (const u of idx.get(key(cx + ox, cy + oy)) ?? []) {
        if (into.has(u.owner)) continue;
        if (dist2(u.x, u.y, p[0], p[1]) <= u.vision * u.vision) into.add(u.owner);
      }
    }
  }
}

export function filterEventsForAll(
  initial: State,
  events: readonly Ev[],
  players: readonly PlayerId[],
): Map<PlayerId, Ev[]> {
  const wanted = new Set(players);
  const out = new Map<PlayerId, Ev[]>();
  for (const p of players) out.set(p, []);
  const pos = new Map<UnitId, Unit>();
  for (const u of initial.units) pos.set(u.id, { ...u });
  const ownerOf = (id: UnitId): PlayerId | undefined => pos.get(id)?.owner;

  const emit = (p: PlayerId, e: Ev) => out.get(p)!.push(e);

  let i = 0;
  while (i < events.length) {
    const tick = events[i]!.tick;
    let j = i;
    while (j < events.length && events[j]!.tick === tick) j++;
    const group = events.slice(i, j);
    i = j;

    const gA = buildGlobal(pos.values());
    for (const e of group) {
      if (e.t === "step" && e.to) {
        const u = pos.get(e.unit)!;
        u.x = e.to[0];
        u.y = e.to[1];
      }
    }
    const gB = buildGlobal(pos.values());
    const seenBy = (pt: Point | null): Set<PlayerId> => {
      const s = new Set<PlayerId>();
      if (pt) {
        seers(gA, pt, s);
        seers(gB, pt, s);
      }
      return s;
    };

    for (const e of group) {
      switch (e.t) {
        case "step": {
          const own = ownerOf(e.unit);
          const sf = seenBy(e.from);
          const st = seenBy(e.to);
          const all = new Set<PlayerId>([...sf, ...st]);
          if (own !== undefined) all.add(own);
          for (const p of all) {
            if (!wanted.has(p)) continue;
            if (p === own) emit(p, e);
            else emit(p, { ...e, from: sf.has(p) ? e.from : null, to: st.has(p) ? e.to : null });
          }
          break;
        }
        case "attack": {
          const a = ownerOf(e.attacker);
          const t = ownerOf(e.target);
          const sf = seenBy(e.from);
          const sa = seenBy(e.at);
          const all = new Set<PlayerId>([...sf, ...sa]);
          if (a !== undefined) all.add(a);
          if (t !== undefined) all.add(t);
          for (const p of all) {
            if (!wanted.has(p)) continue;
            if (p === a || p === t) emit(p, e);
            else emit(p, { ...e, from: sf.has(p) ? e.from : null });
          }
          break;
        }
        case "miss": {
          const a = ownerOf(e.attacker);
          const sf = seenBy(e.from);
          const sa = seenBy(e.at);
          const all = new Set<PlayerId>([...sf, ...sa]);
          if (a !== undefined) all.add(a);
          for (const p of all) {
            if (!wanted.has(p)) continue;
            if (p === a) emit(p, e);
            else emit(p, { ...e, from: sf.has(p) ? e.from : null });
          }
          break;
        }
        case "death":
        case "blocked": {
          const own = ownerOf(e.unit);
          const sv = seenBy(e.at);
          if (own !== undefined) sv.add(own);
          for (const p of sv) if (wanted.has(p)) emit(p, e);
          break;
        }
      }
    }
    for (const e of group) if (e.t === "death") pos.delete(e.unit);
  }
  return out;
}
