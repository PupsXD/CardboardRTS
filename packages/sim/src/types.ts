// Типы чистой симуляции в НЕПРЕРЫВНОМ пространстве (как в Lines of Battle: нет сетки, тела расталкиваются).
// Никакого IO, времени и Math.random. Координаты и длины — целые числа в «пунктах»: SCALE пунктов = 1 единица длины.
// Целые числа дают байт-в-байт одинаковый результат на любой машине и в любом порядке вычислений.

/** Точка [x, y] в пунктах. */
export type Point = readonly [x: number, y: number];
export type PlayerId = number;
export type UnitId = number;

/** 1 единица длины = SCALE пунктов. Диаметр обычного юнита — 1 единица. */
export const SCALE = 100;

/** Рельеф хранится растром ячеек TERRAIN_CELL×TERRAIN_CELL пунктов; рисуется он как угодно, это формат данных. */
export const TERRAIN_CELL = 200;
export const Terrain = { Plain: 0, Road: 1, Rough: 2, Blocked: 3 } as const;
/** Скорость движения по рельефу, проценты. 0 — непроходимо. */
export const TERRAIN_SPEED: readonly number[] = [100, 200, 60, 0];

/** Не больше точек в маршруте приказа (защита от раздувания приказа). */
export const MAX_PATH_POINTS = 16;
/** Радиус обзора не должен превышать это (индекс видимости построен на сетке этого шага). */
export const MAX_VISION = 1000;
/** Радиус тела не должен превышать это (шаг сетки расталкивания = 2 × MAX_RADIUS). */
export const MAX_RADIUS = 100;

export interface Unit {
  id: UnitId;
  owner: PlayerId;
  x: number;
  y: number;
  hp: number;
  /** Урон за залп. */
  dmg: number;
  /** Сколько урона гасит стойка «Оборона». */
  defense: number;
  /** Скорость по равнине, пунктов за тик. */
  speed: number;
  /** Радиус тела. Юниты не перекрываются: тела расталкиваются. */
  radius: number;
  /** Радиус атаки: расстояние от юнита до точки, куда он стреляет. */
  range: number;
  /** Радиус обзора. */
  vision: number;
  /** Радиус поражения вокруг точки выстрела (поверх радиуса тела цели). */
  aoe: number;
}

export interface PlayerInfo {
  id: PlayerId;
  /** Бюджет очков действий на ход: 1 AP за любой приказ (юниту или группе), оборона бесплатна. */
  ap: number;
}

export interface State {
  turn: number;
  /** Размеры карты в пунктах. */
  w: number;
  h: number;
  /** Растр рельефа: tw×th ячеек по TERRAIN_CELL пунктов. */
  terrain: Uint8Array;
  tw: number;
  th: number;
  /** Тиков в ходе. */
  ticks: number;
  /** Максимальный размер группы в одном приказе (заглушка для баланса, решение владельца). */
  maxGroup: number;
  players: PlayerInfo[];
  units: Unit[];
}

/** Приказ группе (или одному юниту: группа из одного). Стоит 1 AP независимо от размера группы. */
export type Order =
  /** Группа идёт по ломаной, сохраняя взаимное расположение; скорость группы — скорость самого медленного. */
  | { kind: "move"; units: UnitId[]; path: Point[] }
  /** Цель — ТОЧКА, а не id юнита: так нельзя зондировать туман, подставляя чужие id. */
  | { kind: "attack"; units: UnitId[]; at: Point }
  | { kind: "defend"; units: UnitId[] };

export interface PlayerOrders {
  player: PlayerId;
  orders: Order[];
}

export type RejectReason =
  | "empty-group"
  | "group-too-big"
  | "unknown-unit"
  | "not-owner"
  | "duplicate"
  | "no-ap"
  | "bad-path"
  | "bad-target"
  | "out-of-range";

export interface Reject {
  player: PlayerId;
  units: UnitId[];
  reason: RejectReason;
}

/** Лог исполнения хода. Это и уходит клиентам (после фильтра тумана), а не состояние. */
export type Ev =
  | { t: "step"; tick: number; unit: UnitId; from: Point | null; to: Point | null }
  | { t: "attack"; tick: number; attacker: UnitId; target: UnitId; from: Point | null; at: Point; dmg: number }
  | { t: "miss"; tick: number; attacker: UnitId; from: Point | null; at: Point }
  | { t: "death"; tick: number; unit: UnitId; at: Point }
  | { t: "blocked"; tick: number; unit: UnitId; at: Point; reason: "terrain" };

/**
 * Когда стреляют юниты с приказом атаки:
 *  - start: один залп в начале хода по начальным позициям (уйти от него в этот ход нельзя);
 *  - zone:  каждый тик по текущим позициям, урон хода делится на тики (цель, прошедшая зону, получает часть);
 *  - end:   один залп после всего движения (кто ушёл — не получил).
 */
export type AttackTiming = "start" | "zone" | "end";

export interface ResolveOptions {
  attackTiming?: AttackTiming;
}

export interface ResolveStats {
  hits: number;
  /** Урон сверх нужного для убийства. */
  overkill: number;
  /** Остановки о непроходимый рельеф. */
  blocked: number;
  /** Наибольшее перекрытие тел в конце хода, пунктов (0 — нет перекрытий). */
  maxOverlap: number;
}

export interface ResolveResult {
  state: State;
  events: Ev[];
  rejected: Reject[];
  stats: ResolveStats;
}
