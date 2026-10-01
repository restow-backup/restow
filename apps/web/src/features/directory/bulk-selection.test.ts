import { describe, expect, it } from "vitest";

import {
  EMPTY_SELECTION,
  bulkTarget,
  clearSelection,
  isEmpty,
  isPageFullySelected,
  isPagePartiallySelected,
  isSelected,
  selectAllMatching,
  selectionCount,
  togglePage,
  toggleRow,
} from "./bulk-selection";

const PAGE = ["a", "b", "c"];

describe("toggleRow", () => {
  it("checks and unchecks one id", () => {
    const checked = toggleRow(EMPTY_SELECTION, "a");
    expect(isSelected(checked, "a")).toBe(true);
    expect(isSelected(checked, "b")).toBe(false);
    expect(isEmpty(toggleRow(checked, "a"))).toBe(true);
  });

  it("touching a row while everything matching is selected starts a fresh pick", () => {
    const all = selectAllMatching();
    const next = toggleRow(all, "a");
    expect(next).toEqual({ mode: "ids", ids: new Set(["a"]) });
  });
});

describe("togglePage", () => {
  it("selects every row of the page, then clears it on the next call", () => {
    const full = togglePage(EMPTY_SELECTION, PAGE);
    expect(PAGE.every((id) => isSelected(full, id))).toBe(true);
    expect(isPageFullySelected(full, PAGE)).toBe(true);
    expect(isEmpty(togglePage(full, PAGE))).toBe(true);
  });

  it("completes a partial page instead of clearing it", () => {
    const partial = toggleRow(EMPTY_SELECTION, "a");
    expect(isPagePartiallySelected(partial, PAGE)).toBe(true);
    const full = togglePage(partial, PAGE);
    expect(isPageFullySelected(full, PAGE)).toBe(true);
  });

  it("leaves selections on other pages alone", () => {
    const otherPage = toggleRow(EMPTY_SELECTION, "z");
    const full = togglePage(otherPage, PAGE);
    expect(isSelected(full, "z")).toBe(true);
    expect(PAGE.every((id) => isSelected(full, id))).toBe(true);
  });

  it("clears the whole selection when the page was covered by 'all matching'", () => {
    expect(togglePage(selectAllMatching(), PAGE)).toEqual(EMPTY_SELECTION);
  });
});

describe("all matching", () => {
  it("treats every id as selected and counts the filter's total", () => {
    const all = selectAllMatching();
    expect(isSelected(all, "anything")).toBe(true);
    expect(selectionCount(all, 143)).toBe(143);
    expect(isPageFullySelected(all, PAGE)).toBe(true);
    expect(isPagePartiallySelected(all, PAGE)).toBe(false);
  });

  it("clears back to nothing", () => {
    expect(clearSelection()).toEqual(EMPTY_SELECTION);
  });
});

describe("bulkTarget", () => {
  it("sends explicit ids, or the filter for 'all matching'", () => {
    const ids = toggleRow(toggleRow(EMPTY_SELECTION, "a"), "b");
    expect(bulkTarget(ids, { kind: "mailbox" })).toEqual({ objectIds: ["a", "b"] });
    expect(bulkTarget(selectAllMatching(), { kind: "mailbox" })).toEqual({
      filter: { kind: "mailbox" },
    });
  });
});
