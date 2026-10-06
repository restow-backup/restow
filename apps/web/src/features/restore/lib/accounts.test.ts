import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import { accountAddress, accountKeywords, matchesAccountType, sortAccounts } from "./accounts";

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

describe("accountAddress", () => {
  it("shows the owner's primary address for a mailbox and a OneDrive, never the Entra id", () => {
    const guid = "f257f896-b28a-4b6d-9d66-f7919b00c781";
    expect(
      accountAddress(
        object({ externalId: guid, displayName: "Lucas Flores", ownerEmail: "lucas@example.com" }),
      ),
    ).toBe("lucas@example.com");
    expect(
      accountAddress(
        object({
          kind: "onedrive",
          externalId: guid,
          displayName: "Lucas Flores",
          ownerEmail: "lucas@example.com",
        }),
      ),
    ).toBe("lucas@example.com");
    expect(accountAddress(object({ externalId: guid, displayName: "Lucas Flores" }))).toBeNull();
  });

  it("shows an IMAP account's login, and nothing that only repeats the name", () => {
    expect(
      accountAddress(
        object({
          kind: "imap",
          sourceKind: "imap",
          externalId: "info@example.com",
          displayName: "Info",
        }),
      ),
    ).toBe("info@example.com");
    expect(
      accountAddress(object({ kind: "imap", sourceKind: "imap", externalId: "info@example.com" })),
    ).toBeNull();
    expect(
      accountAddress(object({ ownerEmail: "Anna@Example.com", displayName: "anna@example.com" })),
    ).toBeNull();
  });
});
