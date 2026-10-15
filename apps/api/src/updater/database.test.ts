import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MoveRefusedError } from "./database.js";
import type { MoveRecord } from "./database-protocol.js";
import {
  createMoverWorld,
  MOVE_ACTOR,
  type MoverWorld,
  OLD_VOLUME,
  TARGET_DIR,
} from "./database-testing.js";
import { OpsError } from "./ops.js";
import { createHarness, DEFAULT_ENV, type Harness } from "./testing.js";

const GIB = 1024 ** 3;
const DATA_DIR = `${TARGET_DIR}/restow-postgres-20260930-100000`;

let h: Harness;
let w: MoverWorld;

beforeEach(async () => {
  h = await createHarness();
  w = createMoverWorld(h);
});

afterEach(async () => {
  await w.mover.settled();
  await h.cleanup();
});

async function move(targetDir = TARGET_DIR): Promise<MoveRecord> {
  await w.mover.start({ targetDir, requestedBy: MOVE_ACTOR });
  await w.mover.settled();
  const record = w.store.state.database?.move;
  if (!record) {
    throw new Error("No move was recorded.");
  }
  return record;
}

function running(service: string): boolean {
  return h.ops.containers.get(service)?.state === "running";
}

/** Everything is as it was before the move: .env, the data, what runs. */
async function expectUnchanged(): Promise<void> {
  expect(await h.readEnv()).toBe(DEFAULT_ENV);
  expect(w.database.directory(OLD_VOLUME)).toEqual({
    pgVersion: true,
    marker: false,
    emptied: false,
  });
  expect(w.database.runningLocation).toEqual(OLD_VOLUME);
  for (const service of ["postgres", "api", "worker", "scheduler", "caddy"]) {
    expect(running(service), service).toBe(true);
  }
  expect(h.ops.migrations).toBe(12);
}

describe("a move", () => {
  it("copies, verifies, checks and switches, keeping the old copy marked", async () => {
    const record = await move();

    expect(record.status).toBe("succeeded");
    expect(record.dataDir).toBe(DATA_DIR);
    expect(record.from).toEqual(OLD_VOLUME);
    expect(record.steps.every((step) => step.status === "done")).toBe(true);
    expect(record.progress).toBe(100);
    expect(record.verified).toEqual({ entries: 1840, bytes: 29 * GIB });
    expect(record.failure).toBeNull();

    // .env names the copy; everything else in it is untouched.
    const env = await h.readEnv();
    expect(env).toBe(
      `${DEFAULT_ENV}RESTOW_POSTGRES_DATA_TYPE=bind\nRESTOW_POSTGRES_DATA=${DATA_DIR}\n`,
    );
    // PostgreSQL runs from the copy; the old one cannot start any more and is kept.
    expect(w.database.runningLocation).toEqual({ kind: "bind", source: DATA_DIR });
    expect(w.database.directory(OLD_VOLUME)).toEqual({
      pgVersion: false,
      marker: true,
      emptied: false,
    });
    expect(w.store.state.database?.oldCopies).toEqual([
      expect.objectContaining({ location: OLD_VOLUME, moveId: record.id }),
    ]);
    expect(w.store.state.database?.context).toBeNull();
    for (const service of ["postgres", "api", "worker", "scheduler", "caddy"]) {
      expect(running(service), service).toBe(true);
    }

    // The order: stop, check the shutdown, copy, verify, trial, switch, start.
    const sequence = w.database.calls.filter((call) =>
      /^(clusterState|copy|compare|trial|quarantine)/.test(call),
    );
    expect(sequence).toEqual([
      "clusterState volume:restow_pgdata",
      `copy volume:restow_pgdata -> ${DATA_DIR}`,
      `compare volume:restow_pgdata ${DATA_DIR}`,
      `trial ${DATA_DIR} 70:70`,
      `clusterState bind:${DATA_DIR}`,
      "quarantine volume:restow_pgdata",
    ]);
    expect(h.ops.callsTo("composeStop")).toEqual([
      "composeStop api,worker,scheduler -t 90",
      "composeStop postgres -t 120",
    ]);
    expect(h.ops.callsTo("composeUp")).toEqual([
      "composeUp postgres",
      "composeUp api",
      "composeUp worker,scheduler",
    ]);

    const actions = w.store.state.events.map((event) => event.action);
    expect(actions).toEqual(["database.move.started", "database.move.succeeded"]);
    expect(w.store.state.events[1]).toMatchObject({
      runId: record.id,
      actor: MOVE_ACTOR,
      target: DATA_DIR,
    });
  });

  it("is reported to the public status without paths", async () => {
    await move();
    const status = w.mover.publicMove();
    expect(status).toMatchObject({ status: "succeeded", progress: 100, step: null });
    expect(JSON.stringify(status)).not.toContain("/mnt");
  });

  it("refuses to start while something else runs, and changes nothing", async () => {
    w.activity.reason = "An update is running; move the database after it.";
    await expect(
      w.mover.start({ targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR }),
    ).rejects.toMatchObject({
      code: "busy",
    });
    expect(w.store.state.database?.move ?? null).toBeNull();
    await expectUnchanged();
  });

  it("refuses a second move while one runs", async () => {
    let release: () => void = () => undefined;
    w.database.onCopy = () => new Promise<void>((resolve) => (release = resolve));
    await w.mover.start({ targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR });
    await waitFor(() => w.database.calls.some((call) => call.startsWith("copy ")));
    expect(w.mover.active()).toBe(true);
    await expect(
      w.mover.start({ targetDir: "/mnt/other", requestedBy: MOVE_ACTOR }),
    ).rejects.toBeInstanceOf(MoveRefusedError);
    release();
    await w.mover.settled();
    expect(w.store.state.database?.move?.status).toBe("succeeded");
  });
});

describe("the checks before anything changes", () => {
  async function problems(targetDir = TARGET_DIR): Promise<string[]> {
    const check = await w.mover.check(targetDir);
    return check.problems.map((problem) => problem.code);
  }

  it("pass for a writable local directory with room on another disk", async () => {
    const check = await w.mover.check(`${TARGET_DIR}/`);
    expect(check).toMatchObject({
      ok: true,
      problems: [],
      targetDir: TARGET_DIR,
      filesystem: "ext2/ext3",
      dataBytes: 29 * GIB,
      requiredBytes: 29 * GIB + Math.ceil(2.9 * GIB),
    });
  });

  it.each([
    ["relative/path"],
    ["/mnt/volume 1"],
    ["/mnt/$(id)"],
    ["/mnt/a:b"],
    ["/mnt/a,b"],
    ["/mnt/../etc"],
    ["/etc/restow"],
    ["/var/lib/docker/volumes/x"],
    ["/tmp/db"],
    ["/"],
  ])("refuse the path %s", async (path) => {
    expect(await problems(path)).toEqual(["path_invalid"]);
  });

  it("refuse a directory that does not exist", async () => {
    expect(await problems("/mnt/nowhere")).toEqual(["path_missing"]);
  });

  it("refuse a directory on the same file system", async () => {
    (w.database.targets.get(TARGET_DIR) as { sameFilesystem: boolean }).sameFilesystem = true;
    expect(await problems()).toEqual(["same_filesystem"]);
  });

  it.each([
    ["6969", "nfs"],
    ["ff534d42", "cifs"],
    ["fe534d42", "smb2"],
    ["65735546", "fuseblk"],
    ["1021994", "tmpfs"],
    ["794c7630", "overlayfs"],
  ])("refuse the file system %s (%s)", async (magic, name) => {
    Object.assign(w.database.targets.get(TARGET_DIR) as object, { magic, name });
    const check = await w.mover.check(TARGET_DIR);
    expect(check.problems.map((problem) => problem.code)).toEqual(["filesystem_unsuitable"]);
    expect(check.problems[0]?.detail).toContain(name);
  });

  it.each([
    ["58465342", "xfs"],
    ["9123683e", "btrfs"],
    ["2fc12fc1", "zfs"],
  ])("accept the file system %s (%s)", async (magic, name) => {
    Object.assign(w.database.targets.get(TARGET_DIR) as object, { magic, name });
    expect(await problems()).toEqual([]);
  });

  it("refuse a directory without room for the data and the margin", async () => {
    (w.database.targets.get(TARGET_DIR) as { freeBytes: number }).freeBytes = 31 * GIB;
    const check = await w.mover.check(TARGET_DIR);
    expect(check.problems.map((problem) => problem.code)).toEqual(["insufficient_space"]);
    expect(check.problems[0]?.detail).toContain("31.0 GiB free");
  });

  it("refuse a directory that cannot be written", async () => {
    (w.database.targets.get(TARGET_DIR) as { writable: boolean }).writable = false;
    expect(await problems()).toEqual(["not_writable"]);
  });

  it("refuse a database with tablespaces", async () => {
    w.database.tablespaces = 1;
    expect(await problems()).toEqual(["tablespaces"]);
  });

  it("refuse a compose file that does not read the location from .env", async () => {
    w.database.composeReadsEnv = false;
    expect(await problems()).toContain("compose_unsupported");
  });

  it("refuse when the database does not run", async () => {
    await h.ops.composeStop(["postgres"], 10);
    expect(await problems()).toEqual(["location_unknown"]);
  });

  it("are run again by the move itself, which then changes nothing", async () => {
    (w.database.targets.get(TARGET_DIR) as { freeBytes: number }).freeBytes = GIB;
    const refused = await w.mover
      .start({ targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MoveRefusedError);
    expect((refused as MoveRefusedError).problems.map((problem) => problem.code)).toEqual([
      "insufficient_space",
    ]);
    expect(h.ops.callsTo("composeStop")).toEqual([]);
    await expectUnchanged();
  });
});

describe("a failure goes back to the old location, unchanged", () => {
  const boom = (message: string) => new OpsError(message, "simulated");

  const cases: {
    step: string;
    code: string;
    arrange: () => void;
    /** The database ran from the copy before the failure: it is kept. */
    keptCopy: boolean;
  }[] = [
    {
      step: "stop_application",
      code: "stop_application.failed",
      arrange: () => h.ops.failOn("composeStop", boom("Stopping services failed."), 0),
      keptCopy: false,
    },
    {
      step: "stop_database",
      code: "stop_database.failed",
      arrange: () => h.ops.failOn("composeStop", boom("Stopping services failed."), 1),
      keptCopy: false,
    },
    {
      step: "stop_database",
      code: "stop_database.unclean",
      arrange: () => w.database.clusterStates.set("volume:restow_pgdata", "in production"),
      keptCopy: false,
    },
    {
      step: "copy",
      code: "copy.failed",
      arrange: () => w.database.failOn("copy", boom("Copying the data directory failed.")),
      keptCopy: false,
    },
    {
      step: "verify",
      code: "verify.mismatch",
      arrange: () => {
        w.database.mismatch = "content";
      },
      keptCopy: false,
    },
    {
      step: "verify",
      code: "verify.mismatch",
      arrange: () => {
        w.database.mismatch = "entries";
      },
      keptCopy: false,
    },
    {
      step: "verify",
      code: "verify.failed",
      arrange: () => w.database.failOn("compare", boom("Comparing the copy failed.")),
      keptCopy: false,
    },
    {
      step: "trial",
      code: "trial.failed",
      arrange: () => w.database.failOn("trial", boom("PostgreSQL stopped on the copy.")),
      keptCopy: false,
    },
    {
      step: "trial",
      code: "trial.mismatch",
      arrange: () => {
        w.database.trialCount = 11;
      },
      keptCopy: false,
    },
    {
      step: "trial",
      code: "trial.failed",
      arrange: () => w.database.clusterStates.set(`bind:${DATA_DIR}`, "in production"),
      keptCopy: false,
    },
    {
      step: "switch",
      code: "switch.compose_unsupported",
      // The first resolutions are the checks; the switch's own one fails.
      arrange: () =>
        w.database.failOn(
          "configDataLocation",
          boom("Reading the compose configuration failed."),
          2,
        ),
      keptCopy: false,
    },
    {
      step: "switch",
      code: "switch.failed",
      // After .env was written.
      arrange: () =>
        w.database.failOn(
          "configDataLocation",
          boom("Reading the compose configuration failed."),
          3,
        ),
      keptCopy: false,
    },
    {
      step: "switch",
      code: "switch.failed",
      arrange: () =>
        w.database.failOn("quarantine", boom("Marking the old data directory failed.")),
      keptCopy: false,
    },
    {
      step: "start_database",
      code: "start_database.failed",
      arrange: () => h.ops.failOn("composeUp", boom("Starting services failed."), 0),
      keptCopy: true,
    },
    {
      step: "start_database",
      code: "start_database.failed",
      // The new directory is unusable: PostgreSQL crashes on it.
      arrange: () => {
        w.database.onCopy = async () => {
          const directory = w.database.directory({ kind: "bind", source: DATA_DIR });
          if (directory) {
            directory.pgVersion = false;
          }
        };
      },
      keptCopy: true,
    },
    {
      step: "start_application",
      code: "start_application.failed",
      arrange: () => h.ops.failOn("composeUp", boom("Starting services failed."), 1),
      keptCopy: true,
    },
    {
      step: "start_application",
      code: "start_application.failed",
      arrange: () => h.ops.failOn("composeUp", boom("Starting services failed."), 2),
      keptCopy: true,
    },
  ];

  it.each(cases)("$step ($code)", async ({ step, code, arrange, keptCopy }) => {
    arrange();
    const record = await move();

    expect(record.status).toBe("rolled_back");
    expect(record.failure).toMatchObject({ code, step });
    expect(record.steps.find((candidate) => candidate.id === step)?.status).toBe("failed");
    await expectUnchanged();
    expect(w.store.state.database?.oldCopies).toEqual([]);
    expect(w.store.state.database?.context).toBeNull();
    if (keptCopy) {
      expect(record.keptCopy).toBe(DATA_DIR);
      expect(w.database.copies.has(DATA_DIR)).toBe(true);
    } else {
      expect(record.keptCopy).toBeNull();
      expect(w.database.copies.size).toBe(0);
    }
    expect(w.store.state.events.map((event) => event.action)).toEqual([
      "database.move.started",
      "database.move.failed",
    ]);
    // Leftover helper containers are removed before anything else.
    expect(w.database.helpersRemoved).toBe(1);
  });

  it("removes nothing it did not create when the copy never started", async () => {
    h.ops.failOn("composeStop", boom("Stopping services failed."), 0);
    await move();
    expect(w.database.calls.filter((call) => call.startsWith("removeCopy"))).toEqual([]);
  });

  it("stops the application and keeps it stopped when the way back fails too", async () => {
    w.database.failOn("copy", boom("Copying the data directory failed."));
    // PostgreSQL does not come back on the old location either.
    h.ops.failOn("composeUp", boom("Starting services failed."));
    const record = await move();

    expect(record.status).toBe("needs_attention");
    expect(record.failure?.code).toBe("copy.failed");
    expect(record.failure?.detail).toContain("The way back failed");
    expect(running("api")).toBe(false);
    // The old data is untouched: nothing was marked or removed.
    expect(w.database.directory(OLD_VOLUME)).toEqual({
      pgVersion: true,
      marker: false,
      emptied: false,
    });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("does not start PostgreSQL when .env cannot be put back", async () => {
    h.ops.failOn("composeUp", boom("Starting services failed."), 0);
    w.database.failOn("configDataLocation", boom("Reading the compose configuration failed."), 4);
    const record = await move();

    expect(record.status).toBe("needs_attention");
    // PostgreSQL stays stopped: starting it could use either copy.
    expect(h.ops.callsTo("composeUp")).toEqual(["composeUp postgres"]);
    expect(running("postgres")).toBe(false);
  });
});

describe("an updater restart during a move", () => {
  it("goes back to the old location at the next start", async () => {
    let release: () => void = () => undefined;
    w.database.onCopy = () => new Promise<void>((resolve) => (release = resolve));
    await w.mover.start({ targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR });
    await waitFor(() => w.database.calls.some((call) => call.startsWith("copy ")));

    const first = w.mover;
    const second = await w.restart();
    await second.settled();
    release();
    await first.settled();

    const record = w.store.state.database?.move;
    expect(record?.status).toBe("rolled_back");
    expect(record?.failure).toMatchObject({ code: "interrupted", step: "copy" });
    await expectUnchanged();
    expect(w.database.copies.size).toBe(0);
  });

  it("puts .env and the old copy back when it stopped after the switch", async () => {
    // Hold the move inside start_database, while Compose recreates PostgreSQL on the copy.
    let release: () => void = () => undefined;
    let held = false;
    w.database.onPostgresUp = () =>
      new Promise<void>((resolve) => {
        held = true;
        release = resolve;
      });
    await w.mover.start({ targetDir: TARGET_DIR, requestedBy: MOVE_ACTOR });
    await waitFor(() => held);
    const first = w.mover;
    const second = await w.restart();
    await second.settled();
    release();
    await first.settled();

    const record = w.store.state.database?.move;
    expect(record?.status).toBe("rolled_back");
    await expectUnchanged();
    expect(record?.keptCopy).toBe(DATA_DIR);
  });

  it("leaves a finished move alone", async () => {
    await move();
    const second = await w.restart();
    await second.settled();
    expect(w.store.state.database?.move?.status).toBe("succeeded");
    expect(w.database.runningLocation).toEqual({ kind: "bind", source: DATA_DIR });
  });
});

describe("the old copy", () => {
  it("is emptied on request, keeping its marker, and the removal is journaled", async () => {
    const record = await move();
    const copy = w.store.state.database?.oldCopies[0];
    expect(copy).toBeDefined();
    await w.mover.removeOldCopy(copy?.id as string, MOVE_ACTOR);
    await w.mover.settled();

    expect(w.database.directory(OLD_VOLUME)).toEqual({
      pgVersion: false,
      marker: true,
      emptied: true,
    });
    expect(w.store.state.database?.oldCopies).toEqual([]);
    expect(w.store.state.database?.removal).toMatchObject({ status: "succeeded" });
    expect(w.store.state.events.at(-1)).toMatchObject({
      action: "database.old_copy.removed",
      runId: record.id,
      actor: MOVE_ACTOR,
      target: "the volume restow_pgdata",
    });
    // The database keeps running from the new directory.
    expect(w.database.runningLocation).toEqual({ kind: "bind", source: DATA_DIR });
  });

  it("is never removed while the database runs from it", async () => {
    await move();
    const copy = w.store.state.database?.oldCopies[0];
    // Someone put .env back by hand: Compose would start the old copy.
    w.database.runningLocation = OLD_VOLUME;
    await expect(w.mover.removeOldCopy(copy?.id as string, MOVE_ACTOR)).rejects.toMatchObject({
      code: "blocked",
    });
    expect(w.database.calls.filter((call) => call.startsWith("removeOldData"))).toEqual([]);
  });

  it("is not removed when the database does not run", async () => {
    await move();
    const copy = w.store.state.database?.oldCopies[0];
    await h.ops.composeStop(["postgres"], 10);
    w.database.runningLocation = OLD_VOLUME;
    await expect(w.mover.removeOldCopy(copy?.id as string, MOVE_ACTOR)).rejects.toBeInstanceOf(
      MoveRefusedError,
    );
  });

  it("refuses an unknown id", async () => {
    await expect(w.mover.removeOldCopy("c-1", MOVE_ACTOR)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("records a failed removal and keeps the copy listed", async () => {
    await move();
    const copy = w.store.state.database?.oldCopies[0];
    w.database.failOn("removeOldData", new OpsError("Removing the old data directory failed."));
    await w.mover.removeOldCopy(copy?.id as string, MOVE_ACTOR);
    await w.mover.settled();
    expect(w.store.state.database?.removal).toMatchObject({ status: "failed" });
    expect(w.store.state.database?.oldCopies).toHaveLength(1);
  });
});

describe("the view", () => {
  it("shows the location, the size and the free space", async () => {
    const view = await w.mover.view(true);
    expect(view).toMatchObject({
      location: OLD_VOLUME,
      movable: true,
      usage: {
        dataBytes: 29 * GIB,
        filesystemFreeBytes: 4 * GIB,
        filesystemTotalBytes: 38 * GIB,
        filesystem: "ext2/ext3",
      },
      move: null,
      oldCopies: [],
      removal: null,
    });
  });

  it("says when the compose file cannot take a new location", async () => {
    w.database.composeReadsEnv = false;
    expect((await w.mover.view(true)).movable).toBe(false);
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The condition did not come true.");
}
