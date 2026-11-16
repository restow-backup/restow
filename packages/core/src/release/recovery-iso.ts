/**
 * Which recovery ISO an installation offers, and the copy it keeps (docs/BAREMETAL.md 8.5, 26.13).
 *
 * Two kinds of ISO belong to a Restow release `<v>`:
 *
 * - the ISO of the release itself, `restow-recovery_<v>_amd64.iso`: its line
 *   `<sha256>  recovery/restow-recovery_<v>_amd64.iso` is in the signed `SHA256SUMS` of the agent
 *   release the image ships (`/srv/agent/<v>/SHA256SUMS`, on GitHub `agent-SHA256SUMS`);
 * - rebuilds against a newer Debian snapshot (security updates), tagged `recovery-v<v>.<n>` with
 *   n = 1, 2, …: `restow-recovery_<v>.<n>_amd64.iso`, listed in the release's own
 *   `recovery-SHA256SUMS`, signed with the same release key in the same namespace.
 *
 * A rebuild counts only when its checksums carry a valid signature of the release key, name exactly
 * the ISO of this installation's release with that number, and bind it to that release: a line
 * `<sha256>  release/agent-SHA256SUMS` with the SHA-256 of the release's own signed checksums
 * (the bytes the image ships). A rebuild for another release names another file and another
 * checksum list and is never taken, even when its file name could be read as one of this
 * release's. The newest verified one is offered.
 *
 * The copy lives in the store (default `/data/recovery-iso`, the data volume the api and the worker
 * share): `<store>/<v>/<file>` (written by the worker, recovery-iso-fetch.ts), and in the drop
 * folders for installations without internet (`<store>/import/` and `RESTOW_RECOVERY_ISO_DIR`),
 * where an operator puts the ISO and, for a rebuild, its `recovery-SHA256SUMS` and `.sig`. A copy
 * counts only when its SHA-256 equals the verified line; nothing in the store is trusted because it
 * is there.
 */
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentRoot,
  isAgentVersion,
  listAgentVersions,
  readReleaseFile,
  readReleaseKey,
} from "./agent-files.js";
import { type ReleaseSignatureProblem, verifyReleaseSignature } from "./sshsig.js";

/** The project's public repository and its alpha repository (features/updates/source.ts). */
export const RECOVERY_ISO_GITHUB_BASES = [
  "https://github.com/restow-backup/restow",
  "https://github.com/restow-backup/restow-alpha",
] as const;

/** The checksums of a release on GitHub (the same bytes as the image's `SHA256SUMS`). */
export const RELEASE_SUMS_ASSET = "agent-SHA256SUMS";
/** The checksums of an ISO rebuild on GitHub and in a drop folder. */
export const REBUILD_SUMS_ASSET = "recovery-SHA256SUMS";
/** The line of a rebuild's checksums that binds it to the release (`<sha256>  release/<this>`). */
export const REBUILD_RELEASE_LINE = `release/${RELEASE_SUMS_ASSET}`;
/** The highest rebuild number a release can have. */
export const MAX_RECOVERY_REBUILD = 999;
/** A checksum file or its signature is never larger than this. */
export const MAX_SUMS_BYTES = 64 * 1024;
/** An ISO is never larger than this (the image aims at less than 900 MiB, 8.2). */
export const MAX_RECOVERY_ISO_BYTES = 2 * 1024 * 1024 * 1024;

/** The file name of the ISO of a release, or of one of its rebuilds. */
export function recoveryIsoFileName(version: string, rebuild: number | null = null): string {
  return `restow-recovery_${rebuild === null ? version : `${version}.${rebuild}`}_amd64.iso`;
}

/** The licence notes of the firmware packages, a release attachment next to the ISO. */
export function recoveryFirmwareLicensesName(
  version: string,
  rebuild: number | null = null,
): string {
  return `restow-recovery_${rebuild === null ? version : `${version}.${rebuild}`}_FIRMWARE-LICENSES.txt`;
}

/** The Git tag (and GitHub release) of a release or of a rebuild of its ISO. */
export function recoveryIsoTag(version: string, rebuild: number | null = null): string {
  return rebuild === null ? `v${version}` : `recovery-v${version}.${rebuild}`;
}

/** Whether a number is a rebuild number (1 to MAX_RECOVERY_REBUILD). */
export function isRecoveryRebuild(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_RECOVERY_REBUILD;
}

/** The hash of `recovery/<fileName>` in a checksum list, lower case, or null. */
export function isoChecksum(text: string, fileName: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?recovery\/(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === fileName) {
      return (match[1] as string).toLowerCase();
    }
  }
  return null;
}

/** One ISO with a verified checksum line. */
export interface RecoveryIsoCandidate {
  /** The Restow release the ISO belongs to. */
  version: string;
  /** null: the ISO of the release itself; n: the rebuild `recovery-v<version>.<n>`. */
  rebuild: number | null;
  fileName: string;
  sha256: string;
  /** The GitHub release that carries it. */
  tag: string;
  /** The checksum file of that release (on GitHub). */
  sumsName: string;
}

export type RecoveryIsoProblem =
  /** No agent release with a signature (a development build). */
  | "no_signed_release"
  /** The image has no usable release key. */
  | "no_key"
  /** The signature of the checksums does not verify against the release key. */
  | "signature_invalid"
  /** The checksums list no ISO of this release. */
  | "no_iso_line";

export type BaseIsoResult =
  | {
      ok: true;
      candidate: RecoveryIsoCandidate;
      /** The SHA-256 of the release's signed checksums: a rebuild must name it. */
      releaseSumsSha256: string;
    }
  | { ok: false; problem: RecoveryIsoProblem; version: string | null };

function signatureProblem(problem: ReleaseSignatureProblem): RecoveryIsoProblem {
  return problem === "no_key" ? "no_key" : "signature_invalid";
}

/**
 * The ISO of the newest signed release the image ships: the release's `SHA256SUMS` must carry a
 * signature of the release key, and list the ISO of that very version. An unsigned newer release
 * is skipped; an older one does not stand in for a newer one without an ISO.
 */
export async function verifiedBaseIso(
  root = agentRoot(),
  key: string | null = null,
): Promise<BaseIsoResult> {
  for (const version of await listAgentVersions(root)) {
    if (!isAgentVersion(version)) {
      continue;
    }
    const signature = await readReleaseFile(version, "SHA256SUMS.sig", root);
    if (!signature) {
      continue;
    }
    const sums = await readReleaseFile(version, "SHA256SUMS", root);
    if (!sums) {
      return { ok: false, problem: "no_iso_line", version };
    }
    const verified = verifyReleaseSignature(sums, signature, key ?? (await readReleaseKey()));
    if (!verified.ok) {
      return { ok: false, problem: signatureProblem(verified.problem), version };
    }
    const fileName = recoveryIsoFileName(version);
    const sha256 = isoChecksum(sums.toString("utf8"), fileName);
    if (!sha256) {
      return { ok: false, problem: "no_iso_line", version };
    }
    return {
      ok: true,
      candidate: {
        version,
        rebuild: null,
        fileName,
        sha256,
        tag: recoveryIsoTag(version),
        sumsName: RELEASE_SUMS_ASSET,
      },
      releaseSumsSha256: createHash("sha256").update(sums).digest("hex"),
    };
  }
  return { ok: false, problem: "no_signed_release", version: null };
}

export type RebuildSumsResult =
  | { ok: true; candidate: RecoveryIsoCandidate }
  | { ok: false; problem: "signature_invalid" | "no_key" | "wrong_release" };

/** The SHA-256 a rebuild's checksums name for the release's checksums, or null. */
export function rebuildReleaseChecksum(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === REBUILD_RELEASE_LINE) {
      return (match[1] as string).toLowerCase();
    }
  }
  return null;
}

/** The checksum list of a rebuild as the release workflow writes it (and tests). */
export function rebuildSumsText(
  version: string,
  rebuild: number,
  isoSha256: string,
  releaseSumsSha256: string,
): string {
  return [
    `${isoSha256}  recovery/${recoveryIsoFileName(version, rebuild)}`,
    `${releaseSumsSha256}  ${REBUILD_RELEASE_LINE}`,
    "",
  ].join("\n");
}

/**
 * The checksums of a rebuild: signed with the release key, naming
 * `recovery/restow-recovery_<version>.<rebuild>_amd64.iso`, and naming the SHA-256 of the
 * release's own checksums (`release/agent-SHA256SUMS`). Checksums of a rebuild for another
 * release, or of another rebuild number, name another file or another list: `wrong_release`.
 */
export function verifyRebuildSums(
  sums: Buffer,
  signature: Buffer,
  key: string,
  version: string,
  rebuild: number,
  releaseSumsSha256: string,
): RebuildSumsResult {
  if (!isAgentVersion(version) || !isRecoveryRebuild(rebuild)) {
    return { ok: false, problem: "wrong_release" };
  }
  const verified = verifyReleaseSignature(sums, signature, key);
  if (!verified.ok) {
    return { ok: false, problem: verified.problem === "no_key" ? "no_key" : "signature_invalid" };
  }
  const text = sums.toString("utf8");
  const fileName = recoveryIsoFileName(version, rebuild);
  const sha256 = isoChecksum(text, fileName);
  if (!sha256 || rebuildReleaseChecksum(text) !== releaseSumsSha256.toLowerCase()) {
    return { ok: false, problem: "wrong_release" };
  }
  return {
    ok: true,
    candidate: {
      version,
      rebuild,
      fileName,
      sha256,
      tag: recoveryIsoTag(version, rebuild),
      sumsName: REBUILD_SUMS_ASSET,
    },
  };
}

/** The rebuild number of a file name `restow-recovery_<version>.<n>_amd64.iso`, or null. */
export function rebuildOfFileName(version: string, fileName: string): number | null {
  const prefix = `restow-recovery_${version}.`;
  const suffix = "_amd64.iso";
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) {
    return null;
  }
  const digits = fileName.slice(prefix.length, fileName.length - suffix.length);
  if (!/^[1-9]\d{0,2}$/.test(digits)) {
    return null;
  }
  const rebuild = Number(digits);
  return isRecoveryRebuild(rebuild) ? rebuild : null;
}

// ---------------------------------------------------------------------------
// The store and the drop folders
// ---------------------------------------------------------------------------

/** Where the downloaded ISO is kept: RESTOW_RECOVERY_ISO_STORE_DIR, else /data/recovery-iso. */
export function recoveryIsoStoreDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.RESTOW_RECOVERY_ISO_STORE_DIR?.trim();
  if (configured) {
    return configured;
  }
  try {
    return statSync("/data").isDirectory() ? "/data/recovery-iso" : null;
  } catch {
    return null;
  }
}

/** Whether the worker downloads the ISO (RESTOW_RECOVERY_ISO_FETCH, default on). */
export function recoveryIsoFetchEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env.RESTOW_RECOVERY_ISO_FETCH?.trim().toLowerCase();
  return !(value === "false" || value === "0" || value === "no" || value === "off");
}

/** The drop folders: `<store>/import/` and RESTOW_RECOVERY_ISO_DIR. */
export function recoveryIsoDropDirs(
  storeDir: string | null,
  isoDir: string | null | undefined,
): string[] {
  const dirs: string[] = [];
  if (storeDir) dirs.push(join(storeDir, "import"));
  if (isoDir) dirs.push(isoDir);
  return dirs;
}

/** Where the worker keeps the verified checksums of a rebuild. */
export function storedRebuildDir(storeDir: string, version: string, rebuild: number): string {
  return join(storeDir, version, "rebuilds", String(rebuild));
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function readSmall(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_SUMS_BYTES) {
      return null;
    }
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * The verified rebuilds of `version` the store and the drop folders know, newest first. The
 * store keeps them under `<store>/<v>/rebuilds/<n>/`; a drop folder holds one
 * `recovery-SHA256SUMS` with its `.sig` (the rebuild number comes from the ISO line it names).
 */
export async function verifiedRebuilds(
  version: string,
  releaseSumsSha256: string,
  key: string,
  storeDir: string | null,
  dropDirs: readonly string[],
): Promise<RecoveryIsoCandidate[]> {
  const found = new Map<number, RecoveryIsoCandidate>();
  const consider = async (dir: string, rebuild: number | null) => {
    const sums = await readSmall(join(dir, REBUILD_SUMS_ASSET));
    const signature = sums ? await readSmall(join(dir, `${REBUILD_SUMS_ASSET}.sig`)) : null;
    if (!sums || !signature) {
      return;
    }
    const numbers =
      rebuild !== null
        ? [rebuild]
        : sums
            .toString("utf8")
            .split("\n")
            .map((line) => /\srecovery\/(\S+)\s*$/.exec(line)?.[1] ?? "")
            .map((name) => rebuildOfFileName(version, name))
            .filter((value): value is number => value !== null);
    for (const number of numbers) {
      const result = verifyRebuildSums(sums, signature, key, version, number, releaseSumsSha256);
      if (result.ok) {
        found.set(number, result.candidate);
      }
    }
  };
  if (storeDir) {
    let names: string[] = [];
    try {
      names = await readdir(join(storeDir, version, "rebuilds"));
    } catch {
      // none yet
    }
    for (const name of names) {
      if (/^[1-9]\d{0,2}$/.test(name)) {
        await consider(storedRebuildDir(storeDir, version, Number(name)), Number(name));
      }
    }
  }
  for (const dir of dropDirs) {
    await consider(dir, null);
  }
  return [...found.values()].sort((a, b) => (b.rebuild ?? 0) - (a.rebuild ?? 0));
}

// ---------------------------------------------------------------------------
// Hashing a copy (once per path, size and mtime)
// ---------------------------------------------------------------------------

const hashCache = new Map<string, Promise<string>>();
const HASH_CACHE_MAX = 16;

/** The SHA-256 of a file, read as a stream. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** How often a file was hashed (tests). */
export const recoveryIsoHashStats = { computed: 0 };

/** Forget the cached hashes (tests). */
export function resetRecoveryIsoHashCache(): void {
  hashCache.clear();
  recoveryIsoHashStats.computed = 0;
}

async function cachedHash(path: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${path}\u0000${size}\u0000${mtimeMs}`;
  let pending = hashCache.get(key);
  if (!pending) {
    recoveryIsoHashStats.computed += 1;
    pending = sha256OfFile(path);
    if (hashCache.size >= HASH_CACHE_MAX) {
      const oldest = hashCache.keys().next().value;
      if (oldest !== undefined) hashCache.delete(oldest);
    }
    hashCache.set(key, pending);
    pending.catch(() => hashCache.delete(key));
  }
  return pending;
}

/** A copy of an ISO whose SHA-256 equals the verified line. */
export interface LocalRecoveryIso {
  path: string;
  size: number;
  /** "store": downloaded by the worker; "import": put into a drop folder by an operator. */
  origin: "store" | "import";
}

/** `<dir>/<fileName>` when it is a file with exactly `sha256`, else null. */
export async function matchingFile(
  dir: string,
  fileName: string,
  sha256: string,
): Promise<{ path: string; size: number } | null> {
  if (!SAFE_FILE.test(fileName) || fileName.includes("..")) {
    return null;
  }
  const path = join(dir, fileName);
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return null;
    }
    const actual = await cachedHash(path, info.size, info.mtimeMs);
    return actual === sha256 ? { path, size: info.size } : null;
  } catch {
    return null;
  }
}

/** The copy of a candidate in the store or a drop folder, or null. */
export async function localCopyOf(
  candidate: Pick<RecoveryIsoCandidate, "version" | "fileName" | "sha256">,
  storeDir: string | null,
  dropDirs: readonly string[],
): Promise<LocalRecoveryIso | null> {
  if (storeDir && isAgentVersion(candidate.version)) {
    const stored = await matchingFile(
      join(storeDir, candidate.version),
      candidate.fileName,
      candidate.sha256,
    );
    if (stored) return { ...stored, origin: "store" };
  }
  for (const dir of dropDirs) {
    const dropped = await matchingFile(dir, candidate.fileName, candidate.sha256);
    if (dropped) return { ...dropped, origin: "import" };
  }
  return null;
}

export interface RecoveryIsoSelection {
  base: BaseIsoResult;
  /** The newest verified ISO: the highest rebuild, else the release's own. */
  newest: RecoveryIsoCandidate | null;
  /** What is offered: the newest one with a copy here, else the newest (from GitHub). */
  offered: RecoveryIsoCandidate | null;
  /** The copy of `offered` here, or null. */
  local: LocalRecoveryIso | null;
}

export interface RecoveryIsoSelectionOptions {
  root?: string;
  /** The release key line; read from the image when not given. */
  key?: string;
  storeDir: string | null;
  dropDirs: readonly string[];
}

/** Which ISO this installation offers now, from files alone (the api and the worker agree). */
export async function selectRecoveryIso(
  options: RecoveryIsoSelectionOptions,
): Promise<RecoveryIsoSelection> {
  const key = options.key ?? (await readReleaseKey());
  const base = await verifiedBaseIso(options.root ?? agentRoot(), key);
  if (!base.ok) {
    return { base, newest: null, offered: null, local: null };
  }
  const rebuilds = await verifiedRebuilds(
    base.candidate.version,
    base.releaseSumsSha256,
    key,
    options.storeDir,
    options.dropDirs,
  );
  const candidates = [...rebuilds, base.candidate];
  const newest = candidates[0] ?? null;
  for (const candidate of candidates) {
    const local = await localCopyOf(candidate, options.storeDir, options.dropDirs);
    if (local) {
      return { base, newest, offered: candidate, local };
    }
  }
  return { base, newest, offered: newest, local: null };
}

// ---------------------------------------------------------------------------
// The worker's state (progress and the last problem), for the web app
// ---------------------------------------------------------------------------

export const RECOVERY_ISO_FETCH_STATUSES = [
  /** Nothing fetched yet (or the ISO changed and the new one was not fetched yet). */
  "not_fetched",
  "fetching",
  "verified",
  "failed",
  /** Downloading is off (RESTOW_RECOVERY_ISO_FETCH=false or no store); drop folders only. */
  "disabled",
] as const;
export type RecoveryIsoFetchStatus = (typeof RECOVERY_ISO_FETCH_STATUSES)[number];

export const RECOVERY_ISO_FETCH_PROBLEMS = [
  "no_signed_release",
  "no_key",
  "signature_invalid",
  "no_iso_line",
  "wrong_release",
  "not_published",
  "network",
  "http_status",
  "too_large",
  "truncated",
  "hash_mismatch",
  "store_not_writable",
  "store_full",
] as const;
export type RecoveryIsoFetchProblem = (typeof RECOVERY_ISO_FETCH_PROBLEMS)[number];

export interface RecoveryIsoFetchState {
  status: RecoveryIsoFetchStatus;
  /** The release, and the ISO the worker worked on. */
  version: string | null;
  fileName: string | null;
  rebuild: number | null;
  sha256: string | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  problem: RecoveryIsoFetchProblem | null;
  /** A short technical detail (an HTTP status, an error code); never a URL with a query. */
  detail: string | null;
  /** The repository whose releases carry the ISO, as found by the worker. */
  githubBase: string | null;
  /** The last change of this state, and the last complete pass. */
  updatedAt: string;
  checkedAt: string | null;
}

const STATE_FILE = "state.json";

/** The worker's state, or null when there is none (or it is unreadable). */
export async function readRecoveryIsoFetchState(
  storeDir: string | null,
): Promise<RecoveryIsoFetchState | null> {
  if (!storeDir) return null;
  const raw = await readSmall(join(storeDir, STATE_FILE));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as Partial<RecoveryIsoFetchState>;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !RECOVERY_ISO_FETCH_STATUSES.includes(parsed.status as RecoveryIsoFetchStatus)
    ) {
      return null;
    }
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    const count = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const githubBase = text(parsed.githubBase);
    return {
      status: parsed.status as RecoveryIsoFetchStatus,
      version: text(parsed.version),
      fileName: text(parsed.fileName),
      rebuild:
        typeof parsed.rebuild === "number" && isRecoveryRebuild(parsed.rebuild)
          ? parsed.rebuild
          : null,
      sha256: text(parsed.sha256),
      bytesDone: count(parsed.bytesDone),
      bytesTotal: count(parsed.bytesTotal),
      problem: RECOVERY_ISO_FETCH_PROBLEMS.includes(parsed.problem as RecoveryIsoFetchProblem)
        ? (parsed.problem as RecoveryIsoFetchProblem)
        : null,
      detail: text(parsed.detail)?.slice(0, 200) ?? null,
      // Only one of the two known repositories; the state file names no other host.
      githubBase:
        githubBase && (RECOVERY_ISO_GITHUB_BASES as readonly string[]).includes(githubBase)
          ? githubBase
          : null,
      updatedAt: text(parsed.updatedAt) ?? new Date(0).toISOString(),
      checkedAt: text(parsed.checkedAt),
    };
  } catch {
    return null;
  }
}

/** Write the state atomically (a temporary file, then rename). */
export async function writeRecoveryIsoFetchState(
  storeDir: string,
  state: RecoveryIsoFetchState,
): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  const temporary = join(storeDir, `.${STATE_FILE}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o644 });
  await rename(temporary, join(storeDir, STATE_FILE));
}

/** Remove what the store holds besides `keep` (older ISOs, partial downloads, older releases). */
export async function pruneRecoveryIsoStore(
  storeDir: string,
  keep: Pick<RecoveryIsoCandidate, "version" | "fileName">,
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(storeDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === STATE_FILE || entry === "import" || entry.startsWith(".")) {
      continue;
    }
    if (entry !== keep.version) {
      if (isAgentVersion(entry)) {
        await rm(join(storeDir, entry), { recursive: true, force: true });
      }
      continue;
    }
    let files: string[] = [];
    try {
      files = await readdir(join(storeDir, entry));
    } catch {
      continue;
    }
    for (const file of files) {
      if (
        file === keep.fileName ||
        file === "rebuilds" ||
        file.startsWith(`${keep.fileName}.part`)
      ) {
        continue;
      }
      if (file.startsWith("restow-recovery_")) {
        await rm(join(storeDir, entry, file), { force: true });
      }
    }
  }
}
