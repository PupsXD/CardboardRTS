import type { Order, PlayerId, PlayerOrders, Point, State, Unit } from "./types.ts";

/**
 * Простой бот для замеров и прототипов (НЕ игровой ИИ): каждая группа из `groupSize` юнитов бьёт ближайшего врага,
 * если он в радиусе, иначе идёт к центру масс ближайшего чужого игрока. Видит всё состояние; честный бот на проекции
 * для своего игрока — в планах (ROADMAP).
 */
export interface BotOptions {
  groupSize?: number;
  /** Сколько приказов за ход отдаёт бот каждого игрока. */
  ap?: number;
  /** За каких игроков отдавать приказы; по умолчанию за всех. */
  players?: readonly PlayerId[];
}

const CELL = 500;
const key = (cx: number, cy: number) => (cx + 1) * 8192 + (cy + 1);

export function botOrders(s: State, opts: BotOptions = {}): PlayerOrders[] {
  const GROUP = opts.groupSize ?? 5;
  const AP = opts.ap ?? 8;
  const only = opts.players ? new Set(opts.players) : null;

  const grid = new Map<number, Unit[]>();
  const sum = new Map<number, { x: number; y: number; n: number }>();
  for (const u of s.units) {
    const k = key(Math.floor(u.x / CELL), Math.floor(u.y / CELL));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(u);
    const c = sum.get(u.owner) ?? { x: 0, y: 0, n: 0 };
    c.x += u.x;
    c.y += u.y;
    c.n++;
    sum.set(u.owner, c);
  }
  const centers = [...sum.entries()].map(([p, c]) => ({ p, x: Math.round(c.x / c.n), y: Math.round(c.y / c.n) }));
  const goal = new Map<number, Point>();
  for (const a of centers) {
    let best = Infinity;
    for (const b of centers) {
      if (a.p === b.p) continue;
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (d < best) {
        best = d;
        goal.set(a.p, [b.x, b.y]);
      }
    }
  }
  const byOwner = new Map<number, Unit[]>();
  for (const u of s.units) (byOwner.get(u.owner) ?? byOwner.set(u.owner, []).get(u.owner)!).push(u);

  const out: PlayerOrders[] = [];
  for (const [owner, mine] of byOwner) {
    if (only && !only.has(owner)) continue;
    const list: Order[] = [];
    let spent = 0;
    for (let g = 0; g < mine.length && spent < AP; g += GROUP) {
      const members = mine.slice(g, g + GROUP);
      const lead = members[0]!;
      let target: Unit | undefined;
      let bd = Infinity;
      const cx = Math.floor(lead.x / CELL);
      const cy = Math.floor(lead.y / CELL);
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (const t of grid.get(key(cx + ox, cy + oy)) ?? []) {
            if (t.owner === owner) continue;
            const d = (t.x - lead.x) ** 2 + (t.y - lead.y) ** 2;
            if (d < bd) {
              bd = d;
              target = t;
            }
          }
      if (target) {
        const at: Point = [target.x, target.y];
        const inRange = members.filter((m) => (m.x - at[0]) ** 2 + (m.y - at[1]) ** 2 <= m.range * m.range);
        if (inRange.length > 0) {
          list.push({ kind: "attack", units: inRange.map((m) => m.id), at });
          spent++;
          continue;
        }
      }
      const g0 = goal.get(owner);
      if (!g0) continue;
      list.push({ kind: "move", units: members.map((m) => m.id), path: [g0] });
      spent++;
    }
    out.push({ player: owner, orders: list });
  }
  return out;
}
