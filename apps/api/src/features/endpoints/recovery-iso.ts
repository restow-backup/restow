import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { config } from "../../config.js";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { ALPHA_SOURCE_URL, DEFAULT_SOURCE_URL } from "../updates/source.js";
import { updateState } from "../updates/state-instance.js";
import { releaseKeyFingerprint } from "./commands.js";
import {
  agentRoot,
  isAgentVersion,
  listAgentVersions,
  readReleaseFile,
  readReleaseKey,
} from "./distribution.js";
import { instanceUrl } from "./instance-url.js";

/**
 * The recovery ISO this installation offers (docs/BAREMETAL.md 8.5, 9.2, 14.6):
 * `restow-recovery_<version>_amd64.iso`, listed in the signed `SHA256SUMS` of an agent release
 * under `recovery/`. The newest signed release decides: when its checksums list the ISO, the ISO is
 * `verified` (the same signature covers it as the agent binaries), and only then can a recovery
 * code be issued and does the web app show the code dialog and the wizard.
 *
 * Where it comes from (`source`): the GitHub release of that version (the project's repository,
 * or the alpha repository when the installation follows it), or this instance, when
 * `RESTOW_RECOVERY_ISO_DIR` holds the file and its SHA-256 equals the line of the signed
 * checksums. The server does not check the signature itself (the install scripts and the person
 * writing the USB stick do, with the release key of the Git tag); it serves only a release that
 * has one, and only the bytes the signed checksums name.
 *
 * The answer carries the commands to check the file before it is written to a USB stick: the
 * signature of `SHA256SUMS` with the release key of the Git tag (never the one this instance
 * serves alone), then the hash of the file.
 *
 *   GET /api/v1/recovery-iso      version, file name, URL, source, SHA-256, size, release key
 *                                 fingerprint, links to the release, the GPL sources and the
 *                                 firmware licences, commands
 */

export interface RecoveryIsoCommands {
  linux: string[];
  macos: string[];
  windows: string[];
}

export type RecoveryIsoSource = "instance" | "github";

export interface RecoveryIsoState {
  version: string | null;
  fileName: string | null;
  url: string | null;
  source: RecoveryIsoSource | null;
  sha256: string | null;
  /** Known only for the copy on this instance. */
  sizeBytes: number | null;
  releaseKeyFingerprint: string | null;
  verified: boolean;
  /** The GitHub release page of the version. */
  releaseUrl: string | null;
  /** Where the source bundle of the GPL packages is (release attachments, 8.7). */
  sourcesUrl: string | null;
  /** The licence notes of the non-free firmware in the image (8.4). */
  firmwareLicensesUrl: string | null;
  commands: RecoveryIsoCommands;
}

/** The file name of the ISO of a version. */
export function recoveryIsoFileName(version: string): string {
  return `restow-recovery_${version}_amd64.iso`;
}

/** The licence notes of the firmware packages, a release attachment next to the ISO. */
export function recoveryFirmwareLicensesName(version: string): string {
  return `restow-recovery_${version}_FIRMWARE-LICENSES.txt`;
}

/** The line of the ISO in a release's SHA256SUMS: `<hash>  recovery/<file>`. */
export function isoChecksum(text: string, fileName: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?recovery\/(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === fileName) {
      return (match[1] as string).toLowerCase();
    }
  }
  return null;
}

function commandsFor(fileName: string | null, version: string | null): RecoveryIsoCommands {
  if (!fileName || !version) {
    return { linux: [], macos: [], windows: [] };
  }
  const verify = [
    `./verify-agent-signature.sh SHA256SUMS SHA256SUMS.sig release-signing.pub`,
    `grep ' recovery/${fileName}$' SHA256SUMS | sed 's# recovery/# #' | sha256sum -c -`,
  ];
  return {
    linux: verify,
    macos: [
      verify[0] as string,
      `grep ' recovery/${fileName}$' SHA256SUMS | sed 's# recovery/# #' | shasum -a 256 -c -`,
    ],
    windows: [`(Get-FileHash -Algorithm SHA256 '${fileName}').Hash.ToLower()`],
  };
}

/**
 * The repository whose releases carry the ISO: the alpha repository when the installation follows
 * it (its test builds attach their own ISO), otherwise the project's public one. A source an
 * administrator named (a fork, a Forgejo mirror) is not assumed to attach an ISO.
 */
export function recoveryIsoGithubBase(): string {
  try {
    return updateState.get().source.isAlpha ? ALPHA_SOURCE_URL : DEFAULT_SOURCE_URL;
  } catch {
    return DEFAULT_SOURCE_URL;
  }
}

// ---------------------------------------------------------------------------
// The copy in RESTOW_RECOVERY_ISO_DIR
// ---------------------------------------------------------------------------

/** SHA-256 of a file by (path, size, mtime): an ISO of 900 MiB is hashed once, not per request. */
const hashCache = new Map<string, Promise<string>>();
const HASH_CACHE_MAX = 16;

function hashFile(path: string): Promise<string> {
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
    pending = hashFile(path);
    if (hashCache.size >= HASH_CACHE_MAX) {
      const oldest = hashCache.keys().next().value;
      if (oldest !== undefined) hashCache.delete(oldest);
    }
    hashCache.set(key, pending);
    pending.catch(() => hashCache.delete(key));
  }
  return pending;
}

/**
 * The ISO in `RESTOW_RECOVERY_ISO_DIR` when its SHA-256 equals `sha256` (the line of the signed
 * checksums), else null. `fileName` is the name from that line: a plain file name.
 */
export async function localRecoveryIso(
  fileName: string,
  sha256: string,
  isoDir: string | null | undefined = config.recoveryIsoDir,
): Promise<{ path: string; size: number } | null> {
  if (!isoDir || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fileName) || fileName.includes("..")) {
    return null;
  }
  const path = join(isoDir, fileName);
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

/**
 * The newest signed release's ISO line: version, file name and hash, or null when that release
 * lists none. An unsigned newer release is skipped; an older one with an ISO does not stand in.
 */
export async function signedRecoveryIso(
  root = agentRoot(),
): Promise<{ version: string; fileName: string; sha256: string } | null> {
  for (const version of await listAgentVersions(root)) {
    if (!isAgentVersion(version) || !(await readReleaseFile(version, "SHA256SUMS.sig", root))) {
      continue;
    }
    const sums = await readReleaseFile(version, "SHA256SUMS", root);
    const fileName = recoveryIsoFileName(version);
    const sha256 = sums ? isoChecksum(sums.toString("utf8"), fileName) : null;
    return sha256 ? { version, fileName, sha256 } : null;
  }
  return null;
}

export interface RecoveryIsoOptions {
  /** `RESTOW_RECOVERY_ISO_DIR`. */
  isoDir?: string | null;
  /** The repository whose release attachments carry the ISO. */
  githubBase?: string;
}

/**
 * What the newest signed release says about the ISO. `verified` only when that release has a
 * signature and its checksums list the ISO of its own version.
 */
export async function recoveryIsoState(
  root = agentRoot(),
  instance: string | null = null,
  options: RecoveryIsoOptions = {},
): Promise<RecoveryIsoState> {
  const fingerprintOf = async () => {
    const key = await readReleaseKey().catch(() => "");
    return key ? releaseKeyFingerprint(key) : null;
  };
  const signed = await signedRecoveryIso(root);
  if (!signed) {
    return {
      version: null,
      fileName: null,
      url: null,
      source: null,
      sha256: null,
      sizeBytes: null,
      releaseKeyFingerprint: await fingerprintOf(),
      verified: false,
      releaseUrl: null,
      sourcesUrl: null,
      firmwareLicensesUrl: null,
      commands: commandsFor(null, null),
    };
  }
  const { version, fileName, sha256 } = signed;
  const base = (options.githubBase ?? recoveryIsoGithubBase()).replace(/\/+$/, "");
  const tag = encodeURIComponent(`v${version}`);
  const releaseUrl = `${base}/releases/tag/${tag}`;
  const download = (name: string) => `${base}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const local = await localRecoveryIso(
    fileName,
    sha256,
    options.isoDir === undefined ? config.recoveryIsoDir : options.isoDir,
  );
  const fromInstance = local !== null && instance !== null;
  return {
    version,
    fileName,
    url: fromInstance
      ? `${(instance as string).replace(/\/+$/, "")}/install/recovery/${version}/${fileName}`
      : download(fileName),
    source: fromInstance ? "instance" : "github",
    sha256,
    sizeBytes: fromInstance ? (local as { size: number }).size : null,
    releaseKeyFingerprint: await fingerprintOf(),
    verified: true,
    releaseUrl,
    // The source bundle of the GPL packages is a set of attachments of the same release (8.7).
    sourcesUrl: releaseUrl,
    firmwareLicensesUrl: download(recoveryFirmwareLicensesName(version)),
    commands: commandsFor(fileName, version),
  };
}

export const recoveryIsoRoutes = new Hono<TenantEnv>();

recoveryIsoRoutes.get("/", requireTenant("tenant_admin"), async (c) => {
  const instance = await instanceUrl(c);
  return c.json(await recoveryIsoState(agentRoot(), instance.url || null));
});
