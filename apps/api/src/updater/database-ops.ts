import {
  type DataLocation,
  MOVED_DATA_NAME,
  MOVED_MARKER_FILE,
  POSTGRES_DATA_TARGET,
  QUARANTINED_VERSION_FILE,
} from "./database-protocol.js";
import type { PostgresSettings } from "./env-file.js";
import { type CommandResult, type CommandRunner, OpsError } from "./ops.js";
import type { Redactor } from "./redact.js";

/**
 * The Docker operations behind the database location (database.ts). Like ops-cli.ts
 * every command is an argument vector; the shell scripts the helper containers run
 * are constants, and every value from outside (a path, a volume name, a file name)
 * arrives as a positional parameter after the script, after it passed a strict
 * pattern here.
 *
 * The helper containers run the image of the postgres service itself (by image id,
 * never pulled): it has the tools of the database it holds (`pg_controldata`,
 * `postgres`, `psql`) and the same user ids. They carry {@link DATABASE_HELPER_LABEL},
 * run without a network and are removed when they end; one a crashed updater left
 * behind is removed by {@link DatabaseOps.removeHelpers}.
 */

/** Label of every container the database operations start. */
export const DATABASE_HELPER_LABEL = "com.restow.updater.database";
/** Name of the container that starts PostgreSQL on a copy before the switch. */
export const TRIAL_CONTAINER = "restow-database-check";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TIMEOUTS = {
  quick: 30_000,
  inspect: 2 * MINUTE,
  usage: 15 * MINUTE,
  copy: 24 * HOUR,
  compare: 24 * HOUR,
  remove: 6 * HOUR,
  trialStop: 3 * MINUTE,
} as const;

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const HOST_PATH = /^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/;
const IMAGE_ID = /^(?:sha256:)?[0-9a-f]{12,64}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/** The running (or stopped) postgres container of the project. */
export interface PostgresContainer {
  id: string;
  /** The image id the container runs; helper containers run exactly this image. */
  imageId: string;
  state: string;
  health: string | null;
  /** Where its data directory comes from; null when nothing is mounted there. */
  location: DataLocation | null;
}

/** The file system under the running database's data directory. */
export interface DataFilesystem {
  /** Device number (`stat %d`), to compare with the updater's state directory. */
  device: number | null;
  totalBytes: number;
  freeBytes: number;
  filesystem: string | null;
}

/** What a look at the target directory found (nothing is changed but a test file). */
export interface TargetProbe {
  /** False: the directory does not exist (or is not a directory). */
  exists: boolean;
  writable: boolean;
  /** The directory and the current data are on the same file system. */
  sameFilesystem: boolean;
  /** `stat -f %t`: the file system's magic number in hex (`ef53`, `58465342`). */
  filesystemMagic: string | null;
  filesystem: string | null;
  freeBytes: number;
  totalBytes: number;
  /** Entries in `pg_tblspc` of the current data (tablespaces elsewhere). */
  tablespaces: number;
  /** Owner of the current data directory, which the copy keeps. */
  owner: { uid: number; gid: number };
  /** The data directory name the move would create exists already. */
  nameTaken: boolean;
}

export interface TreeManifest {
  entries: number;
  bytes: number;
  /** Digest over every entry's type, size, mode, owner and name. */
  meta: string;
  /** Digest over every file's content, by name. */
  content: string;
}

export interface DatabaseOps {
  /** The postgres container of the project; null when there is none. */
  postgresContainer(): Promise<PostgresContainer | null>;
  /** The file system under the running database's data directory (cheap: `stat` and `df`). */
  dataFilesystem(): Promise<DataFilesystem>;
  /** Size of the running database's data directory (`du`: reads every directory). */
  dataBytes(): Promise<number>;
  /** pg_database_size and the size of the tables (without indexes) of the application database. */
  databaseSizes(): Promise<{ databaseBytes: number; tableBytes: number }>;
  /** Size of a local image in bytes; null when it is not there. */
  imageBytes(image: string): Promise<number | null>;
  /** Where Compose puts the postgres data, with `env` set in the process environment. */
  configDataLocation(env: Readonly<Record<string, string>>): Promise<DataLocation | null>;
  probeTarget(
    image: string,
    from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<TargetProbe>;
  /** `Database cluster state` of `pg_controldata` for a stopped data directory. */
  clusterState(image: string, location: DataLocation): Promise<string>;
  /** Create `<targetDir>/<name>` and copy the data into it, owner and permissions included. */
  copy(image: string, from: DataLocation, targetDir: string, name: string): Promise<void>;
  /** Manifests of the original and the copy, made side by side. */
  compare(
    image: string,
    from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<{ source: TreeManifest; copy: TreeManifest }>;
  /**
   * Start PostgreSQL on `dataDir` in an isolated container (no network, the data's
   * owner), read the number of applied migrations and stop it cleanly again.
   */
  trial(
    image: string,
    dataDir: string,
    owner: { uid: number; gid: number },
    timeoutMs: number,
  ): Promise<number>;
  /** Mark the old copy and rename its PG_VERSION, so PostgreSQL never starts on it again. */
  quarantine(image: string, location: DataLocation, note: string): Promise<void>;
  /** Undo {@link quarantine} (idempotent). */
  unquarantine(image: string, location: DataLocation): Promise<void>;
  /** Empty a quarantined old copy, keeping only its marker file. */
  removeOldData(image: string, location: DataLocation, note: string): Promise<void>;
  /** Remove `<targetDir>/<name>`, a copy this updater made. */
  removeCopy(image: string, targetDir: string, name: string): Promise<void>;
  /** Remove containers of these operations a previous run left (the trial, a copy). */
  removeHelpers(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Scripts (constants; values arrive as positional parameters)
// ---------------------------------------------------------------------------

const SCRIPT_FILESYSTEM = `set -eu
d=${POSTGRES_DATA_TARGET}
echo "device=$(stat -c %d "$d")"
echo "fs=$(stat -f -c %T "$d" 2>/dev/null || echo unknown)"
set -- $(df -Pk "$d" | tail -n 1)
echo "total_kb=$2"
echo "avail_kb=$4"`;

const SCRIPT_DATA_SIZE = `du -sk ${POSTGRES_DATA_TARGET} | cut -f1`;

const SCRIPT_PROBE = `set -eu
name="$1"
if [ ! -d /target ]; then echo "exists=0"; exit 0; fi
echo "exists=1"
if [ "$(stat -c %d /from)" = "$(stat -c %d /target)" ]; then echo "same_fs=1"; else echo "same_fs=0"; fi
echo "fs_magic=$(stat -f -c %t /target)"
echo "fs_name=$(stat -f -c %T /target)"
echo "owner=$(stat -c %u:%g /from)"
n=0
if [ -d /from/pg_tblspc ]; then n=$(ls -A /from/pg_tblspc | wc -l); fi
echo "tablespaces=$n"
if [ -e "/target/$name" ]; then echo "name_taken=1"; else echo "name_taken=0"; fi
probe="/target/.restow-write-test-$$"
if ( umask 077; : > "$probe" ) 2>/dev/null && rm -f "$probe"; then echo "writable=1"; else echo "writable=0"; fi
set -- $(df -Pk /target | tail -n 1)
echo "total_kb=$2"
echo "avail_kb=$4"`;

const SCRIPT_COPY = `set -eu
dst="/target/$1"
mkdir "$dst"
cp -a /from/. "$dst/"
chown "$(stat -c %u:%g /from)" "$dst"
chmod "$(stat -c %a /from)" "$dst"
sync`;

const SCRIPT_COMPARE = `set -eu
manifest() {
  set -o pipefail
  cd "$1"
  meta=$( { find . -xdev -type f -exec stat -c 'f %s %a %u %g %n' {} + ; find . -xdev ! -type f -exec stat -c '%F %a %u %g %n' {} + ; } | LC_ALL=C sort | sha256sum | cut -d' ' -f1)
  content=$(find . -xdev -type f -exec sha256sum {} + | LC_ALL=C sort -k2 | sha256sum | cut -d' ' -f1)
  entries=$(find . -xdev | wc -l)
  bytes=$(find . -xdev -type f -exec stat -c %s {} + | awk '{ s += $1 } END { printf "%.0f", s }')
  echo "$2 entries=$entries bytes=$bytes meta=$meta content=$content"
}
manifest /a source > /tmp/source.txt &
a=$!
manifest "/b/$1" copy > /tmp/copy.txt &
b=$!
wait "$a"
wait "$b"
cat /tmp/source.txt /tmp/copy.txt`;

const SCRIPT_QUARANTINE = `set -eu
cd /old
if [ -f ${QUARANTINED_VERSION_FILE} ] && [ ! -e PG_VERSION ]; then
  echo "already"
else
  [ -f PG_VERSION ] || { echo "The old data directory has no PG_VERSION." >&2; exit 3; }
  [ ! -e ${QUARANTINED_VERSION_FILE} ] || { echo "The old data directory has PG_VERSION and ${QUARANTINED_VERSION_FILE}." >&2; exit 4; }
  printf '%s\\n' "$1" > ${MOVED_MARKER_FILE}
  mv PG_VERSION ${QUARANTINED_VERSION_FILE}
fi
sync`;

const SCRIPT_UNQUARANTINE = `set -eu
cd /old
if [ -f ${QUARANTINED_VERSION_FILE} ] && [ ! -e PG_VERSION ]; then
  mv ${QUARANTINED_VERSION_FILE} PG_VERSION
fi
[ -f PG_VERSION ] || { echo "The old data directory has no PG_VERSION." >&2; exit 3; }
rm -f ${MOVED_MARKER_FILE}
sync`;

const SCRIPT_REMOVE_OLD = `set -eu
cd /old
[ -f ${MOVED_MARKER_FILE} ] || { echo "The directory has no ${MOVED_MARKER_FILE}: it is not a moved copy." >&2; exit 3; }
[ ! -e PG_VERSION ] || { echo "The directory has a PG_VERSION: it is not a moved copy." >&2; exit 4; }
find . -mindepth 1 -maxdepth 1 ! -name ${MOVED_MARKER_FILE} -exec rm -rf {} +
printf '%s\\n' "$1" >> ${MOVED_MARKER_FILE}
sync`;

const SCRIPT_REMOVE_COPY = `set -eu
case "$1" in restow-postgres-*) ;; *) exit 3 ;; esac
rm -rf "/target/$1"
sync`;

// ---------------------------------------------------------------------------
// The CLI implementation
// ---------------------------------------------------------------------------

export interface CliDatabaseOpsOptions {
  runner: CommandRunner;
  redactor: Redactor;
  projectName: string;
  composeFile: string | null;
  /** POSTGRES_USER and POSTGRES_DB from `.env`. */
  postgres: () => Promise<PostgresSettings>;
  clock?: { sleep(ms: number): Promise<void>; now(): Date };
}

export class CliDatabaseOps implements DatabaseOps {
  constructor(private readonly options: CliDatabaseOpsOptions) {}

  async postgresContainer(): Promise<PostgresContainer | null> {
    const ids = await this.compose(["ps", "-a", "-q", "postgres"], { timeoutMs: TIMEOUTS.quick });
    this.expectSuccess(ids, "Listing the postgres container");
    const id = ids.stdout.split("\n")[0]?.trim() ?? "";
    if (!CONTAINER_ID.test(id)) {
      return null;
    }
    const inspect = await this.docker(["inspect", "--format", "{{json .}}", id], {
      timeoutMs: TIMEOUTS.quick,
      maxOutputBytes: 1024 * 1024,
    });
    this.expectSuccess(inspect, "Inspecting the postgres container");
    return parsePostgresInspect(inspect.stdout);
  }

  async dataFilesystem(): Promise<DataFilesystem> {
    const result = await this.compose(["exec", "-T", "postgres", "sh", "-c", SCRIPT_FILESYSTEM], {
      timeoutMs: TIMEOUTS.quick,
    });
    this.expectSuccess(result, "Reading the database's file system");
    const values = keyValues(result.stdout);
    const device = Number(values.device);
    return {
      device: Number.isInteger(device) ? device : null,
      totalBytes: kib(values.total_kb),
      freeBytes: kib(values.avail_kb),
      filesystem: values.fs && values.fs !== "unknown" ? values.fs : null,
    };
  }

  async dataBytes(): Promise<number> {
    const result = await this.compose(["exec", "-T", "postgres", "sh", "-c", SCRIPT_DATA_SIZE], {
      timeoutMs: TIMEOUTS.usage,
    });
    this.expectSuccess(result, "Measuring the database directory");
    const text = result.stdout.trim();
    if (!/^\d+$/.test(text)) {
      throw new OpsError("Measuring the database directory failed.", "Unexpected answer.");
    }
    return kib(text);
  }

  async databaseSizes(): Promise<{ databaseBytes: number; tableBytes: number }> {
    const { user, db } = await this.options.postgres();
    const result = await this.compose(
      [
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        user,
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-F",
        " ",
        "-c",
        "SELECT pg_database_size(current_database()), coalesce(sum(pg_table_size(c.oid)), 0) FROM pg_class c WHERE c.relkind IN ('r', 'm')",
      ],
      { timeoutMs: TIMEOUTS.inspect },
    );
    this.expectSuccess(result, "Reading the database size");
    const match = /^(\d+) (\d+)$/.exec(result.stdout.trim());
    if (!match) {
      throw new OpsError("Reading the database size failed.", "Unexpected answer.");
    }
    return { databaseBytes: Number(match[1]), tableBytes: Number(match[2]) };
  }

  async imageBytes(image: string): Promise<number | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,299}$/.test(image)) {
      return null;
    }
    const result = await this.docker(["image", "inspect", "--format", "{{.Size}}", image], {
      timeoutMs: TIMEOUTS.quick,
    });
    const text = result.stdout.trim();
    return result.exitCode === 0 && /^\d+$/.test(text) ? Number(text) : null;
  }

  async configDataLocation(env: Readonly<Record<string, string>>): Promise<DataLocation | null> {
    const result = await this.compose(["config", "--format", "json"], {
      timeoutMs: TIMEOUTS.quick * 2,
      env,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    this.expectSuccess(result, "Reading the compose configuration");
    let parsed: {
      services?: Record<string, { volumes?: unknown } | undefined>;
      volumes?: Record<string, { name?: unknown } | undefined>;
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Never quote the output: it holds the resolved environment.
      throw new OpsError(
        "Reading the compose configuration failed.",
        "The output was not valid JSON.",
      );
    }
    return dataLocationOfService(
      parsed.services?.postgres?.volumes,
      parsed.volumes ?? {},
      this.options.projectName,
    );
  }

  async probeTarget(
    image: string,
    from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<TargetProbe> {
    assertName(name);
    const result = await this.helper(
      image,
      [this.mount(from, "/from", true), bindMount(targetDir, "/target", false)],
      SCRIPT_PROBE,
      [name],
      TIMEOUTS.inspect,
      this.volumeCheck(from),
    );
    if (result.exitCode !== 0) {
      if (/bind source path does not exist|not a directory/i.test(result.errorTail)) {
        return emptyProbe();
      }
      throw this.failure(result, "Checking the directory");
    }
    const values = keyValues(result.stdout);
    if (values.exists !== "1") {
      return emptyProbe();
    }
    const [uid, gid] = (values.owner ?? "").split(":").map(Number);
    return {
      exists: true,
      writable: values.writable === "1",
      sameFilesystem: values.same_fs === "1",
      filesystemMagic: values.fs_magic ?? null,
      filesystem: values.fs_name ?? null,
      freeBytes: kib(values.avail_kb),
      totalBytes: kib(values.total_kb),
      tablespaces: Number(values.tablespaces ?? "0") || 0,
      owner: {
        uid: Number.isInteger(uid) ? (uid as number) : -1,
        gid: Number.isInteger(gid) ? (gid as number) : -1,
      },
      nameTaken: values.name_taken === "1",
    };
  }

  async clusterState(image: string, location: DataLocation): Promise<string> {
    const result = await this.helper(
      image,
      [this.mount(location, "/data", true)],
      'LC_ALL=C pg_controldata /data | sed -n "s/^Database cluster state: *//p"',
      [],
      TIMEOUTS.inspect,
      this.volumeCheck(location),
    );
    this.expectSuccess(result, "Reading the cluster state");
    return result.stdout.trim();
  }

  async copy(image: string, from: DataLocation, targetDir: string, name: string): Promise<void> {
    assertName(name);
    const result = await this.helper(
      image,
      [this.mount(from, "/from", true), bindMount(targetDir, "/target", false)],
      SCRIPT_COPY,
      [name],
      TIMEOUTS.copy,
      this.volumeCheck(from),
    );
    this.expectSuccess(result, "Copying the data directory");
  }

  async compare(
    image: string,
    from: DataLocation,
    targetDir: string,
    name: string,
  ): Promise<{ source: TreeManifest; copy: TreeManifest }> {
    assertName(name);
    const result = await this.helper(
      image,
      [this.mount(from, "/a", true), bindMount(targetDir, "/b", true)],
      SCRIPT_COMPARE,
      [name],
      TIMEOUTS.compare,
      this.volumeCheck(from),
    );
    this.expectSuccess(result, "Comparing the copy");
    const lines = result.stdout.split("\n").map((line) => line.trim());
    const source = parseManifest(lines.find((line) => line.startsWith("source ")));
    const copy = parseManifest(lines.find((line) => line.startsWith("copy ")));
    if (!source || !copy) {
      throw new OpsError("Comparing the copy failed.", "The manifests could not be read.");
    }
    return { source, copy };
  }

  async trial(
    image: string,
    dataDir: string,
    owner: { uid: number; gid: number },
    timeoutMs: number,
  ): Promise<number> {
    assertImage(image);
    assertHostPath(dataDir);
    if (
      !Number.isInteger(owner.uid) ||
      owner.uid < 0 ||
      !Number.isInteger(owner.gid) ||
      owner.gid < 0
    ) {
      throw new OpsError("The owner of the data directory is not known.");
    }
    const { user, db } = await this.options.postgres();
    await this.docker(["rm", "-f", TRIAL_CONTAINER], { timeoutMs: TIMEOUTS.quick });
    const started = await this.docker(
      [
        "run",
        "-d",
        "--name",
        TRIAL_CONTAINER,
        "--label",
        `${DATABASE_HELPER_LABEL}=1`,
        "--network",
        "none",
        "--pull",
        "never",
        "--security-opt",
        "no-new-privileges:true",
        "--user",
        `${owner.uid}:${owner.gid}`,
        "--mount",
        `type=bind,source=${dataDir},target=${POSTGRES_DATA_TARGET}`,
        "--env",
        "LC_ALL=C",
        "--entrypoint",
        "postgres",
        image,
        "-D",
        POSTGRES_DATA_TARGET,
        "-c",
        "listen_addresses=",
      ],
      { timeoutMs: TIMEOUTS.inspect },
    );
    this.expectSuccess(started, "Starting PostgreSQL on the copy");
    try {
      const clock = this.options.clock ?? {
        now: () => new Date(),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      };
      const deadline = clock.now().getTime() + timeoutMs;
      for (;;) {
        const ready = await this.docker(
          ["exec", TRIAL_CONTAINER, "pg_isready", "-q", "-h", "/var/run/postgresql"],
          { timeoutMs: TIMEOUTS.quick },
        );
        if (ready.exitCode === 0) {
          break;
        }
        const running = await this.docker(
          ["inspect", "--format", "{{.State.Running}}", TRIAL_CONTAINER],
          { timeoutMs: TIMEOUTS.quick },
        );
        if (running.stdout.trim() !== "true") {
          throw new OpsError("PostgreSQL stopped on the copy.", await this.trialLog());
        }
        if (clock.now().getTime() >= deadline) {
          throw new OpsError("PostgreSQL did not become ready on the copy.", await this.trialLog());
        }
        await clock.sleep(2000);
      }
      const query = await this.docker(
        [
          "exec",
          TRIAL_CONTAINER,
          "psql",
          "-h",
          "/var/run/postgresql",
          "-U",
          user,
          "-d",
          db,
          "-v",
          "ON_ERROR_STOP=1",
          "-Atc",
          "SELECT count(*) FROM drizzle.__drizzle_migrations",
        ],
        { timeoutMs: TIMEOUTS.inspect },
      );
      this.expectSuccess(query, "Querying the copy");
      const text = query.stdout.trim();
      if (!/^\d+$/.test(text)) {
        throw new OpsError("Querying the copy failed.", "Unexpected answer.");
      }
      const stopped = await this.docker(["stop", "-t", "120", TRIAL_CONTAINER], {
        timeoutMs: TIMEOUTS.trialStop,
      });
      this.expectSuccess(stopped, "Stopping PostgreSQL on the copy");
      const exit = await this.docker(
        ["inspect", "--format", "{{.State.ExitCode}}", TRIAL_CONTAINER],
        { timeoutMs: TIMEOUTS.quick },
      );
      if (exit.stdout.trim() !== "0") {
        throw new OpsError(
          `PostgreSQL on the copy stopped with exit code ${exit.stdout.trim() || "unknown"}.`,
          await this.trialLog(),
        );
      }
      return Number(text);
    } finally {
      await this.docker(["rm", "-f", TRIAL_CONTAINER], { timeoutMs: TIMEOUTS.quick }).catch(
        () => undefined,
      );
    }
  }

  async quarantine(image: string, location: DataLocation, note: string): Promise<void> {
    const result = await this.helper(
      image,
      [this.mount(location, "/old", false)],
      SCRIPT_QUARANTINE,
      [oneLine(note)],
      TIMEOUTS.inspect,
      this.volumeCheck(location),
    );
    this.expectSuccess(result, "Marking the old data directory");
  }

  async unquarantine(image: string, location: DataLocation): Promise<void> {
    const result = await this.helper(
      image,
      [this.mount(location, "/old", false)],
      SCRIPT_UNQUARANTINE,
      [],
      TIMEOUTS.inspect,
      this.volumeCheck(location),
    );
    this.expectSuccess(result, "Restoring the old data directory");
  }

  async removeOldData(image: string, location: DataLocation, note: string): Promise<void> {
    const result = await this.helper(
      image,
      [this.mount(location, "/old", false)],
      SCRIPT_REMOVE_OLD,
      [oneLine(note)],
      TIMEOUTS.remove,
      this.volumeCheck(location),
    );
    this.expectSuccess(result, "Removing the old data directory");
  }

  async removeCopy(image: string, targetDir: string, name: string): Promise<void> {
    assertName(name);
    const result = await this.helper(
      image,
      [bindMount(targetDir, "/target", false)],
      SCRIPT_REMOVE_COPY,
      [name],
      TIMEOUTS.remove,
      null,
    );
    if (result.exitCode !== 0 && /bind source path does not exist/i.test(result.errorTail)) {
      return;
    }
    this.expectSuccess(result, "Removing the incomplete copy");
  }

  async removeHelpers(): Promise<number> {
    const list = await this.docker(
      ["ps", "-a", "-q", "--filter", `label=${DATABASE_HELPER_LABEL}=1`],
      { timeoutMs: TIMEOUTS.quick },
    );
    if (list.exitCode !== 0) {
      return 0;
    }
    let removed = 0;
    for (const id of list.stdout.split("\n").map((line) => line.trim())) {
      if (CONTAINER_ID.test(id)) {
        const result = await this.docker(["rm", "-f", id], { timeoutMs: TIMEOUTS.quick });
        if (result.exitCode === 0) {
          removed += 1;
        }
      }
    }
    return removed;
  }

  // -- Plumbing -------------------------------------------------------------

  private async trialLog(): Promise<string> {
    const logs = await this.docker(["logs", "--tail", "20", TRIAL_CONTAINER], {
      timeoutMs: TIMEOUTS.quick,
      maxOutputBytes: 64 * 1024,
    }).catch(() => null);
    if (!logs) {
      return "";
    }
    return this.options.redactor.tail(`${logs.stdout}\n${logs.errorTail}`, 800);
  }

  /** A named volume must exist before it is mounted: `docker run` would create an empty one. */
  private volumeCheck(location: DataLocation): string | null {
    return location.kind === "volume" ? location.source : null;
  }

  private mount(location: DataLocation, target: string, readonly: boolean): string {
    if (location.kind === "volume") {
      if (!VOLUME_NAME.test(location.source)) {
        throw new OpsError("The volume name is not valid.");
      }
      return `type=volume,source=${location.source},target=${target}${readonly ? ",readonly" : ""}`;
    }
    return bindMount(location.source, target, readonly);
  }

  private async helper(
    image: string,
    mounts: readonly string[],
    script: string,
    args: readonly string[],
    timeoutMs: number,
    volume: string | null,
  ): Promise<CommandResult> {
    assertImage(image);
    if (volume !== null) {
      const exists = await this.docker(["volume", "inspect", "--format", "{{.Name}}", volume], {
        timeoutMs: TIMEOUTS.quick,
      });
      if (exists.exitCode !== 0 || exists.stdout.trim() !== volume) {
        throw new OpsError(`The volume ${volume} does not exist.`);
      }
    }
    return await this.docker(
      [
        "run",
        "--rm",
        "--label",
        `${DATABASE_HELPER_LABEL}=1`,
        "--network",
        "none",
        "--pull",
        "never",
        "--security-opt",
        "no-new-privileges:true",
        ...mounts.flatMap((mount) => ["--mount", mount]),
        "--entrypoint",
        "sh",
        image,
        "-c",
        script,
        "sh",
        ...args,
      ],
      { timeoutMs, maxOutputBytes: 1024 * 1024 },
    );
  }

  private baseCompose(): string[] {
    const args = ["compose", "-p", this.options.projectName];
    if (this.options.composeFile) {
      args.push("-f", this.options.composeFile);
    }
    return args;
  }

  private compose(
    args: readonly string[],
    options: {
      timeoutMs: number;
      env?: Readonly<Record<string, string>>;
      maxOutputBytes?: number;
    },
  ): Promise<CommandResult> {
    return this.options.runner.run({
      argv: ["docker", ...this.baseCompose(), ...args],
      ...options,
    });
  }

  private docker(
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes?: number },
  ): Promise<CommandResult> {
    return this.options.runner.run({ argv: ["docker", ...args], ...options });
  }

  private failure(result: CommandResult, action: string): OpsError {
    return new OpsError(
      result.timedOut ? `${action} timed out.` : `${action} failed (exit code ${result.exitCode}).`,
      result.errorTail,
    );
  }

  private expectSuccess(result: CommandResult, action: string): void {
    if (result.exitCode !== 0) {
      throw this.failure(result, action);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing (exported for the tests)
// ---------------------------------------------------------------------------

function bindMount(hostPath: string, target: string, readonly: boolean): string {
  assertHostPath(hostPath);
  return `type=bind,source=${hostPath},target=${target}${readonly ? ",readonly" : ""}`;
}

function assertHostPath(hostPath: string): void {
  if (!HOST_PATH.test(hostPath) || hostPath.split("/").some((part) => part === "..")) {
    throw new OpsError("The path is not a plain absolute path.");
  }
}

function assertImage(image: string): void {
  if (!IMAGE_ID.test(image)) {
    throw new OpsError("The image id is not valid.");
  }
}

function assertName(name: string): void {
  if (!MOVED_DATA_NAME.test(name)) {
    throw new OpsError("The directory name is not one the updater creates.");
  }
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\0]+/g, " ").slice(0, 500);
}

function kib(value: string | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1024) : 0;
}

function emptyProbe(): TargetProbe {
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

/** `key=value` lines into a record (later keys win). */
export function keyValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) {
      values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return values;
}

export function parseManifest(line: string | undefined): TreeManifest | null {
  if (!line) {
    return null;
  }
  const values = keyValues(line.split(" ").slice(1).join("\n"));
  const entries = Number(values.entries);
  const bytes = Number(values.bytes);
  if (
    !Number.isInteger(entries) ||
    !Number.isFinite(bytes) ||
    !/^[0-9a-f]{64}$/.test(values.meta ?? "") ||
    !/^[0-9a-f]{64}$/.test(values.content ?? "")
  ) {
    return null;
  }
  return { entries, bytes, meta: values.meta as string, content: values.content as string };
}

/** The data mount of the postgres service in `docker compose config --format json`. */
export function dataLocationOfService(
  volumes: unknown,
  declared: Readonly<Record<string, { name?: unknown } | undefined>>,
  projectName: string,
): DataLocation | null {
  if (!Array.isArray(volumes)) {
    return null;
  }
  for (const entry of volumes) {
    const volume = entry as { type?: unknown; source?: unknown; target?: unknown };
    if (volume.target !== POSTGRES_DATA_TARGET || typeof volume.source !== "string") {
      continue;
    }
    if (volume.type === "bind") {
      return { kind: "bind", source: volume.source };
    }
    if (volume.type === "volume") {
      // The service names the key of a top-level volume; its name is <project>_<key> unless
      // the file gives one.
      const name = declared[volume.source]?.name;
      return {
        kind: "volume",
        source: typeof name === "string" && name ? name : `${projectName}_${volume.source}`,
      };
    }
  }
  return null;
}

/** The postgres container from `docker inspect --format '{{json .}}'`. */
export function parsePostgresInspect(text: string): PostgresContainer | null {
  let parsed: {
    Id?: unknown;
    Image?: unknown;
    State?: { Status?: unknown; Health?: { Status?: unknown } };
    Mounts?: { Type?: unknown; Name?: unknown; Source?: unknown; Destination?: unknown }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed.Id !== "string" || typeof parsed.Image !== "string") {
    return null;
  }
  let location: DataLocation | null = null;
  for (const mount of parsed.Mounts ?? []) {
    if (mount.Destination !== POSTGRES_DATA_TARGET) {
      continue;
    }
    if (mount.Type === "volume" && typeof mount.Name === "string") {
      location = { kind: "volume", source: mount.Name };
    } else if (mount.Type === "bind" && typeof mount.Source === "string") {
      location = { kind: "bind", source: mount.Source };
    }
  }
  const health = parsed.State?.Health?.Status;
  return {
    id: parsed.Id,
    imageId: parsed.Image,
    state: typeof parsed.State?.Status === "string" ? parsed.State.Status : "unknown",
    health: typeof health === "string" ? health : null,
    location,
  };
}
