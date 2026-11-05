import { describe, expect, it } from "vitest";
import { MemoryCursorStore } from "../engine/memory.js";
import {
  FLUSH_AFTER_MS,
  FLUSH_EVERY,
  RESTORE_PROGRESS_CURSOR_KEY,
  RestoreProgress,
} from "./progress.js";

describe("RestoreProgress", () => {
  it("keeps what an attempt restored for the next attempt of the same job only", async () => {
    const cursor = new MemoryCursorStore();
    await cursor.save({ sharepointListItemsAddedBy: "job-1" });
    const first = await RestoreProgress.open(cursor, "job-1");
    expect(first.isRetry).toBe(false);
    // The fresh record is saved at once, next to what the cursor held.
    expect(cursor.cursor).toMatchObject({
      sharepointListItemsAddedBy: "job-1",
      [RESTORE_PROGRESS_CURSOR_KEY]: { job: "job-1", items: {} },
    });

    await first.created("mail/a.json", "AAMkLongGraphId".repeat(10));
    await first.done("mail/b.eml", true, "Restow.INBOX:42");
    await first.done("mail/c.eml", false, "x".repeat(150));
    await first.done("mail/d.eml", undefined);
    await first.flush();

    const retry = await RestoreProgress.open(cursor, "job-1");
    expect(retry.isRetry).toBe(true);
    expect(retry.get("mail/a.json")).toEqual({
      state: "created",
      targetRef: "AAMkLongGraphId".repeat(10),
    });
    expect(retry.get("mail/b.eml")).toEqual({
      state: "done",
      verified: true,
      targetRef: "Restow.INBOX:42",
    });
    // A long reference is not kept for a finished item: the record stays small.
    expect(retry.get("mail/c.eml")).toEqual({ state: "done", verified: false });
    expect(retry.get("mail/d.eml")).toEqual({ state: "done", verified: undefined });
    expect(retry.get("mail/e.eml")).toBeUndefined();
    expect(cursor.cursor?.sharepointListItemsAddedBy).toBe("job-1");

    // Another job never reads this job's record.
    const other = await RestoreProgress.open(cursor, "job-2");
    expect(other.isRetry).toBe(false);
    expect(other.get("mail/b.eml")).toBeUndefined();
  });

  it("saves finished items in batches, a created item at once", async () => {
    const cursor = new MemoryCursorStore();
    let saves = 0;
    const counting = {
      load: () => cursor.load(),
      save: async (value: Parameters<MemoryCursorStore["save"]>[0]) => {
        saves++;
        await cursor.save(value);
      },
      clear: () => cursor.clear(),
    };
    let clock = 0;
    const progress = await RestoreProgress.open(counting, "job", () => clock);
    expect(saves).toBe(1);
    for (let i = 0; i < FLUSH_EVERY - 1; i++) {
      await progress.done(`mail/${i}.eml`, true);
    }
    expect(saves).toBe(1);
    await progress.done("mail/last.eml", true);
    expect(saves).toBe(2);
    await progress.done("mail/late.eml", true);
    expect(saves).toBe(2);
    clock += FLUSH_AFTER_MS;
    await progress.done("mail/later.eml", true);
    expect(saves).toBe(3);
    await progress.created("mail/big.json", "id");
    expect(saves).toBe(4);
  });
});
