import { describe, expect, it } from "vitest";
import { FAILURE_CATALOG, catalogCovers, catalogEntry } from "./catalog.js";
import { classifyFailure } from "./classify.js";
import { causeOfReadinessReason } from "./readiness.js";
import {
  DEFAULT_DOCS_TROUBLESHOOTING_URL,
  docsTroubleshootingUrl,
  guidanceFor,
  parseFailureRecord,
  recordFailure,
  summarizeFailure,
  toFailureRecord,
} from "./record.js";
import { FAILURE_CODES, FAILURE_STEP_IDS } from "./types.js";

describe("catalog", () => {
  it("has an entry for every code and only known step ids", () => {
    expect(catalogCovers()).toBe(true);
    const knownSteps = new Set<string>(FAILURE_STEP_IDS);
    for (const code of FAILURE_CODES) {
      const entry = FAILURE_CATALOG[code];
      expect(entry, code).toBeDefined();
      const steps = entry.steps({ role: "imap" });
      expect(steps.length, `${code} has steps`).toBeGreaterThan(0);
      for (const step of steps) {
        expect(knownSteps.has(step.id), `${code}: ${step.id}`).toBe(true);
      }
    }
  });

  it("uses every step id somewhere, so no text is written for nothing", () => {
    const used = new Set<string>();
    for (const code of FAILURE_CODES) {
      for (const role of ["imap", "microsoft", null]) {
        for (const step of FAILURE_CATALOG[code].steps({ role })) {
          used.add(step.id);
        }
      }
    }
    expect([...FAILURE_STEP_IDS].filter((id) => !used.has(id))).toEqual([]);
  });

  it("adds IMAP-specific network steps only for IMAP", () => {
    const imap = FAILURE_CATALOG["network.tls"].steps({ role: "imap" }).map((s) => s.id);
    const other = FAILURE_CATALOG["network.tls"].steps({ role: "microsoft" }).map((s) => s.id);
    expect(imap).toContain("check_imap_security");
    expect(other).not.toContain("check_imap_security");
  });

  it("knows nothing about a code from the future", () => {
    expect(catalogEntry("future.code")).toBeNull();
    expect(
      guidanceFor({ code: "future.code" as never, params: {}, transient: false }),
    ).toMatchObject({
      steps: [],
      retryable: true,
    });
  });

  it("marks the causes an operator waits out as transient", () => {
    for (const code of [
      "graph.throttled",
      "graph.service_unavailable",
      "network.timeout",
      "job.interrupted",
    ] as const) {
      expect(FAILURE_CATALOG[code].transient, code).toBe(true);
    }
    for (const code of [
      "graph.consent_missing",
      "imap.auth_failed",
      "storage.full",
      "verify.hash_mismatch",
    ] as const) {
      expect(FAILURE_CATALOG[code].transient, code).toBe(false);
    }
  });
});

describe("failure records", () => {
  const now = new Date("2026-09-29T10:00:00.000Z");

  it("wraps a cause with when, where and retry state", () => {
    const cause = classifyFailure(new Error("boom"));
    const record = toFailureRecord(cause, {
      now,
      step: "download",
      retry: { attempt: 2, limit: 6, nextAttemptAt: "2026-09-29T10:04:00.000Z" },
    });
    expect(record).toMatchObject({
      v: 1,
      code: "unknown",
      occurredAt: "2026-09-29T10:00:00.000Z",
      step: "download",
      retry: { attempt: 2, limit: 6 },
    });
    expect(recordFailure(new Error("boom"), { now }).step).toBeNull();
  });

  it("survives a JSON round trip", () => {
    const record = recordFailure(new Error("Connection terminated unexpectedly"), {
      now,
      step: "commit",
    });
    expect(parseFailureRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it("reads defensively: junk is null, unknown fields are dropped, codes from newer versions are kept", () => {
    expect(parseFailureRecord(null)).toBeNull();
    expect(parseFailureRecord("text")).toBeNull();
    expect(parseFailureRecord({ code: 12 })).toBeNull();
    expect(parseFailureRecord({})).toBeNull();
    const parsed = parseFailureRecord({
      code: "future.code",
      transient: "yes",
      params: { ok: 1, nested: { no: true }, list: [1] },
      technical: { requestId: "abc", huge: "x".repeat(2000), bad: { a: 1 } },
      occurredAt: "not a date",
      retry: { attempt: 1 },
      extra: "ignored",
    });
    expect(parsed?.code).toBe("future.code");
    expect(parsed?.transient).toBe(false);
    expect(parsed?.params).toEqual({ ok: 1 });
    expect(Object.keys(parsed?.technical ?? {}).sort()).toEqual(["huge", "requestId"]);
    expect(String(parsed?.technical.huge).length).toBeLessThanOrEqual(500);
    expect(parsed?.retry).toBeNull();
    expect(parsed?.step).toBeNull();
  });

  it("summarizes for the legacy text columns without secrets", () => {
    const cause = classifyFailure(new Error("hit password=hunter2 problem"));
    expect(summarizeFailure(cause)).toContain("unknown");
    expect(summarizeFailure(cause)).not.toContain("hunter2");
  });

  it("uses the default docs page unless configured", () => {
    expect(docsTroubleshootingUrl()).toBe(DEFAULT_DOCS_TROUBLESHOOTING_URL);
    expect(docsTroubleshootingUrl("  ")).toBe(DEFAULT_DOCS_TROUBLESHOOTING_URL);
    expect(docsTroubleshootingUrl("https://help.example.test/restow")).toBe(
      "https://help.example.test/restow/",
    );
  });
});

describe("readiness reasons", () => {
  it("maps every reason code onto a catalog cause", () => {
    const table: [string, string][] = [
      ["no_snapshot", "verify.no_snapshot"],
      ["manifest_unreadable", "verify.manifest_unreadable"],
      ["items_missing", "verify.chunk_missing"],
      ["items_unreadable", "verify.pack_unreadable"],
      ["items_mismatched", "verify.hash_mismatch"],
      ["storage_corrupt", "verify.storage_corrupt"],
      ["test_restore_failed", "verify.restore_test_failed"],
      ["snapshot_outdated", "verify.snapshot_outdated"],
      ["snapshot_stale", "verify.snapshot_stale"],
      ["nothing_to_verify", "verify.nothing_to_verify"],
      ["test_restore_unconfirmed", "verify.restore_test_unconfirmed"],
    ];
    for (const [reason, code] of table) {
      expect(causeOfReadinessReason({ code: reason, count: 3, ageHours: 60 })?.code, reason).toBe(
        code,
      );
    }
    expect(causeOfReadinessReason({ code: "from_the_future" })).toBeNull();
    expect(causeOfReadinessReason({ code: "items_mismatched", count: 3 })?.params).toEqual({
      count: 3,
    });
  });
});
