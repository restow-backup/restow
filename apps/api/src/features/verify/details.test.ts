import { describe, expect, it } from "vitest";
import { parseCountSummary, parseDetails, parseReasons, parseScrubReport } from "./details.js";

const verifyDetails = {
  format: 1,
  origin: "verify",
  kind: "verify",
  scope: "sample",
  seed: 42,
  quota: { mail: 20, file: 20, event: 5, contact: 5 },
  snapshot: {
    id: "3f2b1c0d-1111-4222-8333-444455556666",
    sequence: 7,
    completedAt: "2026-09-20T02:00:00.000Z",
    itemCount: 812,
    packCount: 4,
  },
  reasons: [{ code: "items_mismatched", severity: "red", count: 1 }],
  counts: {
    eligible: { mail: 700, file: 0, event: 80, contact: 30 },
    sampled: { mail: 20, file: 0, event: 5, contact: 5 },
    checked: 30,
    bytesRead: 123456,
    verified: 29,
    mismatch: 1,
    missing: 0,
    unreadable: 0,
  },
  items: [
    {
      path: "mail/Inbox/1.eml",
      id: "AAMk1",
      category: "mail",
      size: 100,
      bytesRead: 100,
      chunks: 1,
      status: "mismatch",
      objectHash: "mismatched",
      reason: "SHA-256 of the object differs from the manifest",
    },
    { path: "broken" },
  ],
  itemsOmitted: 0,
  damagedPacks: [],
  testRestore: null,
  startedAt: "2026-09-20T03:00:00.000Z",
  durationMs: 812,
};

describe("parseDetails", () => {
  it("reads a verify report and drops entries it cannot understand", () => {
    const details = parseDetails(verifyDetails);
    expect(details.origin).toBe("verify");
    if (details.origin !== "verify") {
      return;
    }
    expect(details.snapshot?.sequence).toBe(7);
    expect(details.counts.checked).toBe(30);
    expect(details.items).toHaveLength(1);
    expect(details.items[0]).toMatchObject({ status: "mismatch", objectHash: "mismatched" });
  });

  it("fills honest defaults for fields an older worker did not write", () => {
    const details = parseDetails({ origin: "verify", reasons: [] });
    expect(details).toMatchObject({
      origin: "verify",
      scope: "sample",
      snapshot: null,
      items: [],
      testRestore: null,
      counts: { checked: 0, verified: 0 },
    });
  });

  it("reads a scrub finding", () => {
    const details = parseDetails({
      origin: "scrub",
      kind: "health_check",
      scrubJobId: "job-1",
      reasons: [{ code: "storage_corrupt", severity: "red", count: 1 }],
      packs: [
        {
          path: "tenants/t/packs/ab/p1",
          targets: [{ target: 0, status: "hash_mismatch", detail: null, repaired: false }],
        },
      ],
    });
    expect(details).toEqual({
      origin: "scrub",
      scrubJobId: "job-1",
      packs: [
        {
          path: "tenants/t/packs/ab/p1",
          targets: [{ target: 0, status: "hash_mismatch", detail: null, repaired: false }],
        },
      ],
    });
  });

  it("reports unknown shapes as unknown instead of failing", () => {
    expect(parseDetails(null)).toEqual({ origin: "unknown" });
    expect(parseDetails({ origin: "future" })).toEqual({ origin: "unknown" });
  });
});

describe("parseReasons", () => {
  it("keeps valid reasons with nullable parameters", () => {
    expect(
      parseReasons([
        { code: "snapshot_stale", severity: "yellow", ageHours: 60 },
        { code: "no_snapshot", severity: "red" },
        { code: "x", severity: "purple" },
        "nonsense",
      ]),
    ).toMatchObject([
      { code: "snapshot_stale", severity: "yellow", count: null, ageHours: 60 },
      { code: "no_snapshot", severity: "red", count: null, ageHours: null },
    ]);
    expect(parseReasons(undefined)).toEqual([]);
  });

  it("explains each reason with its cause, dated at the report", () => {
    const at = new Date("2026-09-29T10:00:00.000Z");
    const [mismatch, unknown] = parseReasons(
      [
        { code: "items_mismatched", severity: "red", count: 3 },
        { code: "from_the_future", severity: "yellow" },
      ],
      at,
    );
    expect(mismatch?.failure).toMatchObject({
      code: "verify.hash_mismatch",
      category: "verify",
      params: { count: 3 },
      occurredAt: "2026-09-29T10:00:00.000Z",
      steps: expect.arrayContaining([expect.objectContaining({ id: "run_backup_again" })]),
    });
    expect(mismatch?.failure?.docsUrl).toMatch(/^https?:\/\//);
    // A reason code this version does not know keeps its generic text.
    expect(unknown?.failure).toBeNull();
  });
});

describe("parseCountSummary", () => {
  it("adds every kind of failure together", () => {
    expect(
      parseCountSummary({ checked: 30, verified: 26, mismatch: 1, missing: 2, unreadable: 1 }),
    ).toEqual({ checked: 30, verified: 26, failed: 4 });
    expect(parseCountSummary(null)).toBeNull();
  });
});

describe("parseScrubReport", () => {
  it("reads a stored scrub report", () => {
    const report = parseScrubReport({
      format: 1,
      mode: "full",
      seed: null,
      packsTotal: 10,
      packsChecked: 10,
      bytesChecked: 1000,
      ok: 8,
      repaired: [{ packId: "p1", path: "a", size: 1, status: "repaired", targets: [] }],
      corrupt: [{ packId: "p2", path: "b", size: 1, status: "corrupt", targets: [] }],
      retired: ["tenants/t/packs/aa/old"],
      gc: { status: "skipped", reason: "backup_running" },
      orphans: null,
      startedAt: "2026-09-20T03:00:00.000Z",
      durationMs: 5000,
    });
    expect(report).toMatchObject({
      mode: "full",
      ok: 8,
      repaired: [{ path: "a" }],
      corrupt: [{ path: "b" }],
      retired: 1,
      gc: { status: "skipped", reason: "backup_running" },
    });
  });

  it("counts skipped packs of a completed collection", () => {
    const report = parseScrubReport({
      mode: "full",
      gc: {
        status: "completed",
        packsExamined: 3,
        packsRewritten: 1,
        packsRemoved: 1,
        chunksDropped: 9,
        bytesReclaimed: 4096,
        conflicts: 0,
        skipped: [{ path: "x", reason: "unreadable" }],
        interruptedBy: null,
      },
    });
    // Reports from before damaged packs were retired have no list.
    expect(report?.retired).toBe(0);
    expect(report?.gc).toEqual({
      status: "completed",
      packsRewritten: 1,
      packsRemoved: 1,
      chunksDropped: 9,
      bytesReclaimed: 4096,
      conflicts: 0,
      interruptedBy: null,
      skipped: 1,
    });
  });

  it("returns null when a job stored no report", () => {
    expect(parseScrubReport(undefined)).toBeNull();
  });
});
