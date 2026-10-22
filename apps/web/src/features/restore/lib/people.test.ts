import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import {
  activeArea,
  areasOf,
  firstAreaOf,
  latestBackupOf,
  type Person,
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

const mailbox = object({ id: "m-anna", kind: "mailbox" });
const drive = object({
  id: "d-anna",
  kind: "onedrive",
  latestSnapshotAt: "2026-10-01T10:00:00.000Z",
});
const imap = object({ id: "i-anna", kind: "imap", sourceKind: "imap" });
const anna: Person = {
  key: "user:u-anna",
  name: "Anna Berg",
  address: "anna@example.com",
  own: false,
  accountDeleted: false,
  objects: [mailbox, drive, imap],
};

describe("a person's areas", () => {
  it("names each area with its object and folder", () => {
    const links = areasOf(anna);
    expect(links.map((link) => [link.area, link.object.id, link.path])).toEqual([
      ["mail", "m-anna", "mail"],
      ["calendar", "m-anna", "calendar"],
      ["contacts", "m-anna", "contacts"],
      ["onedrive", "d-anna", ""],
      ["imap", "i-anna", ""],
    ]);
    expect(firstAreaOf(anna)?.area).toBe("mail");
    expect(activeArea(links, "m-anna", "calendar/Team")?.area).toBe("calendar");
    expect(activeArea(links, "d-anna", "Documents")?.area).toBe("onedrive");
    expect(activeArea(links, "m-anna", "")).toBeNull();
  });

  it("gives a Microsoft 365 group its group calendar and its conversations", () => {
    const group = object({ id: "g-phoenix", kind: "group", displayName: "Project Phoenix" });
    const entry: Person = {
      key: "group:g-phoenix",
      name: "Project Phoenix",
      address: null,
      own: false,
      accountDeleted: false,
      objects: [group],
    };
    const links = areasOf(entry);
    expect(links.map((link) => [link.area, link.object.id, link.path])).toEqual([
      ["groupCalendar", "g-phoenix", "calendar"],
      ["conversations", "g-phoenix", "mail"],
    ]);
    expect(firstAreaOf(entry)?.path).toBe("calendar");
    expect(activeArea(links, "g-phoenix", "mail/Conversations")?.area).toBe("conversations");
  });

  it("rates a person by their least proven backup, and dates them by their newest", () => {
    expect(readinessOf([mailbox, { ...drive, readiness: "red" }])).toBe("red");
    expect(readinessOf([{ ...mailbox, snapshotCount: 0, readiness: "no_backup" }])).toBe(
      "no_backup",
    );
    expect(latestBackupOf(anna.objects)).toBe("2026-10-01T10:00:00.000Z");
  });
});
