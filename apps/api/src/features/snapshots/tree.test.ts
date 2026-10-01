import { describe, expect, it } from "vitest";
import {
  type MailSummary,
  type TreeEntryDto,
  type VersionRow,
  baseNameOf,
  breadcrumbOf,
  collapseVersions,
  compareEntries,
  escapeLike,
  fingerprintOf,
  implicitFolderId,
  isNativeVersionPath,
  joinPath,
  mailSummaryOf,
  nativeVersionsParent,
  normalizePath,
  parentPathOf,
  sortEntries,
  splitAddressList,
  toStoredVersion,
  toTreeEntry,
} from "./tree.js";

describe("paths", () => {
  it("normalizes surrounding slashes and keeps the root empty", () => {
    expect(normalizePath("/Inbox/Projects/")).toBe("Inbox/Projects");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("///")).toBe("");
  });

  it("splits and joins parent and base name", () => {
    expect(parentPathOf("Documents/report.docx")).toBe("Documents");
    expect(parentPathOf("report.docx")).toBe("");
    expect(baseNameOf("Inbox/Projects/2024")).toBe("2024");
    expect(baseNameOf("")).toBe("");
    expect(joinPath("", "mail")).toBe("mail");
    expect(joinPath("/mail/", "Inbox")).toBe("mail/Inbox");
  });

  it("builds a breadcrumb with cumulative paths", () => {
    expect(breadcrumbOf("Inbox/Projects/2024")).toEqual([
      { name: "Inbox", path: "Inbox" },
      { name: "Projects", path: "Inbox/Projects" },
      { name: "2024", path: "Inbox/Projects/2024" },
    ]);
    expect(breadcrumbOf("")).toEqual([]);
  });

  it("recognizes OneDrive's version namespace", () => {
    expect(isNativeVersionPath("Documents/report.docx:versions/3.0")).toBe(true);
    expect(isNativeVersionPath("Documents/report.docx")).toBe(false);
    expect(nativeVersionsParent("/Documents/report.docx")).toBe("Documents/report.docx:versions");
  });

  it("gives folders without a row a stable, distinct id", () => {
    expect(implicitFolderId("mail/Inbox")).toBe("folder:mail/Inbox");
  });
});

describe("mailSummaryOf", () => {
  it("reads Exchange metadata", () => {
    expect(
      mailSummaryOf({
        subject: "Quarterly report",
        from: "anna@example.com",
        toRecipients: "team@example.com",
        cc: "Bob <bob@example.com>, Carla <carla@example.com>",
        toCount: "23",
        ccCount: "2",
        receivedDateTime: "2026-01-10T08:00:00Z",
        sentDateTime: "2026-01-10T07:58:00Z",
        hasAttachments: "true",
        isRead: "false",
        flagStatus: "flagged",
        protection: "rights-protected",
      }),
    ).toEqual({
      subject: "Quarterly report",
      from: "anna@example.com",
      to: "team@example.com",
      cc: "Bob <bob@example.com>, Carla <carla@example.com>",
      toCount: 23,
      ccCount: 2,
      date: "2026-01-10T08:00:00Z",
      sentDateTime: "2026-01-10T07:58:00Z",
      hasAttachments: true,
      isRead: false,
      flagged: true,
      protection: "rights-protected",
    });
  });

  it("reads IMAP flags in JSON and whitespace form and the internal date", () => {
    expect(
      mailSummaryOf({ flags: '["\\\\Seen"]', internalDate: "2026-02-01T09:30:00.000Z" }),
    ).toMatchObject({ isRead: true, flagged: false, date: "2026-02-01T09:30:00.000Z" });
    expect(mailSummaryOf({ flags: "\\Flagged \\Answered" })).toMatchObject({
      isRead: false,
      flagged: true,
    });
  });

  it("ignores an unknown protection value and keeps signed-only mail unflagged", () => {
    expect(mailSummaryOf({ protection: "smime-encrypted" }).protection).toBe("smime-encrypted");
    expect(mailSummaryOf({ protection: "quarantined" }).protection).toBeNull();
    expect(mailSummaryOf({}).protection).toBeNull();
  });

  it("degrades to nulls without metadata and ignores blank values", () => {
    expect(mailSummaryOf(null)).toEqual({
      subject: null,
      from: null,
      to: null,
      cc: null,
      toCount: null,
      ccCount: null,
      date: null,
      sentDateTime: null,
      hasAttachments: null,
      isRead: null,
      flagged: null,
      protection: null,
    });
    expect(mailSummaryOf({ subject: "   " }).subject).toBeNull();
  });
});

describe("splitAddressList", () => {
  it("splits and trims a comma-separated recipient string", () => {
    expect(splitAddressList("Anna <anna@example.com>, bob@example.com")).toEqual([
      "Anna <anna@example.com>",
      "bob@example.com",
    ]);
    expect(splitAddressList("")).toEqual([]);
    expect(splitAddressList(null)).toEqual([]);
    expect(splitAddressList("a@x.com,, b@x.com")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("does not split a comma inside a quoted display name (packages/core quoteDisplayName)", () => {
    // "Last, First" is how German Exchange/AD directories very commonly name
    // people; both backup engines quote such a display name for exactly this
    // reason (packages/core/src/backup/imap/imapflow-connector.ts and
    // .../exchange/mail.ts, both `quoteDisplayName`).
    expect(splitAddressList('"Flores, Lucas" <l@example.test>, bob@example.test')).toEqual([
      '"Flores, Lucas" <l@example.test>',
      "bob@example.test",
    ]);

    expect(
      splitAddressList('"Flores, Lucas" <lucas@example.test>, "Doe, Jane" <jane@example.test>'),
    ).toEqual(['"Flores, Lucas" <lucas@example.test>', '"Doe, Jane" <jane@example.test>']);
  });

  it("honours a backslash-escaped quote or backslash inside a quoted display name", () => {
    // quoteDisplayName backslash-escapes `\` and `"` inside the quotes; a
    // naive quote toggle would end the quoted section early on `\"`.
    expect(splitAddressList('"Say \\"Hi\\", Bob" <bob@example.test>, x@example.test')).toEqual([
      '"Say \\"Hi\\", Bob" <bob@example.test>',
      "x@example.test",
    ]);
  });
});

function entry(partial: Partial<TreeEntryDto> & Pick<TreeEntryDto, "kind" | "name">): TreeEntryDto {
  return {
    id: partial.name,
    path: partial.name,
    parentPath: "",
    size: 0,
    mtime: null,
    itemId: null,
    deleted: false,
    implicit: false,
    mail: null,
    contentType: null,
    ...partial,
  };
}

/** A blank {@link MailSummary} for tests that only care about `date`. */
const emptyMailSummary: MailSummary = {
  subject: null,
  from: null,
  to: null,
  cc: null,
  toCount: null,
  ccCount: null,
  date: null,
  sentDateTime: null,
  hasAttachments: null,
  isRead: null,
  flagged: null,
  protection: null,
};

describe("toTreeEntry", () => {
  it("maps a row and attaches a mail summary for mail items", () => {
    const mtime = new Date("2026-02-01T10:00:00Z");
    const dto = toTreeEntry({
      id: "row-1",
      kind: "mail",
      name: "Hello.1a2b.eml",
      path: "mail/Inbox/Hello.1a2b.eml",
      parentPath: "mail/Inbox",
      size: 1234,
      mtime,
      itemId: "AAMkAG",
      deleted: false,
      metadata: { subject: "Hello", contentType: "message/rfc822" },
    });
    expect(dto.mtime).toBe(mtime.toISOString());
    expect(dto.mail?.subject).toBe("Hello");
    expect(dto.contentType).toBe("message/rfc822");
    expect(dto.implicit).toBe(false);
  });

  it("has no mail summary for files and folders and keeps the implicit flag", () => {
    const dto = toTreeEntry({
      id: implicitFolderId("mail"),
      kind: "folder",
      name: "mail",
      path: "mail",
      parentPath: "",
      size: 0,
      mtime: null,
      itemId: null,
      deleted: true,
      metadata: null,
      implicit: true,
    });
    expect(dto.mail).toBeNull();
    expect(dto.deleted).toBe(true);
    expect(dto.implicit).toBe(true);
  });
});

describe("sortEntries", () => {
  it("puts folders first, then dated mails newest first, then the rest by natural name", () => {
    const sorted = sortEntries([
      entry({ kind: "file", name: "file10.txt" }),
      entry({ kind: "mail", name: "m1", mtime: "2026-01-01T00:00:00Z" }),
      entry({ kind: "folder", name: "zeta" }),
      entry({ kind: "file", name: "file2.txt" }),
      entry({ kind: "mail", name: "m2", mtime: "2026-03-01T00:00:00Z" }),
      entry({ kind: "folder", name: "Alpha" }),
      entry({ kind: "mail", name: "m3", mtime: null }),
    ]);
    expect(sorted.map((e) => e.name)).toEqual([
      "Alpha",
      "zeta",
      "m2",
      "m1",
      "file2.txt",
      "file10.txt",
      "m3",
    ]);
  });

  it("is a consistent comparator with a path tiebreak", () => {
    const a = entry({ kind: "file", name: "a" });
    const b = entry({ kind: "file", name: "b" });
    expect(compareEntries(a, b)).toBeLessThan(0);
    expect(compareEntries(b, a)).toBeGreaterThan(0);
    expect(compareEntries(a, a)).toBe(0);
    const same1 = entry({ kind: "file", name: "x", path: "one/x" });
    const same2 = entry({ kind: "file", name: "x", path: "two/x" });
    expect(compareEntries(same1, same2)).toBeLessThan(0);
  });

  it("compares dated mail by the actual instant, not the date string's own text", () => {
    // "Z" and "+00:00" name the same instant; a lexical compare of the two
    // strings ("2026-01-01T10:00:00+00:00" vs "2026-01-01T10:00:00Z") does
    // not agree with a plain "Z" vs "Z" compare once the offsets differ, and
    // the Graph and IMAP engines do not always agree on which form (or
    // sub-second precision) they record.
    const zSuffix = entry({
      kind: "mail",
      name: "m-z",
      mail: { ...emptyMailSummary, date: "2026-01-01T10:00:00Z" },
    });
    const sameInstantOffset = entry({
      kind: "mail",
      name: "m-offset",
      mail: { ...emptyMailSummary, date: "2026-01-01T12:00:00+02:00" },
    });
    // Same instant, different text: falls through to the name tiebreak
    // rather than an arbitrary string-based order.
    expect(compareEntries(zSuffix, sameInstantOffset)).toBe(
      zSuffix.name.localeCompare(sameInstantOffset.name, undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );

    const olderWithOffset = entry({
      kind: "mail",
      name: "m-older",
      // 09:00 local with a +02:00 offset is 07:00 UTC (the older instant),
      // but its raw text ("...09:00:00...") lexically outranks the newer
      // entry's ("...08:00:00Z"), which a plain string compare would get
      // backwards.
      mail: { ...emptyMailSummary, date: "2026-01-01T09:00:00+02:00" },
    });
    const newerZ = entry({
      kind: "mail",
      name: "m-newer",
      mail: { ...emptyMailSummary, date: "2026-01-01T08:00:00Z" },
    });
    // Newest first: newerZ (08:00 UTC) sorts before olderWithOffset (07:00
    // UTC) even though its raw date text is lexically *smaller*
    // ("08:..." < "09:...").
    expect(compareEntries(olderWithOffset, newerZ)).toBeGreaterThan(0);
    expect(compareEntries(newerZ, olderWithOffset)).toBeLessThan(0);
  });
});

describe("fingerprintOf", () => {
  const base = { size: 10, mtime: new Date(1000), chunkRefs: null, metadata: null, deleted: false };

  it("prefers sha256, then chunk refs, then etag, then size and mtime", () => {
    expect(fingerprintOf({ ...base, metadata: { sha256: "abc" } })).toBe("sha256:abc");
    expect(fingerprintOf({ ...base, chunkRefs: ["c1", "c2"] })).toBe("chunks:c1,c2");
    expect(fingerprintOf({ ...base, metadata: { etag: "W/1" } })).toBe("etag:W/1");
    expect(fingerprintOf({ ...base, metadata: { cTag: "c/2" } })).toBe("etag:c/2");
    expect(fingerprintOf(base)).toBe("stat:10:1000");
    expect(fingerprintOf({ ...base, deleted: true })).toBe("deleted");
  });
});

function version(
  partial: Partial<VersionRow> & Pick<VersionRow, "sequence" | "fingerprint">,
): VersionRow {
  return {
    objectId: `o${partial.sequence}`,
    snapshotId: `s${partial.sequence}`,
    snapshotAt: `2026-01-0${partial.sequence}T00:00:00Z`,
    path: "Documents/report.docx",
    name: "report.docx",
    kind: "file",
    size: 100,
    mtime: null,
    itemId: "item-1",
    deleted: false,
    ...partial,
  };
}

describe("collapseVersions", () => {
  it("merges consecutive snapshots with identical content into one version", () => {
    const versions = collapseVersions([
      version({ sequence: 1, fingerprint: "a" }),
      version({ sequence: 2, fingerprint: "a" }),
      version({ sequence: 3, fingerprint: "b" }),
      version({ sequence: 4, fingerprint: "b" }),
      version({ sequence: 5, fingerprint: "a" }),
    ]);
    expect(versions.map((v) => [v.sequence, v.firstSeenSequence, v.snapshotCount])).toEqual([
      [5, 5, 1],
      [4, 3, 2],
      [2, 1, 2],
    ]);
    // The newest snapshot carrying a version is the one restore uses.
    expect(versions[1]?.snapshotId).toBe("s4");
    expect(versions[1]?.firstSeenAt).toBe("2026-01-03T00:00:00Z");
  });

  it("accepts rows in any order and handles the empty case", () => {
    expect(collapseVersions([])).toEqual([]);
    const versions = collapseVersions([
      version({ sequence: 2, fingerprint: "x" }),
      version({ sequence: 1, fingerprint: "y" }),
    ]);
    expect(versions.map((v) => v.sequence)).toEqual([2, 1]);
  });

  it("shows a deletion as its own version", () => {
    const versions = collapseVersions([
      version({ sequence: 1, fingerprint: "a" }),
      version({ sequence: 2, fingerprint: "deleted", deleted: true }),
    ]);
    expect(versions[0]?.deleted).toBe(true);
    expect(versions[1]?.deleted).toBe(false);
  });
});

describe("toStoredVersion", () => {
  it("reads OneDrive's version metadata and falls back to the row", () => {
    expect(
      toStoredVersion({
        path: "Documents/report.docx:versions/2.0",
        name: "2.0",
        size: 512,
        mtime: new Date("2026-01-05T12:00:00Z"),
        metadata: {
          versionId: "2.0",
          lastModifiedDateTime: "2026-01-05T11:59:00Z",
          lastModifiedBy: "Anna Example",
        },
      }),
    ).toEqual({
      path: "Documents/report.docx:versions/2.0",
      versionId: "2.0",
      size: 512,
      modifiedAt: "2026-01-05T11:59:00Z",
      modifiedBy: "Anna Example",
    });
    expect(
      toStoredVersion({
        path: "a.txt:versions/1.0",
        name: "1.0",
        size: 1,
        mtime: null,
        metadata: null,
      }),
    ).toEqual({
      path: "a.txt:versions/1.0",
      versionId: "1.0",
      size: 1,
      modifiedAt: null,
      modifiedBy: null,
    });
  });
});

describe("escapeLike", () => {
  it("escapes the ILIKE metacharacters", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });
});
