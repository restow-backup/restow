import * as path from "node:path";
import type { DatabaseOps, PostgresContainer, TargetProbe } from "./database-ops.js";
import {
  type DatabaseView,
  type DataLocation,
  type DataUsage,
  locationFromEnv,
  type MoveCheck,
  type MoveFailureCode,
  type MoveProblem,
  type MoveRecord,
  type MoveRequest,
  type MoveStepId,
  movedDataName,
  moveProgressOf,
  type OldCopy,
  type PublicMove,
  pendingMoveSteps,
  sameLocation,
  validateTargetDir,
} from "./database-protocol.js";
import { type CapturedEnv, DATABASE_LOCATION_KEYS, type EnvFile, envValueOf } from "./env-file.js";
import type { Logger } from "./logger.js";
import { type ApiClient, type Clock, type DockerOps, OpsError } from "./ops.js";
import type { JournalEvent, UpdateActor } from "./protocol.js";
import { clip, type Redactor } from "./redact.js";
import type { DatabaseState, MoveContext, StatusStore } from "./store.js";

/**
 * Moving the database to a directory on another disk (docs/DATABASE.md), on the
 * provider owner's request from Installation > Database.
 *
 * Nothing changes before every check passed: the directory exists on the host, is
 * writable, is on another file system than the data now, that file system suits
 * PostgreSQL (local: ext4, XFS, Btrfs, ZFS; never NFS, SMB, a FUSE or a memory file
 * system), it has room for the data plus a margin, the database has no tablespaces
 * elsewhere, and the compose file takes the location from `.env`. Then:
 *
 *   1. stop_application  api, worker and scheduler stop (the edge keeps serving the
 *                        maintenance page);
 *   2. stop_database     PostgreSQL stops; `pg_controldata` must report a clean shutdown;
 *   3. copy              `<dir>/restow-postgres-<time>` is created and the data directory
 *                        copied into it with owner, permissions and times (a helper
 *                        container of the postgres image, the old data read-only);
 *   4. verify            both trees are listed side by side: the same entries with the same
 *                        types, sizes, permissions and owners, and the same content
 *                        (SHA-256 of every file);
 *   5. trial             PostgreSQL starts on the copy in an isolated container (no network,
 *                        the data's owner), must answer with the migration count read before
 *                        the stop, and stops cleanly again;
 *   6. switch            RESTOW_POSTGRES_DATA_TYPE=bind and RESTOW_POSTGRES_DATA=<copy> go
 *                        into `.env` (the previous lines are kept for the way back), Compose
 *                        must resolve the new location, and the old copy is marked: a note
 *                        file, and its PG_VERSION renamed, so PostgreSQL refuses to start on
 *                        it by mistake (an old compose file, `.env` edited back);
 *   7. start_database    PostgreSQL is recreated on the new directory, must become healthy,
 *                        run from the new directory and show the same migration count;
 *   8. start_application api, then worker and scheduler; the api must answer ready.
 *
 * Any failure goes back to the old location (`rolled_back`): the database stops, `.env` gets
 * its previous lines back, the old copy its PG_VERSION, PostgreSQL starts there, must run
 * from there and show the migration count of before, and the application starts. An
 * incomplete copy is removed (it never ran); a copy the database already ran from is
 * kept and named. When the way back fails too, the move ends `needs_attention` and the
 * operator follows docs/DATABASE.md. After an updater restart in the middle of a move,
 * the same way back runs at the next start.
 *
 * The old data is never deleted by the move: it stays, marked, until an administrator
 * removes it ({@link DatabaseMover.removeOldCopy}).
 */

/** Never more than this many old copies are remembered (each one is removed by hand). */
const OLD_COPIES_LIMIT = 20;
const LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
const APP_SERVICES = ["api", "worker", "scheduler"] as const;
const WORKER_SERVICES = ["worker", "scheduler"] as const;
/** The application gets this long to stop (the worker checkpoints running jobs). */
const APP_STOP_SECONDS = 90;
/** PostgreSQL gets this long to shut down cleanly. */
const DATABASE_STOP_SECONDS = 120;
const POLL_MS = 2000;
/** Container states that mean "it crashed": seen twice, waiting ends. */
const CRASHED = ["restarting", "exited", "dead"];
/** The margin the target needs on top of the data: a tenth of it, at least 2 GiB. */
export const MOVE_MARGIN_MIN_BYTES = 2 * 1024 ** 3;
/** How long the view keeps a measured size of the data directory. */
const USAGE_TTL_MS = 5 * 60_000;
/** How long the view keeps the location and whether Compose reads it from `.env`. */
const LOCATION_TTL_MS = 60_000;
/** A probe value for the compose check (a path nothing is ever created at). */
const COMPOSE_PROBE_PATH = "/restow-database-location-probe";

/**
 * File systems PostgreSQL may live on, by `statfs` magic number: ext2/3/4, XFS, Btrfs,
 * ZFS. Everything else (NFS, SMB/CIFS, FUSE, tmpfs, overlay, 9p, vfat, ...) is refused.
 */
export const SUITABLE_FILESYSTEMS: Readonly<Record<string, string>> = {
  ef53: "ext4",
  "58465342": "xfs",
  "9123683e": "btrfs",
  "2fc12fc1": "zfs",
};

/** The move cannot start; nothing was changed. */
export class MoveRefusedError extends Error {
  constructor(
    readonly code: "busy" | "invalid_request" | "not_found" | "blocked",
    message: string,
    readonly problems: MoveProblem[] = [],
  ) {
    super(message);
    this.name = "MoveRefusedError";
  }
}

class MoveFailure extends Error {
  constructor(
    readonly code: MoveFailureCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "MoveFailure";
  }
}

/** The process is shutting down: the move is left as it is and taken back at the next start. */
class ShutdownSignal extends Error {}

export interface DatabaseMoverDeps {
  ops: Pick<DockerOps, "composeStop" | "composeUp" | "servicesState" | "migrationCount">;
  database: DatabaseOps;
  api: Pick<ApiClient, "readiness">;
  envFile: Pick<
    EnvFile,
    "read" | "capture" | "applyDatabaseLocation" | "restoreDatabaseLocation" | "assertWritable"
  >;
  store: StatusStore;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  /** What else runs that a move must not overlap (an update, a restart): why, or null. */
  otherActivity: () => string | null;
  /** How long PostgreSQL and the api get to become ready (RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS). */
  healthTimeoutSeconds: number;
}

interface Cached<T> {
  at: number;
  value: T;
}

export class DatabaseMover {
  private execution: Promise<void> | null = null;
  private removing: Promise<void> | null = null;
  private shuttingDown = false;
  private location: Cached<{
    container: PostgresContainer | null;
    movable: boolean | null;
  }> | null = null;
  private usage: Cached<DataUsage> | null = null;

  constructor(private readonly deps: DatabaseMoverDeps) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** A move or a removal runs. */
  active(): boolean {
    return (
      this.execution !== null ||
      this.removing !== null ||
      this.state().move?.status === "running" ||
      this.state().removal?.status === "running"
    );
  }

  /** Resolves when the running move and removal (if any) have ended. */
  async settled(): Promise<void> {
    await (this.execution ?? Promise.resolve());
    await (this.removing ?? Promise.resolve());
  }

  /** What the public status may say about the current move (no paths). */
  publicMove(): PublicMove | null {
    const move = this.state().move;
    if (!move) {
      return null;
    }
    return {
      id: move.id,
      status: move.status,
      step: move.step,
      progress: move.progress,
      finishedAt: move.finishedAt,
    };
  }

  /**
   * At start: a move the previous process left running goes back to the old location
   * (in the background; the result is in the state), and a removal it left running is
   * recorded as failed.
   */
  async init(): Promise<void> {
    const state = this.state();
    if (state.removal?.status === "running") {
      state.removal.status = "failed";
      state.removal.finishedAt = this.now();
      state.removal.detail = "The updater stopped while it removed the old copy.";
      await this.deps.store.save();
    }
    const move = state.move;
    if (move?.status !== "running" || !state.context) {
      return;
    }
    this.deps.logger.warn(
      `The database move ${move.id} was running when the updater stopped; going back to the old location.`,
    );
    this.log(move, "The updater restarted while the move ran; going back to the old location.");
    const failure = new MoveFailure("interrupted", "The updater stopped while the move ran.");
    const stepId = move.step;
    if (stepId) {
      this.markFailed(move, stepId);
    }
    move.failure ??= { code: failure.code, step: stepId, detail: failure.detail };
    await this.deps.store.save();
    this.execution = this.rollBack(failure, stepId).finally(() => {
      this.execution = null;
    });
  }

  shutdown(): void {
    this.shuttingDown = true;
  }

  /** Installation > Database. `refresh` measures again instead of using the cached values. */
  async view(refresh = false): Promise<DatabaseView> {
    const state = this.state();
    let location: DataLocation | null = null;
    let movable: boolean | null = null;
    let usage: DataUsage | null = this.usage?.value ?? null;
    if (!this.active()) {
      const current = await this.readLocation(refresh);
      location = current.container?.location ?? null;
      movable = current.movable;
      if (current.container?.state === "running") {
        usage = await this.readUsage(refresh).catch(() => usage);
      }
    } else {
      location = state.move?.status === "running" ? state.move.from : null;
    }
    return {
      location,
      usage,
      movable,
      move: state.move ? structuredClone(state.move) : null,
      oldCopies: structuredClone(state.oldCopies),
      removal: state.removal ? structuredClone(state.removal) : null,
    };
  }

  /** Check a directory without changing anything (but a test file written and removed). */
  async check(targetDir: string): Promise<MoveCheck> {
    const { problems, probe, dataBytes, requiredBytes, dir } = await this.examine(targetDir);
    return {
      ok: problems.length === 0,
      problems,
      targetDir: dir ?? targetDir,
      filesystem: probe?.filesystem ?? null,
      freeBytes: probe?.exists ? probe.freeBytes : null,
      totalBytes: probe?.exists ? probe.totalBytes : null,
      dataBytes,
      requiredBytes,
      checkedAt: this.now(),
    };
  }

  /**
   * Start the move. Every check runs again first; the request is refused
   * ({@link MoveRefusedError}) when one does not pass, and nothing changes then.
   * Resolves with the move as it starts; the move itself runs in the background.
   */
  async start(request: MoveRequest): Promise<MoveRecord> {
    const busy = this.busyReason();
    if (busy) {
      throw new MoveRefusedError("busy", busy);
    }
    const examined = await this.examine(request.targetDir);
    if (examined.problems.length > 0 || !examined.dir || !examined.probe || !examined.container) {
      throw new MoveRefusedError(
        "blocked",
        "The database cannot be moved to this directory.",
        examined.problems,
      );
    }
    const container = examined.container;
    const from = container.location as DataLocation;
    let baseline: number;
    try {
      baseline = await this.deps.ops.migrationCount();
    } catch (error) {
      throw new MoveRefusedError("blocked", "The database cannot be moved now.", [
        {
          code: "location_unknown",
          detail: `The migration count could not be read: ${this.detail(error)}`,
        },
      ]);
    }
    // Nothing awaits between this check and the state change: two requests cannot both pass.
    const again = this.busyReason();
    if (again) {
      throw new MoveRefusedError("busy", again);
    }
    const now = this.deps.clock.now();
    const name = movedDataName(now);
    const move: MoveRecord = {
      id: `m-${now.getTime()}`,
      status: "running",
      requestedBy: request.requestedBy,
      startedAt: now.toISOString(),
      finishedAt: null,
      from,
      targetDir: examined.dir,
      dataDir: path.posix.join(examined.dir, name),
      step: null,
      steps: pendingMoveSteps(),
      progress: 0,
      dataBytes: examined.dataBytes,
      verified: null,
      failure: null,
      keptCopy: null,
      log: [],
    };
    const state = this.state();
    state.move = move;
    state.context = {
      image: container.imageId,
      owner: examined.probe.owner,
      baselineMigrations: baseline,
      previousEnv: null,
      appStopped: false,
      databaseStopped: false,
      copyStarted: false,
      envSwitched: false,
      quarantineStarted: false,
      newDatabaseStarted: false,
      rollingBack: false,
    };
    this.log(
      move,
      `Moving the database from ${describe(from)} to ${move.dataDir} (${examined.dataBytes ?? "?"} bytes), as ${request.requestedBy.label} asked.`,
    );
    this.journal("database.move.started", move, {
      from: describe(from),
      dataBytes: examined.dataBytes,
    });
    await this.deps.store.save();
    this.location = null;
    this.usage = null;
    this.execution = this.run().finally(() => {
      this.execution = null;
    });
    return structuredClone(move);
  }

  /** Remove an old copy a successful move left behind. Runs in the background. */
  async removeOldCopy(id: string, actor: UpdateActor): Promise<void> {
    const busy = this.busyReason();
    if (busy) {
      throw new MoveRefusedError("busy", busy);
    }
    const state = this.state();
    const copy = state.oldCopies.find((entry) => entry.id === id);
    if (!copy) {
      throw new MoveRefusedError("not_found", "There is no old copy with this id.");
    }
    // The copy must not be what the database runs from, nor what Compose would start it from.
    const container = await this.deps.database.postgresContainer();
    const configured = await this.deps.database.configDataLocation({});
    if (
      !container?.location ||
      sameLocation(container.location, copy.location) ||
      sameLocation(configured, copy.location) ||
      !sameLocation(configured, container.location)
    ) {
      throw new MoveRefusedError(
        "blocked",
        "The database runs from this location, or where it runs could not be confirmed; nothing was removed.",
      );
    }
    const again = this.busyReason();
    if (again) {
      throw new MoveRefusedError("busy", again);
    }
    state.removal = {
      copyId: copy.id,
      location: copy.location,
      status: "running",
      startedAt: this.now(),
      finishedAt: null,
      detail: "",
    };
    await this.deps.store.save();
    const image = container.imageId;
    this.removing = this.remove(copy, image, actor).finally(() => {
      this.removing = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------

  private busyReason(): string | null {
    if (this.active()) {
      return "The database is being moved, or an old copy is being removed.";
    }
    return this.deps.otherActivity();
  }

  private async examine(targetDir: string): Promise<{
    problems: MoveProblem[];
    dir: string | null;
    probe: TargetProbe | null;
    container: PostgresContainer | null;
    dataBytes: number | null;
    requiredBytes: number | null;
  }> {
    const problems: MoveProblem[] = [];
    const add = (code: MoveProblem["code"], detail: string | null = null) => {
      problems.push({ code, detail: detail ? this.deps.redactor.oneLine(detail, 500) : null });
    };
    const empty = { dir: null, probe: null, container: null, dataBytes: null, requiredBytes: null };

    const busy = this.busyReason();
    if (busy) {
      add("busy", busy);
      return { problems, ...empty };
    }
    const validated = validateTargetDir(targetDir);
    if ("problem" in validated) {
      add("path_invalid", validated.problem);
      return { problems, ...empty };
    }
    const dir = validated.dir;

    let container: PostgresContainer | null;
    try {
      container = await this.deps.database.postgresContainer();
    } catch (error) {
      add("location_unknown", this.detail(error));
      return { problems, ...empty, dir };
    }
    if (!container?.location || container.state !== "running") {
      add(
        "location_unknown",
        container
          ? `The postgres container is ${container.state}${container.location ? "" : " and mounts no data directory"}.`
          : "The project has no postgres container.",
      );
      return { problems, ...empty, dir, container };
    }
    const from = container.location;
    if (from.kind === "bind" && (dir === from.source || dir.startsWith(`${from.source}/`))) {
      add("path_invalid", "The directory is inside the current data directory.");
      return { problems, ...empty, dir, container };
    }

    // Compose must take the location from `.env`, and must resolve today's to what runs.
    try {
      const probed = await this.deps.database.configDataLocation({
        RESTOW_POSTGRES_DATA_TYPE: "bind",
        RESTOW_POSTGRES_DATA: COMPOSE_PROBE_PATH,
      });
      if (!sameLocation(probed, { kind: "bind", source: COMPOSE_PROBE_PATH })) {
        add(
          "compose_unsupported",
          "The compose file does not take the database location from RESTOW_POSTGRES_DATA in .env. Use the docker-compose.yml of this release.",
        );
      } else {
        const configured = await this.deps.database.configDataLocation({});
        if (!sameLocation(configured, from)) {
          add(
            "compose_unsupported",
            `The compose file resolves the database to ${configured ? describe(configured) : "nothing"}, but it runs from ${describe(from)}. Recreate the postgres service first (docker compose up -d postgres).`,
          );
        }
      }
    } catch (error) {
      add("compose_unsupported", this.detail(error));
    }
    try {
      await this.deps.envFile.assertWritable();
    } catch (error) {
      add("env_unwritable", this.detail(error));
    }

    let dataBytes: number | null = null;
    try {
      dataBytes = (await this.readUsage(true)).dataBytes;
    } catch (error) {
      add(
        "location_unknown",
        `The size of the data directory could not be read: ${this.detail(error)}`,
      );
    }

    let probe: TargetProbe;
    try {
      probe = await this.deps.database.probeTarget(
        container.imageId,
        from,
        dir,
        movedDataName(this.deps.clock.now()),
      );
    } catch (error) {
      add("path_missing", this.detail(error));
      return { problems, dir, probe: null, container, dataBytes, requiredBytes: null };
    }
    if (!probe.exists) {
      add("path_missing", `${dir} does not exist on the host, or is not a directory.`);
      return { problems, dir, probe, container, dataBytes, requiredBytes: null };
    }
    if (!probe.writable) {
      add("not_writable", `${dir} cannot be written to.`);
    }
    if (probe.sameFilesystem) {
      add("same_filesystem", `${dir} is on the file system the database is on now.`);
    }
    const magic = (probe.filesystemMagic ?? "").toLowerCase().replace(/^0x/, "");
    if (!SUITABLE_FILESYSTEMS[magic]) {
      add(
        "filesystem_unsuitable",
        `${dir} is on ${probe.filesystem ?? "an unknown file system"} (${probe.filesystemMagic ?? "?"}); PostgreSQL needs a local file system (ext4, XFS, Btrfs or ZFS).`,
      );
    }
    if (probe.tablespaces > 0) {
      add(
        "tablespaces",
        `The database has ${probe.tablespaces} tablespace(s) outside its data directory.`,
      );
    }
    if (probe.nameTaken) {
      add("busy", "A directory for this move exists already; try again in a second.");
    }
    if (probe.owner.uid < 0 || probe.owner.gid < 0) {
      add("location_unknown", "The owner of the data directory could not be read.");
    }
    let requiredBytes: number | null = null;
    if (dataBytes !== null) {
      requiredBytes = dataBytes + Math.max(Math.ceil(dataBytes * 0.1), MOVE_MARGIN_MIN_BYTES);
      if (probe.freeBytes < requiredBytes) {
        add(
          "insufficient_space",
          `${formatBytes(probe.freeBytes)} free, ${formatBytes(requiredBytes)} needed (the data, ${formatBytes(dataBytes)}, and a margin).`,
        );
      }
    }
    return { problems, dir, probe, container, dataBytes, requiredBytes };
  }

  // ---------------------------------------------------------------------------
  // The move
  // ---------------------------------------------------------------------------

  private async run(): Promise<void> {
    let stepId: MoveStepId | null = null;
    try {
      stepId = "stop_application";
      await this.stopApplication();
      stepId = "stop_database";
      await this.stopDatabase();
      stepId = "copy";
      await this.copy();
      stepId = "verify";
      await this.verify();
      stepId = "trial";
      await this.trial();
      stepId = "switch";
      await this.switchLocation();
      stepId = "start_database";
      await this.startDatabase();
      stepId = "start_application";
      await this.startApplication();
      await this.succeed();
    } catch (error) {
      if (error instanceof ShutdownSignal) {
        return;
      }
      const failure =
        error instanceof MoveFailure
          ? error
          : new MoveFailure(fallbackCode(stepId), this.detail(error));
      try {
        await this.fail(failure, stepId);
      } catch (inner) {
        this.deps.logger.error(
          `The failed database move could not be taken back: ${(inner as Error).message}`,
        );
      }
    }
  }

  private async stopApplication(): Promise<void> {
    await this.beginStep("stop_application", "Stopping api, worker and scheduler.");
    await this.flag("appStopped");
    try {
      await this.deps.ops.composeStop(APP_SERVICES, APP_STOP_SECONDS);
    } catch (error) {
      throw new MoveFailure("stop_application.failed", this.detail(error));
    }
    await this.endStep("stop_application");
  }

  private async stopDatabase(): Promise<void> {
    const { database } = this.deps;
    const move = this.move();
    const context = this.context();
    await this.beginStep("stop_database", "Stopping PostgreSQL.");
    await this.flag("databaseStopped");
    try {
      await this.deps.ops.composeStop(["postgres"], DATABASE_STOP_SECONDS);
    } catch (error) {
      throw new MoveFailure("stop_database.failed", this.detail(error));
    }
    const container = await database.postgresContainer().catch(() => null);
    if (container && container.state === "running") {
      throw new MoveFailure("stop_database.failed", "PostgreSQL still runs after the stop.");
    }
    let clusterState: string;
    try {
      clusterState = await database.clusterState(context.image, move.from);
    } catch (error) {
      throw new MoveFailure("stop_database.failed", this.detail(error));
    }
    if (clusterState !== "shut down") {
      throw new MoveFailure(
        "stop_database.unclean",
        `pg_controldata reports "${clusterState || "nothing"}", not "shut down".`,
      );
    }
    this.log(move, "PostgreSQL shut down cleanly.");
    await this.endStep("stop_database");
  }

  private async copy(): Promise<void> {
    const move = this.move();
    const context = this.context();
    await this.beginStep("copy", `Copying the data directory to ${move.dataDir}.`);
    await this.flag("copyStarted");
    try {
      await this.deps.database.copy(
        context.image,
        move.from,
        move.targetDir,
        path.posix.basename(move.dataDir),
      );
    } catch (error) {
      throw new MoveFailure("copy.failed", this.detail(error));
    }
    await this.endStep("copy");
  }

  private async verify(): Promise<void> {
    const move = this.move();
    const context = this.context();
    await this.beginStep("verify", "Comparing the copy with the original, file by file.");
    let manifests: Awaited<ReturnType<DatabaseOps["compare"]>>;
    try {
      manifests = await this.deps.database.compare(
        context.image,
        move.from,
        move.targetDir,
        path.posix.basename(move.dataDir),
      );
    } catch (error) {
      throw new MoveFailure("verify.failed", this.detail(error));
    }
    const { source, copy } = manifests;
    const differences: string[] = [];
    if (source.entries !== copy.entries) {
      differences.push(`entries ${source.entries} / ${copy.entries}`);
    }
    if (source.bytes !== copy.bytes) {
      differences.push(`bytes ${source.bytes} / ${copy.bytes}`);
    }
    if (source.meta !== copy.meta) {
      differences.push("types, sizes, permissions or owners differ");
    }
    if (source.content !== copy.content) {
      differences.push("the content differs");
    }
    if (differences.length > 0) {
      throw new MoveFailure("verify.mismatch", `Original / copy: ${differences.join("; ")}.`);
    }
    move.verified = { entries: copy.entries, bytes: copy.bytes };
    this.log(move, `The copy is identical: ${copy.entries} entries, ${copy.bytes} bytes.`);
    await this.endStep("verify");
  }

  private async trial(): Promise<void> {
    const move = this.move();
    const context = this.context();
    await this.beginStep("trial", "Starting PostgreSQL on the copy for a check.");
    let count: number;
    try {
      count = await this.deps.database.trial(
        context.image,
        move.dataDir,
        context.owner,
        this.deps.healthTimeoutSeconds * 1000,
      );
    } catch (error) {
      throw new MoveFailure("trial.failed", this.detail(error));
    }
    if (count !== context.baselineMigrations) {
      throw new MoveFailure(
        "trial.mismatch",
        `The copy has ${count} applied migrations, the original had ${context.baselineMigrations}.`,
      );
    }
    let clusterState: string;
    try {
      clusterState = await this.deps.database.clusterState(context.image, {
        kind: "bind",
        source: move.dataDir,
      });
    } catch (error) {
      throw new MoveFailure("trial.failed", this.detail(error));
    }
    if (clusterState !== "shut down") {
      throw new MoveFailure(
        "trial.failed",
        `After the check pg_controldata reports "${clusterState || "nothing"}", not "shut down".`,
      );
    }
    this.log(move, `PostgreSQL ran on the copy: ${count} applied migrations, as before.`);
    await this.endStep("trial");
  }

  private async switchLocation(): Promise<void> {
    const { database, envFile } = this.deps;
    const move = this.move();
    const context = this.context();
    await this.beginStep("switch", "Pointing .env at the new directory.");
    const target: DataLocation = { kind: "bind", source: move.dataDir };
    let resolved: DataLocation | null;
    try {
      resolved = await database.configDataLocation({
        RESTOW_POSTGRES_DATA_TYPE: "bind",
        RESTOW_POSTGRES_DATA: move.dataDir,
      });
    } catch (error) {
      throw new MoveFailure("switch.compose_unsupported", this.detail(error));
    }
    if (!sameLocation(resolved, target)) {
      throw new MoveFailure(
        "switch.compose_unsupported",
        "The compose file does not take the database location from .env.",
      );
    }
    let captured: CapturedEnv;
    try {
      captured = await envFile.capture(DATABASE_LOCATION_KEYS);
    } catch (error) {
      throw new MoveFailure("switch.failed", this.detail(error));
    }
    context.previousEnv = captured;
    await this.deps.store.save();
    await this.flag("envSwitched");
    try {
      await envFile.applyDatabaseLocation(move.dataDir);
      const configured = await database.configDataLocation({});
      if (!sameLocation(configured, target)) {
        throw new Error(
          `Compose resolves the database to ${configured ? describe(configured) : "nothing"} after the change.`,
        );
      }
    } catch (error) {
      throw new MoveFailure("switch.failed", this.detail(error));
    }
    await this.flag("quarantineStarted");
    try {
      await database.quarantine(
        context.image,
        move.from,
        `This PostgreSQL data directory was moved to ${move.dataDir} on ${this.now()} by the Restow updater (move ${move.id}). It is an old copy: PG_VERSION was renamed to PG_VERSION.restow-moved so that PostgreSQL does not start on it. Remove it under Installation > Database, or see docs/DATABASE.md.`,
      );
    } catch (error) {
      throw new MoveFailure("switch.failed", this.detail(error));
    }
    this.log(move, `.env names ${move.dataDir}; the old copy is marked.`);
    await this.endStep("switch");
  }

  private async startDatabase(): Promise<void> {
    const move = this.move();
    const context = this.context();
    await this.beginStep("start_database", "Starting PostgreSQL from the new directory.");
    await this.flag("newDatabaseStarted");
    try {
      await this.deps.ops.composeUp(["postgres"]);
    } catch (error) {
      throw new MoveFailure("start_database.failed", this.detail(error));
    }
    const container = await this.waitForDatabase("start_database.failed");
    if (!sameLocation(container.location, { kind: "bind", source: move.dataDir })) {
      throw new MoveFailure(
        "start_database.wrong_location",
        `PostgreSQL runs from ${container.location ? describe(container.location) : "nothing"}, not ${move.dataDir}.`,
      );
    }
    let count: number;
    try {
      count = await this.deps.ops.migrationCount();
    } catch (error) {
      throw new MoveFailure("start_database.failed", this.detail(error));
    }
    if (count !== context.baselineMigrations) {
      throw new MoveFailure(
        "start_database.failed",
        `The database has ${count} applied migrations, it had ${context.baselineMigrations}.`,
      );
    }
    await this.endStep("start_database");
  }

  private async startApplication(): Promise<void> {
    await this.beginStep("start_application", "Starting api, worker and scheduler.");
    try {
      await this.deps.ops.composeUp(["api"]);
      await this.waitForApi("start_application.failed");
      await this.deps.ops.composeUp(WORKER_SERVICES);
      await this.waitForServices(APP_SERVICES, "start_application.failed");
    } catch (error) {
      if (error instanceof MoveFailure || error instanceof ShutdownSignal) {
        throw error;
      }
      throw new MoveFailure("start_application.failed", this.detail(error));
    }
    await this.endStep("start_application");
  }

  private async succeed(): Promise<void> {
    const state = this.state();
    const move = this.move();
    move.status = "succeeded";
    move.finishedAt = this.now();
    move.progress = 100;
    move.step = null;
    const copy: OldCopy = {
      id: `c-${this.deps.clock.now().getTime()}`,
      location: move.from,
      moveId: move.id,
      movedAt: move.finishedAt,
    };
    state.oldCopies = [copy, ...state.oldCopies].slice(0, OLD_COPIES_LIMIT);
    state.context = null;
    this.log(
      move,
      `The database runs from ${move.dataDir}. The old copy (${describe(move.from)}) is kept until it is removed.`,
    );
    this.journal("database.move.succeeded", move, {
      from: describe(move.from),
      dataBytes: move.dataBytes,
      verified: move.verified,
    });
    this.deps.logger.info(`The database was moved to ${move.dataDir}.`);
    await this.deps.store.save();
    this.location = null;
    this.usage = null;
  }

  // ---------------------------------------------------------------------------
  // The way back
  // ---------------------------------------------------------------------------

  private async fail(failure: MoveFailure, stepId: MoveStepId | null): Promise<void> {
    const move = this.move();
    if (stepId) {
      this.markFailed(move, stepId);
    }
    move.failure = {
      code: failure.code,
      step: stepId,
      detail: this.deps.redactor.oneLine(failure.detail, 2000),
    };
    this.log(move, `Step ${stepId ?? "?"} failed: ${failure.code}. ${failure.detail}`);
    this.deps.logger.warn(
      `The database move ${move.id} failed in ${stepId ?? "?"}: ${failure.code} ${this.deps.redactor.oneLine(failure.detail, 300)}`,
    );
    await this.deps.store.save();
    await this.rollBack(failure, stepId);
  }

  /**
   * Go back to the old location, undoing exactly what the flags say may have happened.
   * Every action is safe to repeat (a restart in the middle of it runs it again).
   */
  private async rollBack(failure: MoveFailure, _stepId: MoveStepId | null): Promise<void> {
    const { ops, database, envFile } = this.deps;
    const move = this.move();
    const context = this.context();
    context.rollingBack = true;
    await this.deps.store.save();
    const problems: string[] = [];
    const attempt = async (what: string, action: () => Promise<void>): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        if (error instanceof ShutdownSignal) {
          throw error;
        }
        problems.push(`${what}: ${this.detail(error)}`);
        this.log(move, `Going back: ${what} failed: ${this.detail(error)}`);
        return false;
      }
    };

    try {
      this.log(move, "Going back to the old location.");
      await database.removeHelpers().catch(() => 0);

      if (context.newDatabaseStarted || context.envSwitched) {
        await attempt("stopping the application", () =>
          ops.composeStop(APP_SERVICES, APP_STOP_SECONDS),
        );
        await attempt("stopping PostgreSQL", () =>
          ops.composeStop(["postgres"], DATABASE_STOP_SECONDS),
        );
      }
      let safe = true;
      if (context.envSwitched && context.previousEnv) {
        const previous = context.previousEnv;
        safe = await attempt("restoring .env", async () => {
          await envFile.restoreDatabaseLocation(previous);
          const configured = await database.configDataLocation({});
          if (!sameLocation(configured, move.from)) {
            throw new Error(
              `Compose resolves the database to ${configured ? describe(configured) : "nothing"}, not ${describe(move.from)}.`,
            );
          }
        });
      }
      if (safe && context.quarantineStarted) {
        safe = await attempt("restoring PG_VERSION of the old data", () =>
          database.unquarantine(context.image, move.from),
        );
      }
      if (context.copyStarted) {
        if (context.newDatabaseStarted) {
          // The database ran from the copy: it may hold changes the old location lacks.
          move.keptCopy = move.dataDir;
          this.log(move, `The copy in ${move.dataDir} is kept: the database ran from it.`);
        } else {
          const removed = await attempt("removing the incomplete copy", () =>
            database.removeCopy(context.image, move.targetDir, path.posix.basename(move.dataDir)),
          );
          if (!removed) {
            move.keptCopy = move.dataDir;
          }
        }
      }
      if (safe && context.databaseStopped) {
        safe = await attempt("starting PostgreSQL on the old location", async () => {
          await ops.composeUp(["postgres"]);
          const container = await this.waitForDatabase("start_database.failed");
          if (!sameLocation(container.location, move.from)) {
            throw new Error(
              `PostgreSQL runs from ${container.location ? describe(container.location) : "nothing"}, not ${describe(move.from)}.`,
            );
          }
          const count = await ops.migrationCount();
          if (count !== context.baselineMigrations) {
            throw new Error(
              `The database has ${count} applied migrations, it had ${context.baselineMigrations}.`,
            );
          }
        });
      }
      if (safe && context.appStopped) {
        safe = await attempt("starting the application", async () => {
          await ops.composeUp(["api"]);
          await this.waitForApi("start_application.failed");
          await ops.composeUp(WORKER_SERVICES);
          await this.waitForServices(APP_SERVICES, "start_application.failed");
        });
      }
      if (!safe && problems.length === 0) {
        problems.push("The way back stopped early.");
      }
    } catch (error) {
      if (error instanceof ShutdownSignal) {
        return;
      }
      problems.push(this.detail(error));
    }

    const state = this.state();
    move.finishedAt = this.now();
    move.step = null;
    for (const step of move.steps) {
      if (step.status === "pending") {
        step.status = "skipped";
      }
    }
    if (problems.length === 0) {
      move.status = "rolled_back";
      this.log(move, `Back on ${describe(move.from)}; the database is unchanged.`);
    } else {
      move.status = "needs_attention";
      const detail = `${clip(failure.detail, 900)} The way back failed: ${clip(problems.join(" "), 1000)}`;
      move.failure = {
        code: move.failure?.code ?? failure.code,
        step: move.failure?.step ?? null,
        detail: this.deps.redactor.oneLine(detail, 2000),
      };
      this.log(move, "The way back did not complete; see docs/DATABASE.md.");
    }
    state.context = null;
    this.journal("database.move.failed", move, {
      from: describe(move.from),
      status: move.status,
      failureCode: move.failure?.code ?? failure.code,
      keptCopy: move.keptCopy,
    });
    await this.deps.store.save();
    this.location = null;
    this.usage = null;
  }

  // ---------------------------------------------------------------------------
  // Removing an old copy
  // ---------------------------------------------------------------------------

  private async remove(copy: OldCopy, image: string, actor: UpdateActor): Promise<void> {
    const state = this.state();
    const removal = state.removal;
    if (!removal) {
      return;
    }
    try {
      await this.deps.database.removeOldData(
        image,
        copy.location,
        `Its content was removed on ${this.now()} by ${actor.label} (Installation > Database).`,
      );
      removal.status = "succeeded";
      state.oldCopies = state.oldCopies.filter((entry) => entry.id !== copy.id);
      this.deps.store.addEvent(
        {
          at: this.now(),
          action: "database.old_copy.removed",
          runId: copy.moveId,
          actor,
          target: describe(copy.location),
          details: { location: describe(copy.location), movedAt: copy.movedAt },
        },
        this.deps.clock.now().getTime(),
      );
      this.deps.logger.info(`The old database copy ${describe(copy.location)} was removed.`);
    } catch (error) {
      removal.status = "failed";
      removal.detail = this.deps.redactor.oneLine(this.detail(error), 1000);
      this.deps.logger.error(
        `Removing the old database copy ${describe(copy.location)} failed: ${removal.detail}`,
      );
    }
    removal.finishedAt = this.now();
    await this.deps.store.save();
    this.usage = null;
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  private async waitForDatabase(code: MoveFailureCode): Promise<PostgresContainer> {
    const { database, clock } = this.deps;
    const deadline = clock.now().getTime() + this.deps.healthTimeoutSeconds * 1000;
    let crashes = 0;
    let last = "not started";
    for (;;) {
      this.assertNotShuttingDown();
      const container = await database.postgresContainer().catch(() => null);
      if (container) {
        last = `${container.state}${container.health ? `, ${container.health}` : ""}`;
        if (
          container.state === "running" &&
          (container.health === "healthy" || container.health === null)
        ) {
          return container;
        }
        if (CRASHED.includes(container.state)) {
          crashes += 1;
          if (crashes >= 2) {
            throw new MoveFailure(code, `PostgreSQL does not stay up (${last}).`);
          }
        }
      }
      if (clock.now().getTime() >= deadline) {
        throw new MoveFailure(
          code,
          `PostgreSQL did not become healthy within ${this.deps.healthTimeoutSeconds} seconds (${last}).`,
        );
      }
      await clock.sleep(POLL_MS);
    }
  }

  private async waitForApi(code: MoveFailureCode): Promise<void> {
    const { api, clock } = this.deps;
    const deadline = clock.now().getTime() + this.deps.healthTimeoutSeconds * 1000;
    let reason: string | null = null;
    for (;;) {
      this.assertNotShuttingDown();
      const readiness = await api.readiness();
      if (readiness.ready) {
        return;
      }
      reason = readiness.reason;
      if (clock.now().getTime() >= deadline) {
        throw new MoveFailure(
          code,
          `The api did not report ready within ${this.deps.healthTimeoutSeconds} seconds${reason ? ` (${reason})` : ""}.`,
        );
      }
      await clock.sleep(POLL_MS);
    }
  }

  private async waitForServices(services: readonly string[], code: MoveFailureCode): Promise<void> {
    const { ops, clock } = this.deps;
    const deadline = clock.now().getTime() + 60_000;
    for (;;) {
      this.assertNotShuttingDown();
      const states = await ops.servicesState().catch(() => null);
      const missing = services.filter(
        (service) =>
          !states?.some((entry) => entry.service === service && entry.state === "running"),
      );
      if (states && missing.length === 0) {
        return;
      }
      if (clock.now().getTime() >= deadline) {
        throw new MoveFailure(code, `Not running: ${missing.join(", ")}.`);
      }
      await clock.sleep(POLL_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // The view's measurements
  // ---------------------------------------------------------------------------

  private async readLocation(
    refresh: boolean,
  ): Promise<{ container: PostgresContainer | null; movable: boolean | null }> {
    const now = this.deps.clock.now().getTime();
    if (!refresh && this.location && now - this.location.at < LOCATION_TTL_MS) {
      return this.location.value;
    }
    const container = await this.deps.database.postgresContainer().catch(() => null);
    let movable: boolean | null = null;
    try {
      const probed = await this.deps.database.configDataLocation({
        RESTOW_POSTGRES_DATA_TYPE: "bind",
        RESTOW_POSTGRES_DATA: COMPOSE_PROBE_PATH,
      });
      movable = sameLocation(probed, { kind: "bind", source: COMPOSE_PROBE_PATH });
    } catch {
      movable = null;
    }
    const value = { container, movable };
    this.location = { at: now, value };
    return value;
  }

  private async readUsage(refresh: boolean): Promise<DataUsage> {
    const now = this.deps.clock.now().getTime();
    if (!refresh && this.usage && now - this.usage.at < USAGE_TTL_MS) {
      return this.usage.value;
    }
    const filesystem = await this.deps.database.dataFilesystem();
    const dataBytes = await this.deps.database.dataBytes();
    const value: DataUsage = {
      dataBytes,
      filesystemTotalBytes: filesystem.totalBytes,
      filesystemFreeBytes: filesystem.freeBytes,
      filesystem: filesystem.filesystem,
      measuredAt: this.now(),
    };
    this.usage = { at: now, value };
    return value;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private state(): DatabaseState {
    const doc = this.deps.store.state;
    doc.database ??= { move: null, context: null, oldCopies: [], removal: null };
    return doc.database;
  }

  private move(): MoveRecord {
    const move = this.state().move;
    if (!move) {
      throw new Error("There is no current move.");
    }
    return move;
  }

  private context(): MoveContext {
    const context = this.state().context;
    if (!context) {
      throw new Error("The move has no context.");
    }
    return context;
  }

  private async flag(
    name:
      | "appStopped"
      | "databaseStopped"
      | "copyStarted"
      | "envSwitched"
      | "quarantineStarted"
      | "newDatabaseStarted",
  ): Promise<void> {
    this.context()[name] = true;
    await this.deps.store.save();
  }

  private async beginStep(id: MoveStepId, line: string): Promise<void> {
    this.assertNotShuttingDown();
    const move = this.move();
    const step = move.steps.find((candidate) => candidate.id === id);
    if (step) {
      step.status = "running";
      step.startedAt = this.now();
    }
    move.step = id;
    move.progress = Math.max(move.progress, moveProgressOf(move.steps));
    this.log(move, line);
    await this.deps.store.save();
  }

  private async endStep(id: MoveStepId): Promise<void> {
    const move = this.move();
    const step = move.steps.find((candidate) => candidate.id === id);
    if (step) {
      step.status = "done";
      step.finishedAt = this.now();
    }
    move.progress = Math.max(move.progress, moveProgressOf(move.steps));
    await this.deps.store.save();
  }

  private markFailed(move: MoveRecord, id: MoveStepId): void {
    const step = move.steps.find((candidate) => candidate.id === id);
    if (step && (step.status === "running" || step.status === "pending")) {
      step.status = "failed";
      step.finishedAt = this.now();
    }
  }

  private log(move: MoveRecord, line: string): void {
    const text = clip(this.deps.redactor.oneLine(line, LOG_LINE_CHARS), LOG_LINE_CHARS);
    move.log = [...move.log, `${this.now()} ${text}`].slice(-LOG_LINES);
  }

  private journal(
    action: JournalEvent["action"],
    move: MoveRecord,
    details: Record<string, unknown>,
  ): void {
    this.deps.store.addEvent(
      {
        at: this.now(),
        action,
        runId: move.id,
        actor: move.requestedBy,
        target: move.dataDir,
        details: { ...details, status: move.status, dataDir: move.dataDir },
      },
      this.deps.clock.now().getTime(),
    );
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new ShutdownSignal();
    }
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }

  private detail(error: unknown): string {
    const text =
      error instanceof OpsError
        ? error.detail
          ? `${error.message} ${error.detail}`
          : error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return this.deps.redactor.oneLine(text, 2000);
  }
}

function fallbackCode(step: MoveStepId | null): MoveFailureCode {
  switch (step) {
    case "stop_application":
      return "stop_application.failed";
    case "stop_database":
      return "stop_database.failed";
    case "copy":
      return "copy.failed";
    case "verify":
      return "verify.failed";
    case "trial":
      return "trial.failed";
    case "switch":
      return "switch.failed";
    case "start_database":
      return "start_database.failed";
    default:
      return "start_application.failed";
  }
}

/** A location for a log line: the volume's name or the directory. */
export function describe(location: DataLocation): string {
  return location.kind === "volume" ? `the volume ${location.source}` : location.source;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** The location `.env` names now (for the tests and the docs' manual steps). */
export async function locationOfEnv(envFile: Pick<EnvFile, "read">): Promise<DataLocation | null> {
  const text = await envFile.read();
  return locationFromEnv(
    envValueOf(text, "RESTOW_POSTGRES_DATA_TYPE"),
    envValueOf(text, "RESTOW_POSTGRES_DATA"),
  );
}
