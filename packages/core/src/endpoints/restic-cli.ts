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
import type { StorageBackend } from "../storage/backend.js";
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
}

export type ResticFailure =
  | "locked"
  | "wrong_password"
  | "no_repository"
  | "incomplete"
  | "interrupted"
  /** Stopped by a signal (killed, aborted, out of memory): its output is incomplete. */
  | "killed"
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
  return "other";
}

/** Strip anything credential-shaped from text that may reach a log or a response. */
export function redactSecrets(
  text: string,
  session?: Pick<ResticSession, "password" | "repositoryPassword">,
): string {
  let result = text;
  for (const secret of [session?.password, session?.repositoryPassword]) {
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
  };
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
): ResticError {
  const kind = failureOf(exitCode, stderr);
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

/** Run restic to completion and return its standard output. */
export async function runRestic(
  session: ResticSession,
  args: readonly string[],
  options: { signal?: AbortSignal; acceptExitCodes?: readonly number[] } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
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
  const { exitCode, signal, stderr } = await done;
  if (
    exitCode === null ||
    (exitCode !== 0 && !(options.acceptExitCodes ?? []).includes(exitCode))
  ) {
    throw failure(args, exitCode, stderr, signal);
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
  );
  return {
    session: {
      repositoryUrl: listener.url,
      username: listener.username,
      password: listener.password,
      repositoryPassword: access.repositoryPassword,
      cacheDir: join(access.cacheBase ?? resticCacheBase(), access.repositoryKey),
      binary: access.binary,
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

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** `restic init`: creates the repository with `session.repositoryPassword`. */
export async function resticInit(session: ResticSession): Promise<void> {
  await runRestic(session, ["init"]);
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
}

interface SnapshotJson {
  id?: unknown;
  short_id?: unknown;
  time?: unknown;
  hostname?: unknown;
  paths?: unknown;
  tags?: unknown;
  summary?: {
    files_new?: unknown;
    total_bytes_processed?: unknown;
    total_files_processed?: unknown;
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
  options: { noLock?: boolean } = {},
): Promise<ResticSnapshot[]> {
  const { stdout } = await runRestic(session, [
    "snapshots",
    "--json",
    ...(options.noLock ? ["--no-lock"] : []),
  ]);
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
      child.kill("SIGTERM");
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
  options: { signal?: AbortSignal } = {},
): Promise<number> {
  for (const id of snapshotIds) {
    if (!/^[0-9a-f]{8,64}$/.test(id)) {
      throw new TypeError("a snapshot id to forget must be 8 to 64 lower-case hex digits");
    }
  }
  for (let start = 0; start < snapshotIds.length; start += FORGET_BATCH) {
    const batch = snapshotIds.slice(start, start + FORGET_BATCH);
    await runRestic(session, ["forget", "--", ...batch], { signal: options.signal });
  }
  return snapshotIds.length;
}

/** `restic prune`: remove the data no snapshot refers to any more (takes the exclusive lock). */
export async function resticPrune(
  session: ResticSession,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await runRestic(session, ["prune"], { signal: options.signal });
}

/**
 * `restic check --read-data-subset=<subset>`: a share of the pack files read
 * back and verified. `subset` is `5%` (a random 5 percent) or `3/20` (the third
 * of twenty fixed parts, so a weekly run covers the whole repository over time).
 */
export async function resticCheck(
  session: ResticSession,
  subset: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ output: string }> {
  if (!/^(\d{1,3}%|\d{1,3}\/\d{1,3})$/.test(subset)) {
    throw new TypeError("subset must look like 5% or 3/20");
  }
  const { stdout, stderr } = await runRestic(session, ["check", `--read-data-subset=${subset}`], {
    signal: options.signal,
  });
  return { output: `${stdout}\n${stderr}`.trim().slice(-4000) };
}

/** `restic unlock`: removes stale locks only (never one a live run still refreshes). */
export async function resticUnlock(session: ResticSession): Promise<void> {
  await runRestic(session, ["unlock"]);
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
