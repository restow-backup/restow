import * as path from "node:path";
import { DatabaseMover } from "./database.js";
import type {
  DatabaseOps,
  DataFilesystem,
  PostgresContainer,
  TargetProbe,
  TreeManifest,
} from "./database-ops.js";
import { type DataLocation, locationFromEnv } from "./database-protocol.js";
import { envValueOf } from "./env-file.js";
import { OpsError } from "./ops.js";
import { StatusStore } from "./store.js";
import type { Failure, FakeDockerOps, Harness } from "./testing.js";

/**
 * A scripted world for the database location (database.ts): data directories that can be
 * copied, marked and emptied, target directories with their file systems, and a compose
 * file that does (or does not) read the location from `.env`. It sits next to the
 * FakeDockerOps of testing.ts, which owns the containers: PostgreSQL runs while its
 * fake container runs, from the location `.env` named at its last `up`.
 */

export const OLD_VOLUME: DataLocation = { kind: "volume", source: "restow_pgdata" };
export const TARGET_DIR = "/mnt/volume-1/restow-db";
const GIB = 1024 ** 3;

export interface FakeDataDirectory {
  /** PG_VERSION is there (false: renamed by the move). */
  pgVersion: boolean;
  marker: boolean;
  /** The content was removed (only the marker is left). */
  emptied: boolean;
}

export interface FakeTarget {
  exists: boolean;
  writable: boolean;
  sameFilesystem: boolean;
  magic: string;
  name: string;
  freeBytes: number;
  totalBytes: number;
}

function key(location: DataLocation): string {
  return `${location.kind}:${location.source}`;
}

export class FakeDatabaseOps implements DatabaseOps {
  readonly calls: string[] = [];
  readonly directories = new Map<string, FakeDataDirectory>();
  readonly targets = new Map<string, FakeTarget>();
  /** Data directories a copy created. */
  readonly copies = new Set<string>();
  /** Where the running PostgreSQL takes its data from (set on `up`). */
  runningLocation: DataLocation = OLD_VOLUME;
  /** The compose file reads RESTOW_POSTGRES_DATA from `.env`. */
  composeReadsEnv = true;
  dataBytesValue = 29 * GIB;
  databaseBytesValue = 27 * GIB;
  tableBytesValue = 9 * GIB;
  imageBytesValue: number | null = 600 * 1024 * 1024;
  dataFilesystemValue: DataFilesystem = {
    device: 2049,
    totalBytes: 38 * GIB,
    freeBytes: 4 * GIB,
    filesystem: "ext2/ext3",
  };
  tablespaces = 0;
  owner = { uid: 70, gid: 70 };
  /** What pg_controldata reports, per location key; default "shut down". */
  readonly clusterStates = new Map<string, string>();
  /** The copy differs from the original. */
  mismatch: "none" | "content" | "entries" = "none";
  /** Migration count the trial reads; null: the original's. */
  trialCount: number | null = null;
  /** Runs inside `copy` (a test can hold it there). */
  onCopy: (() => Promise<void>) | null = null;
  helpersRemoved = 0;
  private readonly failures = new Map<string, ((call: number) => Failure)[]>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly docker: FakeDockerOps,
    private readonly readEnv: () => Promise<string>,
  ) {
    this.directories.set(key(OLD_VOLUME), { pgVersion: true, marker: false, emptied: false });
    this.targets.set(TARGET_DIR, {
      exists: true,
      writable: true,
      sameFilesystem: false,
      magic: "ef53",
      name: "ext2/ext3",
      freeBytes: 95 * GIB,
      totalBytes: 100 * GIB,
    });
  }

  failOn(operation: string, error: Error, call?: number): void {
    const list = this.failures.get(operation) ?? [];
    list.push((index) => (call === undefined || call === index ? error : null));
    this.failures.set(operation, list);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  directory(location: DataLocation): FakeDataDirectory | undefined {
    return this.directories.get(key(location));
  }

  private hit(operation: string, detail = ""): void {
    this.calls.push(detail ? `${operation} ${detail}` : operation);
    const index = this.counters.get(operation) ?? 0;
    this.counters.set(operation, index + 1);
    for (const rule of this.failures.get(operation) ?? []) {
      const error = rule(index);
      if (error) {
        throw error;
      }
    }
  }

  /** The location `.env` names, as Compose would resolve it. */
  async envLocation(override: Readonly<Record<string, string>> = {}): Promise<DataLocation | null> {
    if (!this.composeReadsEnv) {
      return OLD_VOLUME;
    }
    const text = await this.readEnv();
    const type =
      override.RESTOW_POSTGRES_DATA_TYPE ?? envValueOf(text, "RESTOW_POSTGRES_DATA_TYPE");
    const source = override.RESTOW_POSTGRES_DATA ?? envValueOf(text, "RESTOW_POSTGRES_DATA");
    const location = locationFromEnv(type, source);
    if (location?.kind === "volume" && location.source === "pgdata") {
      return OLD_VOLUME;
    }
    return location;
  }

  /** Runs (once) when Compose (re)creates postgres; a test can hold the move there. */
  onPostgresUp: (() => Promise<void>) | null = null;

  /** Called by the harness when Compose (re)creates postgres. */
  async postgresUp(): Promise<void> {
    const hook = this.onPostgresUp;
    this.onPostgresUp = null;
    await hook?.();
    const location = await this.envLocation();
    if (!location) {
      throw new OpsError("Starting services failed (exit code 1).", "invalid volume");
    }
    const directory = this.directories.get(key(location));
    const container = this.docker.containers.get("postgres");
    if (!directory?.pgVersion || directory.emptied) {
      // PostgreSQL refuses an unusable directory: it crashes on start.
      if (container) {
        container.state = "restarting";
        container.exitCode = 1;
      }
    }
    this.runningLocation = location;
  }

  // -- DatabaseOps ------------------------------------------------------------

  async postgresContainer(): Promise<PostgresContainer | null> {
    this.hit("postgresContainer");
    const container = this.docker.containers.get("postgres");
    if (!container) {
      return null;
    }
    return {
      id: "a".repeat(64),
      imageId: `sha256:${"b".repeat(64)}`,
      state: container.state,
      health: container.state === "running" ? "healthy" : null,
      location: this.runningLocation,
    };
  }

  async dataFilesystem(): Promise<DataFilesystem> {
    this.hit("dataFilesystem");
    this.assertDatabaseRuns();
    return { ...this.dataFilesystemValue };
  }

  async dataBytes(): Promise<number> {
    this.hit("dataBytes");
    this.assertDatabaseRuns();
    return this.dataBytesValue;
  }

  async databaseSizes(): Promise<{ databaseBytes: number; tableBytes: number }> {
    this.hit("databaseSizes");
    this.assertDatabaseRuns();
    return { databaseBytes: this.databaseBytesValue, tableBytes: this.tableBytesValue };
  }

  async imageBytes(image: string): Promise<number | null> {
    this.hit("imageBytes", image);
    return this.imageBytesValue;
  }

  async configDataLocation(env: Readonly<Record<string, string>>): Promise<DataLocation | null> {
    this.hit("configDataLocation", JSON.stringify(env));
    return await this.envLocation(env);
  }

  async probeTarget(
    _image: string,
    _from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<TargetProbe> {
    this.hit("probeTarget", targetDir);
    const target = this.targets.get(targetDir);
    if (!target?.exists) {
      return {
        exists: false,
        writable: false,
        sameFilesystem: false,
        filesystemMagic: null,
        filesystem: null,
        freeBytes: 0,
        totalBytes: 0,
        tablespaces: 0,
        owner: { uid: -1, gid: -1 },
        nameTaken: false,
      };
    }
    return {
      exists: true,
      writable: target.writable,
      sameFilesystem: target.sameFilesystem,
      filesystemMagic: target.magic,
      filesystem: target.name,
      freeBytes: target.freeBytes,
      totalBytes: target.totalBytes,
      tablespaces: this.tablespaces,
      owner: { ...this.owner },
      nameTaken: this.copies.has(path.posix.join(targetDir, name)),
    };
  }

  async clusterState(_image: string, location: DataLocation): Promise<string> {
    this.hit("clusterState", key(location));
    return this.clusterStates.get(key(location)) ?? "shut down";
  }

  async copy(_image: string, from: DataLocation, targetDir: string, name: string): Promise<void> {
    const dataDir = path.posix.join(targetDir, name);
    this.hit("copy", `${key(from)} -> ${dataDir}`);
    if (this.docker.containers.get("postgres")?.state === "running") {
      throw new Error("The test copied a running database.");
    }
    this.copies.add(dataDir);
    this.directories.set(key({ kind: "bind", source: dataDir }), {
      pgVersion: true,
      marker: false,
      emptied: false,
    });
    await this.onCopy?.();
  }

  async compare(
    _image: string,
    from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<{ source: TreeManifest; copy: TreeManifest }> {
    this.hit("compare", `${key(from)} ${path.posix.join(targetDir, name)}`);
    const source: TreeManifest = {
      entries: 1840,
      bytes: this.dataBytesValue,
      meta: "1".repeat(64),
      content: "2".repeat(64),
    };
    const copy = { ...source };
    if (this.mismatch === "content") {
      copy.content = "3".repeat(64);
    } else if (this.mismatch === "entries") {
      copy.entries -= 1;
      copy.bytes -= 8192;
    }
    return { source, copy };
  }

  async trial(
    _image: string,
    dataDir: string,
    owner: { uid: number; gid: number },
  ): Promise<number> {
    this.hit("trial", `${dataDir} ${owner.uid}:${owner.gid}`);
    return this.trialCount ?? this.docker.migrations;
  }

  async quarantine(_image: string, location: DataLocation, note: string): Promise<void> {
    this.hit("quarantine", key(location));
    if (!note.includes("restow")) {
      throw new Error("The note must say what happened.");
    }
    const directory = this.directories.get(key(location));
    if (!directory) {
      throw new OpsError("Marking the old data directory failed (exit code 3).");
    }
    directory.marker = true;
    directory.pgVersion = false;
  }

  async unquarantine(_image: string, location: DataLocation): Promise<void> {
    this.hit("unquarantine", key(location));
    const directory = this.directories.get(key(location));
    if (!directory || directory.emptied) {
      throw new OpsError("Restoring the old data directory failed (exit code 3).");
    }
    directory.pgVersion = true;
    directory.marker = false;
  }

  async removeOldData(_image: string, location: DataLocation): Promise<void> {
    this.hit("removeOldData", key(location));
    const directory = this.directories.get(key(location));
    if (!directory?.marker || directory.pgVersion) {
      throw new OpsError("Removing the old data directory failed (exit code 3).");
    }
    directory.emptied = true;
  }

  async removeCopy(_image: string, targetDir: string, name: string): Promise<void> {
    const dataDir = path.posix.join(targetDir, name);
    this.hit("removeCopy", dataDir);
    this.copies.delete(dataDir);
    this.directories.delete(key({ kind: "bind", source: dataDir }));
  }

  async removeHelpers(): Promise<number> {
    this.hit("removeHelpers");
    this.helpersRemoved += 1;
    return 0;
  }

  private assertDatabaseRuns(): void {
    if (this.docker.containers.get("postgres")?.state !== "running") {
      throw new OpsError('service "postgres" is not running');
    }
  }
}

export interface MoverWorld {
  database: FakeDatabaseOps;
  mover: DatabaseMover;
  /** The store the current mover writes (a new one after `restart`). */
  store: StatusStore;
  /** Something else running (an update): the mover refuses. */
  activity: { reason: string | null };
  /** A new mover on the same state and world, as after an updater restart. */
  restart(): Promise<DatabaseMover>;
}

/** A mover on a harness (testing.ts): the same store, `.env`, containers and clock. */
export function createMoverWorld(
  h: Harness,
  options: { healthTimeoutSeconds?: number } = {},
): MoverWorld {
  const database = new FakeDatabaseOps(h.ops, h.readEnv);
  const activity = { reason: null as string | null };
  const ops = {
    composeStop: (services: readonly string[], timeout: number) =>
      h.ops.composeStop(services, timeout),
    composeUp: async (services: readonly string[]) => {
      await h.ops.composeUp(services);
      if (services.includes("postgres")) {
        await database.postgresUp();
      }
    },
    servicesState: () => h.ops.servicesState(),
    migrationCount: () => h.ops.migrationCount(),
  };
  const make = (store: StatusStore) =>
    new DatabaseMover({
      ops,
      database,
      api: h.api,
      envFile: h.envFile,
      store,
      clock: h.clock,
      logger: h.logger,
      redactor: h.redactor,
      otherActivity: () => activity.reason,
      healthTimeoutSeconds: options.healthTimeoutSeconds ?? 60,
    });
  const world: MoverWorld = {
    database,
    store: h.store,
    mover: make(h.store),
    activity,
    restart: async () => {
      world.mover.shutdown();
      // The new process reads the state from disk, as after a real restart.
      world.store = await StatusStore.open(h.stateDir, h.logger, () => h.clock.now());
      world.mover = make(world.store);
      await world.mover.init();
      return world.mover;
    },
  };
  return world;
}

export const MOVE_ACTOR = { userId: "user-1", label: "owner@example.com", ip: "203.0.113.7" };
