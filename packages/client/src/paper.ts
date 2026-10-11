import Phaser from "phaser";
import { Terrain, TERRAIN_CELL } from "@cardboard/sim";
import type { State } from "@cardboard/sim";
import { PEN_CSS, toPx } from "./world";

/** Детерминированный ГПСЧ для «дрожания руки»: рисунок одинаков при каждом запуске. */
function rnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Плитка тетрадного листа в клетку: 32×32 клетки по 20 px. Клетка листа = единица длины (диаметр юнита). */
export function makePaperTexture(scene: Phaser.Scene, key = "paper"): void {
  const cell = 20;
  const n = 32;
  const size = cell * n;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#f6f1e4";
  g.fillRect(0, 0, size, size);
  // зерно бумаги
  const r = rnd(11);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `rgba(120,100,60,${0.02 + r() * 0.04})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 1.5, 1 + r() * 1.5);
  }
  // линии клетки (чуть неровные, как печатные)
  g.strokeStyle = "rgba(120,150,205,0.38)";
  g.lineWidth = 1;
  for (let i = 0; i <= n; i++) {
    const p = i * cell + 0.5;
    g.beginPath();
    g.moveTo(p, 0);
    g.lineTo(p, size);
    g.stroke();
    g.beginPath();
    g.moveTo(0, p);
    g.lineTo(size, p);
    g.stroke();
  }
  if (scene.textures.exists(key)) scene.textures.remove(key);
  scene.textures.addCanvas(key, c);
}

/** Рисованный кружок юнита: слегка неровная окружность, дважды обведённая, с меткой владельца внутри. */
export function makeUnitTextures(scene: Phaser.Scene): void {
  const marks = ["dot", "plus", "cross", "tri"] as const;
  PEN_CSS.forEach((color, i) => {
    const s = 28;
    const c = document.createElement("canvas");
    c.width = s;
    c.height = s;
    const g = c.getContext("2d")!;
    const r = rnd(100 + i);
    const cx = s / 2;
    const cy = s / 2;
    const R = 9;
    g.strokeStyle = color;
    g.lineCap = "round";
    g.lineJoin = "round";
    for (let pass = 0; pass < 2; pass++) {
      g.lineWidth = pass === 0 ? 2 : 1.1;
      g.beginPath();
      const steps = 18;
      const off = r() * 0.6;
      for (let k = 0; k <= steps + 1; k++) {
        const a = (k / steps) * Math.PI * 2 + off;
        const rr = R * (1 + (r() - 0.5) * (pass === 0 ? 0.12 : 0.2)) + (pass ? 0.6 : 0);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.lineWidth = 1.8;
    g.fillStyle = color;
    switch (marks[i]) {
      case "dot":
        g.beginPath();
        g.arc(cx, cy, 2.2, 0, Math.PI * 2);
        g.fill();
        break;
      case "plus":
        g.beginPath();
        g.moveTo(cx - 3.5, cy);
        g.lineTo(cx + 3.5, cy);
        g.moveTo(cx, cy - 3.5);
        g.lineTo(cx, cy + 3.5);
        g.stroke();
        break;
      case "cross":
        g.beginPath();
        g.moveTo(cx - 3, cy - 3);
        g.lineTo(cx + 3, cy + 3);
        g.moveTo(cx + 3, cy - 3);
        g.lineTo(cx - 3, cy + 3);
        g.stroke();
        break;
      case "tri":
        g.beginPath();
        g.moveTo(cx, cy - 3.6);
        g.lineTo(cx + 3.4, cy + 2.6);
        g.lineTo(cx - 3.4, cy + 2.6);
        g.closePath();
        g.stroke();
        break;
    }
    const key = `unit${i}`;
    if (scene.textures.exists(key)) scene.textures.remove(key);
    scene.textures.addCanvas(key, c);
  });
}

/** Рельеф штрихами: стена — густая штриховка, бездорожье — точки, дорога — две линии вдоль. Рисуется один раз. */
export function drawTerrain(g: Phaser.GameObjects.Graphics, s: State): void {
  const C = toPx(TERRAIN_CELL);
  const r = rnd(5);
  g.clear();
  for (let y = 0; y < s.th; y++) {
    for (let x = 0; x < s.tw; x++) {
      const t = s.terrain[y * s.tw + x];
      const px = x * C;
      const py = y * C;
      if (t === Terrain.Blocked) {
        g.fillStyle(0x3a3d46, 0.12);
        g.fillRect(px, py, C, C);
        g.lineStyle(1.2, 0x2b2e36, 0.75);
        for (let k = -C; k < C; k += 5) {
          const x0 = px + Math.max(0, k);
          const y0 = py + Math.max(0, -k);
          const len = Math.min(C - Math.max(0, k), C - Math.max(0, -k));
          g.lineBetween(x0, y0 + len, x0 + len, y0);
        }
        g.lineStyle(1.6, 0x23262d, 0.9);
        g.strokeRect(px + (r() - 0.5), py + (r() - 0.5), C, C);
      } else if (t === Terrain.Rough) {
        g.fillStyle(0x6f6a55, 0.5);
        for (let k = 0; k < 9; k++) g.fillCircle(px + r() * C, py + r() * C, 0.9);
      } else if (t === Terrain.Road) {
        g.lineStyle(1.3, 0x8a7a55, 0.7);
        const horiz = x > 0 && x < s.tw - 1 && s.terrain[y * s.tw + x - 1] === Terrain.Road;
        if (horiz) {
          g.lineBetween(px, py + C * 0.3, px + C, py + C * 0.3);
          g.lineBetween(px, py + C * 0.7, px + C, py + C * 0.7);
        } else {
          g.lineBetween(px + C * 0.3, py, px + C * 0.3, py + C);
          g.lineBetween(px + C * 0.7, py, px + C * 0.7, py + C);
        }
      }
    }
  }
}
