import Phaser from "phaser";
import { botOrders, previewMove, resolveTurn, SCALE, visibleUnits } from "@cardboard/sim";
import type { AttackTiming, Ev, Order, PlayerId, Point, ResolveResult, State, Unit, UnitId } from "@cardboard/sim";
import { simplifyPath } from "./draw";
import { createHud } from "./hud";
import type { Hud } from "./hud";
import { drawTerrain, makePaperTexture, makeUnitTextures } from "./paper";
import { createWorld, DEFAULT_WORLD, PEN, PX, toPt, toPx } from "./world";

const UNIT_SCALE = 20 / 18; // кружок в текстуре диаметром 18 px должен занимать 1 единицу длины (20 px)
const FOG_DIV = 4; // туман рисуется в четверть разрешения

interface Playback {
  res: ResolveResult;
  snaps: Map<UnitId, Point>[];
  intervals: number;
  elapsed: number;
  fired: number; // до какого интервала включительно уже запущены события
  /** Для каждого интервала: позиции и радиусы обзора юнитов активного игрока в начале и в конце интервала. */
  eyes: (readonly [number, number, number])[][];
  dead: Set<UnitId>;
  viewer: PlayerId;
}

interface Effect {
  kind: "shot";
  from: Point | null;
  at: Point;
  owner: PlayerId;
  t0: number;
}

export class BattleScene extends Phaser.Scene {
  private state!: State;
  private plans = new Map<PlayerId, Order[]>();
  private active: PlayerId = 0;
  private selection = new Set<UnitId>();
  private sprites = new Map<UnitId, Phaser.GameObjects.Image>();
  private byId = new Map<UnitId, Unit>();
  private deaths: { at: Point; owner: PlayerId }[] = [];

  private timing: AttackTiming = "zone";
  private botsForOthers = true;
  private tickMs = 500;
  private playback: Playback | null = null;
  private effects: Effect[] = [];

  private paper!: Phaser.GameObjects.TileSprite;
  private terrainG!: Phaser.GameObjects.Graphics;
  private ordersG!: Phaser.GameObjects.Graphics;
  private selG!: Phaser.GameObjects.Graphics;
  private fxG!: Phaser.GameObjects.Graphics;
  private boxG!: Phaser.GameObjects.Graphics;
  private fog: Phaser.GameObjects.RenderTexture | null = null;
  private fogBrush: Phaser.GameObjects.Image | null = null;
  private hud!: Hud;

  private box: { x0: number; y0: number } | null = null;
  private draw: Point[] | null = null;
  private drawShift = false;
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private statsAt = 0;
  private lastResolveMs = 0;
  private lastRejected = 0;

  constructor() {
    super("battle");
  }

  create(): void {
    this.state = createWorld();
    this.reindex();

    makePaperTexture(this);
    makeUnitTextures(this);
    const W = toPx(this.state.w);
    const H = toPx(this.state.h);

    this.paper = this.add.tileSprite(-200, -200, W + 400, H + 400, "paper").setOrigin(0, 0).setDepth(0);
    this.terrainG = this.add.graphics().setDepth(1);
    drawTerrain(this.terrainG, this.state);
    this.terrainG.lineStyle(2.5, 0x23262d, 0.85);
    this.terrainG.strokeRect(0, 0, W, H);
    this.ordersG = this.add.graphics().setDepth(3);
    this.selG = this.add.graphics().setDepth(5);
    this.fxG = this.add.graphics().setDepth(6);
    this.boxG = this.add.graphics().setDepth(7);

    for (const u of this.state.units) {
      const s = this.add.image(toPx(u.x), toPx(u.y), `unit${u.owner}`).setScale(UNIT_SCALE).setDepth(4);
      this.sprites.set(u.id, s);
    }

    this.setupFog(W, H);

    const cam = this.cameras.main;
    cam.setBounds(-300, -300, W + 600, H + 600);
    this.fitCamera();
    this.scale.on("resize", () => this.fitCamera(false));
    this.time.delayedCall(0, () => this.fitCamera(false));

    this.hud = createHud(
      {
        onPlayer: (p) => this.setActive(p),
        onConfirm: () => this.confirmTurn(),
        onSkip: () => this.skipPlayback(),
        onTiming: (t) => (this.timing = t),
        onMaxGroup: (n) => {
          this.state = { ...this.state, maxGroup: Math.max(1, n | 0) };
          this.hud.toast(`Размер группы ≤ ${this.state.maxGroup}`);
        },
        onAp: (n) => {
          this.state = { ...this.state, players: this.state.players.map((p) => ({ ...p, ap: Math.max(1, n | 0) })) };
          this.updateAp();
        },
        onBots: (on) => (this.botsForOthers = on),
        onTickMs: (ms) => (this.tickMs = Math.max(50, ms | 0)),
        onReset: () => this.scene.restart(),
      },
      { players: DEFAULT_WORLD.players, maxGroup: this.state.maxGroup, ap: this.state.players[0]!.ap },
    );

    this.input.mouse?.disableContextMenu();
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on("wheel", (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => this.onWheel(p, dy));
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,UP,DOWN,LEFT,RIGHT") as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.keyboard!.on("keydown", (e: KeyboardEvent) => this.onKey(e));

    this.setActive(0);

    // Для замеров и отладки из консоли браузера.
    (window as unknown as { __proto: unknown }).__proto = {
      scene: this,
      fps: () => this.game.loop.actualFps,
      confirm: () => this.confirmTurn(),
      stats: () => ({ units: this.state.units.length, resolveMs: this.lastResolveMs, turn: this.state.turn }),
    };
  }

  // ------------------------------------------------------------------ камера и ввод

  private fitted = false;

  /** Подгоняет лист под окно. В режиме RESIZE на старте размер канваса может быть нулевым — тогда берём размер окна. */
  private fitCamera(force = true): void {
    const cam = this.cameras.main;
    const W = toPx(this.state.w);
    const H = toPx(this.state.h);
    const vw = this.scale.width || window.innerWidth;
    const vh = this.scale.height || window.innerHeight;
    if (!force && this.fitted) return;
    this.fitted = this.scale.width > 0 && this.scale.height > 0;
    cam.setZoom(Math.max(0.1, Math.min(vw / (W + 80), (vh - 60) / (H + 80))));
    cam.centerOn(W / 2, H / 2 + 20);
  }

  private onWheel(p: Phaser.Input.Pointer, dy: number): void {
    const cam = this.cameras.main;
    const before = cam.getWorldPoint(p.x, p.y);
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.88 : 1.14), 0.15, 5));
    const after = cam.getWorldPoint(p.x, p.y);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
  }

  private worldPt(p: Phaser.Input.Pointer): Point {
    const w = this.cameras.main.getWorldPoint(p.x, p.y);
    return [toPt(w.x), toPt(w.y)];
  }

  private overUi(p: Phaser.Input.Pointer): boolean {
    const el = document.elementFromPoint(p.x, p.y);
    return !!el && el !== this.game.canvas && !!el.closest("#hud, #help");
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.playback || this.overUi(p)) return;
    const [x, y] = this.worldPt(p);
    if (p.rightButtonDown()) {
      if (this.selection.size === 0) return this.hud.toast("Сначала выделите юниты (ЛКМ / рамка)");
      this.draw = [[x, y]];
      this.drawShift = !!(p.event as MouseEvent | undefined)?.shiftKey;
    } else if (p.leftButtonDown()) {
      this.box = { x0: x, y0: y };
    }
  }

  private onMove(p: Phaser.Input.Pointer): void {
    const cam = this.cameras.main;
    if (p.middleButtonDown()) {
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
      return;
    }
    const [x, y] = this.worldPt(p);
    if (this.draw) {
      const last = this.draw[this.draw.length - 1]!;
      if ((last[0] - x) ** 2 + (last[1] - y) ** 2 > 40 * 40) this.draw.push([x, y]);
      this.redrawOrders();
    } else if (this.box) {
      this.boxG.clear();
      this.boxG.lineStyle(1.5, PEN[this.active], 0.9);
      this.boxG.fillStyle(PEN[this.active], 0.08);
      const bx = toPx(Math.min(this.box.x0, x));
      const by = toPx(Math.min(this.box.y0, y));
      const bw = toPx(Math.abs(this.box.x0 - x));
      const bh = toPx(Math.abs(this.box.y0 - y));
      this.boxG.fillRect(bx, by, bw, bh);
      this.boxG.strokeRect(bx, by, bw, bh);
    }
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const [x, y] = this.worldPt(p);
    if (this.draw) {
      const raw = this.draw;
      this.draw = null;
      raw.push([x, y]);
      const moved = Math.hypot(raw[0]![0] - x, raw[0]![1] - y);
      if (this.drawShift && moved < 120) this.orderAttack([x, y]);
      else if (moved >= 120) this.orderMove(simplifyPath(raw));
      this.redrawOrders();
      return;
    }
    if (this.box) {
      const b = this.box;
      this.box = null;
      this.boxG.clear();
      const shift = !!(p.event as MouseEvent | undefined)?.shiftKey;
      const small = Math.hypot(b.x0 - x, b.y0 - y) < 80;
      if (!shift) this.selection.clear();
      const x0 = Math.min(b.x0, x);
      const x1 = Math.max(b.x0, x);
      const y0 = Math.min(b.y0, y);
      const y1 = Math.max(b.y0, y);
      if (small) {
        let best: Unit | undefined;
        let bd = 70 * 70;
        for (const u of this.state.units) {
          if (u.owner !== this.active) continue;
          const d = (u.x - x) ** 2 + (u.y - y) ** 2;
          if (d < bd) {
            bd = d;
            best = u;
          }
        }
        if (best) this.selection.add(best.id);
      } else {
        for (const u of this.state.units) {
          if (u.owner === this.active && u.x >= x0 && u.x <= x1 && u.y >= y0 && u.y <= y1) this.selection.add(u.id);
        }
      }
      this.redrawSelection();
      this.redrawOrders();
    }
  }

  private onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (/^[1-9]$/.test(k) && Number(k) <= DEFAULT_WORLD.players) return this.setActive(Number(k) - 1);
    if (k === "Enter") return this.confirmTurn();
    if (k === "Escape") {
      if (this.playback) return this.skipPlayback();
      this.selection.clear();
      this.redrawSelection();
      return this.redrawOrders();
    }
    if (this.playback) return;
    if (k === "d" || k === "D") this.orderDefend();
    if (k === "Delete" || k === "Backspace") this.clearOrdersOfSelection();
  }

  // ------------------------------------------------------------------ приказы

  private plan(p = this.active): Order[] {
    let l = this.plans.get(p);
    if (!l) this.plans.set(p, (l = []));
    return l;
  }

  private paid(p = this.active): number {
    return this.plan(p).filter((o) => o.kind !== "defend").length;
  }

  private updateAp(): void {
    this.hud.setAp(this.paid(), this.state.players[this.active]!.ap);
  }

  /** Убирает выбранных из прежних приказов (один юнит — один приказ), пустые приказы выкидывает. */
  private detach(units: readonly UnitId[]): void {
    const s = new Set(units);
    const list = this.plan();
    for (const o of list) o.units = o.units.filter((u) => !s.has(u));
    this.plans.set(
      this.active,
      list.filter((o) => o.units.length > 0),
    );
  }

  private chosen(): UnitId[] {
    return [...this.selection].filter((id) => this.byId.has(id));
  }

  private canOrder(units: UnitId[], paid: boolean): boolean {
    if (units.length === 0) return false;
    if (units.length > this.state.maxGroup) {
      this.hud.toast(`В группе максимум ${this.state.maxGroup} юнитов (выбрано ${units.length})`);
      return false;
    }
    if (paid) {
      // приказ, который заменит прежние у этих юнитов, мог их же и освободить: считаем после снятия
      const freed = this.plan().filter((o) => o.kind !== "defend" && o.units.every((u) => units.includes(u))).length;
      if (this.paid() - freed >= this.state.players[this.active]!.ap) {
        this.hud.toast("Нет AP на ещё один приказ");
        return false;
      }
    }
    return true;
  }

  private orderMove(path: Point[]): void {
    const units = this.chosen();
    if (path.length === 0 || !this.canOrder(units, true)) return;
    this.detach(units);
    this.plan().push({ kind: "move", units, path });
    this.updateAp();
  }

  private orderAttack(at: Point): void {
    const units = this.chosen();
    if (!this.canOrder(units, true)) return;
    const far = units.filter((id) => {
      const u = this.byId.get(id)!;
      return (u.x - at[0]) ** 2 + (u.y - at[1]) ** 2 > u.range ** 2;
    });
    if (far.length > 0) return this.hud.toast(`${far.length} из ${units.length} не достают до цели (дальность ${this.byId.get(units[0]!)!.range / SCALE})`);
    this.detach(units);
    this.plan().push({ kind: "attack", units, at });
    this.updateAp();
  }

  private orderDefend(): void {
    const units = this.chosen();
    if (!this.canOrder(units, false)) return;
    this.detach(units);
    this.plan().push({ kind: "defend", units });
    this.updateAp();
    this.redrawOrders();
  }

  private clearOrdersOfSelection(): void {
    this.detach(this.chosen());
    this.updateAp();
    this.redrawOrders();
  }

  // ------------------------------------------------------------------ рисование

  private dashed(g: Phaser.GameObjects.Graphics, pts: readonly Point[], on = 6, off = 5): void {
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = toPx(pts[i]![0]);
      const ay = toPx(pts[i]![1]);
      const bx = toPx(pts[i + 1]![0]);
      const by = toPx(pts[i + 1]![1]);
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len;
      const dy = (by - ay) / len;
      for (let t = 0; t < len; t += on + off) {
        const e = Math.min(len, t + on);
        g.lineBetween(ax + dx * t, ay + dy * t, ax + dx * e, ay + dy * e);
      }
    }
  }

  private arrow(g: Phaser.GameObjects.Graphics, a: Point, b: Point): void {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const x = toPx(b[0]);
    const y = toPx(b[1]);
    g.lineBetween(x, y, x - Math.cos(ang - 0.45) * 8, y - Math.sin(ang - 0.45) * 8);
    g.lineBetween(x, y, x - Math.cos(ang + 0.45) * 8, y - Math.sin(ang + 0.45) * 8);
  }

  private redrawOrders(): void {
    const g = this.ordersG;
    g.clear();
    if (this.playback) return;
    const pen = PEN[this.active]!;
    for (const o of this.plan()) {
      const group = o.units.map((id) => this.byId.get(id)).filter((u): u is Unit => !!u);
      if (group.length === 0) continue;
      if (o.kind === "move") {
        // весь нарисованный маршрут — пунктиром (то, что юнит НЕ успеет), достижимая часть — сплошной чернильной
        g.lineStyle(1.4, pen, 0.45);
        const c = this.centroid(group);
        this.dashed(g, [c, ...o.path]);
        const traces = previewMove(this.state, group, o.path);
        g.lineStyle(1.8, pen, 0.9);
        for (const tr of traces) {
          if (tr.length < 2) continue;
          for (let i = 0; i < tr.length - 1; i++) g.lineBetween(toPx(tr[i]![0]), toPx(tr[i]![1]), toPx(tr[i + 1]![0]), toPx(tr[i + 1]![1]));
        }
        const lead = traces[0]!;
        if (lead.length >= 2) this.arrow(g, lead[lead.length - 2]!, lead[lead.length - 1]!);
      } else if (o.kind === "attack") {
        g.lineStyle(1.2, pen, 0.5);
        for (const u of group) this.dashed(g, [[u.x, u.y], o.at], 3, 6);
        g.lineStyle(2, pen, 0.95);
        const x = toPx(o.at[0]);
        const y = toPx(o.at[1]);
        g.strokeCircle(x, y, 13);
        g.lineBetween(x - 9, y - 9, x + 9, y + 9);
        g.lineBetween(x + 9, y - 9, x - 9, y + 9);
      } else {
        g.lineStyle(2, pen, 0.9);
        for (const u of group) {
          g.beginPath();
          g.arc(toPx(u.x), toPx(u.y) + 1, 13, 0.15 * Math.PI, 0.85 * Math.PI, false);
          g.strokePath();
        }
      }
    }
    if (this.draw && this.draw.length > 1) {
      g.lineStyle(2, pen, 0.95);
      for (let i = 0; i < this.draw.length - 1; i++) {
        g.lineBetween(toPx(this.draw[i]![0]), toPx(this.draw[i]![1]), toPx(this.draw[i + 1]![0]), toPx(this.draw[i + 1]![1]));
      }
    }
    this.updateAp();
  }

  private centroid(group: readonly Unit[]): Point {
    let sx = 0;
    let sy = 0;
    for (const u of group) {
      sx += u.x;
      sy += u.y;
    }
    return [Math.trunc(sx / group.length), Math.trunc(sy / group.length)];
  }

  private redrawSelection(): void {
    const g = this.selG;
    g.clear();
    if (this.playback) return;
    g.lineStyle(1.6, PEN[this.active]!, 0.9);
    for (const id of this.selection) {
      const u = this.byId.get(id);
      if (u) g.strokeCircle(toPx(u.x), toPx(u.y), 13.5);
    }
  }

  // ------------------------------------------------------------------ туман и видимость

  private setupFog(W: number, H: number): void {
    try {
      const b = document.createElement("canvas");
      b.width = 128;
      b.height = 128;
      const g = b.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, 40, 64, 64, 64);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      this.textures.addCanvas("visBrush", b);
      this.fogBrush = new Phaser.GameObjects.Image(this, 0, 0, "visBrush");
      this.fog = this.add
        .renderTexture(-200, -200, Math.ceil((W + 400) / FOG_DIV), Math.ceil((H + 400) / FOG_DIV))
        .setOrigin(0, 0)
        .setScale(FOG_DIV)
        .setDepth(2);
    } catch (err) {
      console.warn("Туман не создан:", err);
      this.fog = null;
    }
  }

  private updateVisibility(): void {
    const vis = new Set(visibleUnits(this.state, this.active).map((u) => u.id));
    for (const u of this.state.units) {
      const s = this.sprites.get(u.id);
      if (s) s.setVisible(vis.has(u.id));
    }
    if (!this.fog || !this.fogBrush) return;
    this.fog.clear();
    this.fog.fill(0x6c6858, 0.34);
    const diam = (r: number) => (toPx(r) * 2 * 1.06) / FOG_DIV;
    for (const u of this.state.units) {
      if (u.owner !== this.active) continue;
      this.fogBrush.setDisplaySize(diam(u.vision), diam(u.vision));
      this.fog.erase(this.fogBrush, (toPx(u.x) + 200) / FOG_DIV, (toPx(u.y) + 200) / FOG_DIV);
    }
    this.fog.render(); // команды RenderTexture буферизуются до явного render()
  }

  private setActive(p: PlayerId): void {
    if (this.playback) return;
    this.active = p;
    this.selection.clear();
    this.hud.setActive(p);
    this.updateVisibility();
    this.redrawSelection();
    this.redrawOrders();
  }

  // ------------------------------------------------------------------ ход и проигрывание

  private reindex(): void {
    this.byId = new Map(this.state.units.map((u) => [u.id, u]));
  }

  private confirmTurn(): void {
    if (this.playback) return;
    const allOrders = [...this.plans.entries()]
      .filter(([, o]) => o.length > 0)
      .map(([player, orders]) => ({ player, orders: orders.map((o) => ({ ...o })) }));
    if (this.botsForOthers) {
      const have = new Set(allOrders.filter((po) => po.orders.some((o) => o.kind !== "defend")).map((po) => po.player));
      const need = this.state.players.map((p) => p.id).filter((id) => !have.has(id));
      allOrders.push(...botOrders(this.state, { players: need, groupSize: Math.min(5, this.state.maxGroup), ap: this.state.players[0]!.ap }));
    }
    const t0 = performance.now();
    const res = resolveTurn(this.state, allOrders, { attackTiming: this.timing });
    this.lastResolveMs = performance.now() - t0;
    this.lastRejected = res.rejected.length;
    if (res.rejected.length > 0) console.warn("Отклонённые приказы:", res.rejected);
    this.startPlayback(res);
  }

  private startPlayback(res: ResolveResult): void {
    const T = this.state.ticks;
    const cur = new Map<UnitId, Point>(this.state.units.map((u) => [u.id, [u.x, u.y] as Point]));
    const snaps: Map<UnitId, Point>[] = [new Map(cur)];
    const maxTick = Math.max(T, ...res.events.map((e) => e.tick));
    for (let t = 1; t <= maxTick; t++) {
      for (const e of res.events) if (e.tick === t && e.t === "step" && e.to) cur.set(e.unit, e.to);
      snaps.push(new Map(cur));
    }
    const viewer = this.active;
    const eyes: (readonly [number, number, number])[][] = [];
    for (let i = 0; i < maxTick; i++) {
      const list: (readonly [number, number, number])[] = [];
      for (const u of this.state.units) {
        if (u.owner !== viewer) continue;
        for (const m of [snaps[i]!, snaps[i + 1]!]) {
          const pos = m.get(u.id);
          if (pos) list.push([pos[0], pos[1], u.vision]);
        }
      }
      eyes.push(list);
    }
    this.playback = { res, snaps, intervals: maxTick, elapsed: 0, fired: -1, eyes, dead: new Set(), viewer };
    this.applyPlaybackVisibility(0);
    this.deaths = [];
    this.effects = [];
    this.hud.setBusy(true);
    this.selG.clear();
    this.ordersG.clear();
    // во время проигрывания показываем всё, что видит игрок в КОНЦЕ хода — но туман не трогаем до конца
  }

  /** Видит ли активный игрок точку на этом интервале хода (круги обзора его юнитов в начале и в конце интервала). */
  private seen(p: Point | null, interval: number): boolean {
    if (!p) return false;
    const eyes = this.playback!.eyes[Math.min(interval, this.playback!.eyes.length - 1)]!;
    for (const [x, y, r] of eyes) if ((x - p[0]) ** 2 + (y - p[1]) ** 2 <= r * r) return true;
    return false;
  }

  /** Спрайты показываются только если юнит свой или попадает в обзор на этом интервале; погибшие скрыты. */
  private applyPlaybackVisibility(interval: number): void {
    const pb = this.playback!;
    const a = pb.snaps[interval]!;
    const b = pb.snaps[Math.min(interval + 1, pb.snaps.length - 1)]!;
    for (const u of this.state.units) {
      const sp = this.sprites.get(u.id);
      if (!sp) continue;
      if (pb.dead.has(u.id)) {
        sp.setVisible(false);
        continue;
      }
      const show = u.owner === pb.viewer || this.seen(a.get(u.id) ?? null, interval) || this.seen(b.get(u.id) ?? null, interval);
      sp.setVisible(show);
    }
  }

  private fireEvents(interval: number): void {
    const pb = this.playback!;
    for (const e of pb.res.events) {
      if (e.tick !== interval + 1) continue;
      this.onEvent(e, interval);
    }
  }

  private onEvent(e: Ev, interval: number): void {
    const pb = this.playback!;
    if (e.t === "attack" || e.t === "miss") {
      const owner = this.byId.get(e.attacker)?.owner ?? 0;
      const involved = owner === pb.viewer || (e.t === "attack" && this.byId.get(e.target)?.owner === pb.viewer);
      if (involved || this.seen(e.from, interval) || this.seen(e.at, interval)) {
        this.effects.push({ kind: "shot", from: involved || this.seen(e.from, interval) ? e.from : null, at: e.at, owner, t0: pb.elapsed });
      }
    } else if (e.t === "death") {
      const owner = this.byId.get(e.unit)?.owner ?? 0;
      pb.dead.add(e.unit);
      this.sprites.get(e.unit)?.setVisible(false);
      if (owner === pb.viewer || this.seen(e.at, interval)) this.deaths.push({ at: e.at, owner });
    }
  }

  private skipPlayback(): void {
    if (!this.playback) return;
    this.playback.elapsed = this.playback.intervals * this.tickMs + 1;
  }

  private finishPlayback(): void {
    const pb = this.playback!;
    this.playback = null;
    this.state = pb.res.state;
    this.reindex();
    const alive = new Set(this.state.units.map((u) => u.id));
    for (const [id, s] of this.sprites) {
      if (!alive.has(id)) {
        s.destroy();
        this.sprites.delete(id);
      }
    }
    for (const u of this.state.units) {
      const s = this.sprites.get(u.id);
      if (s) {
        s.setPosition(toPx(u.x), toPx(u.y));
        s.setAlpha(0.45 + 0.55 * Math.min(1, u.hp / 100));
      }
    }
    this.plans.clear();
    for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
    this.effects = [];
    this.fxG.clear();
    this.drawDeaths();
    this.hud.setBusy(false);
    this.updateVisibility();
    this.redrawSelection();
    this.redrawOrders();
    this.hud.toast(
      `Ход ${this.state.turn - 1} разрешён за ${this.lastResolveMs.toFixed(1)} мс · событий ${pb.res.events.length}` +
        (this.lastRejected ? ` · отклонено приказов: ${this.lastRejected}` : ""),
    );
  }

  private drawDeaths(): void {
    const g = this.fxG;
    for (const d of this.deaths) {
      g.lineStyle(2, PEN[d.owner]!, 0.8);
      const x = toPx(d.at[0]);
      const y = toPx(d.at[1]);
      g.lineBetween(x - 7, y - 7, x + 7, y + 7);
      g.lineBetween(x + 7, y - 7, x - 7, y + 7);
    }
  }

  // ------------------------------------------------------------------ цикл

  update(_t: number, dt: number): void {
    const cam = this.cameras.main;
    const sp = (600 * dt) / 1000 / cam.zoom;
    if (this.keys.A!.isDown || this.keys.LEFT!.isDown) cam.scrollX -= sp;
    if (this.keys.D!.isDown || this.keys.RIGHT!.isDown) cam.scrollX += sp;
    if (this.keys.W!.isDown || this.keys.UP!.isDown) cam.scrollY -= sp;
    if (this.keys.S!.isDown || this.keys.DOWN!.isDown) cam.scrollY += sp;

    const pb = this.playback;
    if (pb) {
      pb.elapsed += dt;
      const total = pb.intervals * this.tickMs;
      const t = Math.min(pb.elapsed, total);
      const i = Math.min(pb.intervals - 1, Math.floor(t / this.tickMs));
      while (pb.fired < i) {
        pb.fired++;
        this.applyPlaybackVisibility(pb.fired);
        this.fireEvents(pb.fired);
      }
      const frac = t / this.tickMs - i;
      const a = pb.snaps[i]!;
      const b = pb.snaps[i + 1]!;
      for (const [id, pa] of a) {
        const pbp = b.get(id);
        const s = this.sprites.get(id);
        if (!s || !pbp) continue;
        s.setPosition(toPx(pa[0] + (pbp[0] - pa[0]) * frac), toPx(pa[1] + (pbp[1] - pa[1]) * frac));
      }
      this.drawEffects(pb.elapsed);
      if (pb.elapsed >= total + 250) this.finishPlayback();
    }

    this.statsAt += dt;
    if (this.statsAt > 400) {
      this.statsAt = 0;
      this.hud.setStats(
        `ход ${this.state.turn} · юнитов ${this.state.units.length} · ${this.game.loop.actualFps.toFixed(0)} fps · resolve ${this.lastResolveMs.toFixed(1)} мс`,
      );
    }
  }

  private drawEffects(now: number): void {
    const g = this.fxG;
    g.clear();
    this.drawDeaths();
    const life = Math.max(250, this.tickMs * 0.9);
    this.effects = this.effects.filter((e) => now - e.t0 < life);
    for (const e of this.effects) {
      const k = 1 - (now - e.t0) / life;
      g.lineStyle(2, PEN[e.owner]!, 0.85 * k);
      const x = toPx(e.at[0]);
      const y = toPx(e.at[1]);
      if (e.from) g.lineBetween(toPx(e.from[0]), toPx(e.from[1]), x, y);
      g.strokeCircle(x, y, 6 + 10 * (1 - k));
    }
  }
}

export { PX };
