import { describe, expect, it } from "vitest";
import { MAX_CAUSE_LENGTH, UNKNOWN_CAUSE, failureCause, groupByCause } from "./causes.js";

describe("failureCause", () => {
  it("reduces a Graph error to its status and code", () => {
    expect(failureCause("Graph 404 ErrorItemNotFound: The specified object was not found.")).toBe(
      "Graph 404 ErrorItemNotFound",
    );
    expect(failureCause("Graph 503: Service unavailable")).toBe("Graph 503");
  });

  it("drops what identifies the item and keeps what identifies the problem", () => {
    expect(
      failureCause("Error: chunk 3f2b1c0d-1111-4222-8333-444455556666 could not be read"),
    ).toBe("Error: chunk … could not be read");
    expect(failureCause("IMAP UID 1234567 vanished during FETCH")).toBe(
      "IMAP UID … vanished during FETCH",
    );
    expect(failureCause("hash a3f9c2d41b7e mismatch")).toBe("hash … mismatch");
    // Words that merely look like hex and short numbers stay.
    expect(failureCause("HTTP 503 from facade")).toBe("HTTP 503 from facade");
  });

  it("uses the first line, collapses whitespace and cuts long reasons", () => {
    expect(failureCause("  first   line \nstack trace")).toBe("first line");
    const long = failureCause(`TypeError: ${"x".repeat(400)}`);
    expect(long).toHaveLength(MAX_CAUSE_LENGTH);
    expect(long.endsWith("…")).toBe(true);
    expect(failureCause("   ")).toBe(UNKNOWN_CAUSE);
  });
});

describe("groupByCause", () => {
  it("adds up reasons of the same cause, most frequent first", () => {
    const at = (day: number) => new Date(Date.UTC(2026, 8, day));
    const grouped = groupByCause([
      { reason: "Graph 404 ErrorItemNotFound: item A", count: 2, lastAt: at(3) },
      { reason: "Graph 404 ErrorItemNotFound: item B", count: 3, lastAt: at(5) },
      { reason: "Graph 429 TooManyRequests: slow down", count: 5, lastAt: at(1) },
      { reason: "disk full", count: 1, lastAt: at(9) },
    ]);
    expect(grouped).toEqual([
      { cause: "Graph 404 ErrorItemNotFound", count: 5, lastAt: at(5) },
      { cause: "Graph 429 TooManyRequests", count: 5, lastAt: at(1) },
      { cause: "disk full", count: 1, lastAt: at(9) },
    ]);
  });
});
