import { describe, expect, it } from "vitest";
import { type MailboxCountable, countProtectedMailboxes } from "./mailboxes.js";

function object(
  kind: MailboxCountable["kind"],
  userId: string | null,
  status: MailboxCountable["status"] = "active",
): MailboxCountable {
  return { kind, userId, status };
}

describe("countProtectedMailboxes", () => {
  it("counts every active mailbox and IMAP account once", () => {
    expect(
      countProtectedMailboxes([
        object("mailbox", "anna"),
        object("mailbox", "shared-sales"),
        object("imap", null),
        object("imap", null),
      ]),
    ).toBe(4);
  });

  it("does not count a OneDrive next to its owner's protected mailbox", () => {
    expect(countProtectedMailboxes([object("mailbox", "anna"), object("onedrive", "anna")])).toBe(
      1,
    );
  });

  it("counts a OneDrive once when its owner has no protected mailbox", () => {
    expect(
      countProtectedMailboxes([
        object("onedrive", "ben"),
        object("mailbox", "ben", "excluded"),
        object("onedrive", null),
      ]),
    ).toBe(2);
  });

  it("ignores excluded and orphaned objects", () => {
    expect(
      countProtectedMailboxes([
        object("mailbox", "anna", "excluded"),
        object("mailbox", "carl", "orphaned"),
        object("imap", null, "excluded"),
        object("onedrive", "carl", "orphaned"),
      ]),
    ).toBe(0);
  });

  it("counts two mailboxes of one directory user separately", () => {
    expect(countProtectedMailboxes([object("mailbox", "anna"), object("mailbox", "anna")])).toBe(2);
  });

  it("is zero for no objects", () => {
    expect(countProtectedMailboxes([])).toBe(0);
  });
});
