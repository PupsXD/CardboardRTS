import type { AttackTiming } from "@cardboard/sim";
import { PEN_CSS } from "./world";

export interface HudHandlers {
  onPlayer(p: number): void;
  onConfirm(): void;
  onSkip(): void;
  onTiming(t: AttackTiming): void;
  onMaxGroup(n: number): void;
  onAp(n: number): void;
  onBots(on: boolean): void;
  onTickMs(ms: number): void;
  onReset(): void;
}

export interface Hud {
  setActive(p: number): void;
  setAp(used: number, total: number): void;
  setStats(text: string): void;
  setBusy(busy: boolean): void;
  toast(msg: string): void;
}

export function createHud(h: HudHandlers, init: { players: number; maxGroup: number; ap: number }): Hud {
  const root = document.getElementById("hud")!;
  root.innerHTML = `
    <span id="players"></span>
    <span>AP: <b id="ap">0/0</b></span>
    <label>Залп
      <select id="timing">
        <option value="zone">zone (каждый тик)</option>
        <option value="start">start (в начале хода)</option>
        <option value="end">end (после движения)</option>
      </select>
    </label>
    <label>Группа ≤ <input id="maxGroup" type="number" min="1" max="60" value="${init.maxGroup}" /></label>
    <label>AP/ход <input id="apTotal" type="number" min="1" max="60" value="${init.ap}" /></label>
    <label><input id="bots" type="checkbox" checked /> боты за остальных</label>
    <label>тик, мс <input id="tickMs" type="number" min="50" max="3000" step="50" value="500" /></label>
    <button id="confirm" class="primary">Подтвердить ход (Enter)</button>
    <button id="skip">Пропустить (Esc)</button>
    <button id="reset">Заново</button>
    <span id="stats"></span>`;
  const q = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + id)!;

  const players = q("players");
  for (let p = 0; p < init.players; p++) {
    const b = document.createElement("button");
    b.className = "player";
    b.textContent = String(p + 1);
    b.style.background = PEN_CSS[p]!;
    b.title = `Играть за игрока ${p + 1} (клавиша ${p + 1})`;
    b.onclick = () => h.onPlayer(p);
    players.appendChild(b);
  }
  q<HTMLSelectElement>("timing").onchange = (e) => h.onTiming((e.target as HTMLSelectElement).value as AttackTiming);
  q<HTMLInputElement>("maxGroup").onchange = (e) => h.onMaxGroup(Number((e.target as HTMLInputElement).value));
  q<HTMLInputElement>("apTotal").onchange = (e) => h.onAp(Number((e.target as HTMLInputElement).value));
  q<HTMLInputElement>("bots").onchange = (e) => h.onBots((e.target as HTMLInputElement).checked);
  q<HTMLInputElement>("tickMs").onchange = (e) => h.onTickMs(Number((e.target as HTMLInputElement).value));
  q("confirm").onclick = () => h.onConfirm();
  q("skip").onclick = () => h.onSkip();
  q("reset").onclick = () => h.onReset();

  document.getElementById("help")!.innerHTML =
    `<b>ЛКМ</b> — выбрать юнит / рамка · <b>Shift+ЛКМ</b> — добавить · <b>ПКМ-протяжка</b> — нарисовать маршрут группе ·
     <b>Shift+ПКМ</b> — атака в точку · <b>D</b> — оборона (бесплатно) · <b>Del</b> — снять приказы выбранных ·
     <b>1–${init.players}</b> — за какого игрока ходить · <b>колесо</b> — зум · <b>СКМ / WASD</b> — двигать лист ·
     <b>Enter</b> — подтвердить ход. Приказ группе стоит 1 AP.`;

  const toastEl = document.getElementById("toast")!;
  let timer: number | undefined;
  return {
    setActive(p) {
      players.querySelectorAll("button").forEach((b, i) => b.classList.toggle("active", i === p));
    },
    setAp(used, total) {
      q("ap").textContent = `${used}/${total}`;
    },
    setStats(text) {
      q("stats").textContent = text;
    },
    setBusy(busy) {
      (q("confirm") as HTMLButtonElement).disabled = busy;
    },
    toast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
    },
  };
}
