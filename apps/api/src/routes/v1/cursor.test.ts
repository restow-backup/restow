import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ProblemError } from "../../problem.js";
import {
  createdCursorOf,
  createdCursorSchema,
  decodeCursor,
  encodeCursor,
  idCursorSchema,
  slicePage,
} from "./cursor.js";

const ID = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

function statusOf(fn: () => unknown): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProblemError) {
      return error.status;
    }
    throw error;
  }
  return 0;
}

describe("cursors", () => {
  it("round-trips a cursor through its opaque form", () => {
    const cursor = createdCursorOf({ createdAt: new Date("2026-09-01T10:00:00.123Z"), id: ID });
    const raw = encodeCursor(cursor);
    expect(raw).not.toContain(ID);
    expect(decodeCursor(createdCursorSchema, raw)).toEqual({
      at: "2026-09-01T10:00:00.123Z",
      id: ID,
    });
  });

  it("means the first page when no cursor is sent", () => {
    expect(decodeCursor(idCursorSchema, undefined)).toBeNull();
  });

  it("answers anything it did not issue with a 400 problem", () => {
    expect(statusOf(() => decodeCursor(idCursorSchema, "%%%"))).toBe(400);
    expect(statusOf(() => decodeCursor(idCursorSchema, encodeCursor({ id: "42" })))).toBe(400);
    expect(statusOf(() => decodeCursor(createdCursorSchema, encodeCursor({ id: ID })))).toBe(400);
  });
});

describe("slicePage", () => {
  const rows = [1, 2, 3].map((n) => ({ id: `row-${n}` }));

  it("uses the extra row only to prove there is a next page", () => {
    const page = slicePage(rows, 2, (last) => ({ id: last.id }));
    expect(page.rows).toEqual(rows.slice(0, 2));
    expect(decodeCursor(z.object({ id: z.string() }), page.next ?? undefined)).toEqual({
      id: "row-2",
    });
  });

  it("ends the pages when nothing follows", () => {
    expect(slicePage(rows, 3, (last) => ({ id: last.id })).next).toBeNull();
    expect(slicePage([], 3, () => ({})).next).toBeNull();
  });
});
