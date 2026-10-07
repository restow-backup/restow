// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  enableActEnvironment,
  flush,
  installMemoryStorage,
  mount,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n";
import { act } from "react";
import { T0, samples } from "../fixtures";
import { ThroughputCharts } from "./throughput-charts";

/**
 * The two charts of the drawer: processing and transfer on one time axis, one crosshair across
 * both, moved by the pointer and by the keyboard, and a text summary as the group's name.
 */

enableActEnvironment();

let mounted: ReturnType<typeof mount> | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

const group = () => document.querySelector<HTMLElement>('[data-slot="throughput-charts"]');
const crosshairs = () => [...document.querySelectorAll<SVGLineElement>('[data-slot="crosshair"]')];
const tooltip = () => document.querySelector<HTMLElement>('[data-slot="chart-tooltip"]');
const status = () => document.querySelector("output")?.textContent ?? "";

async function press(key: string) {
  await act(async () => {
    group()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function show(props: Partial<React.ComponentProps<typeof ThroughputCharts>> = {}) {
  mounted = mount(
    <ThroughputCharts points={samples(40)} running={false} showTransferred {...props} />,
  );
  await flush(2);
}

describe("the throughput charts", () => {
  it("draws processing and transfer as two charts, each with its own scale and its newest value written at its end", async () => {
    await show();
    const charts = [...document.querySelectorAll("[data-chart]")];
    expect(charts.map((chart) => chart.getAttribute("data-chart"))).toEqual([
      "processed",
      "transferred",
    ]);
    // 8 MB per 2 s and 0.4 MB per 2 s: 3.8 MB/s processed and 195 KB/s transferred.
    const ends = [...document.querySelectorAll("svg text")]
      .map((node) => node.textContent ?? "")
      .filter((text) => text.endsWith("/s"));
    expect(ends.some((text) => /MB\/s$/.test(text))).toBe(true);
    expect(ends.some((text) => /kB\/s$/.test(text))).toBe(true);
    // Lapis, 2 px, and a hairline grid (never a colour of its own).
    const line = document.querySelector("polyline");
    expect(line?.getAttribute("stroke")).toBe("var(--chart-info)");
    expect(line?.getAttribute("stroke-width")).toBe("2");
    expect(document.querySelector("polygon")?.getAttribute("fill-opacity")).toBe("0.1");
  });

  it("draws a single chart for a run that writes nothing to a repository", async () => {
    await show({ showTransferred: false });
    expect(document.querySelectorAll("[data-chart]")).toHaveLength(1);
  });

  it("is one tab stop with a text summary as its name, in words and numbers", async () => {
    await show({ running: true });
    expect(group()?.getAttribute("tabindex")).toBe("0");
    expect(group()?.getAttribute("role")).toBe("group");
    const summary = group()?.getAttribute("aria-label") ?? "";
    expect(summary).toContain("Throughput of the last 5 minutes.");
    expect(summary).toMatch(/Processing: now [\d.,]+ \w+\/s, average [\d.,]+ \w+\/s, peak/);
    // The transfer is an average and says over how long; the processing is as measured.
    expect(summary).toMatch(/Transfer to the storage location \(average over 15 s\): now/);
    expect(summary).not.toMatch(/Processing \(average/);
    expect(summary).toContain("arrow keys");
    // A finished run's summary speaks of the whole run.
    await mounted?.unmount();
    await show({ running: false });
    expect(group()?.getAttribute("aria-label")).toContain("Throughput of the whole run.");
  });

  it("says under the transfer chart, and only there, that it is an average over 15 seconds", async () => {
    await show();
    const hint = (key: string) =>
      document.querySelector(`[data-chart="${key}"] .text-muted-foreground`)?.textContent ?? "";
    expect(hint("transferred")).toContain("average over 15 s");
    expect(hint("processed")).not.toContain("average over");
  });

  it("draws the transfer of a steady upload that arrives in packs as a steady line, and says its value", async () => {
    const MIB = 1024 * 1024;
    // 15 MiB reach the repository every third measurement, 5 s apart: 3 MiB/s raw, 1 MiB/s on average.
    const packs = Array.from({ length: 40 }, (_, index): [number, number, number] => [
      T0 + index * 5000,
      index * 8 * MIB,
      Math.floor(index / 3) * 15 * MIB,
    ]);
    await show({ points: packs });
    const line = document.querySelector('[data-chart="transferred"] polyline');
    const ys = (line?.getAttribute("points") ?? "")
      .split(" ")
      .map((pair) => Number(pair.split(",")[1]));
    // After the first window every point sits on the same height: a line, not a square wave.
    const steady = ys.slice(4);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThan(0.2);
    // The end label and the tooltip carry the average, 1 MB/s, not the 3 MB/s of the last pack.
    const labels = [...document.querySelectorAll('[data-chart="transferred"] svg text')].map(
      (node) => node.textContent,
    );
    expect(labels).toContain("1 MB/s");
    expect(labels).not.toContain("3 MB/s");
    await press("End");
    expect(tooltip()?.textContent).toContain("1 MB/s");
    expect(status()).toContain("Transfer to the storage location (average over 15 s): 1 MB/s");
    expect(status()).toMatch(/Processing: [\d.,]+ \w+\/s/);
    expect(status()).not.toContain("Processing (average");
  });

  it("draws no crosshair until a key or the pointer asks for one", async () => {
    await show();
    expect(crosshairs()).toHaveLength(0);
    expect(tooltip()).toBeNull();
  });

  it("moves one crosshair across both charts with the arrow keys, starting at the newest step", async () => {
    await show();
    group()?.focus();
    await press("ArrowLeft");
    const first = crosshairs();
    // The same moment in both charts.
    expect(first).toHaveLength(2);
    expect(first[0]?.getAttribute("x1")).toBe(first[1]?.getAttribute("x1"));
    const x = Number(first[0]?.getAttribute("x1"));
    await press("ArrowLeft");
    expect(Number(crosshairs()[0]?.getAttribute("x1"))).toBeLessThan(x);
    expect(crosshairs()[0]?.getAttribute("x1")).toBe(crosshairs()[1]?.getAttribute("x1"));
    await press("ArrowRight");
    expect(Number(crosshairs()[0]?.getAttribute("x1"))).toBeCloseTo(x, 1);
  });

  it("jumps to the ends with Home and End and stops there", async () => {
    await show();
    await press("Home");
    const start = Number(crosshairs()[0]?.getAttribute("x1"));
    await press("ArrowLeft");
    expect(Number(crosshairs()[0]?.getAttribute("x1"))).toBe(start);
    await press("End");
    const end = Number(crosshairs()[0]?.getAttribute("x1"));
    expect(end).toBeGreaterThan(start);
    await press("ArrowRight");
    expect(Number(crosshairs()[0]?.getAttribute("x1"))).toBe(end);
  });

  it("names the moment and both values in a tooltip, and reads them out to a screen reader", async () => {
    await show({ running: true });
    await press("End");
    expect(tooltip()?.textContent).toContain("now");
    expect(tooltip()?.textContent).toMatch(/Processing/);
    expect(tooltip()?.textContent).toMatch(/Transfer to the storage location/);
    expect(tooltip()?.textContent).toMatch(/[\d.,]+ [kKM]B\/s/);
    expect(status()).toContain("now");
    expect(status()).toMatch(/Processing: [\d.,]+ [kKM]B\/s/);
    await press("ArrowLeft");
    // Further back in time reads as a distance from now.
    expect(tooltip()?.textContent).toMatch(/\d+:\d\d ago/);
  });

  it("lets go of the crosshair with Escape and when the focus leaves", async () => {
    await show();
    await press("End");
    expect(crosshairs()).toHaveLength(2);
    await press("Escape");
    expect(crosshairs()).toHaveLength(0);
    await press("End");
    await act(async () => {
      group()?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(crosshairs()).toHaveLength(0);
  });

  it("follows the pointer: the step nearest the pointer in time, in both charts", async () => {
    await show();
    const hit = document.querySelector<SVGRectElement>('[data-chart="processed"] rect');
    // A box 700 units wide drawn 700 px wide, so a pointer position is a position in the plot.
    Object.defineProperty(hit, "getBoundingClientRect", {
      value: () => ({
        left: 48,
        width: 568,
        top: 0,
        height: 92,
        right: 616,
        bottom: 92,
        x: 48,
        y: 0,
      }),
    });
    await act(async () => {
      const event = new Event("pointermove", { bubbles: true });
      Object.assign(event, { clientX: 48 + 568 / 2 });
      hit?.dispatchEvent(event);
      await Promise.resolve();
    });
    const lines = crosshairs();
    expect(lines).toHaveLength(2);
    const middle = 48 + (700 - 48 - 84) / 2;
    expect(Number(lines[0]?.getAttribute("x1"))).toBeGreaterThan(middle - 20);
    expect(Number(lines[0]?.getAttribute("x1"))).toBeLessThan(middle + 20);
    expect(lines[0]?.getAttribute("x1")).toBe(lines[1]?.getAttribute("x1"));
  });

  it("shows the last five minutes of a running run and all of a finished one", async () => {
    // 200 steps of 2 s: 400 s in all.
    const points = samples(201);
    await show({ points, running: true });
    const running = [...document.querySelectorAll("svg text")].map((node) => node.textContent);
    expect(running).toContain("now");
    await mounted?.unmount();
    await show({ points, running: false });
    const finished = [...document.querySelectorAll("svg text")].map((node) => node.textContent);
    expect(finished).toContain("after 0:00");
    expect(finished.some((text) => /after 6:40/.test(text ?? ""))).toBe(true);
  });

  it("keeps a held crosshair on a step when new measurements arrive, and never past the end", async () => {
    await show({ points: samples(10) });
    await press("End");
    await mounted?.render(
      <ThroughputCharts points={samples(10)} running={false} showTransferred />,
    );
    expect(crosshairs()).toHaveLength(2);
    // Fewer steps than before: the crosshair falls back to the newest one.
    await mounted?.render(<ThroughputCharts points={samples(4)} running={false} showTransferred />);
    expect(crosshairs()).toHaveLength(2);
  });
});
