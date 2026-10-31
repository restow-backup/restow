import { beforeEach, describe, expect, it, vi } from "vitest";

/** "Confirm as empty" sends a large selection in requests of at most 200 ids (0.4.9). */

interface Sent {
  method: string;
  body: { objectIds: string[]; note?: string | null };
}

const apiFetch = vi.fn<(path: string, init: Sent) => Promise<unknown>>();
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  apiFetch: (path: string, init: Sent) => apiFetch(path, init),
}));

const { confirmEmptyObjects, EMPTY_CONFIRM_BATCH } = await import("./api");

beforeEach(() => {
  apiFetch.mockReset();
  // The server confirms every id but the ones ending in 7 (not empty).
  apiFetch.mockImplementation(async (_path, init) => ({
    confirmed: init.body.objectIds
      .filter((id) => !id.endsWith("7"))
      .map((id) => ({ protectedObjectId: id, displayName: id })),
    skipped: init.body.objectIds
      .filter((id) => id.endsWith("7"))
      .map((id) => ({ protectedObjectId: id, displayName: id, reason: "not_empty" })),
  }));
});

describe("confirmEmptyObjects", () => {
  it("confirms 450 objects in three requests of at most 200 and merges the answers", async () => {
    const ids = Array.from({ length: 450 }, (_, index) => `object-${index}`);
    const result = await confirmEmptyObjects(ids, "Leer");
    expect(EMPTY_CONFIRM_BATCH).toBe(200);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    const sent = apiFetch.mock.calls.map(([path, init]) => {
      expect(path).toBe("/verify/empty-confirmations");
      expect(init.method).toBe("POST");
      expect(init.body.note).toBe("Leer");
      return init.body.objectIds;
    });
    expect(sent.map((part) => part.length)).toEqual([200, 200, 50]);
    expect(sent.flat()).toEqual(ids);
    expect(result.confirmed).toHaveLength(405);
    expect(result.skipped).toHaveLength(45);
    expect(result.skipped.every((row) => row.reason === "not_empty")).toBe(true);
  });

  it("sends a small selection in one request, each id once, without a note", async () => {
    const result = await confirmEmptyObjects(["a", "b", "a"]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0]?.[1]).toEqual({
      method: "POST",
      body: { objectIds: ["a", "b"] },
    });
    expect(result.confirmed.map((row) => row.protectedObjectId)).toEqual(["a", "b"]);
  });

  it("stops at the first request that fails", async () => {
    apiFetch
      .mockImplementationOnce(async () => ({ confirmed: [], skipped: [] }))
      .mockImplementationOnce(async () => {
        throw new Error("boom");
      });
    const ids = Array.from({ length: 601 }, (_, index) => `object-${index}`);
    await expect(confirmEmptyObjects(ids)).rejects.toThrow("boom");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
