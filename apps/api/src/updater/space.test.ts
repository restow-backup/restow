import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDatabaseOps } from "./database-testing.js";
import { dumpFileName } from "./dumps.js";
import { Preflight } from "./preflight.js";
import {
  describeShortfall,
  estimateUpdateSpace,
  IMAGE_FALLBACK_BYTES,
  type SpaceInputs,
  UpdateSpaceProbe,
} from "./space.js";
import { createHarness, type Harness, scheduleRequest, settle } from "./testing.js";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function inputs(over: Partial<SpaceInputs> = {}): SpaceInputs {
  return {
    lastDumpBytes: null,
    tableBytes: null,
    databaseBytes: null,
    imageBytes: null,
    minFreeBytes: 1024 * MIB,
    stateFreeBytes: 100 * GIB,
    databaseFreeBytes: 100 * GIB,
    sameFilesystem: true,
    ...over,
  };
}

describe("estimateUpdateSpace", () => {
  it("adds the last dump plus a quarter, the images, the migrations and the margin on one disk", () => {
    const space = estimateUpdateSpace(
      inputs({
        lastDumpBytes: 1 * GIB,
        databaseBytes: 29 * GIB,
        imageBytes: 800 * MIB,
        stateFreeBytes: 4 * GIB,
      }),
    );
    expect(space).toMatchObject({
      dumpBytes: Math.ceil(1.25 * GIB),
      dumpBasis: "last_dump",
      imageBytes: 800 * MIB,
      migrationBytes: Math.ceil(2.9 * GIB),
      marginBytes: 1024 * MIB,
      databaseRequiredBytes: 0,
    });
    expect(space.stateRequiredBytes).toBe(
      Math.ceil(1.25 * GIB) + 800 * MIB + Math.ceil(2.9 * GIB) + 1024 * MIB,
    );
    // The issue's installation: 38 GB disk, 29 GB database, a few GB free. Refused.
    expect(space.enough).toBe(false);
  });

  it("uses the size of the tables when there is no dump yet", () => {
    const space = estimateUpdateSpace(inputs({ tableBytes: 9 * GIB, databaseBytes: 27 * GIB }));
    expect(space).toMatchObject({ dumpBytes: 9 * GIB, dumpBasis: "tables" });
  });

  it("knows nothing about the dump when the database cannot be asked", () => {
    const space = estimateUpdateSpace(inputs());
    expect(space).toMatchObject({
      dumpBytes: 0,
      dumpBasis: "none",
      imageBytes: IMAGE_FALLBACK_BYTES,
      migrationBytes: GIB,
    });
  });

  it("keeps the migrations' room on the database's own disk when it has one", () => {
    const space = estimateUpdateSpace(
      inputs({
        lastDumpBytes: GIB,
        databaseBytes: 29 * GIB,
        imageBytes: GIB,
        sameFilesystem: false,
        stateFreeBytes: 4 * GIB,
        databaseFreeBytes: 60 * GIB,
      }),
    );
    expect(space.stateRequiredBytes).toBe(Math.ceil(1.25 * GIB) + GIB + 1024 * MIB);
    expect(space.databaseRequiredBytes).toBe(Math.ceil(2.9 * GIB));
    expect(space.enough).toBe(true);
    expect(
      estimateUpdateSpace(
        inputs({ databaseBytes: 29 * GIB, sameFilesystem: false, databaseFreeBytes: GIB }),
      ).enough,
    ).toBe(false);
  });

  it("counts an unknown file system as the same one", () => {
    const space = estimateUpdateSpace(inputs({ sameFilesystem: null, databaseBytes: 20 * GIB }));
    expect(space.databaseRequiredBytes).toBe(0);
    expect(space.stateRequiredBytes).toBe(IMAGE_FALLBACK_BYTES + 2 * GIB + 1024 * MIB);
  });

  it("is never enough when the free space is unknown", () => {
    expect(estimateUpdateSpace(inputs({ stateFreeBytes: null })).enough).toBe(false);
  });

  it("explains a shortfall with every part", () => {
    const space = estimateUpdateSpace(
      inputs({ lastDumpBytes: GIB, imageBytes: GIB, databaseBytes: 10 * GIB, stateFreeBytes: GIB }),
    );
    expect(describeShortfall(space)).toBe(
      "1024 MB free where the dump and the images go, 4352 MB needed (dump 1280 MB (last dump + 25 %), images 1024 MB, migrations 1024 MB, margin 1024 MB).",
    );
  });
});

describe("the preflight with the estimate", () => {
  let h: Harness;
  let database: FakeDatabaseOps;
  let preflight: Preflight;
  let activity: string | null;

  beforeEach(async () => {
    h = await createHarness();
    database = new FakeDatabaseOps(h.ops, h.readEnv);
    activity = null;
    const space = new UpdateSpaceProbe({
      ops: h.ops,
      database,
      dumps: h.dumps,
      envFile: h.envFile,
      clock: h.clock,
      stateDir: h.stateDir,
      minFreeMb: 1024,
      stateDevice: async () => 2049,
    });
    preflight = new Preflight({
      ops: h.ops,
      envFile: h.envFile,
      dumps: h.dumps,
      clock: h.clock,
      redactor: h.redactor,
      projectDir: h.projectDir,
      stateDir: h.stateDir,
      minFreeMb: 1024,
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      space,
      otherActivity: () => activity,
    });
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it("refuses an update whose dump, images and migrations do not fit", async () => {
    await h.dumps.ensureDirectory();
    const dump = dumpFileName(new Date("2026-09-01T10:00:00Z"), "0.0.9", "0.1.0");
    await fs.writeFile(h.dumps.pathOf(dump), Buffer.alloc(2048));
    // 4 GiB free on the one disk; 27 GiB database: 2.7 GiB for migrations alone.
    h.ops.freeBytesValue = 4 * GIB;
    const capabilities = await preflight.check({ deep: true });
    expect(capabilities.blockers.map((blocker) => blocker.code)).toEqual(["disk_space"]);
    expect(capabilities.blockers[0]?.detail).toContain("needed");
    expect(capabilities.updateSpace).toMatchObject({
      dumpBasis: "last_dump",
      dumpBytes: Math.ceil(2048 * 1.25),
      imageBytes: 2 * 600 * MIB,
      sameFilesystem: true,
      enough: false,
    });
  });

  it("passes when there is room, and reports the estimate", async () => {
    h.ops.freeBytesValue = 40 * GIB;
    const capabilities = await preflight.check({ deep: true });
    expect(capabilities.ready).toBe(true);
    expect(capabilities.updateSpace).toMatchObject({ dumpBasis: "tables", enough: true });
  });

  it("falls back to the fixed minimum when the estimate cannot be made", async () => {
    const broken = new Preflight({
      ops: h.ops,
      envFile: h.envFile,
      dumps: h.dumps,
      clock: h.clock,
      redactor: h.redactor,
      projectDir: h.projectDir,
      stateDir: h.stateDir,
      minFreeMb: 1024,
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      space: { estimate: async () => Promise.reject(new Error("down")) },
    });
    h.ops.freeBytesValue = 100 * MIB;
    const capabilities = await broken.check();
    expect(capabilities.blockers).toEqual([
      { code: "disk_space", detail: "100 MB free, 1024 MB required" },
    ]);
    expect(capabilities.updateSpace).toBeNull();
  });

  it("blocks while the database is being moved", async () => {
    h.ops.freeBytesValue = 40 * GIB;
    activity = "The database is being moved, or an old copy of it is being removed.";
    const capabilities = await preflight.check();
    expect(capabilities.blockers).toEqual([{ code: "database_move", detail: activity }]);
  });

  it("caches the slow measurements between checks", async () => {
    h.ops.freeBytesValue = 40 * GIB;
    await preflight.check({ deep: true });
    await preflight.check();
    expect(database.calls.filter((call) => call === "databaseSizes")).toHaveLength(1);
    await preflight.check({ deep: true });
    expect(database.calls.filter((call) => call === "databaseSizes")).toHaveLength(2);
  });
});

describe("an update started while the database moves", () => {
  it("fails in its first step with nothing changed", async () => {
    const h = await createHarness();
    try {
      let activity: string | null = null;
      // The engine's preflight, told about a move that starts after the update was announced.
      (
        h.preflight as unknown as { options: { otherActivity: () => string | null } }
      ).options.otherActivity = () => activity;
      await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
      activity = "The database is being moved.";
      h.clock.advance(60_000);
      await settle(h.engine);
      const view = h.engine.view();
      expect(view.history[0]).toMatchObject({
        outcome: "unchanged",
        failure: { code: "prepare.database_move", step: "prepare" },
      });
    } finally {
      await h.cleanup();
    }
  });
});
