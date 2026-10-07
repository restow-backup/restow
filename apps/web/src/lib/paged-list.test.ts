import { describe, expect, it, vi } from "vitest";

import { fetchPages } from "./paged-list";

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `r${from + index}` }));

describe("fetchPages", () => {
  it("loads the asked pages and says that more may exist after a full page", async () => {
    const fetchPage = vi.fn(async (offset: number) => rows(offset, 2));
    const list = await fetchPages(fetchPage, 2, 2);
    expect(list.items.map((row) => row.id)).toEqual(["r0", "r1", "r2", "r3"]);
    expect(list.hasMore).toBe(true);
    expect(fetchPage.mock.calls.map(([offset]) => offset)).toEqual([0, 2]);
  });

  it("stops at a short page: nothing older exists", async () => {
    const fetchPage = vi.fn(async (offset: number) => (offset === 0 ? rows(0, 2) : rows(2, 1)));
    const list = await fetchPages(fetchPage, 2, 5);
    expect(list).toEqual({ items: rows(0, 3), hasMore: false });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("keeps an entry once when a new one pushed it onto the next page", async () => {
    const fetchPage = vi.fn(async (offset: number) =>
      offset === 0 ? rows(0, 2) : [{ id: "r1" }, { id: "r2" }],
    );
    const list = await fetchPages(fetchPage, 2, 2);
    expect(list.items.map((row) => row.id)).toEqual(["r0", "r1", "r2"]);
  });
});
