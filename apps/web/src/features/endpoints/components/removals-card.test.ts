import { describe, expect, it } from "vitest";

import type { EndpointRemoval } from "../api.js";
import { removalStateKey } from "./removals-card.js";

const base: EndpointRemoval = {
  id: "11111111-1111-4111-8111-111111111111",
  hostname: "paperless",
  displayName: null,
  mode: "delete",
  state: "scheduled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  requestedBy: "admin@contoso.example",
  dueAt: "2026-10-20T12:00:00.000Z",
  expiresAt: null,
  heldBy: null,
  lockedUntil: null,
  lockedObjects: 0,
  deletedObjects: 0,
  repositoryBytes: 1024,
  lastError: null,
};

describe("where a removal stands (#65)", () => {
  it("names the day the backups expire, or that they are being deleted", () => {
    expect(removalStateKey(base)).toEqual({ key: "removals.deleting", date: null });
    expect(
      removalStateKey({ ...base, mode: "expire", expiresAt: "2027-10-01T08:00:00.000Z" }),
    ).toEqual({ key: "removals.expires", date: "2027-10-01T08:00:00.000Z" });
  });

  it("names what holds them, and until when the storage locks them", () => {
    expect(removalStateKey({ ...base, state: "held", heldBy: "legal_hold" }).key).toBe(
      "removals.held.legal",
    );
    expect(removalStateKey({ ...base, state: "held", heldBy: "suspicion" }).key).toBe(
      "removals.held.suspicion",
    );
    expect(
      removalStateKey({ ...base, state: "deferred", lockedUntil: "2026-11-01T00:00:00.000Z" }),
    ).toEqual({ key: "removals.deferred", date: "2026-11-01T00:00:00.000Z" });
    expect(removalStateKey({ ...base, state: "deferred" }).key).toBe("removals.deferredUnknown");
  });
});
