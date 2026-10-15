import { z } from "zod";

/**
 * The database location (docs/DATABASE.md): where PostgreSQL keeps its data, how much
 * room it has, and moving it to a directory on another disk. The updater owns all of
 * it: it controls the compose project, so it is the one process that can stop the
 * database, copy its data directory with the owner and permissions intact, and start
 * it again elsewhere. The api forwards the provider owner's request and shows the
 * result (features/updates/database.ts); the web interface shows it under
 * Installation > Database.
 *
 * Like protocol.ts this file imports nothing from the application: the updater holds
 * the Docker socket and no application credential.
 */

/**
 * Where the data directory comes from, as the running postgres container mounts it:
 * a named Docker volume (`source` is its full name, e.g. `restow_pgdata`) or a
 * directory on the host (`source` is the absolute path).
 */
export const DATA_LOCATION_KINDS = ["volume", "bind"] as const;
export type DataLocationKind = (typeof DATA_LOCATION_KINDS)[number];

export const dataLocationSchema = z.object({
  kind: z.enum(DATA_LOCATION_KINDS),
  source: z.string().min(1).max(500),
});
export type DataLocation = z.infer<typeof dataLocationSchema>;

/** The two lines of `.env` the compose files read (docker-compose.yml, `postgres`). */
export const DATA_TYPE_KEY = "RESTOW_POSTGRES_DATA_TYPE";
export const DATA_SOURCE_KEY = "RESTOW_POSTGRES_DATA";

/** Where the postgres service mounts its data directory. */
export const POSTGRES_DATA_TARGET = "/var/lib/postgresql/data";

/**
 * The directory a move creates inside the directory the administrator named: unique
 * per move, so a move can only ever remove a directory it created itself, and a
 * missing disk (the parent not mounted) leaves the path missing instead of empty.
 */
export const MOVED_DATA_PREFIX = "restow-postgres-";
export const MOVED_DATA_NAME = /^restow-postgres-\d{8}-\d{6}$/;

/** The file a move leaves in the old data directory, next to the renamed PG_VERSION. */
export const MOVED_MARKER_FILE = "RESTOW-MOVED.txt";
/** PG_VERSION of the old copy is renamed to this: PostgreSQL refuses to start on it. */
export const QUARANTINED_VERSION_FILE = "PG_VERSION.restow-moved";

/** The steps of a move, in the order they run. */
export const MOVE_STEPS = [
  "stop_application",
  "stop_database",
  "copy",
  "verify",
  "trial",
  "switch",
  "start_database",
  "start_application",
] as const;
export type MoveStepId = (typeof MOVE_STEPS)[number];

/** Share of the whole move each step accounts for, in percent (sums to 100). */
export const MOVE_STEP_WEIGHTS: Readonly<Record<MoveStepId, number>> = {
  stop_application: 5,
  stop_database: 5,
  copy: 40,
  verify: 25,
  trial: 10,
  switch: 5,
  start_database: 5,
  start_application: 5,
};

export const MOVE_STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;

/**
 * running          the move runs; the application is (or is about to be) stopped
 * succeeded        the database runs from the new directory; the old copy is kept
 * rolled_back      a step failed; the database runs from the old location again, unchanged
 * needs_attention  a step failed and so did the way back: the operator decides (docs/DATABASE.md)
 */
export const MOVE_STATUSES = ["running", "succeeded", "rolled_back", "needs_attention"] as const;
export type MoveStatus = (typeof MOVE_STATUSES)[number];

/** Why a move failed (`<step>.<reason>`), translated by the web interface. */
export const MOVE_FAILURE_CODES = [
  "stop_application.failed",
  "stop_database.failed",
  /** PostgreSQL did not shut down cleanly; a copy would need crash recovery. */
  "stop_database.unclean",
  "copy.failed",
  /** The copy differs from the original (files, sizes, permissions or content). */
  "verify.mismatch",
  "verify.failed",
  /** PostgreSQL did not start on the copy, or the copy did not answer the check query. */
  "trial.failed",
  /** The copy started but holds another migration count than the original. */
  "trial.mismatch",
  /** Compose does not resolve the new location from `.env` (an old compose file). */
  "switch.compose_unsupported",
  "switch.failed",
  "start_database.failed",
  /** The database started, but not from the new directory. */
  "start_database.wrong_location",
  "start_application.failed",
  /** The updater stopped while the move ran. */
  "interrupted",
] as const;
export type MoveFailureCode = (typeof MOVE_FAILURE_CODES)[number];

/**
 * Why a move cannot start (the checks before anything is stopped). The web interface
 * shows them next to the path field; nothing has changed when one is reported.
 */
export const MOVE_PROBLEM_CODES = [
  /** Not an absolute path of plain characters, or a system directory. */
  "path_invalid",
  /** The directory does not exist on the host (or is not a directory). */
  "path_missing",
  "not_writable",
  /** The directory is on the file system the database is on now. */
  "same_filesystem",
  /** A network or memory file system (NFS, SMB, tmpfs, ...): unsuitable for PostgreSQL. */
  "filesystem_unsuitable",
  /** Less free space than the data directory plus the margin. */
  "insufficient_space",
  /** The database uses tablespaces outside its data directory. */
  "tablespaces",
  /** The compose file does not read RESTOW_POSTGRES_DATA from `.env`. */
  "compose_unsupported",
  /** The running database's location or size could not be read (is it running?). */
  "location_unknown",
  /** `.env` cannot be written. */
  "env_unwritable",
  /** An update, a restart, another move or a removal runs. */
  "busy",
] as const;
export type MoveProblemCode = (typeof MOVE_PROBLEM_CODES)[number];

const iso = z.string().datetime({ offset: true });

export const moveProblemSchema = z.object({
  code: z.enum(MOVE_PROBLEM_CODES),
  /** Non-sensitive specifics (sizes, a file system name); English, for the log and support. */
  detail: z.string().max(500).nullable().default(null),
});
export type MoveProblem = z.infer<typeof moveProblemSchema>;

/** `POST /v1/database/check` and `POST /v1/database/move`: the directory on the host. */
export const moveRequestSchema = z
  .object({
    targetDir: z.string().min(1).max(200),
    requestedBy: z.object({
      userId: z.string().nullable(),
      label: z.string(),
      ip: z.string().nullable(),
    }),
  })
  .strict();
export type MoveRequest = z.infer<typeof moveRequestSchema>;

/** What the checks found about a directory. */
export const moveCheckSchema = z.object({
  /** Nothing stands in the way. */
  ok: z.boolean(),
  problems: z.array(moveProblemSchema),
  targetDir: z.string(),
  /** File system of the directory (`ext2/ext3`, `xfs`, ...); null when unknown. */
  filesystem: z.string().nullable(),
  freeBytes: z.number().nullable(),
  totalBytes: z.number().nullable(),
  /** The size of the data directory now. */
  dataBytes: z.number().nullable(),
  /** What the directory must have free: the data plus a margin. */
  requiredBytes: z.number().nullable(),
  checkedAt: iso,
});
export type MoveCheck = z.infer<typeof moveCheckSchema>;

export const moveStepSchema = z.object({
  id: z.enum(MOVE_STEPS),
  status: z.enum(MOVE_STEP_STATUSES),
  startedAt: iso.nullable().default(null),
  finishedAt: iso.nullable().default(null),
});
export type MoveStep = z.infer<typeof moveStepSchema>;

export const moveRecordSchema = z.object({
  /** `m-<epoch ms>`. */
  id: z.string(),
  status: z.enum(MOVE_STATUSES),
  requestedBy: z.object({
    userId: z.string().nullable(),
    label: z.string(),
    ip: z.string().nullable(),
  }),
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
  from: dataLocationSchema,
  /** The directory the administrator named. */
  targetDir: z.string(),
  /** The data directory the move creates in it (`<targetDir>/restow-postgres-<time>`). */
  dataDir: z.string(),
  step: z.enum(MOVE_STEPS).nullable().default(null),
  steps: z.array(moveStepSchema),
  progress: z.number().min(0).max(100).default(0),
  /** The size of the data directory when it was copied. */
  dataBytes: z.number().nullable().default(null),
  /** What the verification compared: files and bytes, identical on both sides. */
  verified: z.object({ entries: z.number(), bytes: z.number() }).nullable().default(null),
  failure: z
    .object({
      code: z.enum(MOVE_FAILURE_CODES),
      step: z.enum(MOVE_STEPS).nullable(),
      /** Redacted, single-line excerpt of what failed. */
      detail: z.string().max(2000).default(""),
    })
    .nullable()
    .default(null),
  /**
   * The copy in the new directory that a rollback kept because the database had already
   * run from it (it may hold changes the old location does not); null when there is none.
   */
  keptCopy: z.string().nullable().default(null),
  /** Redacted tail of the move's log (operator-facing, English). */
  log: z.array(z.string()).default([]),
});
export type MoveRecord = z.infer<typeof moveRecordSchema>;

/** A data directory a successful move left behind: kept until an administrator removes it. */
export const oldCopySchema = z.object({
  id: z.string(),
  location: dataLocationSchema,
  /** The move that left it. */
  moveId: z.string(),
  movedAt: iso,
});
export type OldCopy = z.infer<typeof oldCopySchema>;

export const REMOVAL_STATUSES = ["running", "succeeded", "failed"] as const;

export const oldCopyRemovalSchema = z.object({
  copyId: z.string(),
  location: dataLocationSchema,
  status: z.enum(REMOVAL_STATUSES),
  startedAt: iso,
  finishedAt: iso.nullable().default(null),
  detail: z.string().max(1000).default(""),
});
export type OldCopyRemoval = z.infer<typeof oldCopyRemovalSchema>;

/** The size of the data directory and the file system it is on. */
export const dataUsageSchema = z.object({
  dataBytes: z.number(),
  filesystemTotalBytes: z.number(),
  filesystemFreeBytes: z.number(),
  filesystem: z.string().nullable(),
  measuredAt: iso,
});
export type DataUsage = z.infer<typeof dataUsageSchema>;

/**
 * What the next update needs on the disks it writes to (preflight.ts,
 * {@link estimateUpdateSpace}): the dump, the new images, and room for migrations.
 */
export const updateSpaceSchema = z.object({
  /** Expected size of the dump: the last dump plus a quarter, or the tables' size. */
  dumpBytes: z.number(),
  /** Where the dump estimate comes from. */
  dumpBasis: z.enum(["last_dump", "tables", "none"]),
  /** The images that run now (the new ones take about as much). */
  imageBytes: z.number(),
  /** Room the migrations may need in the database (a tenth of it, at least 1 GiB). */
  migrationBytes: z.number(),
  /** RESTOW_UPDATER_MIN_FREE_MB, on top. */
  marginBytes: z.number(),
  /** Free on the disk of the updater's state (dumps; images, when Docker's data is there too). */
  stateFreeBytes: z.number().nullable(),
  /** Needed there. */
  stateRequiredBytes: z.number(),
  /** Free on the disk of the database; null when unknown. */
  databaseFreeBytes: z.number().nullable(),
  /** Needed there (0 when the database shares the disk of the state and is counted above). */
  databaseRequiredBytes: z.number(),
  /** The database and the state are on the same file system. null: unknown. */
  sameFilesystem: z.boolean().nullable(),
  enough: z.boolean(),
});
export type UpdateSpace = z.infer<typeof updateSpaceSchema>;

/** `GET /v1/state` → `database`: what Installation > Database shows. */
export const databaseViewSchema = z.object({
  /** Where the running database keeps its data; null when it could not be read. */
  location: dataLocationSchema.nullable(),
  usage: dataUsageSchema.nullable(),
  /** The compose file reads the location from `.env`: a move is possible. null: unknown. */
  movable: z.boolean().nullable(),
  /** The current or last move; null when there was none. */
  move: moveRecordSchema.nullable(),
  oldCopies: z.array(oldCopySchema).max(20),
  removal: oldCopyRemovalSchema.nullable(),
});
export type DatabaseView = z.infer<typeof databaseViewSchema>;

/** What the public status says about a running move (no paths, nothing sensitive). */
export const publicMoveSchema = z.object({
  id: z.string(),
  status: z.enum(MOVE_STATUSES),
  step: z.enum(MOVE_STEPS).nullable(),
  progress: z.number(),
  finishedAt: iso.nullable(),
});
export type PublicMove = z.infer<typeof publicMoveSchema>;

/** Percent done, from the steps' states (a running step counts as half done). */
export function moveProgressOf(steps: readonly Pick<MoveStep, "id" | "status">[]): number {
  let done = 0;
  for (const step of steps) {
    const weight = MOVE_STEP_WEIGHTS[step.id];
    if (step.status === "done" || step.status === "skipped") {
      done += weight;
    } else if (step.status === "running") {
      done += weight / 2;
    }
  }
  return Math.min(100, Math.round(done));
}

export function pendingMoveSteps(): MoveStep[] {
  return MOVE_STEPS.map((id) => ({
    id,
    status: "pending" as const,
    startedAt: null,
    finishedAt: null,
  }));
}

/** The location `.env` names (the compose files' defaults when both lines are empty). */
export function locationFromEnv(type: string | null, source: string | null): DataLocation | null {
  const kind = type === null || type === "" ? "volume" : type;
  if (kind !== "volume" && kind !== "bind") {
    return null;
  }
  return { kind, source: source === null || source === "" ? "pgdata" : source };
}

export function sameLocation(a: DataLocation | null, b: DataLocation | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.source === b.source;
}

/** Forbidden places for a data directory: the system's own, Docker's, and temporary ones. */
const FORBIDDEN_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/tmp",
  "/usr",
  "/var/run",
  "/var/tmp",
  "/var/lib/docker",
  "/var/lib/containerd",
];

const PLAIN_PATH = /^\/[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/;

/**
 * The directory the administrator named, normalised (no trailing slash), or the reason it
 * is refused. Only plain characters: the path ends up in `.env`, in a Compose bind
 * specification and in `docker run --mount`, none of which may see a comma, a colon, a
 * quote, a dollar sign or a space.
 */
export function validateTargetDir(raw: string): { dir: string } | { problem: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.length > 200 || !PLAIN_PATH.test(trimmed)) {
    return {
      problem:
        "Give an absolute path of letters, digits and . _ - + @ only (for example /mnt/volume-1/restow-db).",
    };
  }
  const segments = trimmed.split("/").slice(1);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { problem: "The path must not contain . or .. segments." };
  }
  for (const root of FORBIDDEN_ROOTS) {
    if (trimmed === root || trimmed.startsWith(`${root}/`)) {
      return { problem: `${root} is a system directory; choose the mount point of a data disk.` };
    }
  }
  return { dir: trimmed };
}

/** `restow-postgres-<yyyymmdd-hhmmss>` (UTC) for a move that starts at `at`. */
export function movedDataName(at: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${MOVED_DATA_PREFIX}${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
}
