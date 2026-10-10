// Типы чистой симуляции. Никакого IO, времени и Math.random: всё целочисленное и детерминированное.

/** Клетка [x, y]. Кортеж, а не объект: события короче в JSON. */
export type Cell = readonly [x: number, y: number];
export type PlayerId = number;
export type UnitId = number;

/** Рельеф. Стоимость входа в клетку — в grid.ts (STEP_COST). */
export const Terrain = { Plain: 0, Road: 1, Rough: 2, Blocked: 3 } as const;

export interface Unit {
  id: UnitId;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  /** Урон за выстрел. */
  dmg: number;
  /** Сколько урона гасит стойка «Оборона». */
  defense: number;
  /** Запас хода в очках движения (не в клетках: цену клетки задаёт рельеф). */
  move: number;
  /** Радиус атаки, манхэттенский. */
  range: number;
  /** Радиус обзора, манхэттенский. */
  vision: number;
}

export interface PlayerInfo {
  id: PlayerId;
  /** Бюджет очков действий на этот ход. */
  ap: number;
}

export interface State {
  turn: number;
  seed: number;
  w: number;
  h: number;
  terrain: Uint8Array;
  players: PlayerInfo[];
  units: Unit[];
}

export type Order =
  | { kind: "move"; unit: UnitId; path: Cell[] }
  /** Цель — КЛЕТКА, а не id юнита: так игрок не может зондировать туман, подставляя чужие id. */
  | { kind: "attack"; unit: UnitId; at: Cell }
  | { kind: "defend"; unit: UnitId };

export interface PlayerOrders {
  player: PlayerId;
  orders: Order[];
}

export type RejectReason =
  | "unknown-unit"
  | "not-owner"
  | "duplicate"
  | "no-ap"
  | "bad-path"
  | "bad-target"
  | "out-of-range";

export interface Reject {
  player: PlayerId;
  unit: UnitId;
  reason: RejectReason;
}

export type BlockReason = "occupied" | "contested" | "swap" | "cycle";

/** Лог разрешения хода. Это и есть то, что уходит клиентам (после фильтра тумана), а не состояние. */
export type Ev =
  | { t: "attack"; tick: number; attacker: UnitId; target: UnitId; from: Cell | null; at: Cell; dmg: number }
  | { t: "miss"; tick: number; attacker: UnitId; from: Cell | null; at: Cell; reason: "empty" | "friendly" }
  | { t: "death"; tick: number; unit: UnitId; at: Cell }
  | { t: "step"; tick: number; unit: UnitId; from: Cell | null; to: Cell | null }
  | { t: "blocked"; tick: number; unit: UnitId; at: Cell; reason: BlockReason };

export type ConflictMode = "bounce" | "seeded";
export type ResolutionOrder = "attacks-first" | "move-first";

export interface ResolveOptions {
  /** Что делать, когда несколько юнитов входят в одну клетку: всех остановить или выбрать по сиду. */
  conflict?: ConflictMode;
  /** attacks-first — как в ГДД v0.1; move-first — атаки по позициям ПОСЛЕ движения. */
  order?: ResolutionOrder;
}

export interface ResolveStats {
  hits: number;
  /** Урон сверх нужного для убийства: «зря потраченные» выстрелы при фокусе. */
  overkill: number;
  blocked: number;
  ticks: number;
}

export interface ResolveResult {
  state: State;
  events: Ev[];
  rejected: Reject[];
  stats: ResolveStats;
}
