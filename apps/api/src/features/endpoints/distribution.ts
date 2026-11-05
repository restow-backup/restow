import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import {
  agentRoot,
  flatAgentVersion,
  installScriptFolders,
  isAgentVersion,
  isReleaseKey,
  listAgentVersions,
  readReleaseFile,
} from "@restow/core";

// The release files and the key moved to @restow/core (release/agent-files.ts) so the worker
// reads them with the same rules; they are re-exported here for the api's callers.
export {
  agentRoot,
  compareAgentVersions,
  flatAgentVersion,
  installScriptFolders,
  isAgentVersion,
  isReleaseFile,
  isReleaseKey,
  listAgentVersions,
  RELEASE_FILES,
  type ReleaseFileName,
  readReleaseFile,
  readReleaseKey,
} from "@restow/core";
/**
 * Where the agent binaries and the install scripts come from
 * (docs/AGENT.md, "Distribution").
 *
 * The image ships the agent for every target under
 * `/srv/agent/<version>/<os>-<arch>/` (the binaries `restow-agent` and
 * `restic`, `restow-agent.exe` and `restic.exe` for Windows, their license
 * notices `THIRD_PARTY_NOTICES.txt` and a `SHA256SUMS` next to them), so an
 * instance never depends on
 * the vendor's site. The install scripts sit in `/srv/agent/install/`; a
 * development checkout reads them from `agent/install/` in the repository.
 * `RESTOW_AGENT_DIR` and `RESTOW_AGENT_INSTALL_DIR` move either.
 *
 * Linux and macOS on amd64 and arm64, and Windows on amd64 (a preview in
 * 0.5.0; there is no Windows on ARM, docs/WINDOWS-AGENT.md). Which systems may
 * enroll is decided elsewhere (`SUPPORTED_ENDPOINT_OS` in @restow/core).
 *
 * Agent releases are signed by the maintainer (agent/README.md, "Release
 * signing"): `<root>/<version>/SHA256SUMS` lists every file of a release and
 * `SHA256SUMS.sig` next to it is the signature over exactly these bytes. Both
 * are served unchanged; the agents and the install scripts check the
 * signature against the public key they carry (`release-signing.pub`, which
 * the server also writes into the install scripts).
 */

/**
 * The `<os>-<arch>` folders the server offers, the targets of agent/build.sh. A
 * fixed list: deriving it from the enrollable systems would invent windows-arm64.
 */
export const DISTRIBUTION_TARGETS: readonly string[] = [
  "linux-amd64",
  "linux-arm64",
  "darwin-amd64",
  "darwin-arm64",
  "windows-amd64",
];

/** The file name of the agent binary of a target (`restow-agent.exe` on Windows). */
export function agentBinaryName(target: string): string {
  return target.startsWith("windows-") ? "restow-agent.exe" : "restow-agent";
}

/** The install scripts by URL name. */
export const INSTALL_SCRIPTS = {
  "linux.sh": "linux.sh",
  "macos.sh": "macos.sh",
  // Windows (0.5.0, preview; docs/WINDOWS-AGENT.md, section 14).
  "windows.ps1": "windows.ps1",
  // The node installer for Proxmox VE (restow-pve, features/pve).
  "pve.sh": "pve.sh",
} as const;
export type InstallScriptName = keyof typeof INSTALL_SCRIPTS;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The version the placeholders fall back to when no agent is shipped (a development checkout). */
export const FALLBACK_AGENT_VERSION = "0.1.0";

export function isDistributionTarget(value: string): boolean {
  return DISTRIBUTION_TARGETS.includes(value);
}

export function isDistributionFile(value: string): boolean {
  return FILE_NAME.test(value);
}

/** The folder of one target for one version, in either layout; null when there is none. */
async function targetFolder(root: string, version: string, target: string): Promise<string | null> {
  for (const candidate of [join(root, version, target), join(root, target)]) {
    try {
      if (!(await stat(candidate)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    // The unversioned folder only serves the version its VERSION file names.
    if (candidate === join(root, target) && (await flatAgentVersion(root)) !== version) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * `SHA256SUMS` as file name -> hash (`<hash>  <name>` and `<hash> *<name>`). A
 * line that names a folder (`linux-amd64/restow-agent`, from a list that covers
 * every target) only counts for that target. The recovery ISO's line
 * (`recovery/restow-recovery_<v>_amd64.iso`, docs/BAREMETAL.md 8.5) belongs to
 * no agent target and is never part of a target's list.
 */
export function parseChecksums(text: string, target?: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(?:(.*)\/)?([^/\s]+)\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const folder = match[2];
    if (target !== undefined && (folder === "recovery" || folder?.startsWith("recovery/"))) {
      continue;
    }
    if (folder !== undefined && target !== undefined && !folder.endsWith(target)) {
      continue;
    }
    sums.set(match[3] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** The checksums of a target folder: its own `SHA256SUMS` and the lists that cover every target. */
export async function readChecksums(
  version: string,
  target: string,
  root = agentRoot(),
): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  const paths = [join(root, version, "SHA256SUMS"), join(root, "SHA256SUMS")];
  const folder = await targetFolder(root, version, target);
  if (folder) {
    paths.push(join(folder, "SHA256SUMS"));
  }
  for (const path of paths) {
    // The unversioned list belongs to the unversioned layout only.
    if (path === join(root, "SHA256SUMS") && (await flatAgentVersion(root)) !== version) {
      continue;
    }
    try {
      for (const [name, sum] of parseChecksums(await readFile(path, "utf8"), target)) {
        merged.set(name, sum);
      }
    } catch {
      // not there
    }
  }
  return merged;
}

export interface AgentRelease {
  version: string;
  target: string;
  sha256: string;
  file: string;
}

/**
 * The newest shipped and signed agent for a target, or null. An unsigned
 * release is never offered: the agents refuse it anyway.
 */
export async function latestAgentRelease(
  os: string,
  arch: string,
  root = agentRoot(),
): Promise<AgentRelease | null> {
  const target = `${os}-${arch}`;
  if (!isDistributionTarget(target)) {
    return null;
  }
  for (const version of await listAgentVersions(root)) {
    if (!(await readReleaseFile(version, "SHA256SUMS.sig", root))) {
      continue;
    }
    const sums = await readChecksums(version, target, root);
    const file = agentBinaryName(target);
    const sha256 = sums.get(file);
    if (sha256) {
      return { version, target, sha256, file };
    }
  }
  return null;
}

/** The absolute path of a distributed file, or null when the request names anything unexpected. */
export async function distributionFile(
  version: string,
  target: string,
  file: string,
  root = agentRoot(),
): Promise<{ path: string; size: number } | null> {
  if (!isAgentVersion(version) || !isDistributionTarget(target) || !isDistributionFile(file)) {
    return null;
  }
  const folder = await targetFolder(root, version, target);
  if (!folder) {
    return null;
  }
  const path = resolve(folder, file);
  if (!path.startsWith(`${resolve(root)}/`)) {
    return null;
  }
  try {
    const info = await stat(path);
    return info.isFile() ? { path, size: info.size } : null;
  } catch {
    return null;
  }
}

export function openDistributionFile(path: string): Readable {
  return createReadStream(path);
}

/** The version install scripts announce: the newest shipped one, else the image's release, else the fallback. */
export async function announcedAgentVersion(
  root = agentRoot(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const [newest] = await listAgentVersions(root);
  if (newest) {
    return newest;
  }
  const release = env.RESTOW_VERSION?.trim().replace(/^v/, "");
  return release && isAgentVersion(release) ? release : FALLBACK_AGENT_VERSION;
}

/** The text of an install script, or null when none of the folders has it. */
export async function readInstallScript(
  name: InstallScriptName,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  for (const folder of installScriptFolders(env)) {
    try {
      return await readFile(join(folder, INSTALL_SCRIPTS[name]), "utf8");
    } catch {
      // try the next
    }
  }
  return null;
}

/** Whether an origin is safe to write into a shell script: scheme, host and port only. */
export function isSafeOrigin(origin: string): boolean {
  return (
    /^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(origin) ||
    /^https?:\/\/\[[0-9A-Fa-f:]+\](:\d{1,5})?$/.test(origin)
  );
}

/** Fill the placeholders of an install script. */
export function renderInstallScript(
  template: string,
  origin: string,
  version: string,
  releaseKey = "",
): string {
  if (!isSafeOrigin(origin)) {
    throw new TypeError("unsafe origin for an install script");
  }
  if (!isAgentVersion(version)) {
    throw new TypeError("unsafe version for an install script");
  }
  if (releaseKey !== "" && !isReleaseKey(releaseKey)) {
    throw new TypeError("unsafe release key for an install script");
  }
  return template
    .replaceAll("__RESTOW_URL__", origin)
    .replaceAll("__RESTOW_VERSION__", version)
    .replaceAll("__RESTOW_RELEASE_KEY__", releaseKey);
}
