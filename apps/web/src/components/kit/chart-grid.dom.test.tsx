// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HORIZONTAL_GRID, VALUE_AXIS_INTERVAL, VERTICAL_GRID } from "./chart-grid.js";

/**
 * recharts' CartesianGrid measures axis labels with `fontSize` and
 * `letterSpacing` set to `undefined`, which Firefox reports as a dropped CSS
 * declaration for every label on every render. The grid presets plus a value
 * axis that shows every tick never measure that way.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = Array.from({ length: 30 }, (_, index) => ({
  day: `2026-09-${String(index + 1).padStart(2, "0")}`,
  bytes: 1000 + index * 50,
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let undefinedStyles: string[] = [];

beforeEach(() => {
  undefinedStyles = [];
  // recharts measures text by assigning a style object to a hidden span
  // (`Object.assign(span.style, …)`); record keys it assigns as undefined.
  const assign = Object.assign;
  vi.spyOn(Object, "assign").mockImplementation(((target: object, ...sources: object[]) => {
    if (target instanceof CSSStyleDeclaration) {
      for (const source of sources) {
        for (const [key, value] of Object.entries(source ?? {})) {
          if (value === undefined) {
            undefinedStyles.push(key);
          }
        }
      }
    }
    return assign(target, ...sources);
  }) as typeof Object.assign);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

async function renderChart(grid: React.ReactNode, interval?: number): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AreaChart width={640} height={224} data={DATA}>
        {grid}
        <XAxis dataKey="day" minTickGap={32} interval="preserveStartEnd" />
        <YAxis interval={interval} />
        <Area dataKey="bytes" isAnimationActive={false} />
      </AreaChart>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("chart grid presets", () => {
  it("draw no lines in the switched-off direction, without measuring", () => {
    expect(HORIZONTAL_GRID.vertical).toBe(false);
    expect(HORIZONTAL_GRID.verticalCoordinatesGenerator()).toEqual([]);
    expect(VERTICAL_GRID.horizontal).toBe(false);
    expect(VERTICAL_GRID.horizontalCoordinatesGenerator()).toEqual([]);
    expect(VALUE_AXIS_INTERVAL).toBe(0);
  });

  it("measure nothing with an undefined font, where the plain grid does", async () => {
    await renderChart(<CartesianGrid vertical={false} />);
    // The control: recharts' own grid sets undefined font values (what Firefox reports).
    expect(undefinedStyles.length).toBeGreaterThan(0);
    act(() => root?.unmount());
    host?.remove();

    undefinedStyles = [];
    await renderChart(<CartesianGrid {...HORIZONTAL_GRID} />, VALUE_AXIS_INTERVAL);
    expect(undefinedStyles).toEqual([]);
  });
});
