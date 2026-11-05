import { describe, expect, it } from "vitest";
import { MemoryCursorStore } from "../engine/memory.js";
import { FLUSH_AFTER_MS, FLUSH_EVERY, RestoreProgress } from "./progress.js";

describe("RestoreProgress", () => {
  it("keeps what an attempt restored for the next attempt of the same job", async () => {
    const cursor = new MemoryCursorStore();
    await cursor.save({ sharepointListItemsAddedBy: "job-1" });
    const first = await RestoreProgress.open(cursor, { restoreJobId: "job-1", retry: false });
    expect(first.isRetry).toBe(false);
    // Opening writes nothing: an attempt that restores nothing leaves no checkpoint.
    expect(cursor.entryPuts).toEqual([]);
    expect(cursor.saves).toBe(1);

    await first.created("mail/a.json", "AAMkLongGraphId".repeat(10));
    await first.done("mail/b.eml", true, "Restow.INBOX:42");
    await first.done("mail/c.eml", false, "x".repeat(150));
    await first.done("mail/d.eml", undefined);
    await first.flush();

    const retry = await RestoreProgress.open(cursor, { restoreJobId: "job-1", retry: true });
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
    // The cursor itself is never touched.
    expect(cursor.cursor).toEqual({ sharepointListItemsAddedBy: "job-1" });
    expect(cursor.saves).toBe(1);

    // Another job never reads this job's record.
    const other = await RestoreProgress.open(cursor, { restoreJobId: "job-2", retry: false });
    expect(other.isRetry).toBe(false);
    expect(other.get("mail/b.eml")).toBeUndefined();

    // A job's entries end with it.
    await cursor.clear();
    const next = await RestoreProgress.open(cursor, { restoreJobId: "job-1", retry: false });
    expect(next.isRetry).toBe(false);
    expect(next.get("mail/b.eml")).toBeUndefined();
  });

  it("is a retry when the job ran before, also when the earlier attempt saved nothing", async () => {
    const progress = await RestoreProgress.open(new MemoryCursorStore(), {
      restoreJobId: "job-1",
      retry: true,
    });
    expect(progress.isRetry).toBe(true);
  });

  it("saves finished items in batches, a created item at once, and nothing when nothing changed", async () => {
    const cursor = new MemoryCursorStore();
    let clock = 0;
    const progress = await RestoreProgress.open(cursor, {
      restoreJobId: "job-1",
      retry: false,
      now: () => clock,
    });
    await progress.flush();
    expect(cursor.entryPuts).toEqual([]);
    for (let i = 0; i < FLUSH_EVERY - 1; i++) {
      await progress.done(`mail/${i}.eml`, true);
    }
    expect(cursor.entryPuts).toEqual([]);
    await progress.done("mail/last.eml", true);
    expect(cursor.entryPuts).toEqual([FLUSH_EVERY]);
    await progress.done("mail/late.eml", true);
    expect(cursor.entryPuts).toEqual([FLUSH_EVERY]);
    clock += FLUSH_AFTER_MS;
    await progress.done("mail/later.eml", true);
    expect(cursor.entryPuts).toEqual([FLUSH_EVERY, 2]);
    await progress.created("mail/big.json", "id");
    expect(cursor.entryPuts).toEqual([FLUSH_EVERY, 2, 1]);
    // The same entry again is no change.
    await progress.done("mail/late.eml", true);
    await progress.flush();
    expect(cursor.entryPuts).toEqual([FLUSH_EVERY, 2, 1]);
  });

  it("writes per flush only what changed, however many items are finished already", async () => {
    const cursor = new MemoryCursorStore();
    const written: number[] = [];
    const counting = Object.assign(Object.create(cursor) as MemoryCursorStore, {
      putEntries: async (entries: Readonly<Record<string, string>>) => {
        written.push(JSON.stringify(entries).length);
        await cursor.putEntries(entries);
      },
    });
    const progress = await RestoreProgress.open(counting, { restoreJobId: "job-1", retry: false });
    for (let i = 0; i < 20 * FLUSH_EVERY; i++) {
      await progress.done(`mail/${String(i).padStart(6, "0")}.eml`, true, `INBOX:${i % 10}`);
    }
    // Like a rewritten Office file or a multi-part message: one entry, saved at once.
    for (let i = 0; i < 50; i++) {
      await progress.created(`mail/part-${i}.json`, `AAMk${String(i).padStart(4, "0")}`);
    }
    expect(Object.keys(cursor.entries)).toHaveLength(20 * FLUSH_EVERY + 50);
    const batches = written.slice(0, 20);
    const singles = written.slice(20);
    expect(Math.max(...batches)).toBeLessThan(FLUSH_EVERY * 40);
    expect(Math.max(...batches) - Math.min(...batches)).toBeLessThan(FLUSH_EVERY);
    expect(Math.max(...singles)).toBeLessThan(60);
  });
});
