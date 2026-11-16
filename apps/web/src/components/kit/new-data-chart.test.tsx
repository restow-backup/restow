import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { byteAxisTicks } from "./chart-grid.js";
import {
  NEW_DATA_CAP_FACTOR,
  NewDataChart,
  type NewDataPoint,
  newDataRows,
} from "./new-data-chart.js";
import { count, render } from "./test-utils.js";

/** The "new data per backup" chart of a guest's and a machine's page (#58). */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const point = (day: number, added: number, type?: NewDataPoint["type"]): NewDataPoint => ({
  id: `p-${day}`,
  at: new Date(Date.UTC(2026, 9, day, 22)).toISOString(),
  added,
  type,
});

/** A first backup of 32 GB and follow-ups of about 200 MB: the issue's example. */
const GUEST = [
  point(3, 32 * GiB, "first"),
  point(4, 210 * MiB, "incremental"),
  point(5, 180 * MiB, "incremental"),
  point(6, 150 * MiB, "incremental"),
];

describe("newDataRows", () => {
  it("scales to the follow-ups and cuts a first backup far above them", () => {
    const { rows, ticks } = newDataRows(GUEST);
    const top = ticks.at(-1) ?? 0;
    expect(top).toBeGreaterThanOrEqual(210 * MiB);
    expect(top).toBeLessThan(32 * GiB);
    expect(rows[0]).toMatchObject({ series: "first", bytes: 32 * GiB, cut: true, first: top });
    expect(rows[1]).toMatchObject({ series: "incremental", bytes: 210 * MiB, cut: false });
    expect(rows[1]?.incremental).toBe(210 * MiB);
  });

  it("draws everything to one scale while the full backup is not far above the rest", () => {
    const close = [
      point(3, 300 * MiB, "first"),
      point(4, 210 * MiB, "incremental"),
      point(5, 180 * MiB, "incremental"),
    ];
    expect(300 / 210).toBeLessThan(NEW_DATA_CAP_FACTOR);
    const { rows, ticks } = newDataRows(close);
    expect(rows.some((row) => row.cut)).toBe(false);
    expect(ticks).toEqual(byteAxisTicks(300 * MiB));
    // With a single follow-up the scale stays honest as well (nothing to compare it with).
    expect(newDataRows([point(3, 32 * GiB, "first"), point(4, MiB)]).rows[0]?.cut).toBe(false);
  });

  it("cuts a machine's backup far above the rest although it has no type", () => {
    // A machine's first snapshot of 50 GB next to follow-ups of about 200 MB.
    const machine = [point(1, 50 * GiB), point(2, 210 * MiB), point(3, 180 * MiB), point(4, MiB)];
    const { rows, ticks } = newDataRows(machine);
    const top = ticks.at(-1) ?? 0;
    expect(ticks).toEqual(byteAxisTicks(210 * MiB));
    expect(rows[0]).toMatchObject({ series: "backup", bytes: 50 * GiB, cut: true, backup: top });
    expect(rows.slice(1).some((row) => row.cut)).toBe(false);
  });

  it("cuts every untyped backup above the first large step, not only the largest", () => {
    const { rows } = newDataRows([
      point(1, 50 * GiB),
      point(2, 40 * GiB),
      point(3, 210 * MiB),
      point(4, 180 * MiB),
    ]);
    expect(rows.map((row) => row.cut)).toEqual([true, true, false, false]);
  });

  it("keeps untyped backups on one scale without a large step or with too few below it", () => {
    // Follow-ups of different size, no step of more than the factor between neighbours.
    const spread = newDataRows([point(1, 600 * MiB), point(2, 200 * MiB), point(3, 60 * MiB)]);
    expect(spread.rows.some((row) => row.cut)).toBe(false);
    expect(spread.ticks).toEqual(byteAxisTicks(600 * MiB));
    // A single backup below the step: nothing to compare it with.
    expect(newDataRows([point(1, 50 * GiB), point(2, MiB)]).rows.some((row) => row.cut)).toBe(
      false,
    );
  });

  it("puts a machine's untyped points into one series", () => {
    const { rows } = newDataRows([point(1, MiB), point(2, 2 * MiB)]);
    expect(rows.map((row) => row.series)).toEqual(["backup", "backup"]);
  });
});

describe("NewDataChart", () => {
  it("draws nothing with fewer than two backups", () => {
    expect(render(<NewDataChart points={[point(3, GiB, "first")]} />)).toBe("");
  });

  it("has a title, a text alternative and a table of every bar", () => {
    const html = render(<NewDataChart points={GUEST} />);
    expect(html).toContain("New data per backup");
    expect(html).toContain('data-slot="chart"');
    // The sentence for screen readers.
    expect(html).toContain(
      "New data of the last 4 backups: from 150 MB to 32 GB, the newest added 150 MB.",
    );
    // The table fallback behind "Show as table": a row per bar with its real size.
    expect(html).toContain("Show as table");
    expect(html).toMatch(/<details[^>]*data-slot="new-data-table"/);
    expect(count(html, "<tr")).toBe(1 + GUEST.length);
    expect(html).toContain("32 GB");
    expect(html).toContain("First backup");
    expect(html).toContain("Follow-up backup");
  });

  it("names the bar it cut at the top of the scale", () => {
    const html = render(<NewDataChart points={GUEST} />);
    expect(html).toMatch(
      /data-slot="new-data-cut">Cut at the top of the scale so that the follow-up backups stay readable: Oct 3 \(First backup, 32 GB\)\./,
    );
  });

  it("is never green: sizes prove nothing", () => {
    const html = render(<NewDataChart points={[...GUEST, point(7, 4 * GiB, "full_read")]} />);
    expect(html).toContain("--color-first: var(--chart-4)");
    expect(html).toContain("--color-fullRead: var(--chart-3)");
    expect(html).toContain("--color-incremental: var(--chart-1)");
    expect(html).not.toContain("chart-success");
    expect(html).not.toContain("chart-5");
    expect(html).not.toContain("--success");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = render(<NewDataChart points={GUEST} />);
      expect(html).toContain("Neue Daten je Sicherung");
      expect(html).toContain("Als Tabelle anzeigen");
      expect(html).toContain("Erste Sicherung");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
