import { describe, expect, it } from "vitest";
import type { SnapshotCheckpoint } from "../../engine/types.js";
import {
  ENGINE_NAME,
  type OneDriveCursor,
  type OneDriveManifestState,
  checkpointState,
  planRun,
  readCheckpointDeletions,
  readCursor,
  readManifestState,
} from "./state.js";

const DRIVE = "b!drive1";
const checkpoint: SnapshotCheckpoint = {
  snapshotId: "snap-1",
  sequence: 1,
  partialKey: "tenants/t/manifests/snap-1.partial",
  objectCount: 3,
};

const previous: OneDriveManifestState = {
  engine: ENGINE_NAME,
  driveId: DRIVE,
  rootId: "01ROOT",
  deltaLink: "https://graph/delta?token=DELTA1",
  mode: "initial",
  retry: ["01BROKEN"],
  fullResyncRequired: false,
  versions: false,
  completedAt: 1,
};

const cursor: OneDriveCursor = {
  engine: ENGINE_NAME,
  driveId: DRIVE,
  rootId: "01ROOT",
  mode: "incremental",
  pageUrl: "https://graph/delta?token=NEXT2",
  lastItemId: "01NOTES",
  retriesDone: false,
  retry: ["01FAILED"],
  retryOverflow: false,
  snapshot: checkpoint,
};

describe("readManifestState", () => {
  it("accepts state written by this engine for the same drive", () => {
    expect(readManifestState({ ...previous }, DRIVE)).toEqual(previous);
  });

  it("rejects foreign, other-drive or incomplete state", () => {
    expect(readManifestState(undefined, DRIVE)).toBeNull();
    expect(
      readManifestState({ engine: "mailbox", driveId: DRIVE, deltaLink: "x" }, DRIVE),
    ).toBeNull();
    expect(readManifestState({ ...previous, driveId: "b!other" }, DRIVE)).toBeNull();
    expect(readManifestState({ ...previous, deltaLink: "" }, DRIVE)).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const minimal = readManifestState(
      { engine: ENGINE_NAME, driveId: DRIVE, deltaLink: "d" },
      DRIVE,
    );
    expect(minimal).toEqual({
      engine: ENGINE_NAME,
      driveId: DRIVE,
      rootId: null,
      deltaLink: "d",
      mode: "initial",
      retry: [],
      fullResyncRequired: false,
      versions: false,
      completedAt: 0,
    });
  });
});

describe("readCursor", () => {
  it("round-trips a cursor of this engine and drive", () => {
    expect(readCursor(cursor, DRIVE)).toEqual(cursor);
  });

  it("ignores cursors of other engines, other drives or without a checkpoint", () => {
    expect(readCursor(null, DRIVE)).toBeNull();
    expect(readCursor({ ...cursor, engine: "mailbox" }, DRIVE)).toBeNull();
    expect(readCursor(cursor, "b!other")).toBeNull();
    expect(readCursor({ ...cursor, snapshot: undefined }, DRIVE)).toBeNull();
    expect(readCursor({ ...cursor, pageUrl: undefined }, DRIVE)).toBeNull();
    expect(readCursor({ ...cursor, mode: "weird" }, DRIVE)).toBeNull();
  });
});

describe("checkpoint state", () => {
  it("carries the pending deletions of this drive only", () => {
    const state = checkpointState(DRIVE, ["01DOCS"]) as unknown as Record<string, unknown>;
    expect(readCheckpointDeletions(state, DRIVE)).toEqual(["01DOCS"]);
    expect(readCheckpointDeletions(state, "b!other")).toEqual([]);
    expect(readCheckpointDeletions({ ...previous }, DRIVE)).toEqual([]);
    expect(readCheckpointDeletions(undefined, DRIVE)).toEqual([]);
  });
});

describe("planRun", () => {
  const base = { full: false, includeVersions: false, resume: null } as const;

  it("enumerates everything on the first run", () => {
    const plan = planRun({ ...base, previous: null });
    expect(plan).toMatchObject({
      reason: "first-run",
      start: { url: null, mode: "initial" },
      inheritPrevious: false,
      retryIds: [],
      walkDone: false,
      backfillVersions: false,
    });
  });

  it("continues from the previous delta link and replays its retry list", () => {
    const plan = planRun({ ...base, previous });
    expect(plan).toMatchObject({
      reason: "incremental",
      start: { url: previous.deltaLink, mode: "incremental" },
      inheritPrevious: true,
      retryIds: ["01BROKEN"],
      rootId: "01ROOT",
    });
  });

  it("enumerates the whole drive when asked, after a retry overflow, or when versions were switched on", () => {
    const cases = [
      { input: { ...base, full: true, previous }, reason: "full-requested" },
      {
        input: { ...base, previous: { ...previous, fullResyncRequired: true } },
        reason: "retry-overflow",
      },
      { input: { ...base, includeVersions: true, previous }, reason: "versions-enabled" },
    ] as const;
    for (const { input, reason } of cases) {
      const plan = planRun(input);
      expect(plan.reason).toBe(reason);
      expect(plan.start).toEqual({ url: null, mode: "initial" });
      expect(plan.inheritPrevious).toBe(false);
      expect(plan.retryIds).toEqual([]);
      expect(plan.rootId).toBe("01ROOT");
    }
    expect(planRun({ ...base, includeVersions: true, previous }).backfillVersions).toBe(true);
    expect(
      planRun({ ...base, includeVersions: true, previous: { ...previous, versions: true } }),
    ).toMatchObject({ reason: "incremental", backfillVersions: false });
  });

  it("resumes at the checkpointed page and item", () => {
    const plan = planRun({ ...base, resume: cursor, previous });
    expect(plan).toMatchObject({
      reason: "resume",
      start: { url: cursor.pageUrl, mode: "incremental" },
      skipThroughItemId: "01NOTES",
      inheritPrevious: false,
      retryIds: ["01BROKEN", "01FAILED"],
      walkDone: false,
      deltaLink: null,
      retryOverflow: false,
    });
    const afterRetries = planRun({
      ...base,
      resume: { ...cursor, retriesDone: true, retryOverflow: true },
      previous,
    });
    expect(afterRetries.retryIds).toEqual(["01FAILED"]);
    expect(afterRetries.retryOverflow).toBe(true);
  });

  it("skips the walk when the checkpoint already carries the final delta link", () => {
    const plan = planRun({
      ...base,
      full: true,
      resume: {
        ...cursor,
        retriesDone: true,
        retry: [],
        deltaLink: "https://graph/delta?token=DONE",
      },
      previous,
    });
    expect(plan.walkDone).toBe(true);
    expect(plan.deltaLink).toBe("https://graph/delta?token=DONE");
    expect(plan.skipThroughItemId).toBeUndefined();
  });
});
