import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENDPOINT_PLAN,
  ENDPOINT_RUN_TABLES,
  FIRST_RUN_TABLES,
  MAIL_PLAN,
  RUN_TABLES,
  type RunWindow,
  assertMovable,
  simulatedTargets,
} from "./backdate.js";

const DAY = 24 * 60 * 60 * 1000;
const ANCHOR = new Date("2026-09-30T01:30:00.000Z");

describe("simulatedTargets", () => {
  it("puts the newest run at the anchor and each earlier one a day before", () => {
    const targets = simulatedTargets(ANCHOR, 31);
    expect(targets).toHaveLength(31);
    expect(targets[30]).toEqual(ANCHOR);
    for (let i = 0; i < 30; i++) {
      const daysBack = 30 - i;
      const offset = ANCHOR.getTime() - (targets[i] as Date).getTime() - daysBack * DAY;
      expect(Math.abs(offset)).toBeLessThanOrEqual(20 * 60_000);
    }
  });

  it("is the same for the same anchor and seed", () => {
    expect(simulatedTargets(ANCHOR, 10)).toEqual(simulatedTargets(ANCHOR, 10));
  });

  it("keeps the runs in order", () => {
    const targets = simulatedTargets(ANCHOR, 31).map((d) => d.getTime());
    expect([...targets].sort((a, b) => a - b)).toEqual(targets);
  });
});

describe("assertMovable", () => {
  const minutes = (n: number) => n * 60_000;
  function windowsOf(count: number, runMinutes: number): RunWindow[] {
    const start = ANCHOR.getTime();
    const raw = Array.from({ length: count }, (_, i) => ({
      start: new Date(start + minutes(i * runMinutes)),
      end: new Date(start + minutes((i + 1) * runMinutes)),
    }));
    const targets = simulatedTargets(raw[count - 1]?.start as Date, count);
    return raw.map((w, i) => ({ ...w, target: targets[i] as Date }));
  }

  it("accepts a history whose runs move to earlier days", () => {
    expect(() => assertMovable(windowsOf(31, 3))).not.toThrow();
  });

  it("refuses a run that would land inside a later run's window", () => {
    const windows = windowsOf(3, 3);
    const later = windows[2] as RunWindow;
    (windows[0] as RunWindow).target = new Date(later.start.getTime());
    expect(() => assertMovable(windows)).toThrow(/later run/);
  });

  it("refuses a window that ends before it starts", () => {
    const w: RunWindow = { start: new Date(ANCHOR.getTime() + 1000), end: ANCHOR, target: ANCHOR };
    expect(() => assertMovable([w])).toThrow(/ends before/);
  });
});

describe("backdate plans", () => {
  it("move the mailbox history's tables for the mail history and the endpoint tables for the machines", () => {
    expect(MAIL_PLAN).toEqual({ runTables: RUN_TABLES, firstRunTables: FIRST_RUN_TABLES });
    expect(ENDPOINT_PLAN.runTables).toEqual(ENDPOINT_RUN_TABLES);
    expect(ENDPOINT_PLAN.firstRunTables).toEqual([]);
    // The two histories never touch the same table, so each can be moved on its own.
    for (const table of ENDPOINT_RUN_TABLES) {
      expect([...RUN_TABLES, ...FIRST_RUN_TABLES] as string[]).not.toContain(table);
    }
  });

  it("only names tables that exist in the endpoint schema", () => {
    const schema = readFileSync(
      new URL("../../../../packages/db/src/schema/endpoints.ts", import.meta.url),
      "utf8",
    );
    for (const table of ENDPOINT_RUN_TABLES) {
      expect(schema, table).toContain(`pgTable(\n  "${table}"`);
    }
  });

  it("never touches the append-only tables", () => {
    for (const table of [...ENDPOINT_RUN_TABLES, ...RUN_TABLES, ...FIRST_RUN_TABLES]) {
      expect(table).not.toMatch(/^(audit_|archive_)/);
    }
  });
});
