import { describe, expect, it } from "vitest";
import { JobAbortedError } from "../../engine/chunkstore.js";
import { GraphError } from "../../graph/errors.js";
import type { MailFolderNode, WellKnownFolderName } from "../../graph/resources/mail.js";
import { graphError } from "../../graph/testing/fake-graph.js";
import { contentFingerprint, planMailFolders } from "./mail.js";
import {
  assignFolderPaths,
  attachmentsFolderOf,
  displayFolderPath,
  mailJsonObjectPath,
  rebasePath,
  sanitizeSegment,
  shortId,
} from "./paths.js";
import { ItemError, isItemLevelError, isMailboxAccessError, isVanished } from "./run.js";
import { EXCHANGE_STATE_VERSION, parseCursor, readState } from "./state.js";
import { mimeFor } from "./testing/fake-mailbox.js";

function graphFailure(status: number, code: string): GraphError {
  return new GraphError({
    status,
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/users/u/messages/m/$value",
    payload: graphError(code),
  });
}

function folderNode(
  id: string,
  displayName: string,
  parent: MailFolderNode | null,
  wellKnownName: WellKnownFolderName | null = null,
): MailFolderNode {
  return {
    id,
    displayName,
    parentFolderId: parent?.id ?? "AAMkRoot",
    childFolderCount: 0,
    totalItemCount: 0,
    unreadItemCount: 0,
    isHidden: false,
    wellKnownName,
    path: [...(parent?.path ?? []), displayName],
    depth: (parent?.depth ?? -1) + 1,
  };
}

describe("object paths", () => {
  it("sanitises display names without losing readability", () => {
    expect(sanitizeSegment("Q3/Q4 numbers", "x")).toBe("Q3∕Q4 numbers");
    expect(sanitizeSegment("back\\slash", "x")).toBe("back∕slash");
    expect(sanitizeSegment("  spaced\t\nout  ", "x")).toBe("spaced out");
    expect(sanitizeSegment("bell\u0007 and nul\u0000", "x")).toBe("bell and nul");
    expect(sanitizeSegment(" ", "(no subject)")).toBe("(no subject)");
    expect(sanitizeSegment(null, "(no subject)")).toBe("(no subject)");
    expect(sanitizeSegment("...hidden", "x")).toBe("hidden");
    expect(sanitizeSegment("a".repeat(500), "x")).toHaveLength(120);
  });

  it("records folder paths as the user named them", () => {
    expect(displayFolderPath(["Inbox", "Projects"])).toBe("Inbox/Projects");
    expect(displayFolderPath([".config", "Q3/Q4", "  "])).toBe(".config/Q3∕Q4/(unnamed)");
    expect(displayFolderPath([])).toBe("");
  });

  it("gives colliding sibling folders distinct paths", () => {
    const paths = assignFolderPaths("mail", [
      { id: "a", parentId: null, name: "Inbox" },
      { id: "b", parentId: null, name: "inbox" },
      { id: "c", parentId: null, name: "Inbox" },
      { id: "d", parentId: "c", name: "Child" },
      { id: "e", parentId: "missing", name: "Orphan" },
    ]);
    expect(paths.get("a")).toBe("mail/Inbox");
    expect(paths.get("b")).toBe("mail/inbox");
    expect(paths.get("c")).toBe(`mail/Inbox.${shortId("c", 8)}`);
    expect(paths.get("d")).toBe(`mail/Inbox.${shortId("c", 8)}/Child`);
    expect(paths.get("e")).toBe("mail/Orphan");
  });

  it("derives the attachments folder of a JSON message and rebases paths", () => {
    const message = mailJsonObjectPath("mail/Inbox", "Launch", "AAMk1");
    expect(message).toBe(`mail/Inbox/Launch.${shortId("AAMk1")}.json`);
    expect(attachmentsFolderOf(message)).toBe(`mail/Inbox/Launch.${shortId("AAMk1")}.attachments`);
    expect(rebasePath("mail/Inbox/a/b", "mail/Inbox", "mail/Posteingang")).toBe(
      "mail/Posteingang/a/b",
    );
    expect(rebasePath("mail/Inboxes/a", "mail/Inbox", "mail/X")).toBe("mail/Inboxes/a");
  });

  it("builds a MIME fixture with the message id header", () => {
    expect(mimeFor({ subject: "S", internetMessageId: "<a@b>" })).toContain("Message-ID: <a@b>");
  });
});

describe("planMailFolders", () => {
  const inbox = folderNode("inbox", "Posteingang", null, "inbox");
  const projects = folderNode("projects", "Projekte", inbox);
  const archive = folderNode("archive", "Archiv", projects);
  const custom = folderNode("custom", "Kunden", null);
  const search = folderNode("search", "Suchordner", null, "searchfolders");
  const searchChild = folderNode("search-child", "Gespeichert", search);

  it("inherits the top-level well-known name and skips virtual subtrees", () => {
    const planned = planMailFolders(
      [inbox, custom, search, projects, searchChild, archive],
      new Set(["searchfolders"]),
    );
    expect(planned.map((folder) => folder.node.id)).toEqual([
      "inbox",
      "custom",
      "projects",
      "archive",
    ]);
    const byId = new Map(planned.map((folder) => [folder.node.id, folder]));
    expect(byId.get("archive")).toMatchObject({
      path: "mail/Posteingang/Projekte/Archiv",
      displayPath: "Posteingang/Projekte/Archiv",
      topWellKnownName: "inbox",
    });
    expect(byId.get("custom")?.topWellKnownName).toBeNull();
  });
});

describe("contentFingerprint", () => {
  const base = { id: "m", subject: "Hi", hasAttachments: false, isDraft: false, bodyPreview: "x" };

  it("ignores flags, read state, categories and importance", () => {
    const changed = {
      ...base,
      isRead: true,
      flag: { flagStatus: "flagged" as const },
      categories: ["A"],
      importance: "high" as const,
      lastModifiedDateTime: "2026-09-10T10:00:00Z",
    };
    expect(contentFingerprint(changed)).toBe(contentFingerprint(base));
  });

  it("changes with the content", () => {
    expect(contentFingerprint({ ...base, subject: "Hi!" })).not.toBe(contentFingerprint(base));
    expect(contentFingerprint({ ...base, hasAttachments: true })).not.toBe(
      contentFingerprint(base),
    );
    expect(contentFingerprint({ ...base, bodyPreview: "y" })).not.toBe(contentFingerprint(base));
  });

  it("treats every modification of a draft as a content change", () => {
    const draft = { ...base, isDraft: true, lastModifiedDateTime: "2026-09-10T10:00:00Z" };
    expect(contentFingerprint({ ...draft, lastModifiedDateTime: "2026-09-10T10:05:00Z" })).not.toBe(
      contentFingerprint(draft),
    );
  });
});

describe("error classification", () => {
  it("records single-item problems as item failures", () => {
    expect(isItemLevelError(graphFailure(500, "ErrorInternalServerError"))).toBe(true);
    expect(isItemLevelError(graphFailure(400, "ErrorInvalidRequest"))).toBe(true);
    expect(isItemLevelError(new ItemError("attachment removed"))).toBe(true);
    expect(isItemLevelError(new TypeError("fetch failed"))).toBe(true);
    expect(isItemLevelError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("fails the run for what the next item would hit as well", () => {
    expect(isItemLevelError(graphFailure(401, "InvalidAuthenticationToken"))).toBe(false);
    expect(isItemLevelError(graphFailure(429, "ApplicationThrottled"))).toBe(false);
    expect(isItemLevelError(graphFailure(503, "ServiceUnavailable"))).toBe(false);
    expect(isItemLevelError(new JobAbortedError())).toBe(false);
    expect(isItemLevelError(new Error("disk full"))).toBe(false);
  });

  it("tells a deleted item from a missing mailbox", () => {
    expect(isVanished(graphFailure(404, "ErrorItemNotFound"))).toBe(true);
    expect(isVanished(graphFailure(404, "MailboxNotEnabledForRESTAPI"))).toBe(false);
    expect(isMailboxAccessError(graphFailure(404, "MailboxNotEnabledForRESTAPI"))).toBe(true);
    expect(isMailboxAccessError(graphFailure(403, "ErrorAccessDenied"))).toBe(true);
    expect(isMailboxAccessError(graphFailure(404, "ErrorItemNotFound"))).toBe(false);
  });
});

describe("state and cursor parsing", () => {
  it("degrades unknown or malformed state to a fresh start", () => {
    expect(readState(undefined).mailDeltaLinks).toEqual({});
    expect(readState({ exchange: { version: EXCHANGE_STATE_VERSION + 1 } }).mailFolders).toEqual(
      {},
    );
    const state = readState({
      exchange: {
        version: EXCHANGE_STATE_VERSION,
        mailDeltaLinks: { f1: "https://graph/delta?token=1", f2: 42 },
        mailFolders: {
          f1: { path: "mail/Inbox", displayPath: "Inbox", name: "Inbox", parentId: null },
          f2: { path: "mail/Broken" },
        },
        mailRetry: { f1: ["m1", "m2"], f2: "m3", f3: [] },
        calendars: { c1: "calendar/Calendar" },
        contactFolders: "nope",
      },
    });
    expect(state.mailDeltaLinks).toEqual({});
    expect(Object.keys(state.mailFolders)).toEqual(["f1"]);
    expect(state.mailRetry).toEqual({ f1: ["m1", "m2"] });
    expect(state.calendars).toEqual({ c1: "calendar/Calendar" });
    expect(state.contactFolders).toEqual({});
  });

  it("treats a cursor without a snapshot checkpoint as absent", () => {
    expect(parseCursor(null).checkpoint).toBeUndefined();
    expect(parseCursor({ folderId: "f1", exchange: { completedFolders: ["f0"] } })).toEqual({
      checkpoint: undefined,
      progress: { completedFolders: [], calendarDone: false, contactsDone: false },
      deltaTokens: {},
    });
    const parsed = parseCursor({
      snapshot: { snapshotId: "s", sequence: 2, partialKey: "k", objectCount: 3 },
      exchange: { completedFolders: ["f0", 7], calendarDone: true },
      deltaTokens: { f0: "link" },
    });
    expect(parsed.progress).toEqual({
      completedFolders: ["f0"],
      calendarDone: true,
      contactsDone: false,
    });
    expect(parsed.deltaTokens).toEqual({ f0: "link" });
  });
});
