import { describe, expect, it } from "vitest";

import type { TreeEntry } from "@/features/restore/api";
import {
  EMPTY_SELECTION,
  countSelection,
  coveringFolder,
  deselectAll,
  everythingSelection,
  isCovered,
  isSelected,
  listSelectionState,
  remove,
  selectAll,
  selectionOf,
  toApiSelection,
  toSelectedEntry,
  toggle,
} from "./selection";

function entry(partial: Partial<TreeEntry> & Pick<TreeEntry, "path" | "kind">): TreeEntry {
  const slash = partial.path.lastIndexOf("/");
  return {
    id: partial.path,
    name: partial.path.slice(slash + 1),
    parentPath: slash < 0 ? "" : partial.path.slice(0, slash),
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

const inbox = entry({ path: "mail/Inbox", kind: "folder" });
const mail = entry({
  path: "mail/Inbox/Hello.0123456789abcdef.eml",
  kind: "mail",
  size: 10,
  itemId: "AAMk",
  mail: {
    subject: "Hello",
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
  },
});
const file = entry({ path: "Documents/a.docx", kind: "file", size: 5 });

describe("selection", () => {
  it("toggles entries and keeps the model immutable", () => {
    const one = toggle(EMPTY_SELECTION, mail);
    expect(isSelected(one, mail.path)).toBe(true);
    expect(EMPTY_SELECTION.size).toBe(0);
    const none = toggle(one, mail);
    expect(none.size).toBe(0);
    expect(remove(none, "missing")).toBe(none);
  });

  it("keeps what the dialog needs to name and size an entry", () => {
    expect(toSelectedEntry(mail)).toEqual({
      path: mail.path,
      kind: "mail",
      itemId: "AAMk",
      subject: "Hello",
      size: 10,
    });
  });

  it("selects and deselects whole listings and reports the header state", () => {
    const entries = [inbox, file];
    expect(listSelectionState(EMPTY_SELECTION, entries)).toBe("none");
    const all = selectAll(EMPTY_SELECTION, entries);
    expect(listSelectionState(all, entries)).toBe("all");
    const some = remove(all, file.path);
    expect(listSelectionState(some, entries)).toBe("some");
    expect(deselectAll(all, entries).size).toBe(0);
    expect(listSelectionState(EMPTY_SELECTION, [])).toBe("none");
  });

  it("treats entries below a selected folder as covered and does not select them twice", () => {
    const selection = toggle(EMPTY_SELECTION, inbox);
    expect(isCovered(selection, mail.path)).toBe(true);
    expect(coveringFolder(selection, mail.path)?.path).toBe("mail/Inbox");
    expect(coveringFolder(selection, "mail/Inbox")).toBeNull();
    expect(isCovered(selection, "mail/Inbox2/x.eml")).toBe(false);
    // Opening the folder and ticking "all" adds nothing the folder already includes.
    expect(selectAll(selection, [mail]).size).toBe(1);
    expect(listSelectionState(selection, [mail])).toBe("all");
  });

  it("counts folders, items and item bytes", () => {
    const selection = selectAll(EMPTY_SELECTION, [inbox, mail, file]);
    expect(countSelection(selection)).toEqual({ folders: 1, items: 2, total: 3, bytes: 15 });
  });

  it("serializes to the API shape, sorted by path", () => {
    const selection = selectAll(EMPTY_SELECTION, [mail, file, inbox]);
    expect(toApiSelection(selection)).toEqual([
      { path: "Documents/a.docx", kind: "item" },
      { path: "mail/Inbox", kind: "folder" },
      { path: mail.path, kind: "item" },
    ]);
    expect(everythingSelection()).toEqual([{ path: "", kind: "folder" }]);
  });

  it("builds a selection of exactly the given entries", () => {
    const selection = selectionOf(toSelectedEntry(file));
    expect([...selection.keys()]).toEqual(["Documents/a.docx"]);
  });
});
