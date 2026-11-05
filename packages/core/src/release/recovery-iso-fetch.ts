/**
 * The worker's download of the recovery ISO (docs/BAREMETAL.md 26.13): once per installation and
 * release, not per person. It reads the release's GitHub attachments, never anything the database
 * or a person named:
 *
 *   1. the ISO line of the image's signed `SHA256SUMS` (the signature checked with the release key
 *      the image ships, recovery-iso.ts), the repository that carries the release (the project's,
 *      else the alpha one: the first that has `agent-SHA256SUMS` under the tag `v<v>`);
 *   2. the rebuilds `recovery-v<v>.<n>` for n = 1, 2, … until the first that does not exist; each
 *      `recovery-SHA256SUMS` must carry the release key's signature, name
 *      `restow-recovery_<v>.<n>_amd64.iso` and the SHA-256 of this release's own checksums
 *      (`release/agent-SHA256SUMS`), then it is kept in the store;
 *   3. the newest verified ISO, unless the store or a drop folder has it already: into
 *      `<file>.part` (continued with a Range request after an interruption, at most
 *      MAX_RECOVERY_ISO_BYTES), then its SHA-256 against the verified line, and only then renamed
 *      to `<file>`. Older copies and partial files are removed. The download needs the rest of the
 *      file plus MIN_FREE_BYTES free in the store (checked before and while it runs); short of
 *      that, or on ENOSPC, the partial file is removed and the pass ends with `store_full`.
 *
 * A pass holds `<store>/.fetch.lock` (created exclusively, refreshed while it works, checked
 * before every write; a stale lock is taken over atomically, lockStore), so two passes never
 * write the same partial file, and ends itself before the queue's expiry
 * (RECOVERY_ISO_PASS_TIME_LIMIT_MS) with a resumable `truncated`. Progress and the last problem go
 * to `<store>/state.json` for the web app. Redirects (GitHub
 * hands the bytes out from another host) are followed over https only. Outbound connections honour
 * the usual proxy variables (`HTTPS_PROXY`, `NO_PROXY`; the installation has no proxy setting of
 * its own): a proxy gets a CONNECT tunnel; without one, the lookup refuses private addresses.
 */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { ENDPOINT_QUEUE_SETTINGS, ENDPOINT_QUEUES } from "../endpoints/queues.js";
import { guardedLookup, refuseHostBeforeConnect } from "../net/address-policy.js";
import { agentRoot, readReleaseKey } from "./agent-files.js";
import {
  MAX_RECOVERY_ISO_BYTES,
  MAX_RECOVERY_REBUILD,
  MAX_SUMS_BYTES,
  pruneRecoveryIsoStore,
  REBUILD_SUMS_ASSET,
  RECOVERY_ISO_GITHUB_BASES,
  RELEASE_SUMS_ASSET,
  type RecoveryIsoCandidate,
  type RecoveryIsoFetchProblem,
  type RecoveryIsoFetchState,
  readRecoveryIsoFetchState,
  recoveryIsoTag,
  selectRecoveryIso,
  sha256OfFile,
  storedRebuildDir,
  verifiedBaseIso,
  verifiedRebuilds,
  verifyRebuildSums,
  writeRecoveryIsoFetchState,
} from "./recovery-iso.js";

// ---------------------------------------------------------------------------
// Outbound HTTP: proxy variables, redirects, guarded lookups
// ---------------------------------------------------------------------------

export interface ProxySettings {
  /** For https URLs (HTTPS_PROXY / https_proxy). */
  https: URL | null;
  /** For http URLs (HTTP_PROXY / http_proxy); only tests fetch plain http. */
  http: URL | null;
  /** NO_PROXY / no_proxy: host names, `.suffix` or `suffix` (and its subdomains), `*`. */
  noProxy: string[];
}

function proxyUrl(value: string | undefined): URL | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** The proxy variables of the environment (an http proxy; an https:// proxy URL is ignored). */
export function proxySettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): ProxySettings {
  return {
    https: proxyUrl(env.HTTPS_PROXY ?? env.https_proxy),
    http: proxyUrl(env.HTTP_PROXY ?? env.http_proxy),
    noProxy: (env.NO_PROXY ?? env.no_proxy ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
  };
}

/** The proxy for a URL, or null for a direct connection. */
export function proxyFor(url: URL, settings: ProxySettings): URL | null {
  const proxy = url.protocol === "https:" ? settings.https : settings.http;
  if (!proxy) return null;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  for (const entry of settings.noProxy) {
    if (entry === "*") return null;
    const suffix = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === suffix || host.endsWith(`.${suffix}`)) return null;
  }
  return proxy;
}

export interface RecoveryIsoHttpOptions {
  /** Tests only: let the lookup hand out loopback and private addresses. */
  allowPrivateNetworks?: boolean;
  /** Tests only: plain http to a fake release server. Never set from configuration. */
  allowInsecureHttp?: boolean;
  /** The proxy variables; default: the environment. */
  proxy?: ProxySettings;
  /** Idle time of a connection before it is given up (default 60 s). */
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/** A request that ended without an answer worth reading (network, proxy, refused address). */
export class RecoveryIsoNetworkError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "RecoveryIsoNetworkError";
  }
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

function tunnel(proxy: URL, host: string, port: number, options: RecoveryIsoHttpOptions) {
  return new Promise<Socket>((resolve, reject) => {
    const headers: Record<string, string> = { host: `${host}:${port}` };
    if (proxy.username) {
      const user = decodeURIComponent(proxy.username);
      const password = decodeURIComponent(proxy.password);
      headers["proxy-authorization"] =
        `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    }
    const request = http.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      agent: false,
      signal: options.signal,
      timeout: options.idleTimeoutMs ?? 60_000,
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new RecoveryIsoNetworkError("the proxy refused the tunnel", "PROXY_REFUSED"));
      }
    });
    request.once("timeout", () =>
      request.destroy(new RecoveryIsoNetworkError("timeout", "ETIMEDOUT")),
    );
    request.once("error", (error) =>
      reject(
        error instanceof RecoveryIsoNetworkError
          ? error
          : new RecoveryIsoNetworkError("the proxy cannot be reached", errorCode(error)),
      ),
    );
    request.end();
  });
}

/** One GET, no redirect followed. */
async function getOnce(
  target: URL,
  headers: Record<string, string>,
  options: RecoveryIsoHttpOptions,
): Promise<IncomingMessage> {
  const secure = target.protocol === "https:";
  if (!secure && !(target.protocol === "http:" && options.allowInsecureHttp === true)) {
    throw new RecoveryIsoNetworkError("only https is fetched", "NOT_HTTPS");
  }
  const allowPrivate = options.allowPrivateNetworks === true;
  const refused = refuseHostBeforeConnect(target.hostname, allowPrivate);
  if (refused) {
    throw new RecoveryIsoNetworkError("the address is not allowed", "BLOCKED_ADDRESS");
  }
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (secure ? 443 : 80));
  const proxy = proxyFor(target, options.proxy ?? proxySettingsFromEnv());
  const requestOptions: https.RequestOptions = {
    method: "GET",
    headers: { "user-agent": "restow-recovery-iso", ...headers },
    signal: options.signal,
    timeout: options.idleTimeoutMs ?? 60_000,
  };
  if (proxy) {
    const socket = await tunnel(proxy, host, port, options);
    requestOptions.createConnection = () =>
      secure ? tls.connect({ socket, servername: host }) : socket;
  } else {
    requestOptions.lookup = guardedLookup(allowPrivate);
    // A fresh connection each time: a pooled socket would skip the guarded lookup.
    requestOptions.agent = false;
  }
  return new Promise<IncomingMessage>((resolve, reject) => {
    const request = (secure ? https : http).request(target, requestOptions, resolve);
    request.once("timeout", () =>
      request.destroy(new RecoveryIsoNetworkError("timeout", "ETIMEDOUT")),
    );
    request.once("error", (error) =>
      reject(
        error instanceof RecoveryIsoNetworkError
          ? error
          : new RecoveryIsoNetworkError("the request failed", errorCode(error)),
      ),
    );
    request.end();
  });
}

const MAX_REDIRECTS = 5;

/** GET with redirects followed (https only, at most five); the final answer is the caller's. */
export async function recoveryIsoGet(
  url: string,
  headers: Record<string, string>,
  options: RecoveryIsoHttpOptions = {},
): Promise<IncomingMessage> {
  let target = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await getOnce(target, headers, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.resume();
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        throw new RecoveryIsoNetworkError("a redirect named no valid address", "BAD_REDIRECT");
      }
      if (next.protocol !== "https:" && !(options.allowInsecureHttp && next.protocol === "http:")) {
        throw new RecoveryIsoNetworkError("a redirect left https", "BAD_REDIRECT");
      }
      target = next;
      continue;
    }
    return response;
  }
  throw new RecoveryIsoNetworkError("too many redirects", "TOO_MANY_REDIRECTS");
}

/** A small file (checksums, signature): its bytes, null for 404, or a problem. */
async function getSmall(
  url: string,
  options: RecoveryIsoHttpOptions,
): Promise<
  | { ok: true; body: Buffer }
  | { ok: false; problem: "absent" | "http_status" | "too_large"; detail: string | null }
> {
  const response = await recoveryIsoGet(url, {}, options);
  const status = response.statusCode ?? 0;
  if (status === 404) {
    response.resume();
    return { ok: false, problem: "absent", detail: null };
  }
  if (status !== 200) {
    response.resume();
    return { ok: false, problem: "http_status", detail: `HTTP ${status}` };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    total += (chunk as Buffer).length;
    if (total > MAX_SUMS_BYTES) {
      response.destroy();
      return { ok: false, problem: "too_large", detail: null };
    }
    chunks.push(chunk as Buffer);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

function assetUrl(base: string, tag: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

// ---------------------------------------------------------------------------
// The download of one ISO into the store
// ---------------------------------------------------------------------------

type DownloadResult =
  | { ok: true }
  | {
      ok: false;
      problem: RecoveryIsoFetchProblem;
      detail: string | null;
      /** Worth another attempt soon (pg-boss retry): the network, a cut-off transfer. */
      transient: boolean;
    };

interface PartMeta {
  sha256: string;
}

/**
 * What must stay free in the store after the rest of the ISO is written: the store sits in the
 * data volume next to the backups, and a background download must never be what fills it.
 */
export const RECOVERY_ISO_MIN_FREE_BYTES = 1024 ** 3;

/**
 * A pass ends itself this long before the queue's expiry: pg-boss fails an expired job and
 * schedules the retry while the handler keeps running, so a pass without its own deadline would
 * still be writing when the retry starts.
 */
export const RECOVERY_ISO_PASS_TIME_LIMIT_MS =
  ENDPOINT_QUEUE_SETTINGS[ENDPOINT_QUEUES.recoveryIso].expireInHours * 3_600_000 - 30 * 60_000;

/** Free bytes for an unprivileged writer in the file system of `dir`, null when unknown. */
async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return null;
  }
}

const SPACE_ERRORS = new Set(["ENOSPC", "EDQUOT"]);

interface DownloadContext {
  maxBytes: number;
  minFreeBytes: number;
  freeBytes: (dir: string) => Promise<number | null>;
  /** Fires at the pass's deadline. */
  deadline: AbortSignal;
  progress: (done: number, total: number | null) => Promise<void>;
  /**
   * Throws RecoveryIsoLockLostError when the store's lock is no longer this pass's: before
   * every write and removal (`soon`: at most every LOCK_CHECK_INTERVAL_MS, for the chunks).
   */
  owner: (soon?: boolean) => Promise<void>;
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/** `bytes <start>-<end>/<total>` → start and total (total null for `*`). */
function contentRange(value: string | undefined): { start: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  return { start: Number(match[1]), total: match[3] === "*" ? null : Number(match[3]) };
}

async function downloadIso(
  url: string,
  candidate: RecoveryIsoCandidate,
  dir: string,
  options: RecoveryIsoHttpOptions,
  context: DownloadContext,
): Promise<DownloadResult> {
  const { maxBytes, progress, owner } = context;
  const finalPath = join(dir, candidate.fileName);
  const partPath = `${finalPath}.part`;
  const metaPath = `${partPath}.json`;
  /** No room: the partial file goes (it would hold space in the backups' volume) and so does the pass. */
  const storeFull = async (detail: string | null): Promise<DownloadResult> => {
    await owner();
    await rm(partPath, { force: true });
    await rm(metaPath, { force: true });
    return { ok: false, problem: "store_full", detail, transient: false };
  };
  // A partial file of another ISO (or another hash) starts over.
  let meta: PartMeta | null = null;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as PartMeta;
  } catch {
    meta = null;
  }
  let have = (await sizeOf(partPath)) ?? 0;
  await owner();
  if (meta?.sha256 !== candidate.sha256 || have > maxBytes) {
    await rm(partPath, { force: true });
    have = 0;
  }
  try {
    await writeFile(metaPath, JSON.stringify({ sha256: candidate.sha256 } satisfies PartMeta));
  } catch (error) {
    const code = errorCode(error);
    if (code && SPACE_ERRORS.has(code)) return storeFull(code);
    return { ok: false, problem: "store_not_writable", detail: code, transient: false };
  }

  const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
  let response: IncomingMessage;
  try {
    response = await recoveryIsoGet(url, headers, options);
  } catch (error) {
    return { ok: false, problem: "network", detail: errorCode(error), transient: true };
  }
  const status = response.statusCode ?? 0;
  let total: number | null = null;
  if (status === 416 && have > 0) {
    // The part is complete already (or longer than the file): its hash decides below.
    response.resume();
    total = have;
  } else if (status === 206 && have > 0) {
    const range = contentRange(response.headers["content-range"]);
    if (!range || range.start !== have) {
      response.resume();
      await owner();
      await rm(partPath, { force: true });
      return { ok: false, problem: "truncated", detail: "range", transient: true };
    }
    total = range.total;
  } else if (status === 200) {
    have = 0;
    const length = Number(response.headers["content-length"]);
    total = Number.isFinite(length) && length >= 0 ? length : null;
  } else {
    response.resume();
    if (status === 404) {
      return { ok: false, problem: "not_published", detail: "HTTP 404", transient: false };
    }
    return {
      ok: false,
      problem: "http_status",
      detail: `HTTP ${status}`,
      transient: status >= 500 || status === 429,
    };
  }
  if (total !== null && total > maxBytes) {
    response.resume();
    await owner();
    await rm(partPath, { force: true });
    return { ok: false, problem: "too_large", detail: String(total), transient: false };
  }
  if (status !== 416) {
    // Room for the rest of the file and the reserve, before anything is written.
    const remaining = total === null ? 0 : Math.max(0, total - have);
    const free = await context.freeBytes(dir);
    if (free !== null && free - remaining < context.minFreeBytes) {
      response.destroy();
      return storeFull(`free ${free}, needed ${remaining + context.minFreeBytes}`);
    }
    // Written chunk by chunk to an open file: what arrived before a cut-off stays on disk.
    let file: Awaited<ReturnType<typeof open>>;
    try {
      await owner();
      file = await open(partPath, have === 0 ? "w" : "a");
    } catch (error) {
      response.destroy();
      if (error instanceof RecoveryIsoLockLostError) throw error;
      const code = errorCode(error);
      if (code && SPACE_ERRORS.has(code)) return storeFull(code);
      return { ok: false, problem: "store_not_writable", detail: code, transient: false };
    }
    let done = have;
    let lastReport = 0;
    try {
      for await (const chunk of response) {
        const bytes = chunk as Buffer;
        if (done + bytes.length > maxBytes) {
          response.destroy();
          await file.close();
          await owner();
          await rm(partPath, { force: true });
          await rm(metaPath, { force: true });
          return { ok: false, problem: "too_large", detail: null, transient: false };
        }
        await owner(true);
        await file.write(bytes);
        done += bytes.length;
        const now = Date.now();
        if (now - lastReport >= 2000) {
          lastReport = now;
          // Backups write to the same volume while this runs: the reserve must hold throughout.
          const left = await context.freeBytes(dir);
          if (left !== null && left < context.minFreeBytes) {
            response.destroy();
            await file.close();
            return storeFull(`free ${left}`);
          }
          await progress(done, total).catch(() => undefined);
        }
      }
    } catch (error) {
      await file.close().catch(() => undefined);
      if (error instanceof RecoveryIsoLockLostError) {
        response.destroy();
        throw error;
      }
      const code = errorCode(error);
      if (code && SPACE_ERRORS.has(code)) return storeFull(code);
      // Cut off, or the pass's deadline: the part stays and the next attempt continues it.
      return {
        ok: false,
        problem: "truncated",
        detail: context.deadline.aborted ? "deadline" : code,
        transient: true,
      };
    }
    await file.close();
    if (total !== null && done < total) {
      return { ok: false, problem: "truncated", detail: `${done}/${total}`, transient: true };
    }
    await progress(done, total);
  }
  const actual = await sha256OfFile(partPath);
  await owner();
  if (actual !== candidate.sha256) {
    await rm(partPath, { force: true });
    await rm(metaPath, { force: true });
    return { ok: false, problem: "hash_mismatch", detail: null, transient: false };
  }
  await rename(partPath, finalPath);
  await rm(metaPath, { force: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// One pass of the worker
// ---------------------------------------------------------------------------

export interface RecoveryIsoFetchOptions {
  /** The agent folder of the image (default: agentRoot()). */
  root?: string;
  /** The release key line (default: the image's release-signing.pub). */
  key?: string;
  /** The store; null: nothing is downloaded or written. */
  storeDir: string | null;
  /** The drop folders (`<store>/import`, RESTOW_RECOVERY_ISO_DIR). */
  dropDirs: readonly string[];
  /** RESTOW_RECOVERY_ISO_FETCH; false: only the drop folders count. */
  enabled?: boolean;
  /** The repositories to look in, in order (default: the project's, then the alpha one). */
  bases?: readonly string[];
  http?: RecoveryIsoHttpOptions;
  maxBytes?: number;
  /** At most this many rebuild numbers are asked for in one pass (default 20). */
  maxRebuildRequests?: number;
  /** What must stay free in the store (default RECOVERY_ISO_MIN_FREE_BYTES). */
  minFreeBytes?: number;
  /** Tests only: the free bytes of the store's file system (default: statfs). */
  freeBytes?: (dir: string) => Promise<number | null>;
  /** The pass ends itself after this long (default RECOVERY_ISO_PASS_TIME_LIMIT_MS). */
  timeLimitMs?: number;
  now?: () => Date;
}

export interface RecoveryIsoFetchResult {
  state: RecoveryIsoFetchState;
  /** The pass should be retried soon (network, a cut-off transfer); otherwise the next schedule. */
  transient: boolean;
  /**
   * The release page could not be asked for rebuilds (network, an error answer, nothing
   * published) while a verified copy is here: for the log only, not a problem of the state.
   */
  lookupProblem?: { problem: RecoveryIsoFetchProblem; detail: string | null } | null;
  /** Another pass holds the store; this one changed nothing. */
  busy?: boolean;
}

const LOCK_FILE = ".fetch.lock";
/** A lock not refreshed for this long belongs to a pass that is gone. */
const LOCK_STALE_MS = 15 * 60_000;
/** A pass that confirmed its lock this recently writes without reading it again. */
const LOCK_CHECK_INTERVAL_MS = 250;

/** The pass's lock is no longer its own (taken over after it went silent); it writes nothing more. */
export class RecoveryIsoLockLostError extends Error {
  constructor() {
    super("the lock of the recovery ISO store was taken over by another pass");
    this.name = "RecoveryIsoLockLostError";
  }
}

interface StoreLock {
  /** Throws RecoveryIsoLockLostError when the lock file no longer carries this pass's token. */
  check(): Promise<void>;
  /** check(), at most every LOCK_CHECK_INTERVAL_MS: before each chunk of the download. */
  checkSoon(): Promise<void>;
  /** check(), then refresh the lock's mtime. */
  touch(): Promise<void>;
  release(): Promise<void>;
}

interface SeenLock {
  token: string | null;
  ino: number;
  mtimeMs: number;
}

/** The lock at path (null: none). An unreadable or half-written file has no token. */
async function readLock(path: string): Promise<SeenLock | null> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  let token: string | null = null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
    token = typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    token = null;
  }
  return { token, ino: Number(info.ino), mtimeMs: Number(info.mtimeMs) };
}

/**
 * Takes whatever lock is at path away in one step (rename to a name only this pass uses) and
 * keeps it gone only when `mine` accepts it; anything else (a lock another pass created in the
 * meantime) goes back with an exclusive link, never over a newer lock. "gone": nothing was there.
 */
async function takeLockAway(
  path: string,
  aside: string,
  mine: (lock: SeenLock | null) => boolean,
): Promise<"removed" | "restored" | "gone"> {
  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "gone";
    throw error;
  }
  try {
    if (mine(await readLock(aside))) return "removed";
    try {
      await link(aside, path);
    } catch (error) {
      // EEXIST: a newer lock took the place; the owner of this one notices at its next check.
      if (errorCode(error) !== "EEXIST") {
        await copyFile(aside, path, fsConstants.COPYFILE_EXCL).catch(() => undefined);
      }
    }
    return "restored";
  } finally {
    await rm(aside, { force: true });
  }
}

/**
 * The store's lock: created exclusively, with a token, refreshed (mtime) while the pass works,
 * and checked before every write (RecoveryIsoLockLostError once another pass holds it). A lock
 * older than LOCK_STALE_MS is taken over atomically: it is renamed aside, and only when the
 * file renamed is still the stale lock this pass looked at (same inode, same token, still
 * stale) is it dropped and the exclusive creation tried again; a lock another pass created in
 * the meantime goes back. Two passes that both see a stale lock therefore never both hold it:
 * only one exclusive creation can succeed. Null when another pass holds the lock.
 */
async function lockStore(storeDir: string): Promise<StoreLock | null> {
  const path = join(storeDir, LOCK_FILE);
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, "wx", 0o644);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (handle) {
      try {
        await handle.writeFile(
          JSON.stringify({
            token,
            pid: process.pid,
            host: hostname(),
            startedAt: new Date().toISOString(),
          }),
        );
      } finally {
        await handle.close();
      }
      return ownedLock(path, token);
    }
    const seen = await readLock(path);
    if (!seen) continue; // released in the meantime
    if (Date.now() - seen.mtimeMs < LOCK_STALE_MS) return null;
    const outcome = await takeLockAway(
      path,
      `${path}.stale-${token}`,
      (lock) =>
        lock !== null &&
        lock.ino === seen.ino &&
        lock.token === seen.token &&
        Date.now() - lock.mtimeMs >= LOCK_STALE_MS,
    );
    if (outcome === "restored") return null;
  }
  return null;
}

function ownedLock(path: string, token: string): StoreLock {
  let confirmedAt = Date.now();
  const check = async () => {
    // A pass that takes a stale lock over may hold this one aside for a moment before it puts
    // it back (takeLockAway): read again shortly before giving up.
    for (let read = 0; read < 3; read++) {
      if (read > 0) await new Promise((resolve) => setTimeout(resolve, 20));
      const lock = await readLock(path).catch(() => null);
      if (lock?.token === token) {
        confirmedAt = Date.now();
        return;
      }
    }
    throw new RecoveryIsoLockLostError();
  };
  return {
    check,
    async checkSoon() {
      if (Date.now() - confirmedAt >= LOCK_CHECK_INTERVAL_MS) await check();
    },
    async touch() {
      await check();
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
    },
    async release() {
      await takeLockAway(path, `${path}.release-${token}`, (lock) => lock?.token === token);
    },
  };
}

function emptyState(now: Date): RecoveryIsoFetchState {
  return {
    status: "not_fetched",
    version: null,
    fileName: null,
    rebuild: null,
    sha256: null,
    bytesDone: null,
    bytesTotal: null,
    problem: null,
    detail: null,
    githubBase: null,
    updatedAt: now.toISOString(),
    checkedAt: null,
  };
}

/** One pass: discover, verify, download if needed, record the state. */
export async function fetchRecoveryIso(
  options: RecoveryIsoFetchOptions,
): Promise<RecoveryIsoFetchResult> {
  const now = options.now ?? (() => new Date());
  const root = options.root ?? agentRoot();
  const key = options.key ?? (await readReleaseKey());
  const storeDir = options.storeDir;
  const http = options.http ?? {};
  const previous = await readRecoveryIsoFetchState(storeDir);
  let state: RecoveryIsoFetchState = { ...(previous ?? emptyState(now())) };

  const save = async (patch: Partial<RecoveryIsoFetchState>, done = false) => {
    state = { ...state, ...patch, updatedAt: now().toISOString() };
    if (done) state.checkedAt = state.updatedAt;
    if (storeDir) {
      await writeRecoveryIsoFetchState(storeDir, state).catch(() => undefined);
    }
    return state;
  };

  const base = await verifiedBaseIso(root, key);
  if (!base.ok) {
    return {
      state: await save(
        {
          status: base.problem === "no_signed_release" ? "not_fetched" : "failed",
          version: base.version,
          fileName: null,
          rebuild: null,
          sha256: null,
          bytesDone: null,
          bytesTotal: null,
          problem: base.problem,
          detail: null,
        },
        true,
      ),
      transient: false,
    };
  }
  const version = base.candidate.version;
  if (storeDir) {
    try {
      await mkdir(join(storeDir, version), { recursive: true });
      await mkdir(join(storeDir, "import"), { recursive: true });
    } catch (error) {
      state = {
        ...state,
        status: "failed",
        version,
        problem: "store_not_writable",
        detail: errorCode(error),
        updatedAt: now().toISOString(),
      };
      return { state, transient: false };
    }
  }

  const select = () => selectRecoveryIso({ root, key, storeDir, dropDirs: options.dropDirs });
  if (!storeDir || options.enabled === false) {
    const selection = await select();
    const offered = selection.offered;
    return {
      state: await save(
        {
          status: selection.local ? "verified" : "disabled",
          version,
          fileName: offered?.fileName ?? null,
          rebuild: offered?.rebuild ?? null,
          sha256: offered?.sha256 ?? null,
          bytesDone: selection.local?.size ?? null,
          bytesTotal: selection.local?.size ?? null,
          problem: null,
          detail: null,
        },
        true,
      ),
      transient: false,
    };
  }

  let lock: StoreLock | null;
  try {
    lock = await lockStore(storeDir);
  } catch (error) {
    return {
      state: await save(
        { status: "failed", version, problem: "store_not_writable", detail: errorCode(error) },
        true,
      ),
      transient: false,
    };
  }
  if (!lock) {
    // Another pass works on the store (and its partial file); it records the state.
    return {
      state: (await readRecoveryIsoFetchState(storeDir)) ?? state,
      transient: false,
      busy: true,
    };
  }
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(),
    options.timeLimitMs ?? RECOVERY_ISO_PASS_TIME_LIMIT_MS,
  );
  timer.unref?.();
  try {
    return await fetchLocked({
      options,
      root,
      key,
      storeDir,
      version,
      base,
      state: () => state,
      save: async (patch, done) => {
        await lock.touch();
        return save(patch, done);
      },
      touch: () => lock.touch(),
      owner: (soon) => (soon ? lock.checkSoon() : lock.check()),
      http: {
        ...http,
        signal: http.signal ? AbortSignal.any([http.signal, deadline.signal]) : deadline.signal,
      },
      deadline: deadline.signal,
    });
  } catch (error) {
    if (!(error instanceof RecoveryIsoLockLostError)) throw error;
    // The pass went silent long enough for another to take the store over: that one records
    // the state, this one stops without writing.
    return {
      state: (await readRecoveryIsoFetchState(storeDir)) ?? state,
      transient: false,
      busy: true,
    };
  } finally {
    clearTimeout(timer);
    await lock.release().catch(() => undefined);
  }
}

interface LockedPass {
  options: RecoveryIsoFetchOptions;
  root: string;
  key: string;
  storeDir: string;
  version: string;
  base: Extract<Awaited<ReturnType<typeof verifiedBaseIso>>, { ok: true }>;
  state: () => RecoveryIsoFetchState;
  save: (patch: Partial<RecoveryIsoFetchState>, done?: boolean) => Promise<RecoveryIsoFetchState>;
  /** Checks the lock (RecoveryIsoLockLostError) and refreshes it. */
  touch: () => Promise<void>;
  /** Checks the lock only (DownloadContext.owner). */
  owner: (soon?: boolean) => Promise<void>;
  http: RecoveryIsoHttpOptions;
  deadline: AbortSignal;
}

/** The part of a pass that talks to the release page and writes the store, under its lock. */
async function fetchLocked(pass: LockedPass): Promise<RecoveryIsoFetchResult> {
  const { options, root, key, storeDir, version, base, save, http } = pass;
  const select = () => selectRecoveryIso({ root, key, storeDir, dropDirs: options.dropDirs });
  // 1. The repository that carries this release. A problem of the lookup (network, an error
  // answer, nothing published) is kept apart from a rebuild that was found and refused.
  let home: string | null = null;
  let problem: RecoveryIsoFetchProblem | null = null;
  let detail: string | null = null;
  let transient = false;
  let skipped: { problem: RecoveryIsoFetchProblem; detail: string | null } | null = null;
  for (const candidateBase of options.bases ?? RECOVERY_ISO_GITHUB_BASES) {
    try {
      const sums = await getSmall(
        assetUrl(candidateBase, recoveryIsoTag(version), RELEASE_SUMS_ASSET),
        http,
      );
      if (sums.ok) {
        home = candidateBase;
        break;
      }
      if (sums.problem !== "absent") {
        problem = "http_status";
        detail = sums.detail;
        transient = true;
      }
    } catch (error) {
      problem = "network";
      detail = errorCode(error);
      transient = true;
    }
  }
  if (home) {
    problem = null;
    detail = null;
    transient = false;
  } else if (problem === null) {
    problem = "not_published";
  }

  // 2. Rebuilds of this release's ISO, from the first number not yet verified in the store.
  if (home) {
    const known = new Set(
      (await verifiedRebuilds(version, base.releaseSumsSha256, key, storeDir, []))
        .map((candidate) => candidate.rebuild)
        .filter((value): value is number => value !== null),
    );
    let requests = 0;
    for (let rebuild = 1; rebuild <= MAX_RECOVERY_REBUILD; rebuild++) {
      if (known.has(rebuild)) continue;
      if (requests >= (options.maxRebuildRequests ?? 20)) break;
      requests += 1;
      await pass.touch();
      const tag = recoveryIsoTag(version, rebuild);
      let sums: Awaited<ReturnType<typeof getSmall>>;
      let signature: Awaited<ReturnType<typeof getSmall>> | null = null;
      try {
        sums = await getSmall(assetUrl(home, tag, REBUILD_SUMS_ASSET), http);
        if (sums.ok) {
          signature = await getSmall(assetUrl(home, tag, `${REBUILD_SUMS_ASSET}.sig`), http);
        }
      } catch (error) {
        problem = "network";
        detail = errorCode(error);
        transient = true;
        break;
      }
      if (!sums.ok) {
        if (sums.problem === "absent") break;
        if (sums.problem === "too_large") {
          skipped = { problem: "too_large", detail: tag };
        } else {
          problem = "http_status";
          detail = `${tag}: ${sums.detail ?? ""}`.trim();
          transient = true;
        }
        break;
      }
      if (!signature?.ok) {
        // Published without a signature (or the signature does not come): never taken.
        skipped = { problem: "signature_invalid", detail: tag };
        continue;
      }
      const verified = verifyRebuildSums(
        sums.body,
        signature.body,
        key,
        version,
        rebuild,
        base.releaseSumsSha256,
      );
      if (!verified.ok) {
        skipped = {
          problem: verified.problem === "wrong_release" ? "wrong_release" : "signature_invalid",
          detail: tag,
        };
        continue;
      }
      const dir = storedRebuildDir(storeDir, version, rebuild);
      const temporary = `${dir}.tmp`;
      await pass.touch();
      await rm(temporary, { recursive: true, force: true });
      await mkdir(temporary, { recursive: true });
      await writeFile(join(temporary, REBUILD_SUMS_ASSET), sums.body);
      await writeFile(join(temporary, `${REBUILD_SUMS_ASSET}.sig`), signature.body);
      await rm(dir, { recursive: true, force: true });
      await rename(temporary, dir);
    }
  }

  // 3. The newest verified ISO: here already, or downloaded now.
  const selection = await select();
  const newest = selection.newest ?? base.candidate;
  const describe = {
    version,
    fileName: newest.fileName,
    rebuild: newest.rebuild,
    sha256: newest.sha256,
    githubBase: home ?? pass.state().githubBase,
  };
  const lookupProblem = problem ? { problem, detail } : null;
  if (selection.local && selection.offered?.fileName === newest.fileName) {
    if (selection.local.origin === "store") {
      await pass.touch();
      await pruneRecoveryIsoStore(storeDir, newest);
    }
    return {
      state: await save(
        {
          ...describe,
          status: "verified",
          bytesDone: selection.local.size,
          bytesTotal: selection.local.size,
          // Only a rebuild that was found and refused (bad signature, another release) is worth
          // a note; that the release page could not be asked is not news next to a verified copy
          // (on an installation without internet access it is the permanent state), and nothing
          // needs a retry soon: the next pass asks again.
          problem: skipped?.problem ?? null,
          detail: skipped?.detail ?? null,
        },
        true,
      ),
      transient: false,
      lookupProblem,
    };
  }
  if (!home) {
    return {
      state: await save(
        { ...describe, status: "failed", bytesDone: null, bytesTotal: null, problem, detail },
        true,
      ),
      transient,
    };
  }
  await save({
    ...describe,
    status: "fetching",
    bytesDone: (await sizeOf(join(storeDir, version, `${newest.fileName}.part`))) ?? 0,
    bytesTotal: null,
    problem: null,
    detail: null,
  });
  const result = await downloadIso(
    assetUrl(home, newest.tag, newest.fileName),
    newest,
    join(storeDir, version),
    http,
    {
      maxBytes: options.maxBytes ?? MAX_RECOVERY_ISO_BYTES,
      minFreeBytes: options.minFreeBytes ?? RECOVERY_ISO_MIN_FREE_BYTES,
      freeBytes: options.freeBytes ?? freeBytesOf,
      deadline: pass.deadline,
      progress: async (done, total) => {
        await save({ bytesDone: done, bytesTotal: total });
      },
      owner: pass.owner,
    },
  );
  if (!result.ok) {
    return {
      state: await save({ status: "failed", problem: result.problem, detail: result.detail }, true),
      transient: result.transient,
    };
  }
  await pass.touch();
  await pruneRecoveryIsoStore(storeDir, newest);
  const size = (await sizeOf(join(storeDir, version, newest.fileName))) ?? null;
  return {
    state: await save(
      {
        status: "verified",
        bytesDone: size,
        bytesTotal: size,
        problem: skipped?.problem ?? null,
        detail: skipped?.detail ?? null,
      },
      true,
    ),
    transient: false,
    lookupProblem,
  };
}

/** For a caller that wants the problem of a failed pass as one line (logs). */
export function describeRecoveryIsoState(state: RecoveryIsoFetchState): string {
  return [state.status, state.fileName, state.problem, state.detail].filter(Boolean).join(" ");
}
