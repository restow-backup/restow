import { describe, expect, it } from "vitest";
import {
  batchBySize,
  breakdownByUidNext,
  orderFolders,
  planFolder,
  readImapState,
  selectUidsToFetch,
} from "./planning.js";
import type { ImapFolderInfo, ImapFolderState, ImapFolderStatus } from "./types.js";

const status: ImapFolderStatus = { path: "INBOX", uidValidity: "1000", uidNext: 50, exists: 10 };
const previous: ImapFolderState = {
  uidValidity: "1000",
  uidNext: 40,
  delimiter: "/",
  messages: 8,
};

describe("planFolder", () => {
  it("reads a folder in full the first time", () => {
    expect(planFolder(undefined, status)).toEqual({ mode: "full", reason: "first_backup" });
  });

  it("continues incrementally under the same UIDVALIDITY", () => {
    expect(planFolder(previous, status)).toEqual({ mode: "incremental", reason: "incremental" });
  });

  it("re-reads the folder when UIDVALIDITY changed", () => {
    expect(planFolder({ ...previous, uidValidity: "999" }, status)).toEqual({
      mode: "full",
      reason: "uidvalidity_changed",
    });
  });

  it("re-reads everything when a full run is requested", () => {
    expect(planFolder(previous, status, { full: true })).toEqual({
      mode: "full",
      reason: "full_requested",
    });
  });
});

describe("selectUidsToFetch", () => {
  it("fetches only unknown UIDs incrementally, sorted ascending", () => {
    expect(selectUidsToFetch("incremental", [9, 3, 7, 1], new Set([1, 3]))).toEqual([7, 9]);
  });

  it("fetches every UID on a full read", () => {
    expect(selectUidsToFetch("full", [9, 3, 7, 1], new Set([1, 3]))).toEqual([1, 3, 7, 9]);
  });

  it("skips what a checkpointed attempt already stored", () => {
    expect(selectUidsToFetch("full", [1, 2, 3, 4], new Set(), 2)).toEqual([3, 4]);
  });
});

describe("breakdownByUidNext", () => {
  it("separates messages delivered since the last run from retries of older ones", () => {
    expect(breakdownByUidNext([3, 40, 41, 57], 40)).toEqual({ arrived: 3, retried: 1 });
    expect(breakdownByUidNext([], 40)).toEqual({ arrived: 0, retried: 0 });
  });
});

describe("batchBySize", () => {
  it("groups by cumulative size and message count", () => {
    const messages = [
      { uid: 1, size: 40 },
      { uid: 2, size: 40 },
      { uid: 3, size: 40 },
      { uid: 4, size: 10 },
      { uid: 5, size: 10 },
      { uid: 6, size: 10 },
    ];
    expect(batchBySize(messages, { maxBytes: 100, maxMessages: 2 })).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(batchBySize(messages, { maxBytes: 100, maxMessages: 10 })).toEqual([
      [1, 2],
      [3, 4, 5, 6],
    ]);
  });

  it("gives an oversized message a batch of its own", () => {
    expect(
      batchBySize(
        [
          { uid: 1, size: 5 },
          { uid: 2, size: 500 },
          { uid: 3, size: 5 },
        ],
        { maxBytes: 100, maxMessages: 10 },
      ),
    ).toEqual([[1], [2], [3]]);
  });

  it("returns nothing for no messages", () => {
    expect(batchBySize([], { maxBytes: 1, maxMessages: 1 })).toEqual([]);
  });
});

describe("orderFolders", () => {
  it("puts INBOX first, sorts the rest by path and drops containers", () => {
    const folder = (path: string, extra: Partial<ImapFolderInfo> = {}): ImapFolderInfo => ({
      path,
      name: path,
      parent: [],
      delimiter: "/",
      selectable: true,
      ...extra,
    });
    const ordered = orderFolders([
      folder("Sent"),
      folder("Projects", { selectable: false }),
      folder("Archive"),
      folder("INBOX", { specialUse: "\\Inbox" }),
    ]);
    expect(ordered.map((f) => f.path)).toEqual(["INBOX", "Archive", "Sent"]);
  });
});

describe("readImapState", () => {
  it("returns an empty state for anything malformed", () => {
    expect(readImapState(undefined).imap.folders).toEqual({});
    expect(readImapState({ imap: "nope" }).imap.folders).toEqual({});
    expect(
      readImapState({ imap: { folders: { INBOX: { uidValidity: 1 } } } }).imap.folders,
    ).toEqual({});
  });

  it("keeps well-formed folder entries", () => {
    const state = readImapState({ imap: { version: 1, folders: { INBOX: previous } } });
    expect(state.imap.folders.INBOX).toEqual(previous);
  });
});
