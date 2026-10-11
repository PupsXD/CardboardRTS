import { describe, expect, it } from "vitest";
import { MAX_PATH_POINTS } from "@cardboard/sim";
import type { Point } from "@cardboard/sim";
import { simplifyPath } from "../src/draw.ts";

const line = (n: number): Point[] => Array.from({ length: n }, (_, i) => [i * 40, 0] as Point);

describe("simplifyPath: рисованная линия → маршрут приказа", () => {
  it("прямая линия сводится к двум точкам", () => {
    expect(simplifyPath(line(50))).toEqual([
      [0, 0],
      [1960, 0],
    ]);
  });

  it("концы сохраняются, излом остаётся", () => {
    const raw: Point[] = [...line(10), ...Array.from({ length: 10 }, (_, i) => [360, (i + 1) * 40] as Point)];
    const out = simplifyPath(raw);
    expect(out[0]).toEqual([0, 0]);
    expect(out[out.length - 1]).toEqual([360, 400]);
    expect(out.some((p) => p[0] === 360 && p[1] === 0)).toBe(true); // угол
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it("сложная кривая укладывается в лимит MAX_PATH_POINTS ядра", () => {
    const raw: Point[] = Array.from({ length: 400 }, (_, i) => [i * 15, Math.round(Math.sin(i / 6) * 500)] as Point);
    const out = simplifyPath(raw);
    expect(out.length).toBeLessThanOrEqual(MAX_PATH_POINTS);
    expect(out.length).toBeGreaterThan(2);
    expect(out[0]).toEqual(raw[0]);
    expect(out[out.length - 1]).toEqual(raw[raw.length - 1]);
  });

  it("результат — целые числа и допустимые для ядра точки", () => {
    const raw: Point[] = Array.from({ length: 60 }, (_, i) => [i * 13.7, i * 7.3] as unknown as Point);
    for (const p of simplifyPath(raw)) {
      expect(Number.isInteger(p[0]) && Number.isInteger(p[1])).toBe(true);
    }
  });
});
