import { describe, expect, it } from "vitest";

import {
  activeQuery,
  compactSearch,
  parseExplorerSearch,
  preferredObject,
  withFolder,
  withItem,
  withObject,
  withQuery,
  withSnapshot,
  withSort,
} from "./explorer-search";

const OBJECT = "3f5c9c2e-7d0f-4c2e-9a4b-1d2f3e4a5b6c";
const SNAPSHOT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_SNAPSHOT = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";

describe("parseExplorerSearch", () => {
  it("keeps valid values and drops malformed ones instead of failing", () => {
    expect(
      parseExplorerSearch({
        object: OBJECT,
        snapshot: "not-a-uuid",
        path: "mail/Inbox",
        item: 42,
        q: "report",
      }),
    ).toEqual({
      object: OBJECT,
      snapshot: undefined,
      path: "mail/Inbox",
      item: undefined,
      q: "report",
    });
    expect(parseExplorerSearch(undefined)).toEqual({});
  });
});

describe("compactSearch", () => {
  it("normalizes paths and removes empty values", () => {
    expect(
      compactSearch({ object: OBJECT, snapshot: SNAPSHOT, path: "/mail/", item: "", q: "  " }),
    ).toEqual({ object: OBJECT, snapshot: SNAPSHOT, path: "mail" });
  });

  it("drops the default sort but keeps a non-default choice", () => {
    expect(compactSearch({ sort: "date" })).toEqual({});
    expect(compactSearch({ sort: "name" })).toEqual({ sort: "name" });
  });
});

describe("withSort", () => {
  it("sets the item list order without touching anything else", () => {
    expect(withSort({ object: OBJECT, path: "mail/Inbox" }, "name")).toEqual({
      object: OBJECT,
      path: "mail/Inbox",
      sort: "name",
    });
  });
});

describe("transitions", () => {
  const base = {
    object: OBJECT,
    snapshot: SNAPSHOT,
    path: "mail/Inbox",
    item: "mail/Inbox/a.eml",
    q: "quarter",
  };

  it("starts over for another object", () => {
    expect(withObject("x")).toEqual({ object: "x" });
  });

  it("keeps folder and item when the point in time changes", () => {
    expect(withSnapshot(base, OTHER_SNAPSHOT)).toEqual({ ...base, snapshot: OTHER_SNAPSHOT });
  });

  it("closes details and search when a folder opens", () => {
    expect(withFolder(base, "/mail/Sent/")).toEqual({
      object: OBJECT,
      snapshot: SNAPSHOT,
      path: "mail/Sent",
      item: undefined,
      q: undefined,
    });
  });

  it("opens and closes details", () => {
    expect(withItem(base, "/mail/Inbox/b.eml").item).toBe("mail/Inbox/b.eml");
    expect(withItem(base, undefined).item).toBeUndefined();
  });

  it("sets and clears the query, closing the details", () => {
    expect(withQuery(base, "invoice")).toMatchObject({ q: "invoice", item: undefined });
    expect(withQuery(base, "").q).toBeUndefined();
  });

  it("searches only with at least two characters", () => {
    expect(activeQuery({ q: " a " })).toBeNull();
    expect(activeQuery({ q: " ab " })).toBe("ab");
    expect(activeQuery({})).toBeNull();
  });
});

describe("preferredObject", () => {
  it("opens the viewer's own object first, else the first one", () => {
    expect(
      preferredObject([
        { own: false, id: "a" },
        { own: true, id: "b" },
      ])?.id,
    ).toBe("b");
    expect(preferredObject([{ own: false, id: "a" }])?.id).toBe("a");
    expect(preferredObject([])).toBeNull();
  });
});
