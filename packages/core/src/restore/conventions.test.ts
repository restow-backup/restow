import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../manifest.js";
import { SnapshotCatalog, folderKindOf, isDefaultContactFolder, splitAtAnchor } from "./catalog.js";
import {
  attachmentFactsOf,
  calendarFactsOf,
  fileTimestampsOf,
  folderSegmentsOf,
  imapFlagsOf,
  imapInternalDateOf,
  imapMailboxComponentsOf,
  mailboxAreaOf,
  messageFlagsOf,
  messageFormatOf,
  messageIdOf,
  objectTypeOf,
  recordedQuickXorHashOf,
  referenceAttachmentsOf,
  versionFactsOf,
} from "./conventions.js";

function object(overrides: Partial<ManifestObject> & { path: string }): ManifestObject {
  return { size: 1, mtime: Date.UTC(2026, 0, 2, 3, 4, 5), chunks: [], ...overrides };
}

describe("object types and areas", () => {
  it("normalises the type and defaults untyped objects to files", () => {
    expect(objectTypeOf(object({ path: "a", type: "message" }))).toBe("mail");
    expect(objectTypeOf(object({ path: "a", type: "mail" }))).toBe("mail");
    expect(objectTypeOf(object({ path: "a", type: "file-version" }))).toBe("version");
    expect(objectTypeOf(object({ path: "a", type: "package" }))).toBe("package");
    expect(objectTypeOf(object({ path: "a" }))).toBe("file");
    expect(objectTypeOf(object({ path: "a", type: "blob" }))).toBe("unknown");
  });

  it("derives the area from the type, the folder kind and the path root", () => {
    expect(mailboxAreaOf(object({ path: "calendar/x.json", type: "event" }))).toBe("calendar");
    expect(mailboxAreaOf(object({ path: "x", type: "contact" }))).toBe("contacts");
    expect(
      mailboxAreaOf(
        object({ path: "contacts/Clients", type: "folder", metadata: { folderKind: "contacts" } }),
      ),
    ).toBe("contacts");
    expect(mailboxAreaOf(object({ path: "calendar/Team", type: "folder" }))).toBe("calendar");
    expect(mailboxAreaOf(object({ path: "Inbox/x", type: "folder" }))).toBe("mail");
  });
});

describe("folder paths", () => {
  it("reads the recorded display path relative to the area", () => {
    expect(
      folderSegmentsOf(
        object({ path: "mail/Inbox/x.eml", type: "mail", metadata: { folderPath: "Inbox/A∕B" } }),
      ),
    ).toEqual(["Inbox", "A∕B"]);
    // A user folder may well be called "mail"; a recorded path is taken as it is.
    expect(
      folderSegmentsOf(
        object({ path: "mail/mail/x.eml", type: "mail", metadata: { folderPath: "mail/Old" } }),
      ),
    ).toEqual(["mail", "Old"]);
    expect(
      folderSegmentsOf(
        object({ path: "contacts/c.json", type: "contact", metadata: { folderPath: "" } }),
      ),
    ).toEqual([]);
  });

  it("falls back to the parent path, or a folder object's own path", () => {
    expect(folderSegmentsOf(object({ path: "mail/Inbox/Projects/msg.eml", type: "mail" }))).toEqual(
      ["Inbox", "Projects"],
    );
    expect(folderSegmentsOf(object({ path: "mail/Inbox/Projects", type: "folder" }))).toEqual([
      "Inbox",
      "Projects",
    ]);
    expect(folderSegmentsOf(object({ path: "mail/msg.eml", type: "mail" }))).toEqual([]);
  });

  it("anchors the first mail folder on its well-known name", () => {
    const message = object({
      path: "mail/Posteingang/Projekte/x.eml",
      type: "mail",
      metadata: { folderPath: "Posteingang/Projekte", wellKnownFolder: "Inbox" },
    });
    const catalog = SnapshotCatalog.of({ objects: [message] });
    expect(catalog.mailFolderChain(message)).toEqual([
      { name: "Posteingang", anchor: "inbox" },
      { name: "Projekte" },
    ]);
    expect(splitAtAnchor(catalog.mailFolderChain(message))).toEqual({
      anchor: "inbox",
      below: ["Projekte"],
      names: ["Posteingang", "Projekte"],
    });
    expect(splitAtAnchor([{ name: "A" }, { name: "B" }])).toEqual({
      anchor: undefined,
      below: ["A", "B"],
      names: ["A", "B"],
    });
  });

  it("classifies folder objects and recognises the default contacts folder", () => {
    expect(folderKindOf(object({ path: "mail", type: "folder" }))).toBe("root");
    expect(folderKindOf(object({ path: "mail/Inbox", type: "folder" }))).toBe("mail");
    expect(
      folderKindOf(
        object({
          path: "mail/x.attachments",
          type: "folder",
          metadata: { folderKind: "attachments" },
        }),
      ),
    ).toBe("attachments");
    const defaultFolder = object({
      path: "contacts",
      type: "folder",
      metadata: { folderKind: "contacts", folderPath: "", isDefault: "true" },
    });
    expect(isDefaultContactFolder(defaultFolder)).toBe(true);
    const clients = object({
      path: "contacts/Clients",
      type: "folder",
      metadata: { folderKind: "contacts", folderPath: "Clients", isDefault: "false" },
    });
    expect(isDefaultContactFolder(clients)).toBe(false);
    expect(SnapshotCatalog.of({ objects: [clients] }).contactFolderNames(clients)).toEqual([
      "Clients",
    ]);
  });

  it("restores real folder names that a /-separated path cannot carry", () => {
    const folder = object({
      path: "mail/Posteingang/A∕B",
      type: "folder",
      metadata: { folderKind: "mail", folderPath: "Posteingang/A∕B", displayName: "A/B" },
    });
    const inbox = object({
      path: "mail/Posteingang",
      type: "folder",
      metadata: { folderKind: "mail", folderPath: "Posteingang", displayName: "Posteingang" },
    });
    const message = object({
      path: "mail/Posteingang/A∕B/x.eml",
      type: "mail",
      metadata: { folderPath: "Posteingang/A∕B/Sub", wellKnownFolder: "inbox" },
    });
    const catalog = SnapshotCatalog.of({ objects: [inbox, folder, message] });
    expect(catalog.mailFolderChain(message)).toEqual([
      { name: "Posteingang", anchor: "inbox" },
      { name: "A/B" },
      { name: "Sub" },
    ]);
  });
});

describe("mail metadata", () => {
  it("reads the Message-ID, the format and the flags tolerantly", () => {
    const mail = object({
      path: "mail/Inbox/1.eml",
      type: "mail",
      metadata: {
        messageId: "<a@b>",
        isRead: "true",
        flagStatus: "flagged",
        categories: '["Red","Blue"]',
        importance: "high",
      },
    });
    expect(messageIdOf(mail)).toBe("<a@b>");
    expect(messageFormatOf(mail)).toBe("mime");
    expect(messageFlagsOf(mail)).toEqual({
      isRead: true,
      flag: { flagStatus: "flagged" },
      categories: ["Red", "Blue"],
      importance: "high",
    });
    expect(messageFlagsOf(object({ path: "x", metadata: { categories: "Red Blue" } }))).toEqual({
      categories: ["Red", "Blue"],
    });
    expect(messageFlagsOf(object({ path: "x", metadata: { flagStatus: "nonsense" } }))).toEqual({});
    expect(messageIdOf(object({ path: "x", metadata: { internetMessageId: "<c@d>" } }))).toBe(
      "<c@d>",
    );
    expect(messageIdOf(object({ path: "x", metadata: { messageId: "  " } }))).toBeUndefined();
    expect(messageFormatOf(object({ path: "x", metadata: { format: "json" } }))).toBe("json");
    expect(messageFormatOf(object({ path: "x", metadata: { format: "parts" } }))).toBe("json");
  });

  it("describes attachments and link attachments", () => {
    const item = object({
      path: "mail/Inbox/x.attachments/Fwd.1234",
      type: "attachment",
      metadata: {
        name: "Fwd",
        attachmentType: "#microsoft.graph.itemAttachment",
        isInline: "false",
      },
    });
    expect(attachmentFactsOf(item)).toEqual({
      kind: "item",
      name: "Fwd",
      contentType: undefined,
      isInline: false,
      contentId: undefined,
    });
    expect(attachmentFactsOf(object({ path: "a/plan.pdf.99", type: "attachment" })).name).toBe(
      "plan.pdf.99",
    );
    const message = object({
      path: "m.json",
      metadata: { referenceAttachments: '["Budget.xlsx","Plan"]' },
    });
    expect(referenceAttachmentsOf(message)).toEqual(["Budget.xlsx", "Plan"]);
    expect(
      referenceAttachmentsOf(object({ path: "m", metadata: { referenceAttachments: "oops" } })),
    ).toEqual([]);
  });
});

describe("calendar facts", () => {
  it("reads the calendar from the event and completes it from the calendar folder", () => {
    expect(
      calendarFactsOf(
        object({ path: "calendar/Team/e.json", type: "event", metadata: { folderPath: "Team" } }),
      ),
    ).toEqual({ name: "Team", isDefault: false });
    expect(
      calendarFactsOf(
        object({
          path: "calendar/Kalender/e.json",
          type: "event",
          metadata: { calendarName: "Kalender", isDefaultCalendar: "true" },
        }),
      ),
    ).toEqual({ name: "Kalender", isDefault: true });

    const calendarFolder = object({
      path: "calendar/Kalender",
      type: "folder",
      metadata: {
        folderKind: "calendar",
        calendarId: "cal-1",
        calendarName: "Kalender",
        isDefaultCalendar: "true",
      },
    });
    const event = object({
      path: "calendar/Kalender/e.json",
      type: "event",
      metadata: { calendarId: "cal-1" },
    });
    const catalog = SnapshotCatalog.of({ objects: [calendarFolder, event] });
    expect(catalog.calendarOf(event)).toEqual({ name: "Kalender", isDefault: true });
  });
});

describe("file facts", () => {
  it("falls back to mtime for file timestamps and ignores unparsable values", () => {
    const file = object({ path: "Documents/a.txt", metadata: { createdDateTime: "garbage" } });
    expect(fileTimestampsOf(file)).toEqual({ lastModifiedDateTime: "2026-01-02T03:04:05.000Z" });
    const dated = object({
      path: "Documents/a.txt",
      metadata: {
        createdDateTime: "2025-05-05T05:05:05Z",
        lastModifiedDateTime: "2025-06-06T06:06:06Z",
      },
    });
    expect(fileTimestampsOf(dated)).toEqual({
      createdDateTime: "2025-05-05T05:05:05Z",
      lastModifiedDateTime: "2025-06-06T06:06:06Z",
    });
  });

  it("splits version paths and ignores the hash of a stale copy", () => {
    expect(
      versionFactsOf(object({ path: "Docs/report.docx:versions/3.0", type: "file-version" })),
    ).toEqual({ filePath: "Docs/report.docx", versionId: "3.0" });
    expect(recordedQuickXorHashOf(object({ path: "a", metadata: { quickXorHash: "abc=" } }))).toBe(
      "abc=",
    );
    expect(
      recordedQuickXorHashOf(
        object({ path: "a", metadata: { quickXorHash: "abc=", stale: "true" } }),
      ),
    ).toBeUndefined();
  });
});

describe("IMAP metadata", () => {
  it("splits the recorded mailbox on the recorded delimiter", () => {
    const dotted = object({
      path: "mail/INBOX/Projects/12.eml",
      metadata: { mailbox: "INBOX.Projects", delimiter: "." },
    });
    expect(imapMailboxComponentsOf(dotted)).toEqual(["INBOX", "Projects"]);
    expect(
      imapMailboxComponentsOf(
        object({ path: "x", metadata: { mailbox: "Clients.A/B Corp", delimiter: "." } }),
      ),
    ).toEqual(["Clients", "A/B Corp"]);
    expect(imapMailboxComponentsOf(object({ path: "mail/Work%2FPrivate/Sub/7.eml" }))).toEqual([
      "Work/Private",
      "Sub",
    ]);
    expect(imapMailboxComponentsOf(object({ path: "mail/inbox/7.eml" }))).toEqual(["INBOX"]);
    expect(imapMailboxComponentsOf(object({ path: "7.eml" }))).toEqual(["INBOX"]);
  });

  it("anchors special-use mailboxes, including the parents of a message's mailbox", () => {
    const sentFolder = object({
      path: "mail/Sent",
      type: "folder",
      metadata: { mailbox: "Sent", delimiter: "/", specialUse: "\\Sent" },
    });
    const message = object({
      path: "mail/Sent/2025/4.eml",
      type: "message",
      metadata: { mailbox: "Sent/2025", delimiter: "/" },
    });
    const catalog = SnapshotCatalog.of({ objects: [sentFolder, message] });
    expect(catalog.imapFolderChain(message)).toEqual([
      { name: "Sent", anchor: "\\Sent" },
      { name: "2025" },
    ]);
    expect(
      catalog.imapFolderChain(
        object({ path: "x", metadata: { mailbox: "INBOX", delimiter: "/" } }),
      ),
    ).toEqual([{ name: "INBOX", anchor: "\\Inbox" }]);
  });

  it("parses flags and the internal date", () => {
    const mail = object({
      path: "INBOX/1.eml",
      metadata: { flags: '["\\\\Seen","\\\\Flagged"]', internalDate: "2024-03-04T05:06:07Z" },
    });
    expect(imapFlagsOf(mail)).toEqual(["\\Seen", "\\Flagged"]);
    expect(imapInternalDateOf(mail)?.toISOString()).toBe("2024-03-04T05:06:07.000Z");
    expect(imapFlagsOf(object({ path: "x", metadata: { flags: "\\Seen $Label1" } }))).toEqual([
      "\\Seen",
      "$Label1",
    ]);
    expect(imapInternalDateOf(object({ path: "x" }))?.getTime()).toBe(
      Date.UTC(2026, 0, 2, 3, 4, 5),
    );
  });
});
