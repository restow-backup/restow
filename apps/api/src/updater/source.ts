import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type ImageVariant, buildTargetsOf, imageNamesOf } from "./image-variant.js";
import type { BuildSpec, DockerOps } from "./ops.js";
import type { Redactor } from "./redact.js";
import {
  SOURCE_ALLOWLIST_VARIABLE,
  type SourceAllowEntry,
  isSourceAllowed,
  sourceTargetOf,
} from "./source-policy.js";

/**
 * `source` mode: fetch the tagged repository as an archive, unpack it and build the
 * images from it. The access token for a private repository is held only for the
 * one download request:
 *
 *   - it travels as an `Authorization: token <t>` request header, never in a URL,
 *     an argument vector, a child process's environment, a log line or status.json;
 *   - the header is sent only to the origin of the archive URL; a redirect to
 *     another origin (GitHub answers with a signed codeload URL) is followed
 *     without it;
 *   - only https is accepted, for the first request and for every redirect;
 *   - at most three redirects are followed and the download is capped in size.
 *
 * The archive and the unpacked tree live in `<state>/src` and are removed
 * afterwards, whether the update succeeded or not.
 *
 * What is built here runs as the application, so the operator alone decides where
 * it may come from: an archive URL whose host and repository are not on the
 * allowlist in the updater's environment (source-policy.ts) is refused before
 * anything is fetched, and without an allowlist `source` mode is off.
 */

export const MAX_REDIRECTS = 3;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class SourceError extends Error {
  constructor(
    message: string,
    readonly stage: "download" | "extract",
    /** The operator has not allowed this source (or `source` mode at all). */
    readonly notAllowed = false,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface UrlPolicy {
  /** Tests only: accept http (a fake server on 127.0.0.1). Never set from configuration. */
  allowInsecureHttp?: boolean;
}

/** Parse an archive URL and refuse anything that is not plain https without credentials. */
export function assertArchiveUrl(value: string | URL, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = typeof value === "string" ? new URL(value) : value;
  } catch {
    throw new SourceError("The archive URL is not a valid URL.", "download");
  }
  const secure =
    url.protocol === "https:" || (policy.allowInsecureHttp && url.protocol === "http:");
  if (!secure) {
    throw new SourceError("The archive URL must use https.", "download");
  }
  if (url.username || url.password) {
    throw new SourceError("The archive URL must not contain credentials.", "download");
  }
  if (!url.hostname) {
    throw new SourceError("The archive URL has no host.", "download");
  }
  return url;
}

/** Origin and path only: a query string may carry a signed token. */
export function describeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

export interface DownloadOptions {
  url: string;
  /** Sent as `Authorization: token <token>` to the origin of `url` only. */
  token: string | null;
  destination: string;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  timeoutMs?: number;
}

/** Download the archive to `destination`. Returns its size in bytes. */
export async function downloadArchive(options: DownloadOptions): Promise<number> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const first = assertArchiveUrl(options.url, options.policy);
  const authOrigin = first.origin;
  const signal = AbortSignal.timeout(options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);

  let current = first;
  let sendToken = true;
  let response: Response | null = null;
  for (let redirects = 0; ; redirects++) {
    const headers: Record<string, string> = {
      "User-Agent": "restow-updater",
      Accept: "application/x-gzip, application/gzip, application/octet-stream, */*",
    };
    // Once a redirect has left the origin the token was meant for, it is gone for good.
    if (current.origin !== authOrigin) {
      sendToken = false;
    }
    if (options.token !== null && sendToken) {
      headers.Authorization = `token ${options.token}`;
    }
    let candidate: Response;
    try {
      candidate = await fetchImpl(current, { redirect: "manual", headers, signal });
    } catch (error) {
      throw new SourceError(
        `The download from ${describeUrl(current)} failed: ${describeFetchError(error)}`,
        "download",
      );
    }
    if (REDIRECT_STATUSES.has(candidate.status)) {
      await candidate.body?.cancel().catch(() => undefined);
      if (redirects >= MAX_REDIRECTS) {
        throw new SourceError(
          `The download was redirected more than ${MAX_REDIRECTS} times.`,
          "download",
        );
      }
      const location = candidate.headers.get("location");
      if (!location) {
        throw new SourceError("The server sent a redirect without a location.", "download");
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new SourceError("The server sent an invalid redirect location.", "download");
      }
      current = assertArchiveUrl(next, options.policy);
      continue;
    }
    response = candidate;
    break;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceError(
      `The download from ${describeUrl(current)} failed with HTTP ${response.status}.`,
      "download",
    );
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceError("The archive is larger than the allowed size.", "download");
  }
  if (!response.body) {
    throw new SourceError("The server sent no content.", "download");
  }

  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new SourceError("The archive is larger than the allowed size.", "download"));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      limiter,
      createWriteStream(options.destination, { flags: "wx", mode: 0o600 }),
      { signal },
    );
  } catch (error) {
    await fs.rm(options.destination, { force: true });
    if (error instanceof SourceError) {
      throw error;
    }
    throw new SourceError(
      `The download from ${describeUrl(current)} was interrupted: ${describeFetchError(error)}`,
      "download",
    );
  }
  return total;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const code =
      cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code: unknown }).code)
        : null;
    return code ? `${error.message} (${code})` : error.message;
  }
  return "unknown error";
}

/** Unpack a .tar.gz into `directory`, dropping the archive's top-level directory. */
export async function extractArchive(
  archive: string,
  directory: string,
  redactor: Redactor,
  tarBinary = "tar",
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      tarBinary,
      ["-xzf", archive, "-C", directory, "--strip-components=1", "--no-same-owner"],
      { stdio: ["ignore", "ignore", "pipe"], shell: false, env: { PATH: process.env.PATH ?? "" } },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), EXTRACT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new SourceError(
          `Unpacking the archive failed: ${redactor.oneLine(error.message, 300)}`,
          "extract",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new SourceError(
            `Unpacking the archive failed (exit code ${code}): ${redactor.oneLine(stderr, 500)}`,
            "extract",
          ),
        );
      }
    });
  });
  try {
    await fs.access(path.join(directory, "Dockerfile"));
  } catch {
    throw new SourceError("The archive has no Dockerfile at its top level.", "extract");
  }
}

export interface FetchedSource {
  /** Directory to build from. */
  contextDir: string;
  /** Delete the archive and the unpacked tree. Safe to call twice. */
  cleanup(): Promise<void>;
}

export interface SourceFetchInput {
  /** Normalized target version; used in file names only. */
  version: string;
  archiveUrl: string;
  token: string | null;
  onStage?: (stage: "downloading" | "extracting") => void | Promise<void>;
}

/** Fetches the source tree the engine builds from (a seam for tests). */
export interface SourceProvider {
  /** Refuse an archive URL this updater would not fetch (throws SourceError). Cheap, no network. */
  validate(archiveUrl: string): void;
  fetch(input: SourceFetchInput): Promise<FetchedSource>;
  /** Remove everything a previous, interrupted run left behind. */
  purge(): Promise<void>;
}

export interface ArchiveSourceOptions {
  stateDir: string;
  redactor: Redactor;
  /** Hosts and repositories the archive URL may point at; empty or absent: none (`source` mode is off). */
  allowlist?: readonly SourceAllowEntry[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  tarBinary?: string;
  policy?: UrlPolicy;
}

export class ArchiveSourceProvider implements SourceProvider {
  private readonly root: string;

  constructor(private readonly options: ArchiveSourceOptions) {
    this.root = path.join(options.stateDir, "src");
  }

  async purge(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }

  validate(archiveUrl: string): void {
    const url = assertArchiveUrl(archiveUrl, this.options.policy);
    const allowlist = this.options.allowlist ?? [];
    if (allowlist.length === 0) {
      throw new SourceError(
        `Installing from a source repository is turned off. The operator enables it by naming the repository in ${SOURCE_ALLOWLIST_VARIABLE} (docs/UPDATING.md).`,
        "download",
        true,
      );
    }
    const target = sourceTargetOf(url);
    if (!target || !isSourceAllowed(allowlist, target)) {
      throw new SourceError(
        `The repository ${target?.repository ? `${target.host}/${target.repository}` : url.hostname} is not in ${SOURCE_ALLOWLIST_VARIABLE}.`,
        "download",
        true,
      );
    }
  }

  async fetch(input: SourceFetchInput): Promise<FetchedSource> {
    if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/.test(input.version)) {
      throw new SourceError("The version is not usable in a file name.", "download");
    }
    this.validate(input.archiveUrl);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const archive = path.join(this.root, `${input.version}.tar.gz`);
    const tree = path.join(this.root, input.version);
    const cleanup = async (): Promise<void> => {
      await fs.rm(archive, { force: true });
      await fs.rm(tree, { recursive: true, force: true });
    };
    try {
      await cleanup();
      await input.onStage?.("downloading");
      await downloadArchive({
        url: input.archiveUrl,
        token: input.token,
        destination: archive,
        maxBytes: this.options.maxBytes,
        fetchImpl: this.options.fetchImpl,
        policy: this.options.policy,
      });
      await input.onStage?.("extracting");
      await extractArchive(archive, tree, this.options.redactor, this.options.tarBinary);
      // The archive is not needed once it is unpacked.
      await fs.rm(archive, { force: true });
      return { contextDir: tree, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}

/**
 * The two images source mode builds, tagged `restow:<version>` and
 * `restow-web:<version>`, or `restow-community:<version>` and
 * `restow-web-community:<version>` for the Community build.
 */
export function sourceImageTags(
  version: string,
  variant: ImageVariant = "full",
): { app: string; web: string } {
  const names = imageNamesOf(variant);
  return { app: `${names.app}:${version}`, web: `${names.web}:${version}` };
}

/** The Dockerfile targets of the variant: `runtime` and `web`, or their Community twins. */
export function buildSpecs(
  contextDir: string,
  version: string,
  variant: ImageVariant = "full",
): { app: BuildSpec; web: BuildSpec } {
  const tags = sourceImageTags(version, variant);
  const targets = buildTargetsOf(variant);
  return {
    app: { contextDir, target: targets.app, tag: tags.app, buildArgs: { RESTOW_VERSION: version } },
    web: { contextDir, target: targets.web, tag: tags.web, buildArgs: {} },
  };
}

/** Build the runtime and the web image from an unpacked tree. */
export async function buildImages(
  ops: Pick<DockerOps, "build">,
  contextDir: string,
  version: string,
  hooks: { onApp?: () => void | Promise<void>; onWeb?: () => void | Promise<void> } = {},
  variant: ImageVariant = "full",
): Promise<{ app: string; web: string }> {
  const specs = buildSpecs(contextDir, version, variant);
  await hooks.onApp?.();
  await ops.build(specs.app);
  await hooks.onWeb?.();
  await ops.build(specs.web);
  return sourceImageTags(version, variant);
}
