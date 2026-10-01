import { describe, expect, it } from "vitest";

import { areaOf, displayName, entryDate } from "./entries";

describe("displayName", () => {
  it("prefers the mail subject", () => {
    expect(
      displayName({ kind: "mail", path: "mail/Inbox/Hi.0123456789abcdef.eml", subject: " Hello " }),
    ).toBe("Hello");
  });

  it("strips the id digest Exchange item names carry", () => {
    expect(displayName({ kind: "mail", path: "mail/Inbox/Hi.0123456789abcdef.eml" })).toBe("Hi");
    expect(displayName({ kind: "event", path: "calendar/Cal/Standup.fedcba9876543210.json" })).toBe(
      "Standup",
    );
    expect(
      displayName({ kind: "contact", path: "contacts/Contacts/Anna.00112233aabbccdd.json" }),
    ).toBe("Anna");
  });

  it("keeps file names and names without a digest as they are", () => {
    expect(displayName({ kind: "file", path: "Documents/report.0123456789abcdef.json" })).toBe(
      "report.0123456789abcdef.json",
    );
    expect(displayName({ kind: "mail", path: "mail/INBOX/42.eml" })).toBe("42.eml");
    expect(displayName({ kind: "folder", path: "mail/Inbox" })).toBe("Inbox");
  });
});

describe("areaOf", () => {
  it("recognizes the mailbox areas at the root of mailboxes and IMAP accounts only", () => {
    expect(areaOf({ kind: "folder", path: "calendar" }, "mailbox")).toBe("calendar");
    expect(areaOf({ kind: "folder", path: "mail" }, "imap")).toBe("mail");
    expect(areaOf({ kind: "folder", path: "mail" }, "onedrive")).toBeNull();
    expect(areaOf({ kind: "folder", path: "mail/Inbox" }, "mailbox")).toBeNull();
    expect(areaOf({ kind: "file", path: "mail" }, "mailbox")).toBeNull();
  });
});

describe("entryDate", () => {
  it("uses the mail date, else the modification time", () => {
    expect(entryDate({ mail: null, mtime: "2026-01-01T00:00:00Z" })).toBe("2026-01-01T00:00:00Z");
    expect(
      entryDate({
        mail: {
          subject: null,
          from: null,
          to: null,
          cc: null,
          toCount: null,
          ccCount: null,
          date: "2026-02-02T00:00:00Z",
          sentDateTime: null,
          hasAttachments: null,
          isRead: null,
          flagged: null,
          protection: null,
        },
        mtime: "2026-01-01T00:00:00Z",
      }),
    ).toBe("2026-02-02T00:00:00Z");
  });
});
