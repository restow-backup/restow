import { describe, expect, it } from "vitest";

import type { TenantJobKindSummary, TenantJobSummary } from "./api.js";
import {
  ACTIVE_REFRESH_MS,
  attentionRank,
  IDLE_REFRESH_MS,
  matchesFilter,
  outcomeTone,
  refreshIntervalOf,
  sortRows,
  tenantJobFacts,
} from "./presenters.js";

const NONE: TenantJobKindSummary = {
  jobs: 0,
  paused: 0,
  running: 0,
  queued: 0,
  outcome: null,
  failed: 0,
  warning: 0,
  lastRunAt: null,
  nextRunAt: null,
};

function summary(
  tenantId: string,
  kinds: Partial<Record<"mail" | "endpoint" | "pve", Partial<TenantJobKindSummary>>> | null,
): TenantJobSummary {
  return {
    tenantId,
    name: tenantId,
    status: "active",
    kind: "customer",
    state: kinds ? "ok" : "error",
    kinds: kinds
      ? {
          mail: { ...NONE, ...kinds.mail },
          endpoint: { ...NONE, ...kinds.endpoint },
          pve: { ...NONE, ...kinds.pve },
        }
      : null,
  };
}

describe("tenantJobFacts", () => {
  it("adds the kinds up: the worst outcome, the newest last run, the earliest next run", () => {
    const facts = tenantJobFacts(
      summary("a", {
        mail: {
          jobs: 2,
          paused: 1,
          running: 1,
          outcome: "succeeded",
          lastRunAt: "2026-10-14T10:00:00Z",
          nextRunAt: "2026-10-15T22:00:00Z",
        },
        endpoint: {
          jobs: 1,
          queued: 2,
          outcome: "warning",
          lastRunAt: "2026-10-14T12:00:00Z",
          nextRunAt: "2026-10-15T20:00:00Z",
        },
        pve: { jobs: 1, running: 1 },
      }),
    );
    expect(facts).toEqual({
      jobs: { mail: 2, endpoint: 1, pve: 1 },
      total: 4,
      paused: 1,
      running: 2,
      queued: 2,
      outcome: "warning",
      lastRunAt: "2026-10-14T12:00:00Z",
      nextRunAt: "2026-10-15T20:00:00Z",
    });
    expect(tenantJobFacts(summary("b", { pve: { outcome: "failed" } }))?.outcome).toBe("failed");
  });

  it("has no facts for a tenant whose figures could not be read, or that is missing", () => {
    expect(tenantJobFacts(summary("x", null))).toBeNull();
    expect(tenantJobFacts(undefined)).toBeNull();
  });
});

describe("filters", () => {
  const busy = tenantJobFacts(summary("busy", { mail: { jobs: 1, running: 1 } }));
  const failing = tenantJobFacts(summary("failing", { endpoint: { jobs: 1, outcome: "failed" } }));
  const empty = tenantJobFacts(summary("empty", {}));
  const waiting = tenantJobFacts(summary("waiting", { mail: { jobs: 1, queued: 1 } }));

  it("keeps the tenants with running jobs, with failures, or without any job", () => {
    expect([busy, failing, empty, waiting].map((f) => matchesFilter(f, "running"))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([busy, failing, empty, waiting].map((f) => matchesFilter(f, "failures"))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([busy, failing, empty, waiting].map((f) => matchesFilter(f, "noJobs"))).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  it("shows a tenant without figures under all only", () => {
    expect(matchesFilter(null, "all")).toBe(true);
    expect(matchesFilter(null, "running")).toBe(false);
    expect(matchesFilter(null, "failures")).toBe(false);
    expect(matchesFilter(null, "noJobs")).toBe(false);
  });
});

describe("sortRows", () => {
  const row = (name: string, kinds: Parameters<typeof summary>[1]) => ({
    tenant: { name },
    facts: tenantJobFacts(summary(name, kinds)),
  });
  const rows = [
    row("Own", { mail: { jobs: 1, outcome: "succeeded", nextRunAt: "2026-10-16T01:00:00Z" } }),
    row("Alpha", { mail: { jobs: 1, running: 1, nextRunAt: "2026-10-15T23:00:00Z" } }),
    row("Beta", { pve: { jobs: 1, outcome: "failed" } }),
    row("Gamma", null),
    row("Delta", { endpoint: { jobs: 1, outcome: "warning", nextRunAt: "2026-10-15T21:00:00Z" } }),
  ];

  it("keeps the order it was given by name", () => {
    expect(sortRows(rows, "name").map((r) => r.tenant.name)).toEqual([
      "Own",
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
  });

  it("puts failures first, then missing figures, warnings and running work", () => {
    expect(sortRows(rows, "attention").map((r) => r.tenant.name)).toEqual([
      "Beta",
      "Gamma",
      "Delta",
      "Alpha",
      "Own",
    ]);
    expect(attentionRank(null)).toBe(1);
  });

  it("orders by the next run, tenants with nothing planned last", () => {
    expect(sortRows(rows, "nextRun").map((r) => r.tenant.name)).toEqual([
      "Delta",
      "Alpha",
      "Own",
      "Beta",
      "Gamma",
    ]);
  });
});

describe("refresh and tone", () => {
  it("asks often while something runs or waits anywhere", () => {
    expect(refreshIntervalOf([summary("a", { mail: { jobs: 1 } })])).toBe(IDLE_REFRESH_MS);
    expect(refreshIntervalOf([summary("a", { pve: { queued: 1 } })])).toBe(ACTIVE_REFRESH_MS);
    expect(refreshIntervalOf(undefined)).toBe(IDLE_REFRESH_MS);
  });

  it("never shows a backup that went through in green", () => {
    expect(outcomeTone("succeeded")).toBe("neutral");
    expect(outcomeTone("failed")).toBe("destructive");
    expect(outcomeTone("warning")).toBe("warning");
    expect(outcomeTone(null)).toBe("muted");
  });
});
