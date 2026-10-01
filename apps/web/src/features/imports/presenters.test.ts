import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "@/lib/api";

import {
  alreadyImportedCount,
  collectMailboxes,
  countByFilter,
  formatKey,
  hasProblems,
  importErrorKey,
  initialFilter,
  isCancellable,
  isLive,
  itemCodeKey,
  itemsAsText,
  matchesFilter,
  noteKey,
  orderItems,
  phaseKey,
  progressRatio,
  shortHash,
  statusKey,
  statusTone,
} from "./presenters";
import { duplicateItem, failedItem, notMailItem, report, summary } from "./testing/fixtures";

describe("status", () => {
  it("is live while queued or running, and only then cancellable", () => {
    expect(isLive({ status: "queued" })).toBe(true);
    expect(isLive({ status: "active" })).toBe(true);
    expect(isLive({ status: "completed" })).toBe(false);
    expect(isCancellable({ status: "active" })).toBe(true);
    expect(isCancellable({ status: "failed" })).toBe(false);
  });

  it("calls a completed import with failed items a warning, never a plain success", () => {
    // A clean import is neutral: the mail is stowed, which no restore check has proven.
    expect(statusTone({ status: "completed", failed: 0 })).toBe("neutral");
    expect(statusTone({ status: "completed", failed: null })).toBe("neutral");
    expect(statusTone({ status: "completed", failed: 3 })).toBe("warning");
    expect(statusKey({ status: "completed", failed: 3 })).toBe("status.completedWithIssues");
    expect(statusKey({ status: "completed", failed: 0 })).toBe("status.completed");
    expect(hasProblems({ failed: 1 })).toBe(true);
  });

  it("gives every other status its own tone and label", () => {
    expect(statusTone({ status: "queued", failed: null })).toBe("muted");
    expect(statusTone({ status: "active", failed: null })).toBe("default");
    expect(statusTone({ status: "failed", failed: null })).toBe("destructive");
    expect(statusTone({ status: "cancelled", failed: null })).toBe("secondary");
    expect(statusKey({ status: "failed", failed: null })).toBe("status.failed");
    expect(statusKey({ status: "unknown", failed: null })).toBe("status.unknown");
  });
});

describe("progress", () => {
  it("is the share of source bytes read", () => {
    expect(progressRatio({ total: 200, done: 50 })).toBe(0.25);
    expect(progressRatio({ total: 200, done: 900 })).toBe(1);
    expect(progressRatio({ total: 0, done: 0 })).toBeNull();
    expect(progressRatio(null)).toBeNull();
  });

  it("maps the phases the worker reports and falls back for others", () => {
    expect(phaseKey("import")).toBe("phase.import");
    expect(phaseKey("archive")).toBe("phase.archive");
    expect(phaseKey("something-new")).toBe("phase.other");
    expect(phaseKey(null)).toBeNull();
  });
});

describe("items", () => {
  const items = [notMailItem, duplicateItem, failedItem];

  it("lists failed items first and keeps the order within each group", () => {
    expect(orderItems(items).map((item) => item.ref)).toEqual([
      failedItem.ref,
      notMailItem.ref,
      duplicateItem.ref,
    ]);
  });

  it("filters and counts by outcome", () => {
    expect(countByFilter(items)).toEqual({ all: 3, failed: 1, skipped: 2 });
    expect(items.filter((item) => matchesFilter(item, "skipped"))).toHaveLength(2);
    expect(items.filter((item) => matchesFilter(item, "all"))).toHaveLength(3);
  });

  it("opens on the failures when there are any", () => {
    expect(initialFilter(items)).toBe("failed");
    expect(initialFilter([notMailItem])).toBe("all");
  });

  it("explains every code the readers know and has a fallback for a new one", () => {
    expect(itemCodeKey("unreadable")).toBe("items.codes.unreadable");
    expect(itemCodeKey("duplicate")).toBe("items.codes.duplicate");
    expect(itemCodeKey("from-the-future")).toBe("items.codes.other");
  });

  it("puts one item per line with the reason for the clipboard", () => {
    expect(itemsAsText([failedItem, notMailItem])).toBe(
      [
        "mail/Inbox.mbox\tInbox.mbox#17\tfailed\tunreadable\tCould not parse the message: header block is truncated",
        "export.zip\texport.zip!Contacts/anna.msg\tskipped\tnot_mail\tOutlook item class IPM.Contact is not a mail message",
      ].join("\n"),
    );
  });
});

describe("notes, hashes and formats", () => {
  it("knows the notes it has a sentence for", () => {
    expect(noteKey("calendar_contacts_not_imported")).toBe("notes.calendar_contacts_not_imported");
    expect(noteKey("msg_reconstructed")).toBe("notes.msg_reconstructed");
    expect(noteKey("metadata_unavailable")).toBe("notes.metadata_unavailable");
    expect(noteKey("item_list_truncated")).toBe("notes.item_list_truncated");
    expect(noteKey("report_recovered")).toBe("notes.report_recovered");
    expect(noteKey("brand_new_note")).toBeNull();
  });

  it("shortens a hash and names a format", () => {
    expect(shortHash("abcdef0123456789")).toBe("abcdef012345");
    expect(shortHash(null)).toBeNull();
    expect(formatKey("pst")).toBe("formats.pst");
    expect(formatKey(null)).toBe("formats.unknown");
  });
});

describe("imported mailboxes", () => {
  it("merges the account list with the history, sorted by name", () => {
    const boxes = collectMailboxes(
      [
        { id: "o1", displayName: "Zeta archive", externalId: "import-o1", sourceKind: "import" },
        { id: "o2", displayName: "Anna", externalId: "ext", sourceKind: "m365" },
        { id: "o3", displayName: null, externalId: "import-o3", sourceKind: "import" },
      ],
      [
        summary({ id: "i3", objectId: "o1", name: "Zeta archive" }),
        summary({ id: "i2", objectId: "o4", name: "Only in history" }),
        summary({ id: "i1", objectId: "o1", name: "Zeta archive" }),
      ],
    );
    expect(boxes).toEqual([
      { id: "o3", name: "import-o3", imports: 0 },
      { id: "o4", name: "Only in history", imports: 1 },
      { id: "o1", name: "Zeta archive", imports: 2 },
    ]);
  });

  it("works from the history alone, newest name first", () => {
    const boxes = collectMailboxes(
      [],
      [
        summary({ id: "i2", objectId: "o1", name: "New name" }),
        summary({ id: "i1", objectId: "o1", name: "Old name" }),
      ],
    );
    expect(boxes).toEqual([{ id: "o1", name: "New name", imports: 2 }]);
  });
});

describe("API problems", () => {
  const problem = (type: string) => new ApiError(422, { type, title: "x", status: 422 }, "x");

  it("maps the import problems to feature messages", () => {
    expect(importErrorKey(problem("urn:restow:problem:import-format-not-supported"))).toBe(
      "imports:errors.formatNotSupported",
    );
    expect(importErrorKey(problem("urn:restow:problem:import-already-queued"))).toBe(
      "imports:errors.alreadyQueued",
    );
    expect(importErrorKey(problem("urn:restow:problem:import-name-taken"))).toBe(
      "imports:errors.nameTaken",
    );
  });

  it("falls back to the shared messages", () => {
    expect(importErrorKey(new NetworkError(new Error("x")))).toBe("common:errors.network");
    expect(importErrorKey(new ApiError(401, null, "x"))).toBe("common:errors.unauthorized");
    expect(importErrorKey(new Error("x"))).toBe("common:errors.generic");
  });
});

describe("alreadyImportedCount", () => {
  const totals = (overrides: Partial<ReturnType<typeof report>["totals"]>) => ({
    ...report().totals,
    ...overrides,
  });

  it("counts the messages of a re-import where every one was a duplicate", () => {
    expect(
      alreadyImportedCount(
        report({ snapshotId: null, totals: totals({ messages: 0, duplicates: 37, failed: 0 }) }),
      ),
    ).toBe(37);
  });

  it("is null for an import that stored something, failed on an item, found no duplicate or has no report", () => {
    expect(alreadyImportedCount(null)).toBeNull();
    // A snapshot was written: something was new.
    expect(alreadyImportedCount(report())).toBeNull();
    expect(
      alreadyImportedCount(
        report({ snapshotId: null, totals: totals({ messages: 2, duplicates: 5, failed: 0 }) }),
      ),
    ).toBeNull();
    // An unreadable item is not "already imported".
    expect(
      alreadyImportedCount(
        report({ snapshotId: null, totals: totals({ messages: 0, duplicates: 5, failed: 1 }) }),
      ),
    ).toBeNull();
    expect(
      alreadyImportedCount(
        report({ snapshotId: null, totals: totals({ messages: 0, duplicates: 0, failed: 0 }) }),
      ),
    ).toBeNull();
  });
});
