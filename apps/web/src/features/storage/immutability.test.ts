import { describe, expect, it } from "vitest";

import {
  availableModes,
  immutabilityDetails,
  immutabilityHeadline,
  lowers,
  restorePointBadge,
} from "./immutability";
import type { ImmutabilityDto, RestorePointImmutability } from "./types";

function dto(overrides: Partial<ImmutabilityDto> = {}): ImmutabilityDto {
  return {
    mode: "compliance",
    days: 30,
    kind: "object_lock",
    since: "2026-10-01T00:00:00.000Z",
    renewalBufferDays: 7,
    renewedAt: null,
    renewalOverdue: false,
    renewal: null,
    verification: null,
    deferredDeletions: 0,
    history: [],
    canLower: false,
    ...overrides,
  };
}

const format = { date: (iso: string) => iso.slice(0, 10) };

describe("immutability on a repository", () => {
  it("offers Object Lock on S3 and only the deletion delay on a directory", () => {
    expect(availableModes("s3")).toEqual(["compliance", "governance"]);
    expect(availableModes("local")).toEqual(["delayed_deletion"]);
  });

  it("calls fewer days, a weaker mode and off a lowering", () => {
    const current = { mode: "compliance" as const, days: 30 };
    expect(lowers(current, { mode: "compliance", days: 7 })).toBe(true);
    expect(lowers(current, { mode: "governance", days: 30 })).toBe(true);
    expect(lowers(current, { mode: null, days: 0 })).toBe(true);
    expect(lowers(current, { mode: "compliance", days: 60 })).toBe(false);
    expect(lowers({ mode: null, days: 0 }, { mode: "governance", days: 1 })).toBe(false);
  });

  it("says plainly when a repository cannot be made immutable", () => {
    expect(immutabilityHeadline(undefined, "s3", false).key).toBe("immutability.offNoObjectLock");
    expect(immutabilityHeadline(dto({ mode: null, days: 0 }), "s3", true).key).toBe(
      "immutability.offObjectLock",
    );
    expect(immutabilityHeadline(undefined, "local", false).key).toBe("immutability.offDirectory");
    const delay = immutabilityHeadline(
      dto({ mode: "delayed_deletion", kind: "deletion_delay", days: 14 }),
      "local",
      false,
    );
    expect(delay).toEqual({
      tone: "neutral",
      key: "immutability.deletionDelayOn",
      values: { days: 14 },
    });
    expect(immutabilityHeadline(dto(), "s3", true).key).toBe("immutability.complianceOn");
  });

  it("puts warnings first: objects without lock, a weaker mode, an overdue renewal", () => {
    const lines = immutabilityDetails(
      dto({
        renewalOverdue: true,
        renewedAt: "2026-10-02T00:00:00.000Z",
        deferredDeletions: 3,
        verification: {
          checkedAt: "2026-10-10T00:00:00.000Z",
          sampled: 12,
          locked: 10,
          unlocked: 1,
          weakerMode: 1,
          missing: 0,
          errors: 0,
          problems: [],
        },
      }),
      format,
    );
    expect(lines.map((line) => [line.tone, line.key])).toEqual([
      ["warning", "immutability.unlockedFound"],
      ["warning", "immutability.weakerModeFound"],
      ["warning", "immutability.renewalOverdue"],
      ["neutral", "immutability.renewedAt"],
      ["neutral", "immutability.deferred"],
    ]);
  });

  it("reports a clean verification and a renewal that has not run yet", () => {
    const lines = immutabilityDetails(
      dto({
        verification: {
          checkedAt: "2026-10-10T00:00:00.000Z",
          sampled: 4,
          locked: 4,
          unlocked: 0,
          weakerMode: 0,
          missing: 0,
          errors: 0,
          problems: [],
        },
      }),
      format,
    );
    expect(lines.map((line) => line.key)).toEqual([
      "immutability.notRenewedYet",
      "immutability.verifiedAt",
    ]);
  });
});

describe("a restore point's badge", () => {
  const result = (
    state: RestorePointImmutability["state"],
    targets: RestorePointImmutability["targets"] = [
      {
        targetId: "t1",
        source: "object_lock",
        mode: "COMPLIANCE",
        until: "2026-12-01T00:00:00.000Z",
        exists: true,
      },
    ],
  ): RestorePointImmutability => ({
    state,
    until: state === "none" ? null : "2026-12-01T00:00:00.000Z",
    targets,
    checkedAt: "2026-10-15T00:00:00.000Z",
  });

  it("is proof only for a COMPLIANCE lock the storage confirmed", () => {
    expect(restorePointBadge(result("immutable"))?.tone).toBe("proven");
    expect(restorePointBadge(result("governance"))?.tone).toBe("neutral");
    expect(restorePointBadge(result("delayed"))?.tone).toBe("neutral");
    expect(restorePointBadge(result("none"))?.tone).toBe("none");
  });

  it("says nothing for a tenant without an immutable repository", () => {
    expect(restorePointBadge(result("none", []))).toBeNull();
    expect(restorePointBadge(undefined)).toBeNull();
  });
});
