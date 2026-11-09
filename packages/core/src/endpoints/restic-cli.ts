/**
 * Running the restic binary on the server (docs/AGENT.md).
 *
 * The server never links restic; it runs the pinned binary as a child process
 * against the maintenance listener (./loopback.ts). Everything the child needs
 * goes through its environment, nothing through its command line, where other
 * processes could read it:
 *
 *   RESTIC_REPOSITORY / RESTIC_PASSWORD             the repository and its password
 *   RESTIC_REST_USERNAME / RESTIC_REST_PASSWORD     the listener's credential
 *   RESTIC_CACHE_DIR                                a cache folder per endpoint
 *
 * The child gets a minimal environment (PATH and TMPDIR), not the server's:
 * database URLs and the master key stay out of it. Output is captured with a
 * cap; the repository password is never in it (restic does not print it), and
 * error text goes through {@link redactSecrets} before it is returned as a message.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { StorageBackend, StorageSpace } from "../storage/backend.js";
import { type LoopbackRepository, serveMaintenanceRepository } from "./loopback.js";

/** The pinned restic version the server and the agents are built against. */
export const RESTIC_VERSION = "0.19.1";

/** Where the binary is: `RESTIC_BINARY`, else `restic` from the PATH. */
export function resticBinary(env: Record<string, string | undefined> = process.env): string {
  return env.RESTIC_BINARY?.trim() || "restic";
}

/** Base folder of the per-endpoint restic caches: `RESTOW_RESTIC_CACHE_DIR`, else the temp folder. */
export function resticCacheBase(env: Record<string, string | undefined> = process.env): string {
  return env.RESTOW_RESTIC_CACHE_DIR?.trim() || join(tmpdir(), "restow-restic-cache");
}

/** Everything one restic invocation needs to reach a repository. */
export interface ResticSession {
  readonly repositoryUrl: string;
  readonly username: string;
  readonly password: string;
  /** The repository's own password (the one sealed in the secret store). */
  readonly repositoryPassword: string;
  readonly cacheDir: string;
  readonly binary?: string;
  /**
   * Uploads the maintenance listener refused so far because the storage is full (loopback.ts):
   * a run that fails after one more is a `storage_full` failure, whatever restic printed.
   */
  readonly storageFullRefusals?: () => number;
  /**
   * A second repository restic reads from (`restic copy`, `init --copy-chunker-params`): its
   * listener and password go to the child as `RESTIC_FROM_REPOSITORY` (the listener's credential
   * in the URL: restic reads no `RESTIC_FROM_REST_*` variables) and `RESTIC_FROM_PASSWORD`,
   * never through the command line.
   */
  readonly from?: Pick<
    ResticSession,
    "repositoryUrl" | "username" | "password" | "repositoryPassword"
  >;
}

export type ResticFailure =
  | "locked"
  | "wrong_password"
  | "no_repository"
  | "incomplete"
  | "interrupted"
  /** Stopped by a signal (killed, aborted, out of memory): its output is incomplete. */
  | "killed"
  /** Stopped by the server because it ran longer than its time limit (`timeoutMs`). */
  | "timeout"
  /**
   * The storage target (or the server's own disk for restic's cache) is full or over its quota:
   * a write failed for lack of space (docs/STORAGE.md, "A full target").
   */
  | "storage_full"
  | "other";

/** A restic run that ended with a non-zero exit code, or that a signal stopped. */
export class ResticError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly failure: ResticFailure,
    /** Redacted stderr (last part), for the operator. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ResticError";
  }
}

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;

/** restic's documented exit codes; no exit code at all means a signal stopped the process. */
function failureOf(exitCode: number | null, stderr: string): ResticFailure {
  if (exitCode === null) return "killed";
  if (exitCode === 3) return "incomplete";
  if (exitCode === 10) return "no_repository";
  if (exitCode === 11) return "locked";
  if (exitCode === 12) return "wrong_password";
  if (exitCode === 130) return "interrupted";
  if (/already locked|unable to create lock/i.test(stderr)) return "locked";
  if (/wrong password|no key found/i.test(stderr)) return "wrong_password";
  if (NO_SPACE_TEXT.test(stderr)) return "storage_full";
  return "other";
}

/** What restic (or the storage behind it) prints when a write failed for lack of space. */
const NO_SPACE_TEXT =
  /no space left on device|disk quota exceeded|quota ?exceeded|insufficient storage|storage (?:is )?full/i;

/** Strip anything credential-shaped from text that may reach a log or a response. */
export function redactSecrets(
  text: string,
  session?: Pick<ResticSession, "password" | "repositoryPassword" | "from">,
): string {
  let result = text;
  for (const secret of [
    session?.password,
    session?.repositoryPassword,
    session?.from?.password,
    session?.from?.repositoryPassword,
  ]) {
    if (secret && secret.length >= 6) {
      result = result.split(secret).join("***");
    }
  }
  return result.replace(/(RESTIC_[A-Z_]*PASSWORD=)\S+/g, "$1***");
}

function childEnvironment(session: ResticSession): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    RESTIC_REPOSITORY: session.repositoryUrl,
    RESTIC_PASSWORD: session.repositoryPassword,
    RESTIC_REST_USERNAME: session.username,
    RESTIC_REST_PASSWORD: session.password,
    RESTIC_CACHE_DIR: session.cacheDir,
    // Deterministic, machine-readable behaviour.
    RESTIC_PROGRESS_FPS: "0.1",
    ...(session.from
      ? {
          RESTIC_FROM_REPOSITORY: withUrlCredentials(
            session.from.repositoryUrl,
            session.from.username,
            session.from.password,
          ),
          RESTIC_FROM_PASSWORD: session.from.repositoryPassword,
        }
      : {}),
  };
}

/** `rest:http://127.0.0.1:<port>/` with the listener's credential in it. */
function withUrlCredentials(repositoryUrl: string, username: string, password: string): string {
  const scheme = "rest:http://";
  if (!repositoryUrl.startsWith(scheme)) {
    return repositoryUrl;
  }
  return `${scheme}${encodeURIComponent(username)}:${encodeURIComponent(password)}@${repositoryUrl.slice(scheme.length)}`;
}

/** How a restic process ended: its exit code, or (with a null exit code) the signal that stopped it. */
export interface ResticExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface SpawnedRestic {
  readonly child: ChildProcess;
  /**
   * Resolves once the child ended and its stderr was read. A null `exitCode`
   * means a signal stopped it: never a success, whatever it wrote before.
   */
  readonly done: Promise<ResticExit>;
}

/** Start restic with `args`; the caller consumes `child.stdout`. */
export function spawnRestic(
  session: ResticSession,
  args: readonly string[],
  options: { signal?: AbortSignal } = {},
): SpawnedRestic {
  const child = spawn(session.binary ?? resticBinary(), [...args], {
    env: childEnvironment(session),
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  const done = new Promise<ResticExit>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (exitCode, signal) =>
      resolve({ exitCode, signal, stderr: redactSecrets(stderr, session) }),
    );
  });
  // A rejected `done` nobody awaits must not crash the process (e.g. an aborted run).
  done.catch(() => undefined);
  return { child, done };
}

/** The error of a restic run that ended badly (for callers that spawn restic themselves). */
export function resticErrorOf(
  args: readonly string[],
  exitCode: number | null,
  stderr: string,
  signal: NodeJS.Signals | null = null,
): ResticError {
  return failure(args, exitCode, stderr, signal);
}

function failure(
  args: readonly string[],
  exitCode: number | null,
  stderr: string,
  signal: NodeJS.Signals | null = null,
  storageFull = false,
): ResticError {
  const kind =
    storageFull && exitCode !== null && exitCode !== 11
      ? "storage_full"
      : failureOf(exitCode, stderr);
  if (exitCode === null) {
    return new ResticError(
      `restic ${args[0] ?? ""} was stopped by ${signal ?? "a signal"} before it finished; its output is incomplete`,
      exitCode,
      kind,
      stderr,
    );
  }
  const lastLine = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "no output";
  return new ResticError(
    `restic ${args[0] ?? ""} failed (exit code ${exitCode}): ${lastLine}`,
    exitCode,
    kind,
    stderr,
  );
}

/** After the time limit restic gets SIGTERM (it releases its lock), then SIGKILL after this. */
export const RESTIC_KILL_GRACE_MS = 15_000;

/** A time limit in words for a message: "90 seconds", "2 minutes", "1 hour". */
function durationText(ms: number): string {
  if (ms < 120_000) {
    return `${Math.round(ms / 1000)} seconds`;
  }
  if (ms < 2 * 60 * 60 * 1000) {
    return `${Math.round(ms / 60_000)} minutes`;
  }
  return `${Math.round(ms / 3_600_000)} hours`;
}

/**
 * Run restic to completion and return its standard output. With `timeoutMs`, a run that takes
 * longer is stopped (SIGTERM, then SIGKILL after {@link RESTIC_KILL_GRACE_MS}) and fails with
 * the failure `timeout`: nothing it would have said is known, so it is no finding either.
 */
export async function runRestic(
  session: ResticSession,
  args: readonly string[],
  options: {
    signal?: AbortSignal;
    acceptExitCodes?: readonly number[];
    timeoutMs?: number;
    /** SIGTERM to SIGKILL after the time limit (tests shorten it). */
    killGraceMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const refusedBefore = session.storageFullRefusals?.() ?? 0;
  const { child, done } = spawnRestic(session, args, { signal: options.signal });
  const chunks: Buffer[] = [];
  let size = 0;
  child.stdout?.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_CAPTURE_BYTES) {
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  });
  const timers: NodeJS.Timeout[] = [];
  const limit = { reached: false };
  if (options.timeoutMs !== undefined) {
    timers.push(
      setTimeout(() => {
        limit.reached = true;
        child.kill("SIGTERM");
        timers.push(
          setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? RESTIC_KILL_GRACE_MS),
        );
      }, options.timeoutMs),
    );
  }
  let ended: ResticExit;
  try {
    ended = await done;
  } finally {
    for (const timer of timers) {
      clearTimeout(timer);
    }
  }
  const { exitCode, signal, stderr } = ended;
  if (limit.reached && exitCode !== 0) {
    throw new ResticError(
      `restic ${args[0] ?? ""} did not finish within ${durationText(options.timeoutMs ?? 0)} and was stopped`,
      exitCode,
      "timeout",
      stderr,
    );
  }
  if (
    exitCode === null ||
    (exitCode !== 0 && !(options.acceptExitCodes ?? []).includes(exitCode))
  ) {
    const refused = (session.storageFullRefusals?.() ?? 0) > refusedBefore;
    throw failure(args, exitCode, stderr, signal, refused);
  }
  return { stdout: Buffer.concat(chunks).toString("utf8"), stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * A restic repository the server opens for its own work: where it lives (a storage prefix such as
 * `endpoints/<endpoint id>/`, `pve-guests/<guest id>/` or `file-shares/<share id>/`), its
 * password, and the key of its local restic cache folder (one per repository).
 */
export interface RepositoryAccess {
  readonly storage: StorageBackend;
  /** The repository's storage prefix, with a trailing slash. */
  readonly prefix: string;
  readonly repositoryPassword: string;
  /** Names the repository's cache folder below `cacheBase` (the endpoint id for a machine). */
  readonly repositoryKey: string;
  readonly binary?: string;
  readonly cacheBase?: string;
  /**
   * Told about every deletion the storage refused because the object is still
   * locked (docs/STORAGE.md, "Immutable backups"), e.g. so retention can count
   * it and the renewal leave it to run out.
   */
  readonly onDeletionDeferred?: (key: string, retainUntil: Date | null) => void | Promise<void>;
}

/** Storage prefix of an endpoint's repository. */
export function endpointPrefix(endpointId: string): string {
  return `endpoints/${endpointId}/`;
}

/** An open maintenance listener and the restic session that reaches it. */
export interface OpenRepository {
  readonly session: ResticSession;
  /** Close the listener; call it when the last restic run on `session` ended. */
  close(): Promise<void>;
}

/**
 * Open the repository for the server's own work. The caller closes it;
 * streaming operations (a download) keep it open until their stream ends.
 */
export async function openRepository(access: RepositoryAccess): Promise<OpenRepository> {
  const listener: LoopbackRepository = await serveMaintenanceRepository(
    access.storage,
    access.prefix,
    access.onDeletionDeferred ? { onDeletionDeferred: access.onDeletionDeferred } : {},
  );
  return {
    session: {
      repositoryUrl: listener.url,
      username: listener.username,
      password: listener.password,
      repositoryPassword: access.repositoryPassword,
      cacheDir: join(access.cacheBase ?? resticCacheBase(), access.repositoryKey),
      binary: access.binary,
      storageFullRefusals: listener.storageFullRefusals,
    },
    close: () => listener.close(),
  };
}

/** Open the repository, run `run` and close the listener whatever its outcome. */
export async function withRepository<T>(
  access: RepositoryAccess,
  run: (session: ResticSession) => Promise<T>,
): Promise<T> {
  const open = await openRepository(access);
  try {
    return await run(open.session);
  } finally {
    await open.close();
  }
}

/**
 * Open two repositories at once (`destination` the one restic writes, `source` the one it reads
 * from: `session.from`), run `run` with the destination's session (and the source's own, for
 * reads of the source alone) and close both listeners whatever its outcome. What
 * `restic copy` between two storage targets needs (docs/STORAGE.md, "restic repositories on
 * copies").
 */
export async function withRepositoryPair<T>(
  source: RepositoryAccess,
  destination: RepositoryAccess,
  run: (session: ResticSession, source: ResticSession) => Promise<T>,
): Promise<T> {
  const from = await openRepository(source);
  try {
    const to = await openRepository(destination);
    try {
      return await run({ ...to.session, from: from.session }, from.session);
    } finally {
      await to.close();
    }
  } finally {
    await from.close();
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** `restic init`: creates the repository with `session.repositoryPassword`. */
export async function resticInit(session: ResticSession): Promise<void> {
  await runRestic(session, ["init"]);
}

/**
 * `restic init --copy-chunker-params`: creates the repository with `session.repositoryPassword`
 * and the chunker parameters of `session.from`, so `restic copy` keeps deduplicating the way the
 * source does (the copy of a repository, docs/STORAGE.md "restic repositories on copies").
 */
export async function resticInitCopy(session: ResticSession): Promise<void> {
  if (!session.from) {
    throw new TypeError("a copy is initialised from a source repository (session.from)");
  }
  await runRestic(session, ["init", "--copy-chunker-params"]);
}

/** Snapshots one `restic copy` call names at most (the command line stays short). */
const COPY_BATCH = 50;

/**
 * `restic copy <ids>`: copy the named snapshots of `session.from` into the session's repository.
 * restic skips a snapshot the destination already holds (by its `original`), and writes each
 * copied snapshot under a new id whose `original` is the source's id. Ids must be restic ids
 * (hex), so nothing can pass for an option.
 */
export async function resticCopy(
  session: ResticSession,
  snapshotIds: readonly string[],
  options: { signal?: AbortSignal; retryLock?: string; timeoutMs?: number } = {},
): Promise<number> {
  if (!session.from) {
    throw new TypeError("restic copy reads from a source repository (session.from)");
  }
  for (const id of snapshotIds) {
    if (!/^[0-9a-f]{8,64}$/.test(id)) {
      throw new TypeError("a snapshot id to copy must be 8 to 64 lower-case hex digits");
    }
  }
  const retry = retryLockArgs(options.retryLock);
  for (let start = 0; start < snapshotIds.length; start += COPY_BATCH) {
    const batch = snapshotIds.slice(start, start + COPY_BATCH);
    await runRestic(session, ["copy", ...retry, "--", ...batch], {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }
  return snapshotIds.length;
}

/**
 * The id under which `snapshots` hold the snapshot `id` names: the snapshot itself, else the one
 * copied from it (`original`). A repository on a copy target holds copies with ids of their own,
 * while the database records the primary's ids; a read that falls back to the copy finds the
 * restore point this way. Null when neither is there.
 */
export function snapshotIdIn(
  snapshots: readonly Pick<ResticSnapshot, "id" | "original">[],
  id: string,
): string | null {
  if (!id) {
    return null;
  }
  const own = snapshots.find((snapshot) => snapshot.id === id || snapshot.id.startsWith(id));
  if (own) {
    return own.id;
  }
  const copied = snapshots.find(
    (snapshot) => typeof snapshot.original === "string" && snapshot.original.startsWith(id),
  );
  return copied?.id ?? null;
}

/**
 * {@link snapshotIdIn} against the repository `session` opens (one `restic snapshots`): `id`
 * itself when the repository holds it, else the id of its copy. Returns `id` unchanged when
 * neither is found, so restic reports the missing snapshot itself.
 */
export async function resticSnapshotRef(
  session: ResticSession,
  id: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const listed = await resticSnapshots(session, { noLock: true, ...options });
  return snapshotIdIn(listed, id) ?? id;
}

export interface ResticSnapshot {
  id: string;
  shortId: string;
  time: string;
  hostname: string;
  paths: string[];
  tags: string[];
  filesNew: number | null;
  totalBytesProcessed: number | null;
  totalFilesProcessed: number | null;
  /** What the backup added to the repository after deduplication (restic 0.17+ summary). */
  dataAdded: number | null;
  /**
   * The id of the snapshot this one was copied from (`restic copy` keeps it as `original`), or
   * null for a snapshot a backup wrote. A copy's snapshots have ids of their own.
   */
  original?: string | null;
}

interface SnapshotJson {
  id?: unknown;
  short_id?: unknown;
  time?: unknown;
  hostname?: unknown;
  paths?: unknown;
  tags?: unknown;
  original?: unknown;
  summary?: {
    files_new?: unknown;
    total_bytes_processed?: unknown;
    total_files_processed?: unknown;
    data_added?: unknown;
  };
}

const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The first JSON array in restic's output (commands print progress text around it). */
export function firstJsonArray(output: string): unknown[] {
  const start = output.indexOf("[");
  if (start === -1) {
    return [];
  }
  // Try the whole tail first; fall back to line-wise parsing.
  for (const line of output.slice(start).split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        // keep looking
      }
    }
  }
  return [];
}

/**
 * `restic snapshots --json`, newest first. `noLock` reads without a lock (a
 * listing changes nothing, so it need not wait for a backup that holds one).
 */
export async function resticSnapshots(
  session: ResticSession,
  options: { noLock?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ResticSnapshot[]> {
  const { stdout } = await runRestic(
    session,
    ["snapshots", "--json", ...(options.noLock ? ["--no-lock"] : [])],
    { signal: options.signal, timeoutMs: options.timeoutMs },
  );
  const rows = firstJsonArray(stdout) as SnapshotJson[];
  return rows
    .filter((row) => typeof row.id === "string")
    .map((row) => ({
      id: row.id as string,
      shortId: typeof row.short_id === "string" ? row.short_id : (row.id as string).slice(0, 8),
      time: typeof row.time === "string" ? row.time : "",
      hostname: typeof row.hostname === "string" ? row.hostname : "",
      paths: Array.isArray(row.paths) ? (row.paths as string[]) : [],
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      filesNew: asNumber(row.summary?.files_new),
      totalBytesProcessed: asNumber(row.summary?.total_bytes_processed),
      totalFilesProcessed: asNumber(row.summary?.total_files_processed),
      dataAdded: asNumber(row.summary?.data_added),
      original: typeof row.original === "string" ? row.original : null,
    }))
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
}

export interface ResticNode {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  path: string;
  size: number | null;
  mtime: string | null;
  mode: number | null;
}

/** One page of a folder: folders first, then everything else, each group by name. */
export interface DirectoryListing {
  entries: ResticNode[];
  /** The folder has more entries after the last one returned. */
  hasMore: boolean;
}

/** Where a listing page continues: strictly after the entry with this kind and name. */
export interface DirectoryPosition {
  /** Folders come first in the listing, so a folder is before any other entry. */
  folder: boolean;
  name: string;
}

const nameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The order of a folder listing: folders first, then by name the way a file
 * manager sorts them (`a` before `B`, `file2` before `file10`). Names within a folder are unique
 * and the raw comparison breaks the ties a collator leaves (letters that differ
 * only in case or accents, `007` and `7`, canonically equal Unicode), so this
 * is a strict total order a cursor can point into.
 */
export function compareDirectoryEntries(
  a: { type: ResticNode["type"]; name: string },
  b: { type: ResticNode["type"]; name: string },
): number {
  const folder = Number(b.type === "dir") - Number(a.type === "dir");
  if (folder !== 0) {
    return folder;
  }
  const byName = nameCollator.compare(a.name, b.name);
  if (byName !== 0) {
    return byName;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function nodeTypeOf(value: unknown): ResticNode["type"] {
  return value === "file"
    ? "file"
    : value === "dir"
      ? "dir"
      : value === "symlink"
        ? "symlink"
        : "other";
}

/** Normalise a path the way restic stores it: absolute, `/`-separated, no trailing slash. */
export function normaliseSnapshotPath(path: string): string {
  const collapsed = `/${path}`.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/** Candidates kept while reading a folder; trimmed back to the page whenever it grows past this. */
const PAGE_BUFFER_FACTOR = 4;

/**
 * One page of the direct children of a directory in a snapshot (`restic ls`):
 * folders first, then by name, `limit` entries from just after `after` (the
 * last entry of the previous page, or the start of the folder).
 *
 * restic lists a folder in its own order and cannot seek, so every page reads
 * the whole folder from the child process' output and keeps only the entries
 * of the page (a few times `limit` at any moment): a folder of a million
 * entries costs one read of the listing per page, never a million entries in
 * memory. Sorting here, not trusting restic's order, is what makes the pages
 * stable: they tile the folder with no gap and no overlap.
 */
export async function resticListDirectory(
  session: ResticSession,
  snapshotId: string,
  directory: string,
  options: { limit?: number; after?: DirectoryPosition | null; signal?: AbortSignal } = {},
): Promise<DirectoryListing> {
  const limit = Math.max(1, options.limit ?? 1000);
  const after = options.after ?? null;
  const dir = normaliseSnapshotPath(directory);
  const args = ["ls", "--json", snapshotId, dir];
  const { child, done } = spawnRestic(session, args, { signal: options.signal });
  if (!child.stdout) {
    throw new Error("restic produced no output stream");
  }
  const marker = after
    ? { type: after.folder ? ("dir" as const) : ("file" as const), name: after.name }
    : null;
  let candidates: ResticNode[] = [];
  const trim = () => {
    candidates.sort(compareDirectoryEntries);
    candidates = candidates.slice(0, limit + 1);
  };
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.startsWith("{")) {
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The first line describes the snapshot; the directory itself is listed too.
    if (row.struct_type === "snapshot" || row.message_type === "snapshot") {
      continue;
    }
    const path = typeof row.path === "string" ? row.path : "";
    if (path === dir || typeof row.name !== "string") {
      continue;
    }
    const node: ResticNode = {
      name: row.name,
      type: nodeTypeOf(row.type),
      path,
      size: asNumber(row.size),
      mtime: typeof row.mtime === "string" ? row.mtime : null,
      mode: asNumber(row.mode),
    };
    if (marker && compareDirectoryEntries(node, marker) <= 0) {
      continue;
    }
    candidates.push(node);
    if (candidates.length > limit * PAGE_BUFFER_FACTOR) {
      trim();
    }
  }
  const { exitCode, signal, stderr } = await done;
  if (exitCode !== 0) {
    throw failure(args, exitCode, stderr, signal);
  }
  trim();
  return { entries: candidates.slice(0, limit), hasMore: candidates.length > limit };
}

/** Paths per `restic ls` call, and their combined length, so the command line stays short. */
const STAT_BATCH_PATHS = 200;
const STAT_BATCH_CHARS = 64_000;

function statBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (current.length >= STAT_BATCH_PATHS || chars + path.length + 1 > STAT_BATCH_CHARS) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 1;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * What the given paths are in a snapshot, keyed by the normalised path; a path
 * the snapshot does not have is left out. One `restic ls` answers up to a few
 * hundred paths (every start of restic costs a key derivation, so one process
 * per path would make a large selection take minutes), and it is stopped as
 * soon as it found them all.
 */
export async function resticStatMany(
  session: ResticSession,
  snapshotId: string,
  paths: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, ResticNode>> {
  const found = new Map<string, ResticNode>();
  const wanted = [...new Set(paths.map(normaliseSnapshotPath))];
  for (const batch of statBatches(wanted)) {
    const targets = new Set(batch);
    const args = ["ls", "--json", snapshotId, ...batch];
    const { child, done } = spawnRestic(session, args, { signal: options.signal });
    if (!child.stdout) {
      throw new Error("restic produced no output stream");
    }
    let open = batch.length;
    let stopped = false;
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (!line.startsWith("{")) {
        continue;
      }
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const path = typeof row.path === "string" ? row.path : "";
        if (targets.has(path) && !found.has(path) && typeof row.name === "string") {
          found.set(path, {
            name: row.name,
            type: nodeTypeOf(row.type),
            path,
            size: asNumber(row.size),
            mtime: typeof row.mtime === "string" ? row.mtime : null,
            mode: asNumber(row.mode),
          });
          open -= 1;
          if (open === 0) {
            stopped = true;
            child.kill("SIGTERM");
            break;
          }
        }
      } catch {
        // not a node line
      }
    }
    const { exitCode, signal, stderr } = await done;
    // Only a run this function stopped itself (it had found every path) may end without an exit code.
    if (!stopped && exitCode !== 0) {
      throw failure(args, exitCode, stderr, signal);
    }
  }
  return found;
}

/** What a path in a snapshot is: the node itself, or null when the snapshot has none there. */
export async function resticStat(
  session: ResticSession,
  snapshotId: string,
  path: string,
): Promise<ResticNode | null> {
  const found = await resticStatMany(session, snapshotId, [path]);
  return found.get(normaliseSnapshotPath(path)) ?? null;
}

/** A stream of a file's bytes (or a directory's tar) plus the run's outcome. */
export interface ResticDump {
  readonly stream: Readable;
  /** Rejects if restic failed; await it after the stream ended. */
  readonly done: Promise<void>;
  cancel(): void;
}

/** How long a cancelled `restic dump` gets to end after SIGTERM before it is killed. */
const DUMP_KILL_AFTER_MS = 5_000;

/** `restic dump`: a file's content, or a directory as a tar archive with `archive: "tar"`. */
export function resticDump(
  session: ResticSession,
  snapshotId: string,
  path: string,
  options: { archive?: "tar" | "zip"; signal?: AbortSignal } = {},
): ResticDump {
  const args = [
    "dump",
    ...(options.archive ? ["--archive", options.archive] : []),
    snapshotId,
    normaliseSnapshotPath(path),
  ];
  const { child, done } = spawnRestic(session, args, { signal: options.signal });
  // A dump stopped by a signal delivered only part of the content: never a success.
  const outcome = done.then(({ exitCode, signal, stderr }) => {
    if (exitCode !== 0) {
      throw failure(args, exitCode, stderr, signal);
    }
  });
  outcome.catch(() => undefined);
  return {
    stream: child.stdout as Readable,
    done: outcome,
    cancel: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      // Nobody reads its output any more: SIGTERM, and SIGKILL when it does not end in time
      // (it may be blocked writing into the pipe). "close" reaps it either way.
      child.stdout?.destroy();
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), DUMP_KILL_AFTER_MS);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
    },
  };
}

/** Snapshot ids per `restic forget` call, so the command line stays short. */
const FORGET_BATCH = 100;

/**
 * `restic forget <id>...`: forget exactly these snapshots, nothing else. The
 * server decides which (./retention-policy.ts); restic's own `--keep-*`
 * rules are never used, because they trust the time the agent wrote into
 * each snapshot. Ids must be full or abbreviated restic ids (hex), so nothing
 * can pass for an option. Returns how many ids were forgotten.
 */
export async function resticForget(
  session: ResticSession,
  snapshotIds: readonly string[],
  options: { signal?: AbortSignal; retryLock?: string; timeoutMs?: number } = {},
): Promise<number> {
  for (const id of snapshotIds) {
    if (!/^[0-9a-f]{8,64}$/.test(id)) {
      throw new TypeError("a snapshot id to forget must be 8 to 64 lower-case hex digits");
    }
  }
  const retry = retryLockArgs(options.retryLock);
  for (let start = 0; start < snapshotIds.length; start += FORGET_BATCH) {
    const batch = snapshotIds.slice(start, start + FORGET_BATCH);
    await runRestic(session, ["forget", ...retry, "--", ...batch], {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }
  return snapshotIds.length;
}

/**
 * restic's flags for a prune that only deletes: packs no snapshot uses at all are removed,
 * partly used ones stay as they are (`--max-unused unlimited` selects none of them, and
 * `--max-repack-size 0` stops restic from repacking anything at all, also the packs it would
 * otherwise rewrite for duplicates or mixed content). Nothing is written but the new index files
 * and the lock, so it frees space on a full target. `--no-cache`: the cache would be written on
 * the server's disk, which may be full as well (or be the same disk as a local target).
 * docs/STORAGE.md, "A full target".
 */
export const DELETE_ONLY_PRUNE_ARGS: readonly string[] = [
  "--max-unused",
  "unlimited",
  "--max-repack-size",
  "0",
  "--no-cache",
];

/** Room a normal prune needs beyond what it repacks: new index files, the lock, a pack in flight. */
export const PRUNE_SCRATCH_BYTES = 64 * 1024 * 1024;

/**
 * Above this much free space (and {@link PRUNE_HEADROOM_CHECK_FRACTION} of the target) the
 * headroom check is left out: a dry run reads the whole index and every snapshot once more.
 */
export const PRUNE_HEADROOM_CHECK_BYTES = 8 * 1024 * 1024 * 1024;
export const PRUNE_HEADROOM_CHECK_FRACTION = 0.2;

/** Unused data a later normal prune would repack: restic's own default (`--max-unused 5%`). */
const REPACK_DUE_PERCENT = 5;

/** How a prune went (see {@link resticPrune}). */
export interface PruneOutcome {
  /** `full`: restic's normal prune; `delete_only`: {@link DELETE_ONLY_PRUNE_ARGS}. */
  readonly mode: "full" | "delete_only";
  /**
   * Why only deleted: the target reported too little free space for what the normal prune would
   * write (`low_space`), or the normal prune failed for lack of space (`storage_full`).
   */
  readonly reason: "low_space" | "storage_full" | null;
  /**
   * Partly used packs hold more unused data than restic tolerates by default: a later prune with
   * headroom should repack them (the caller runs one even when it has nothing to forget).
   */
  readonly repackDeferred: boolean;
  /** Free bytes on the target before the prune, when it reports them. */
  readonly freeBytesBefore: number | null;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** A size as restic prints it (`11.492 MiB`, `0 B`), in bytes; null when it is none. */
function parseResticSize(text: string): number | null {
  const match = /^\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\s*$/.exec(text);
  if (!match) {
    return null;
  }
  return Math.round(Number(match[1]) * (SIZE_UNITS[match[2] as string] ?? 1));
}

/** The figures of restic's prune statistics (the dry run prints them, the real run too). */
export function parsePruneStatistics(output: string): {
  repackBytes: number | null;
  repackRemovesBytes: number | null;
  unusedAfterPercent: number | null;
} {
  const size = (label: string) => {
    const match = new RegExp(`^${label}:\\s*\\d+ blobs / (.+)$`, "m").exec(output);
    return match ? parseResticSize(match[1] as string) : null;
  };
  const unused = /^unused size after prune: .+\(([\d.]+)% of remaining size\)/m.exec(output);
  return {
    repackBytes: size("to repack"),
    repackRemovesBytes: size("this removes"),
    unusedAfterPercent: unused ? Number(unused[1]) : null,
  };
}

/**
 * Whether a target reports that it is (nearly) full: less than twice the scratch room
 * ({@link PRUNE_SCRATCH_BYTES}) or 2 % of its size free. Retention prunes such a target even
 * when it has nothing to forget (an earlier prune may have stopped there). False when the
 * target reports no free space (S3).
 */
export async function storageShortOfSpace(
  storage: Pick<StorageBackend, "freeSpace">,
): Promise<boolean> {
  const space = storage.freeSpace ? await storage.freeSpace().catch(() => null) : null;
  return (
    space !== null &&
    (space.freeBytes < 2 * PRUNE_SCRATCH_BYTES || space.freeBytes < space.totalBytes * 0.02)
  );
}

/** Whether the target is short enough of space that a dry run should tell what prune would write. */
function headroomCheckDue(space: StorageSpace): boolean {
  return (
    space.freeBytes < PRUNE_HEADROOM_CHECK_BYTES ||
    space.freeBytes < space.totalBytes * PRUNE_HEADROOM_CHECK_FRACTION
  );
}

/**
 * `restic prune`: remove the data no snapshot refers to any more (takes the exclusive lock).
 * `retryLock` waits that long for another run's lock (`--retry-lock`) before it gives up.
 *
 * One policy for every repository the server prunes (docs/STORAGE.md, "A full target"):
 * a normal prune repacks partly used packs, writing the new packs before it deletes the old
 * ones, so on a full target it fails and frees nothing. Hence
 *
 *   - with `storage` (a target that reports its free space: a directory, an NFS or SMB share) and little
 *     of it, a dry run (`--no-lock`, it writes nothing) tells what the normal prune would write;
 *     when that does not fit, only the delete-only prune runs ({@link DELETE_ONLY_PRUNE_ARGS});
 *   - a normal prune that fails for lack of space (`storage_full`, also an S3 service at its
 *     quota) is followed by the delete-only prune;
 *   - the repack is left to a later prune with headroom (`repackDeferred`).
 *
 * The delete-only prune is a deletion like any other: it runs under the caller's deletion
 * permit (storage/deletion-guard.ts). When even it fails for lack of space (the lock or the new
 * index does not fit), the `storage_full` ResticError goes to the caller.
 */
export async function resticPrune(
  session: ResticSession,
  options: {
    signal?: AbortSignal;
    retryLock?: string;
    timeoutMs?: number;
    /** The repository's storage: where it reports its free space (`freeSpace`), the headroom check. */
    storage?: Pick<StorageBackend, "freeSpace">;
  } = {},
): Promise<PruneOutcome> {
  const lock = retryLockArgs(options.retryLock);
  const run = { signal: options.signal, timeoutMs: options.timeoutMs };
  const space = options.storage?.freeSpace
    ? await options.storage.freeSpace().catch(() => null)
    : null;
  const freeBytesBefore = space?.freeBytes ?? null;
  let reason: PruneOutcome["reason"] = null;
  if (space && headroomCheckDue(space)) {
    let need: number;
    try {
      const { stdout } = await runRestic(session, ["prune", "--dry-run", "--no-lock"], run);
      const figures = parsePruneStatistics(stdout);
      // What the repack writes is what it keeps of the packs it reads.
      need =
        Math.max(0, (figures.repackBytes ?? 0) - (figures.repackRemovesBytes ?? 0)) +
        PRUNE_SCRATCH_BYTES;
    } catch (error) {
      if (error instanceof ResticError && error.failure === "locked") {
        throw error;
      }
      // Without the figures only the scratch room is known to be needed.
      need = PRUNE_SCRATCH_BYTES;
    }
    if (need > space.freeBytes) {
      reason = "low_space";
    }
  }
  if (reason === null) {
    try {
      await runRestic(session, ["prune", ...lock], run);
      return { mode: "full", reason: null, repackDeferred: false, freeBytesBefore };
    } catch (error) {
      if (!(error instanceof ResticError && error.failure === "storage_full")) {
        throw error;
      }
      reason = "storage_full";
    }
  }
  const { stdout } = await runRestic(session, ["prune", ...lock, ...DELETE_ONLY_PRUNE_ARGS], run);
  const unused = parsePruneStatistics(stdout).unusedAfterPercent;
  return {
    mode: "delete_only",
    reason,
    repackDeferred: unused === null || unused > REPACK_DUE_PERCENT,
    freeBytesBefore,
  };
}

function retryLockArgs(retryLock: string | undefined): string[] {
  if (retryLock === undefined) {
    return [];
  }
  if (!RETRY_LOCK.test(retryLock)) {
    throw new TypeError("retryLock must look like 30s, 5m or 1h");
  }
  return [`--retry-lock=${retryLock}`];
}

/**
 * The time a lock file says it was written (restic's own timestamp, from the clock of whoever
 * wrote it), read without taking a lock. A lock that could not be read (the file is gone, the
 * storage did not answer, restic failed, the content holds no time) is `unreadable` with what
 * went wrong: the caller tells "gone" from "still there" by the storage, never by a guess, and
 * keeps a lock it could not judge (@restow/core `locksToRemove`). A read stopped by `signal` or
 * its time limit (`timeoutMs`) is unreadable as well.
 */
export async function resticLockTime(
  session: ResticSession,
  name: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ time: Date } | { unreadable: string }> {
  if (!/^[0-9a-f]{64}$/.test(name)) {
    throw new TypeError("a lock name must be 64 lower-case hex digits");
  }
  let stdout: string;
  try {
    ({ stdout } = await runRestic(session, ["cat", "lock", "--no-lock", name], {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    }));
  } catch (error) {
    return { unreadable: resticErrorDetail(error, 300) };
  }
  try {
    const parsed = JSON.parse(stdout) as { time?: unknown };
    const time = typeof parsed.time === "string" ? new Date(parsed.time) : null;
    return time && Number.isFinite(time.getTime())
      ? { time }
      : { unreadable: "the lock holds no time" };
  } catch {
    return { unreadable: "the lock is not JSON" };
  }
}

/**
 * `restic check --read-data-subset=<subset>`: a share of the pack files read
 * back and verified. `subset` is `5%` (a random 5 percent) or `3/20` (the third
 * of twenty fixed parts, so a weekly run covers the whole repository over time).
 */
export async function resticCheck(
  session: ResticSession,
  subset: string,
  options: {
    signal?: AbortSignal;
    /**
     * How long restic waits for a lock another run holds (`--retry-lock`, e.g. `5m`) before it
     * gives up with exit code 11; without it, a lock fails the check at once.
     */
    retryLock?: string;
    /**
     * Check without a lock (`--no-lock`): restic neither waits for other locks nor writes or
     * removes one of its own. For a caller that keeps every writer away itself (the PVE check:
     * its own repository lock and no run of the guest going); on write-once storage, where no
     * lock is ever removed, the only way a check can run. Excludes `retryLock`.
     */
    noLock?: boolean;
    /** Stop the check after this long (failure `timeout`, see `runRestic`). */
    timeoutMs?: number;
  } = {},
): Promise<{ output: string }> {
  if (!/^(\d{1,3}%|\d{1,3}\/\d{1,3})$/.test(subset)) {
    throw new TypeError("subset must look like 5% or 3/20");
  }
  if (options.retryLock !== undefined && !RETRY_LOCK.test(options.retryLock)) {
    throw new TypeError("retryLock must look like 30s, 5m or 1h");
  }
  if (options.noLock && options.retryLock !== undefined) {
    throw new TypeError("a check without a lock waits for no lock");
  }
  const args = [
    "check",
    ...(options.noLock ? ["--no-lock"] : []),
    ...(options.retryLock ? [`--retry-lock=${options.retryLock}`] : []),
    `--read-data-subset=${subset}`,
  ];
  const { stdout, stderr } = await runRestic(session, args, {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  return { output: `${stdout}\n${stderr}`.trim().slice(-4000) };
}

/**
 * `restic check` without reading pack data: the structure of the repository (config, keys,
 * index and snapshots readable with the password, every pack the index names present). What a
 * storage change and the repository repair run on a repository they copied together
 * (docs/STORAGE.md, "Repository repair") before anything relies on it.
 */
export async function resticCheckStructure(
  session: ResticSession,
  options: { signal?: AbortSignal } = {},
): Promise<{ output: string }> {
  const { stdout, stderr } = await runRestic(session, ["check", "--no-lock"], {
    signal: options.signal,
  });
  return { output: `${stdout}\n${stderr}`.trim().slice(-4000) };
}

/** A `--retry-lock` duration restic understands: whole seconds, minutes or hours. */
const RETRY_LOCK = /^\d{1,4}[smh]$/;

/** stderr lines that tell who holds a lock (restic's "already locked" report). */
const LOCK_HOLDER_LINE = /locked|lock was created|storage ID|PID \d+|unlock/i;

/**
 * What to keep of a failed restic run for the operator, bounded to `maxLength`: its message
 * and the stderr lines that say why. For a lock, these are restic's report of the holder
 * ("repository is already locked by PID … on host … by …", "lock was created at …",
 * "storage ID …"), which the message (the last line only) loses; otherwise the last few lines.
 */
export function resticErrorDetail(error: unknown, maxLength = 1000): string {
  if (!(error instanceof ResticError)) {
    return (error instanceof Error ? error.message : String(error)).slice(0, maxLength);
  }
  const lines = error.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const holder = lines.filter((line) => LOCK_HOLDER_LINE.test(line));
  const relevant = (error.failure === "locked" && holder.length > 0 ? holder : lines).slice(-6);
  const parts = [error.message];
  for (const line of relevant) {
    if (!parts.some((part) => part.includes(line))) {
      parts.push(line);
    }
  }
  return parts.join("\n").slice(0, maxLength);
}

/** How long `restic unlock` may take unless the caller says otherwise. */
export const RESTIC_UNLOCK_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * `restic unlock`: removes stale locks only (never one a live run still refreshes). Bounded
 * ({@link RESTIC_UNLOCK_TIMEOUT_MS} by default): a storage that keeps failing a deletion with a
 * temporary error would otherwise keep restic trying, a quarter of an hour per lock file.
 */
export async function resticUnlock(
  session: ResticSession,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  await runRestic(session, ["unlock"], {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? RESTIC_UNLOCK_TIMEOUT_MS,
  });
}

/** Bytes the repository takes (`stats --mode raw-data`), and how many snapshots it holds. */
export async function resticStats(
  session: ResticSession,
): Promise<{ repositoryBytes: number; snapshots: number }> {
  const { stdout } = await runRestic(session, ["stats", "--mode", "raw-data", "--json"]);
  const parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as {
    total_size?: unknown;
    snapshots_count?: unknown;
  };
  return {
    repositoryBytes: asNumber(parsed.total_size) ?? 0,
    snapshots: asNumber(parsed.snapshots_count) ?? 0,
  };
}
