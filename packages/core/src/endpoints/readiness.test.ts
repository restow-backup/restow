import { describe, expect, it } from "vitest";
import { type ReadinessReportFact, endpointReadiness, endpointVerifyOverdue } from "./readiness.js";

const at = (iso: string) => new Date(iso);
const SNAPSHOT = "a".repeat(64);
const OLDER = "b".repeat(64);

const test = (
  readiness: "green" | "red",
  when: string,
  overrides: Partial<ReadinessReportFact> = {},
): ReadinessReportFact => ({
  kind: "restore_test",
  origin: "server",
  snapshotId: SNAPSHOT,
  readiness,
  checkedAt: at(when),
  ...overrides,
});

describe("endpoint readiness", () => {
  it("has no rating without a good backup", () => {
    expect(
      endpointReadiness({ latestSnapshotId: null, latestBackupPartial: false, reports: [] }).state,
    ).toBe("no_backup");
  });

  it("is unverified until the newest backup was restore-tested", () => {
    const result = endpointReadiness({
      latestSnapshotId: SNAPSHOT,
      latestBackupPartial: false,
      reports: [],
    });
    expect(result).toEqual({ state: "unverified", checkedAt: null, basis: null });
    // A green test of an OLDER backup says nothing about the newest one.
    const older = endpointReadiness({
      latestSnapshotId: SNAPSHOT,
      latestBackupPartial: false,
      reports: [test("green", "2026-09-01T00:00:00Z", { snapshotId: OLDER })],
    });
    expect(older.state).toBe("unverified");
  });

  it("is green only after a restore test with matching hashes", () => {
    const result = endpointReadiness({
      latestSnapshotId: SNAPSHOT,
      latestBackupPartial: false,
      reports: [test("green", "2026-09-30T10:00:00Z")],
    });
    expect(result).toEqual({
      state: "green",
      checkedAt: at("2026-09-30T10:00:00Z"),
      basis: "restore_test",
    });
  });

  it("is yellow when the backup itself was partial", () => {
    const result = endpointReadiness({
      latestSnapshotId: SNAPSHOT,
      latestBackupPartial: true,
      reports: [test("green", "2026-09-30T10:00:00Z")],
    });
    expect(result.state).toBe("yellow");
  });

  it("is red when a restore test failed, whichever side ran it", () => {
    for (const origin of ["server", "agent"] as const) {
      const result = endpointReadiness({
        latestSnapshotId: SNAPSHOT,
        latestBackupPartial: false,
        reports: [
          test("green", "2026-09-30T10:00:00Z"),
          test("red", "2026-09-30T11:00:00Z", { origin }),
        ],
      });
      expect(result.state, origin).toBe("red");
      expect(result.basis).toBe("restore_test");
    }
  });

  it("lets a newer test of the same side replace an older failure", () => {
    const result = endpointReadiness({
      latestSnapshotId: SNAPSHOT,
      latestBackupPartial: false,
      reports: [test("red", "2026-09-30T09:00:00Z"), test("green", "2026-09-30T10:00:00Z")],
    });
    expect(result.state).toBe("green");
  });

  it("is red when a repository check found damage after the last test", () => {
    const check: ReadinessReportFact = {
      kind: "repository_check",
      origin: "server",
      snapshotId: null,
      readiness: "red",
      checkedAt: at("2026-09-30T12:00:00Z"),
    };
    expect(
      endpointReadiness({
        latestSnapshotId: SNAPSHOT,
        latestBackupPartial: false,
        reports: [test("green", "2026-09-30T10:00:00Z"), check],
      }),
    ).toMatchObject({ state: "red", basis: "repository_check" });
    // A test that ran after the check saw the repository whole again.
    expect(
      endpointReadiness({
        latestSnapshotId: SNAPSHOT,
        latestBackupPartial: false,
        reports: [test("green", "2026-09-30T13:00:00Z"), check],
      }).state,
    ).toBe("green");
    // Damage found with no test at all still rates the endpoint.
    expect(
      endpointReadiness({
        latestSnapshotId: SNAPSHOT,
        latestBackupPartial: false,
        reports: [check],
      }).state,
    ).toBe("red");
  });

  it("ignores retention reports", () => {
    const retention: ReadinessReportFact = {
      kind: "retention",
      origin: "server",
      snapshotId: null,
      readiness: null,
      checkedAt: at("2026-09-30T12:00:00Z"),
    };
    expect(
      endpointReadiness({
        latestSnapshotId: SNAPSHOT,
        latestBackupPartial: false,
        reports: [retention],
      }).state,
    ).toBe("unverified");
  });

  it("marks a rating older than 8 days as overdue", () => {
    const now = at("2026-09-30T12:00:00Z");
    expect(endpointVerifyOverdue(at("2026-09-23T12:00:00Z"), now)).toBe(false);
    expect(endpointVerifyOverdue(at("2026-09-22T11:59:00Z"), now)).toBe(true);
    expect(endpointVerifyOverdue(null, now)).toBe(false);
  });
});
