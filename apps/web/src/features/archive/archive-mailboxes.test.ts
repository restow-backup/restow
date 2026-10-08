import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import { mailboxesOfArchive } from "./archive-page.js";

const object = (over: Partial<SnapshotObject>) =>
  ({
    id: "o",
    kind: "mailbox",
    externalId: "f257f896-b28a-4b6d-9d66-f7919b00c781",
    displayName: "IT Systeme Flores",
    ownerEmail: null,
    ...over,
  }) as SnapshotObject;

describe("mailboxesOfArchive", () => {
  it("offers mailboxes and IMAP accounts with their address, never a OneDrive or an Entra id", () => {
    const list = mailboxesOfArchive([
      object({ id: "a", ownerEmail: "info@flores.example" }),
      object({ id: "b", ownerEmail: "it@flores.example" }),
      object({ id: "c" }),
      object({ id: "d", kind: "onedrive", ownerEmail: "info@flores.example" }),
      object({ id: "e", kind: "imap", displayName: null, externalId: "alt@imap.example" }),
    ]);
    expect(list).toEqual([
      { id: "e", label: "alt@imap.example" },
      { id: "c", label: "IT Systeme Flores" },
      { id: "a", label: "IT Systeme Flores (info@flores.example)" },
      { id: "b", label: "IT Systeme Flores (it@flores.example)" },
    ]);
  });
});
