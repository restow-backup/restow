import { buildCause } from "@restow/core";
import { describe, expect, it } from "vitest";

import { addToSummary, parseItemFailureSummary } from "./progress.js";

/** The per-run count of failed items that keeps the explanation exact beyond the stored rows. */

describe("the item failure summary of a run", () => {
  it("counts every failure under its cause and only the written rows as stored", () => {
    const tooLarge = { cause: buildCause("graph.item_too_large") };
    const summary = addToSummary({ total: 0, stored: 0, byCause: {} }, [tooLarge, tooLarge, {}], 2);
    expect(summary).toEqual({
      total: 3,
      stored: 2,
      byCause: { "graph.item_too_large": 2, unknown: 1 },
    });
    expect(addToSummary(summary, [tooLarge], 0)).toEqual({
      total: 4,
      stored: 2,
      byCause: { "graph.item_too_large": 3, unknown: 1 },
    });
  });

  it("stays bounded in the number of causes it names", () => {
    let summary = parseItemFailureSummary(null);
    for (let index = 0; index < 60; index += 1) {
      summary = addToSummary(
        summary,
        [{ cause: { ...buildCause("unknown"), code: `x.code_${index}` as never } }],
        0,
      );
    }
    expect(Object.keys(summary.byCause)).toHaveLength(51);
    expect(summary.byCause.unknown).toBe(10);
    expect(summary.total).toBe(60);
  });

  it("reads a stored summary defensively", () => {
    expect(parseItemFailureSummary({ total: "3", stored: -1, byCause: { a: 2, b: "x" } })).toEqual({
      total: 0,
      stored: 0,
      byCause: { a: 2 },
    });
    expect(parseItemFailureSummary([])).toEqual({ total: 0, stored: 0, byCause: {} });
  });
});
