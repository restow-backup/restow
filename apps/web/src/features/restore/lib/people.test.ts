import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import {
  activeArea,
  areasOf,
  firstAreaOf,
  groupPeople,
  matchesPerson,
  personOfObject,
  readinessOf,
} from "./people.js";

function object(
  over: Partial<SnapshotObject> & Pick<SnapshotObject, "id" | "kind">,
): SnapshotObject {
  return {
    externalId: over.id,
    displayName: null,
    status: "active",
    sourceKind: "m365",
    ownerEmail: null,
    own: false,
    snapshotCount: 1,
    latestSnapshotId: "s",
    latestSnapshotAt: "2026-09-20T10:00:00.000Z",
    readiness: "green",
    ...over,
  };
}

const anna = { ownerKey: "u-anna", ownerName: "Anna Berg", ownerEmail: "anna@example.com" };
const mailbox = object({ id: "m-anna", kind: "mailbox", displayName: "Anna Berg", ...anna });
const drive = object({ id: "d-anna", kind: "onedrive", displayName: "Anna Berg", ...anna });
const imap = object({
  id: "i-anna",
  kind: "imap",
  externalId: "anna@old-provider.example",
  ...anna,
  sourceKind: "imap",
});
const ben = object({
  id: "m-ben",
  kind: "mailbox",
  displayName: "Ben Koch",
  ownerKey: "u-ben",
  ownerName: "Ben Koch",
  own: true,
});
const loose = object({
  id: "i-loose",
  kind: "imap",
  externalId: "info@shop.example",
  sourceKind: "imap",
});
const site = object({ id: "s-1", kind: "site", displayName: "Intranet" });

describe("people", () => {
  const { people, sites } = groupPeople([drive, site, loose, imap, mailbox, ben]);

  it("groups a person's mailbox, OneDrive and IMAP account, own entry first", () => {
    expect(people.map((person) => person.name)).toEqual([
      "Ben Koch",
      "Anna Berg",
      "info@shop.example",
    ]);
    expect(people[1]?.objects.map((o) => o.kind)).toEqual(["mailbox", "onedrive", "imap"]);
    expect(people[1]?.address).toBe("anna@example.com");
    expect(sites.map((s) => s.id)).toEqual(["s-1"]);
    expect(personOfObject(people, "d-anna")?.key).toBe("user:u-anna");
    expect(personOfObject(people, "s-1")).toBeNull();
  });

  it("finds a person by any of their accounts, and filters by type", () => {
    const annaPerson = people[1];
    if (!annaPerson) throw new Error("no Anna");
    expect(matchesPerson(annaPerson, "old-provider", "all")).toBe(true);
    expect(matchesPerson(annaPerson, "berg anna", "all")).toBe(true);
    expect(matchesPerson(annaPerson, "koch", "all")).toBe(false);
    expect(matchesPerson(annaPerson, "", "onedrive")).toBe(true);
    expect(matchesPerson(people[0] as never, "", "onedrive")).toBe(false);
  });

  it("names a person's areas, each with its object and folder", () => {
    const annaPerson = people[1];
    if (!annaPerson) throw new Error("no Anna");
    const links = areasOf(annaPerson);
    expect(links.map((link) => [link.area, link.object.id, link.path])).toEqual([
      ["mail", "m-anna", "mail"],
      ["calendar", "m-anna", "calendar"],
      ["contacts", "m-anna", "contacts"],
      ["onedrive", "d-anna", ""],
      ["imap", "i-anna", ""],
    ]);
    expect(firstAreaOf(annaPerson)?.area).toBe("mail");
    expect(activeArea(links, "m-anna", "calendar/Team")?.area).toBe("calendar");
    expect(activeArea(links, "d-anna", "Documents")?.area).toBe("onedrive");
    expect(activeArea(links, "m-anna", "")).toBeNull();
  });

  it("marks a person whose every account is gone, and rates them by their least proven backup", () => {
    const { people: gone } = groupPeople([
      object({ id: "d-x", kind: "onedrive", status: "orphaned", ownerKey: "u-x", ownerName: "X" }),
    ]);
    expect(gone[0]?.accountDeleted).toBe(true);
    expect(people[1]?.accountDeleted).toBe(false);
    expect(readinessOf([mailbox, { ...drive, readiness: "red" }])).toBe("red");
    expect(readinessOf([{ ...mailbox, snapshotCount: 0, readiness: "no_backup" }])).toBe(
      "no_backup",
    );
  });
});
