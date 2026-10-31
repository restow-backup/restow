import { describe, expect, it } from "vitest";
import { packPrefix } from "../engine/layout.js";
import { noopLogger } from "../engine/logger.js";
import { causeOfReadinessReason } from "../failures/readiness.js";
import { isTransientTransferError } from "../storage/transfer.js";
import { MemoryPackCatalog } from "./catalog.js";
import { verifyProtectedObject } from "./engine.js";
import {
  checkPack,
  isPersistentlyUnreadable,
  PACK_READ_ATTEMPTS,
  PACK_READ_RETRY_DELAYS_MS,
  selectPacks,
  UNREADABLE_CHECKS_LIMIT,
} from "./integrity.js";
import { seededRandom } from "./random.js";
import { assessReadiness } from "./readiness.js";
import { runScrub, type ScrubOptions, scrubFindingDetails } from "./scrub.js";
import { createStoreFixture, mailboxItems, type StoreFixture, writeSnapshot } from "./testing.js";

const HOUR = 3_600_000;
const NO_PAUSE = { delaysMs: [0, 0] };

async function fixtureWithPacks() {
  const fixture = createStoreFixture();
  await writeSnapshot(fixture, mailboxItems(24, 0), 4 * 1024);
  const catalog = new MemoryPackCatalog(fixture.index);
  const keys = await fixture.primary.list(packPrefix(fixture.ctx.tenantId));
  return { fixture, catalog, keys };
}

function scrub(
  fixture: StoreFixture,
  catalog: MemoryPackCatalog,
  options: Partial<ScrubOptions> = {},
) {
  return runScrub(
    {
      tenantId: fixture.ctx.tenantId,
      storage: fixture.storage,
      keys: fixture.ctx.keys,
      catalog,
      logger: noopLogger,
      signal: new AbortController().signal,
      now: () => fixture.clock.now,
    },
    fixture.ctx.progress,
    { mode: "full", gc: null, retry: NO_PAUSE, ...options },
  );
}

describe("transfer errors", () => {
  it("tells a broken transfer from an answer about the object", () => {
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    expect(isTransientTransferError(aborted)).toBe(true);
    expect(isTransientTransferError(new Error("aborted"))).toBe(true);
    expect(isTransientTransferError(new Error("socket hang up"))).toBe(true);
    expect(isTransientTransferError(Object.assign(new Error("x"), { code: "EPIPE" }))).toBe(true);
    expect(isTransientTransferError(Object.assign(new Error("x"), { name: "SlowDown" }))).toBe(
      true,
    );
    expect(
      isTransientTransferError(Object.assign(new Error("x"), { name: "RequestTimeout" })),
    ).toBe(true);
    expect(
      isTransientTransferError(
        Object.assign(new Error("x"), { $metadata: { httpStatusCode: 503 } }),
      ),
    ).toBe(true);
    expect(
      isTransientTransferError(new Error("wrapped", { cause: new Error("socket hang up") })),
    ).toBe(true);
    // Answers about the object, and cancellation, are not worth a second read.
    expect(
      isTransientTransferError(
        Object.assign(new Error("Access Denied"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: 403 },
        }),
      ),
    ).toBe(false);
    expect(
      isTransientTransferError(
        Object.assign(new Error("x"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }),
      ),
    ).toBe(false);
    expect(
      isTransientTransferError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ).toBe(false);
  });
});

describe("pack reads after transfer errors", () => {
  it("defaults to three reads, two and eight seconds apart", () => {
    expect(PACK_READ_ATTEMPTS).toBe(3);
    expect(PACK_READ_RETRY_DELAYS_MS).toEqual([2_000, 8_000]);
  });

  it("reads the whole pack again after a download breaks off, and finds it intact", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    if (!pack) throw new Error("no pack");
    fixture.primary.abortReads(key, 2);

    const check = await checkPack(
      fixture.storage,
      fixture.ctx.tenantId,
      pack,
      await catalog.chunksOf(pack.id),
      { retry: NO_PAUSE },
    );
    expect(check.status).toBe("ok");
    expect(check.targets[0]).toMatchObject({ status: "ok", attempts: 3 });
    expect(fixture.primary.streamReads.get(key)).toBe(3);
  });

  it("reports unreadable (not damaged) when every read breaks off", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    if (!pack) throw new Error("no pack");
    fixture.primary.abortReads(key, 3);

    const check = await checkPack(
      fixture.storage,
      fixture.ctx.tenantId,
      pack,
      await catalog.chunksOf(pack.id),
      { retry: NO_PAUSE },
    );
    expect(check.status).toBe("corrupt");
    expect(check.targets[0]).toMatchObject({
      status: "unreadable",
      detail: "aborted (3 attempts)",
      attempts: 3,
    });
  });

  it("does not read again after an error that is an answer (denied access)", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    if (!pack) throw new Error("no pack");
    fixture.primary.failReads(key, () =>
      Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const check = await checkPack(
      fixture.storage,
      fixture.ctx.tenantId,
      pack,
      await catalog.chunksOf(pack.id),
      { retry: NO_PAUSE },
    );
    expect(check.targets[0]).toMatchObject({ status: "unreadable", detail: "Access Denied" });
    expect(check.targets[0]?.attempts).toBeUndefined();
  });

  it("names the size found when the storage sends more than the pack holds", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    if (!pack) throw new Error("no pack");
    const bytes = await fixture.primary.get(key);
    await fixture.primary.put(key, Buffer.concat([bytes, Buffer.alloc(100)]));
    const check = await checkPack(
      fixture.storage,
      fixture.ctx.tenantId,
      pack,
      await catalog.chunksOf(pack.id),
      { retry: NO_PAUSE },
    );
    expect(check.targets[0]).toMatchObject({
      status: "size_mismatch",
      detail: `expected ${pack.size} bytes, found ${pack.size + 100}`,
    });
  });
});

describe("temporarily unreadable packs in the storage check", () => {
  it("lists an unreadable pack apart from damage and never marks it damaged", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    fixture.primary.abortReads(key, 3);

    const report = await scrub(fixture, catalog);
    expect(report.corrupt).toEqual([]);
    expect(report.unreadable.map((pack) => pack.path)).toEqual([key]);
    expect(report.unreadable[0]?.unreadable).toEqual({
      since: fixture.clock.now.toISOString(),
      lastAt: fixture.clock.now.toISOString(),
      checks: 1,
      persistent: false,
    });
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    expect(pack?.damagedAt).toBeNull();
    expect(pack?.unreadable).toMatchObject({ checks: 1, detail: "aborted (3 attempts)" });
    expect(fixture.ctx.progressSink.failures.map((failure) => failure.cause?.code)).toEqual([
      "verify.storage_unreadable",
    ]);
  });

  it("re-reads unreadable packs first, and a recheck reads only those", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[keys.length - 1] as string;
    fixture.primary.abortReads(key, 3);
    await scrub(fixture, catalog);

    const packs = await catalog.listPacks();
    expect(selectPacks(packs, "sample", seededRandom(1))[0]?.path).toBe(key);
    expect(selectPacks(packs, "full", seededRandom(1))[0]?.path).toBe(key);
    expect(selectPacks(packs, "recheck", seededRandom(1)).map((pack) => pack.path)).toEqual([key]);

    fixture.clock.now = new Date(fixture.clock.now.getTime() + HOUR);
    const recheck = await scrub(fixture, catalog, { mode: "recheck" });
    expect(recheck.packsChecked).toBe(1);
    expect(recheck.unreadable).toEqual([]);
    expect(recheck.gc).toEqual({ status: "skipped", reason: "sample_run" });
    // Read intact again: the run of failures is over.
    expect((await catalog.listPacks()).every((pack) => !pack.unreadable)).toBe(true);
  });

  it("counts like damage only after three consecutive failed checks over at least a day", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    const runs = [];
    for (const hoursLater of [0, 1, 2, 23]) {
      fixture.clock.now = new Date(fixture.clock.now.getTime() + hoursLater * HOUR);
      fixture.primary.abortReads(key, 3);
      const report = await scrub(fixture, catalog);
      runs.push(report.unreadable[0]?.unreadable);
    }
    expect(runs.map((run) => run?.checks)).toEqual([1, 2, 3, 4]);
    // Three checks within three hours are not enough; the fourth, 26 hours after the first, is.
    expect(runs.map((run) => run?.persistent)).toEqual([false, false, false, true]);
    expect(UNREADABLE_CHECKS_LIMIT).toBe(3);
  });

  it("ends the run of failures when the pack turns out damaged", async () => {
    const { fixture, catalog, keys } = await fixtureWithPacks();
    const key = keys[0] as string;
    fixture.primary.abortReads(key, 3);
    await scrub(fixture, catalog);
    fixture.primary.flipByte(key, 200);
    const report = await scrub(fixture, catalog);
    expect(report.corrupt.map((pack) => pack.path)).toEqual([key]);
    expect(report.unreadable).toEqual([]);
    const pack = (await catalog.listPacks()).find((entry) => entry.path === key);
    expect(pack?.unreadable).toBeNull();
    expect(pack?.damagedAt).not.toBeNull();
  });

  it("isPersistentlyUnreadable needs both the count and the span", () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const at = (hours: number) => new Date(since.getTime() + hours * HOUR);
    expect(isPersistentlyUnreadable(null)).toBe(false);
    expect(isPersistentlyUnreadable({ since, lastAt: at(48), checks: 2 })).toBe(false);
    expect(isPersistentlyUnreadable({ since, lastAt: at(23), checks: 5 })).toBe(false);
    expect(isPersistentlyUnreadable({ since, lastAt: at(24), checks: 3 })).toBe(true);
  });
});

describe("rating unreadable packs", () => {
  const base = {
    snapshotCompletedAt: new Date("2026-10-01T00:00:00Z"),
    hasSnapshot: true,
    manifestReadable: true,
    checked: 20,
    contentBytes: 20_000,
    contentObjects: 20,
    outcomes: { verified: 20, mismatch: 0, missing: 0, unreadable: 0 },
    damagedPacks: 0,
    testRestore: null,
    now: new Date("2026-10-01T01:00:00Z"),
  };

  it("asks for attention while a pack is only temporarily unreadable", () => {
    expect(assessReadiness({ ...base, unreadablePacks: 2 })).toEqual({
      readiness: "yellow",
      reasons: [{ code: "storage_unreadable", severity: "yellow", count: 2 }],
    });
  });

  it("rates not restorable once a pack stayed unreadable", () => {
    expect(assessReadiness({ ...base, persistentlyUnreadablePacks: 1 })).toEqual({
      readiness: "red",
      reasons: [{ code: "storage_unreadable_persistent", severity: "red", count: 1 }],
    });
  });

  it("maps both reasons onto failure causes", () => {
    expect(causeOfReadinessReason({ code: "storage_unreadable", count: 1 })?.code).toBe(
      "verify.storage_unreadable",
    );
    expect(causeOfReadinessReason({ code: "storage_unreadable_persistent", count: 1 })?.code).toBe(
      "verify.storage_unreadable_persistent",
    );
  });

  it("files a yellow finding for unreadable packs and a red one for damage", () => {
    const check = {
      packId: "p1",
      path: "tenants/t/packs/ab/p1",
      size: 10,
      status: "corrupt" as const,
      targets: [{ target: 0, status: "unreadable" as const, detail: "aborted", repaired: false }],
    };
    const run = { since: "2026-10-01T00:00:00.000Z", lastAt: "2026-10-01T00:00:00.000Z" };
    const yellow = scrubFindingDetails(
      "job",
      [],
      [{ ...check, unreadable: { ...run, checks: 1, persistent: false } }],
    );
    expect(yellow.reasons).toEqual([{ code: "storage_unreadable", severity: "yellow", count: 1 }]);
    expect(yellow.packs[0]?.unreadable?.checks).toBe(1);
    const red = scrubFindingDetails(
      "job",
      [],
      [{ ...check, unreadable: { ...run, checks: 3, persistent: true } }],
    );
    expect(red.reasons).toEqual([
      { code: "storage_unreadable_persistent", severity: "red", count: 1 },
    ]);
  });

  it("a restore check rates a snapshot in an unreadable pack yellow, not red", async () => {
    const { fixture, keys } = await fixtureWithPacks();
    const outcome = await verifyProtectedObject(fixture.ctx, fixture.protectedObject, {
      kind: "verify",
      sampleSize: 5,
      unreadablePacks: new Set(keys),
    });
    expect(outcome.readiness).toBe("yellow");
    expect(outcome.details.reasons.map((reason) => reason.code)).toContain("storage_unreadable");
    expect(outcome.details.damagedPacks).toEqual([]);
    expect(outcome.details.unreadablePacks?.length).toBeGreaterThan(0);

    const persistent = await verifyProtectedObject(fixture.ctx, fixture.protectedObject, {
      kind: "verify",
      sampleSize: 5,
      persistentlyUnreadablePacks: new Set(keys),
    });
    expect(persistent.readiness).toBe("red");
    expect(persistent.details.reasons[0]?.code).toBe("storage_unreadable_persistent");
  });
});
