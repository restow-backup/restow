import { describe, expect, it } from "vitest";
import type { ProtectedObjectRef } from "../engine/types.js";
import { mailboxRestoreMode, restoreFolderNameFor, restoreRequestTime } from "./common.js";
import { restoreRequestFor } from "./testing/fixtures.js";

const protectedObject: ProtectedObjectRef = {
  id: "p",
  tenantId: "t",
  sourceId: "s",
  kind: "mailbox",
  externalId: "anna@example.org",
  displayName: null,
  userId: null,
};
const REQUESTED = new Date(Date.UTC(2026, 8, 22, 14, 30, 59));
const LATER = new Date(Date.UTC(2026, 8, 22, 14, 41, 5));
const clock = { now: () => LATER };

describe("restore folder name", () => {
  it("is dated by the request, so every attempt of a retried job computes the same one", () => {
    const request = restoreRequestFor(
      { protectedObject, snapshotId: "snap" },
      { requestedAt: REQUESTED },
    );
    expect(restoreFolderNameFor(clock, request)).toBe("Restow 2026-09-22 1430");
    expect(restoreFolderNameFor({ now: () => new Date() }, request)).toBe("Restow 2026-09-22 1430");
  });

  it("prefers the caller's name and falls back to the job clock without a request time", () => {
    const base = { protectedObject, snapshotId: "snap" };
    expect(
      restoreFolderNameFor(
        clock,
        restoreRequestFor(base, {
          requestedAt: REQUESTED,
          options: { restoreFolderName: " Wiederhergestellt / alt " },
        }),
      ),
    ).toBe("Wiederhergestellt - alt");
    expect(restoreFolderNameFor(clock, restoreRequestFor(base))).toBe("Restow 2026-09-22 1441");
    expect(
      restoreRequestTime(clock, restoreRequestFor(base, { requestedAt: new Date(Number.NaN) })),
    ).toBe(LATER);
  });
});

describe("mailboxRestoreMode", () => {
  it("passes rename and skip through unchanged", () => {
    expect(mailboxRestoreMode("rename")).toEqual({ mode: "rename", legacyReplace: false });
    expect(mailboxRestoreMode("skip")).toEqual({ mode: "skip", legacyReplace: false });
  });

  it("coerces the discontinued replace mode to rename", () => {
    expect(mailboxRestoreMode("replace")).toEqual({ mode: "rename", legacyReplace: true });
  });
});
