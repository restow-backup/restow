import type { FirstBackupCandidate, NewlyActiveObject } from "@restow/core";
import { noopLogger } from "@restow/core";
import { describe, expect, it } from "vitest";
import { type FirstBackupStore, enqueueFirstBackupsAfterSync } from "./directory.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

function newlyActive(...externalIds: string[]): NewlyActiveObject[] {
  return externalIds.map((externalId) => ({ externalId, kind: "mailbox" as const }));
}

/** Sends a job through a fake pg-boss; null reports the singleton key as already taken. */
type FakeSend = (protectedObjectId: string) => string | null;

/** A fake {@link FirstBackupStore} over an in-memory candidate table. */
function fakeStore(
  candidates: readonly (FirstBackupCandidate & { externalId: string })[],
  send: FakeSend = (id) => `boss-${id}`,
) {
  const enqueued: { jobId: string; protectedObjectId: string; pgBossJobId: string }[] = [];
  const audited: string[][] = [];
  const loadedFor: string[][] = [];
  const store: FirstBackupStore = {
    async loadCandidates(externalIds) {
      loadedFor.push([...externalIds]);
      const requested = new Set(externalIds);
      return candidates.filter((candidate) => requested.has(candidate.externalId));
    },
    async enqueueBackup(payload) {
      const pgBossJobId = send(payload.protectedObjectId);
      if (pgBossJobId === null) {
        return null;
      }
      enqueued.push({
        jobId: payload.jobId,
        protectedObjectId: payload.protectedObjectId,
        pgBossJobId,
      });
      return pgBossJobId;
    },
    async auditQueued(protectedObjectIds) {
      audited.push([...protectedObjectIds]);
    },
  };
  return { store, enqueued, audited, loadedFor };
}

function candidate(
  protectedObjectId: string,
  externalId: string,
  overrides: Partial<FirstBackupCandidate> = {},
): FirstBackupCandidate & { externalId: string } {
  return {
    protectedObjectId,
    externalId,
    hasSnapshot: false,
    hasQueuedOrActiveBackup: false,
    ...overrides,
  };
}

const NOT_ABORTED = new AbortController().signal;

describe("enqueueFirstBackupsAfterSync", () => {
  it("does nothing when the sync made nothing newly active", async () => {
    const { store, loadedFor } = fakeStore([]);
    const queued = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: [],
      store,
      signal: NOT_ABORTED,
      logger: noopLogger,
    });
    expect(queued).toEqual([]);
    expect(loadedFor).toEqual([]);
  });

  it("enqueues a first backup for each newly-active object and audits once", async () => {
    const { store, enqueued, audited, loadedFor } = fakeStore([
      candidate("object-a", "ext-a"),
      candidate("object-b", "ext-b"),
    ]);
    let n = 0;
    const result = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: newlyActive("ext-a", "ext-b"),
      store,
      signal: NOT_ABORTED,
      logger: noopLogger,
      jobIdGenerator: () => `job-${++n}`,
    });

    expect(loadedFor).toEqual([["ext-a", "ext-b"]]);
    expect(result.sort()).toEqual(["object-a", "object-b"]);
    expect(enqueued).toEqual([
      { jobId: "job-1", protectedObjectId: "object-a", pgBossJobId: "boss-object-a" },
      { jobId: "job-2", protectedObjectId: "object-b", pgBossJobId: "boss-object-b" },
    ]);
    expect(audited).toEqual([["object-a", "object-b"]]);
  });

  it("skips a candidate that already has a snapshot or an in-flight backup, without auditing them", async () => {
    const { store, enqueued, audited } = fakeStore([
      candidate("has-snapshot", "ext-a", { hasSnapshot: true }),
      candidate("already-queued", "ext-b", { hasQueuedOrActiveBackup: true }),
      candidate("needs-one", "ext-c"),
    ]);
    const result = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: newlyActive("ext-a", "ext-b", "ext-c"),
      store,
      signal: NOT_ABORTED,
      logger: noopLogger,
    });
    expect(result).toEqual(["needs-one"]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.protectedObjectId).toBe("needs-one");
    expect(audited).toEqual([["needs-one"]]);
  });

  it("records nothing, and writes no audit entry, when pg-boss reports the backup as already queued", async () => {
    const { store, enqueued, audited } = fakeStore([candidate("object-a", "ext-a")], () => null);
    const result = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: newlyActive("ext-a"),
      store,
      signal: NOT_ABORTED,
      logger: noopLogger,
    });
    expect(result).toEqual([]);
    expect(enqueued).toEqual([]);
    expect(audited).toEqual([]);
  });

  it("drops an external id the store no longer finds active (rescoped again before this ran)", async () => {
    const { store, enqueued } = fakeStore([candidate("object-a", "ext-a")]);
    const result = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: newlyActive("ext-a", "ext-gone"),
      store,
      signal: NOT_ABORTED,
      logger: noopLogger,
    });
    expect(result).toEqual(["object-a"]);
    expect(enqueued).toHaveLength(1);
  });

  it("stops sending once the signal is aborted, but still audits what was already queued", async () => {
    const controller = new AbortController();
    const { store, enqueued, audited } = fakeStore([
      candidate("object-a", "ext-a"),
      candidate("object-b", "ext-b"),
    ]);
    const original = store.enqueueBackup.bind(store);
    store.enqueueBackup = async (payload) => {
      const result = await original(payload);
      // Abort right after the first send, before the loop reaches the second.
      controller.abort();
      return result;
    };
    const result = await enqueueFirstBackupsAfterSync({
      tenantId: TENANT,
      newlyActive: newlyActive("ext-a", "ext-b"),
      store,
      signal: controller.signal,
      logger: noopLogger,
    });
    expect(result).toEqual(["object-a"]);
    expect(enqueued).toHaveLength(1);
    expect(audited).toEqual([["object-a"]]);
  });
});
