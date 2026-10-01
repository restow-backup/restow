import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, pageOf } from "./pagination.js";

const ID_1 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const ID_2 = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
const ID_3 = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

function rows(count: number) {
  const ids = [ID_1, ID_2, ID_3];
  return Array.from({ length: count }, (_, index) => ({
    id: ids[index % ids.length] as string,
    createdAt: new Date(Date.UTC(2026, 0, 1, 10, 0, 10 - index)),
  }));
}

describe("job page cursors", () => {
  it("round-trips a cursor", () => {
    const cursor = { createdAt: "2026-01-01T10:00:00.123Z", id: ID_1 };
    const encoded = encodeCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it("rejects anything this endpoint did not issue", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("not base64 json")).toBeNull();
    expect(decodeCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeCursor(encodeCursor({ createdAt: "2026-01-01T10:00:00Z", id: "not-a-uuid" })),
    ).toBeNull();
    expect(decodeCursor(encodeCursor({ createdAt: "yesterday", id: ID_1 }))).toBeNull();
  });
});

describe("pageOf", () => {
  it("returns `limit` rows and a cursor at the last one when there is more", () => {
    const page = pageOf(rows(3), 2);
    expect(page.items.map((row) => row.id)).toEqual([ID_1, ID_2]);
    expect(decodeCursor(page.next ?? undefined)).toEqual({
      createdAt: "2026-01-01T10:00:09.000Z",
      id: ID_2,
    });
  });

  it("ends the pagination on the last page", () => {
    expect(pageOf(rows(2), 2).next).toBeNull();
    expect(pageOf(rows(1), 2)).toMatchObject({ next: null });
    expect(pageOf([], 2)).toEqual({ items: [], next: null });
  });
});
