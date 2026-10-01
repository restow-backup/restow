import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import { accountKeywords, matchesAccountType, sortAccounts } from "./accounts";

function object(patch: Partial<SnapshotObject>): SnapshotObject {
  return {
    id: "id",
    kind: "mailbox",
    externalId: "anna@example.com",
    displayName: null,
    status: "active",
    sourceKind: "m365",
    ownerEmail: null,
    own: false,
    snapshotCount: 1,
    latestSnapshotId: "s1",
    latestSnapshotAt: "2026-09-20T10:00:00.000Z",
    readiness: "green",
    ...patch,
  };
}

describe("matchesAccountType", () => {
  it("matches everything for 'all' and only the same kind otherwise", () => {
    expect(matchesAccountType(object({ kind: "onedrive" }), "all")).toBe(true);
    expect(matchesAccountType(object({ kind: "onedrive" }), "onedrive")).toBe(true);
    expect(matchesAccountType(object({ kind: "onedrive" }), "mailbox")).toBe(false);
  });
});

describe("sortAccounts", () => {
  it("puts the viewer's own account first, then sorts alphabetically", () => {
    const objects = [
      object({ id: "b", displayName: "Bob", own: false }),
      object({ id: "a", displayName: "Anna", own: false }),
      object({ id: "c", displayName: "Carla", own: true }),
    ];
    expect(sortAccounts(objects).map((o) => o.id)).toEqual(["c", "a", "b"]);
  });
});

describe("accountKeywords", () => {
  it("includes the external id, kind and owner so the search can match any of them", () => {
    expect(accountKeywords(object({ externalId: "x@y.com", ownerEmail: "owner@y.com" }))).toEqual([
      "x@y.com",
      "mailbox",
      "owner@y.com",
    ]);
    expect(accountKeywords(object({ ownerEmail: null }))).toEqual(["anna@example.com", "mailbox"]);
  });
});
