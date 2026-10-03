import { describe, expect, it } from "vitest";

import type { SnapshotObject } from "@/features/restore/api";

import type { EndpointSummary } from "./api.js";
import { machineMatches, mailboxMatches, mailboxesOf, onlyChoice } from "./file-restore-page.js";
import { fileRestoreMailboxTo, fileRestoreTo, parseFileRestoreSearch } from "./paths.js";

const machine = (displayName: string | null, hostname: string) =>
  ({ displayName, hostname }) as EndpointSummary;

const object = (over: Partial<SnapshotObject>) =>
  ({
    id: "o1",
    kind: "mailbox",
    externalId: "anna@contoso.example",
    displayName: "Anna Berg",
    ownerEmail: "anna@contoso.example",
    ...over,
  }) as SnapshotObject;

describe("machineMatches", () => {
  it("matches the label and the host name, ignoring case and surrounding spaces", () => {
    expect(machineMatches(machine("Main file server", "fs-01"), "FILE")).toBe(true);
    expect(machineMatches(machine("Main file server", "fs-01"), " fs-0 ")).toBe(true);
    expect(machineMatches(machine(null, "web-01"), "web")).toBe(true);
  });

  it("keeps every machine for an empty search and none for a miss", () => {
    expect(machineMatches(machine(null, "web-01"), "  ")).toBe(true);
    expect(machineMatches(machine("Main file server", "fs-01"), "mail")).toBe(false);
  });
});

describe("mailboxMatches", () => {
  it("matches the name, the address and the owner", () => {
    expect(mailboxMatches(object({}), "berg")).toBe(true);
    expect(mailboxMatches(object({ displayName: null }), "CONTOSO")).toBe(true);
    expect(mailboxMatches(object({ externalId: "x", ownerEmail: "boss@example" }), "boss")).toBe(
      true,
    );
    expect(mailboxMatches(object({}), "web-01")).toBe(false);
  });
});

describe("mailboxesOf", () => {
  it("keeps Microsoft 365 and IMAP mailboxes, leaves OneDrive out, sorted by name", () => {
    const list = mailboxesOf([
      object({ id: "d", kind: "onedrive", displayName: "Anna's drive" }),
      object({ id: "z", kind: "imap", displayName: "Zentrale" }),
      object({ id: "a", kind: "mailbox", displayName: "Anna Berg" }),
    ]);
    expect(list.map((item) => item.id)).toEqual(["a", "z"]);
  });
});

describe("onlyChoice", () => {
  it("chooses the one machine or the one mailbox, and nothing for more or none", () => {
    expect(onlyChoice([{ id: "m1" }], [])).toEqual({ machine: "m1" });
    expect(onlyChoice([], [{ id: "o1" }])).toEqual({ mailbox: "o1" });
    expect(onlyChoice([{ id: "m1" }], [{ id: "o1" }])).toBeNull();
    expect(onlyChoice([], [])).toBeNull();
  });
});

describe("file restore search", () => {
  it("reads the machine or the mailbox, the machine winning when both are given", () => {
    expect(parseFileRestoreSearch({ machine: "m1" })).toEqual({ machine: "m1" });
    expect(parseFileRestoreSearch({ mailbox: "o1" })).toEqual({ mailbox: "o1" });
    expect(parseFileRestoreSearch({ machine: "m1", mailbox: "o1" })).toEqual({ machine: "m1" });
    expect(parseFileRestoreSearch({ machine: "", mailbox: 3 })).toEqual({});
    expect(parseFileRestoreSearch({ mailbox: "x".repeat(65) })).toEqual({});
  });

  it("links to file restore with a machine or a mailbox chosen", () => {
    expect(fileRestoreTo("m1")).toEqual({ to: "/file-restore", search: { machine: "m1" } });
    expect(fileRestoreMailboxTo("o1")).toEqual({ to: "/file-restore", search: { mailbox: "o1" } });
  });
});
