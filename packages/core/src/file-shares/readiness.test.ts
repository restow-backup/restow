import { describe, expect, it } from "vitest";
import { isVerifiedRestorePoint, shareReadiness, shareVerifyOverdue } from "./readiness.js";

const at = (iso: string) => new Date(iso);

describe("file share readiness (8.4)", () => {
  it("rates the newest restore point by its own restore check", () => {
    expect(
      shareReadiness({ latestResticSnapshotId: null, latestBackupWarning: false, reports: [] })
        .state,
    ).toBe("no_backup");
    expect(
      shareReadiness({
        latestResticSnapshotId: "bbb",
        latestBackupWarning: false,
        reports: [
          {
            kind: "restore_test",
            snapshotId: "aaa",
            readiness: "green",
            checkedAt: at("2026-10-01"),
          },
        ],
      }).state,
    ).toBe("unverified");
    expect(
      shareReadiness({
        latestResticSnapshotId: "bbb",
        latestBackupWarning: true,
        reports: [
          {
            kind: "restore_test",
            snapshotId: "bbb",
            readiness: "green",
            checkedAt: at("2026-10-02"),
          },
        ],
      }).state,
    ).toBe("yellow");
    expect(
      shareReadiness({
        latestResticSnapshotId: "bbb",
        latestBackupWarning: false,
        reports: [
          {
            kind: "restore_test",
            snapshotId: "bbb",
            readiness: "green",
            checkedAt: at("2026-10-02"),
          },
          {
            kind: "repository_check",
            snapshotId: null,
            readiness: "red",
            checkedAt: at("2026-10-03"),
          },
        ],
      }),
    ).toMatchObject({ state: "red", basis: "repository_check" });
  });

  it("is overdue after 8 days", () => {
    expect(shareVerifyOverdue(at("2026-10-01"), at("2026-10-08"))).toBe(false);
    expect(shareVerifyOverdue(at("2026-10-01"), at("2026-10-10"))).toBe(true);
  });

  it("counts a restore point as verified only with a passed newest check", () => {
    const reports = [
      {
        kind: "restore_test" as const,
        snapshotId: "a",
        readiness: "green" as const,
        checkedAt: at("2026-10-01"),
      },
      {
        kind: "restore_test" as const,
        snapshotId: "a",
        readiness: "red" as const,
        checkedAt: at("2026-10-02"),
      },
      {
        kind: "restore_test" as const,
        snapshotId: "b",
        readiness: "green" as const,
        checkedAt: at("2026-10-02"),
      },
    ];
    expect(isVerifiedRestorePoint("a", reports)).toBe(false);
    expect(isVerifiedRestorePoint("b", reports)).toBe(true);
    expect(isVerifiedRestorePoint("c", reports)).toBe(false);
  });
});
