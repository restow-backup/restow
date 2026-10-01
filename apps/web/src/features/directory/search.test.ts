import { describe, expect, it } from "vitest";

import { objectsSearchParams } from "./api";
import { hasObjectFilters, nextSearch, parseDirectorySearch, toObjectsQuery } from "./search";

const SOURCE = "0b0f7a52-3a1f-4a4e-9a0e-1f2d3c4b5a69";

describe("parseDirectorySearch", () => {
  it("keeps valid values and drops everything else", () => {
    expect(
      parseDirectorySearch({
        tab: "sources",
        q: "  alice  ",
        kind: "mailbox",
        status: "nonsense",
        source: SOURCE,
        page: "3",
        size: "50",
        sort: "status",
        order: "desc",
        extra: "ignored",
      }),
    ).toEqual({
      tab: "sources",
      q: "alice",
      kind: "mailbox",
      source: SOURCE,
      page: 3,
      size: 50,
      sort: "status",
      order: "desc",
    });
  });

  it("keeps the not-selected status and the shared/blocked flag", () => {
    expect(parseDirectorySearch({ status: "not_selected", shared: "true" })).toEqual({
      status: "not_selected",
      shared: true,
    });
    expect(parseDirectorySearch({ shared: "false" })).toEqual({ shared: false });
    expect(parseDirectorySearch({ shared: "maybe" })).toEqual({});
  });

  it("leaves defaults out of the URL", () => {
    expect(
      parseDirectorySearch({
        tab: "objects",
        q: " ",
        source: "not-a-uuid",
        page: 1,
        size: 25,
        sort: "name",
        order: "asc",
      }),
    ).toEqual({});
    expect(parseDirectorySearch({ size: 37, page: -2 })).toEqual({});
  });
});

describe("nextSearch", () => {
  it("returns to the first page when a filter changes", () => {
    expect(nextSearch({ page: 4, kind: "imap" }, { status: "excluded" })).toEqual({
      kind: "imap",
      status: "excluded",
    });
  });

  it("keeps the page when only the page or the tab changes", () => {
    expect(nextSearch({ page: 4, kind: "imap" }, { page: 5 })).toEqual({ page: 5, kind: "imap" });
    expect(nextSearch({ page: 4 }, { tab: "sources" })).toEqual({ page: 4, tab: "sources" });
  });

  it("removes a filter set to undefined", () => {
    expect(nextSearch({ kind: "imap", q: "x" }, { kind: undefined })).toEqual({ q: "x" });
  });
});

describe("toObjectsQuery and objectsSearchParams", () => {
  it("fills in defaults and sends only set filters", () => {
    const query = toObjectsQuery({ q: "anna", status: "active" });
    expect(query).toEqual({
      search: "anna",
      kind: undefined,
      status: "active",
      sourceId: undefined,
      page: 1,
      pageSize: 25,
      sort: "name",
      order: "asc",
    });
    expect(objectsSearchParams(query).toString()).toBe(
      "page=1&pageSize=25&sort=name&order=asc&search=anna&status=active",
    );
  });

  it("knows when filters are active", () => {
    expect(hasObjectFilters({})).toBe(false);
    expect(hasObjectFilters({ page: 3, sort: "kind" })).toBe(false);
    expect(hasObjectFilters({ source: SOURCE })).toBe(true);
    expect(hasObjectFilters({ shared: false })).toBe(true);
  });
});
