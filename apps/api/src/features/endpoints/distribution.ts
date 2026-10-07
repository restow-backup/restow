import { createReadStream, existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SUPPORTED_ENDPOINT_OS } from "@restow/core";

/**
 * Where the agent binaries and the install scripts come from
 * (docs/AGENT.md, "Distribution").
 *
 * The image ships the agent for every target under
 * `/srv/agent/<version>/<os>-<arch>/` (the binaries `restow-agent` and
 * `restic`, their license notices `THIRD_PARTY_NOTICES.txt` and a `SHA256SUMS`
 * next to them), so an instance never depends on
 * the vendor's site. The install scripts sit in `/srv/agent/install/`; a
 * development checkout reads them from `agent/install/` in the repository.
 * `RESTOW_AGENT_DIR` and `RESTOW_AGENT_INSTALL_DIR` move either.
 *
 * Only Linux and macOS targets exist in 0.1.0 (Windows is on the roadmap).
 *
 * Agent releases are signed by the maintainer (agent/README.md, "Release
 * signing"): `<root>/<version>/SHA256SUMS` lists every file of a release and
 * `SHA256SUMS.sig` next to it is the signature over exactly these bytes. Both
 * are served unchanged; the agents and the install scripts check the
 * signature against the public key they carry (`release-signing.pub`, which
 * the server also writes into the install scripts).
 */

/** The `<os>-<arch>` folders the server offers. */
export const DISTRIBUTION_TARGETS = SUPPORTED_ENDPOINT_OS.flatMap((os) => [
  `${os}-amd64`,
  `${os}-arm64`,
]);

/** The install scripts by URL name. Windows is intentionally absent. */
export const INSTALL_SCRIPTS = {
  "linux.sh": "linux.sh",
  "macos.sh": "macos.sh",
  // The node installer for Proxmox VE (restow-pve, features/pve).
  "pve.sh": "pve.sh",
} as const;
export type InstallScriptName = keyof typeof INSTALL_SCRIPTS;

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The version the placeholders fall back to when no agent is shipped (a development checkout). */
export const FALLBACK_AGENT_VERSION = "0.1.0";

export function agentRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env.RESTOW_AGENT_DIR?.trim();
  if (configured) {
    return configured;
  }
  if (existsSync("/srv/agent")) {
    return "/srv/agent";
  }
  // A development checkout: what agent/build.sh leaves in <repo>/agent/dist.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [here, process.cwd()]) {
    let current = start;
    for (let depth = 0; depth < 10; depth++) {
      const candidate = join(current, "agent", "dist");
      if (existsSync(join(candidate, "VERSION"))) {
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return "/srv/agent";
}

export function isDistributionTarget(value: string): boolean {
  return DISTRIBUTION_TARGETS.includes(value);
}

export function isAgentVersion(value: string): boolean {
  return VERSION.test(value);
}

export function isDistributionFile(value: string): boolean {
  return FILE_NAME.test(value);
}

interface Parsed {
  core: [number, number, number];
  prerelease: string | null;
}

function parse(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? null,
  };
}

/** Negative when `a` is older than `b`; a pre-release precedes its release. */
export function compareAgentVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) {
    return (left ? 1 : 0) - (right ? 1 : 0);
  }
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] as number) - (right.core[index] as number);
    if (difference !== 0) {
      return difference;
    }
  }
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

/**
 * The version a development build announces in `<root>/VERSION`. The image
 * uses versioned folders (`<root>/<version>/<os>-<arch>/`); `agent/build.sh`
 * leaves the targets directly under `agent/dist/` next to a `VERSION` file.
 */
async function flatVersion(root: string): Promise<string | null> {
  try {
    const version = (await readFile(join(root, "VERSION"), "utf8")).trim().replace(/^v/, "");
    return isAgentVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** The shipped agent versions, newest first. */
export async function listAgentVersions(root = agentRoot()): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const versions = names.filter(isAgentVersion);
  const flat = await flatVersion(root);
  if (flat && !versions.includes(flat)) {
    versions.push(flat);
  }
  return versions.sort((a, b) => compareAgentVersions(b, a));
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
    if (candidate === join(root, target) && (await flatVersion(root)) !== version) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * `SHA256SUMS` as file name -> hash (`<hash>  <name>` and `<hash> *<name>`). A
 * line that names a folder (`linux-amd64/restow-agent`, from a list that covers
 * every target) only counts for that target.
 */
export function parseChecksums(text: string, target?: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(?:(.*)\/)?([^/\s]+)\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const folder = match[2];
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
    if (path === join(root, "SHA256SUMS") && (await flatVersion(root)) !== version) {
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

/** The files that cover a whole release: the checksums and the maintainer's signature over them. */
export const RELEASE_FILES = ["SHA256SUMS", "SHA256SUMS.sig"] as const;
export type ReleaseFileName = (typeof RELEASE_FILES)[number];

export function isReleaseFile(value: string): value is ReleaseFileName {
  return (RELEASE_FILES as readonly string[]).includes(value);
}

/**
 * The bytes of a release-wide file (`<root>/<version>/SHA256SUMS` or `.sig`;
 * in a development layout `<root>/SHA256SUMS` for the version in VERSION), or
 * null. They are served exactly as stored: the signature covers these bytes.
 */
export async function readReleaseFile(
  version: string,
  name: ReleaseFileName,
  root = agentRoot(),
): Promise<Buffer | null> {
  if (!isAgentVersion(version) || !isReleaseFile(name)) {
    return null;
  }
  const candidates = [join(root, version, name)];
  if ((await flatVersion(root)) === version) {
    candidates.push(join(root, name));
  }
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.size <= 1024 * 1024) {
        return await readFile(path);
      }
    } catch {
      // try the next
    }
  }
  return null;
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
    const sha256 = sums.get("restow-agent");
    if (sha256) {
      return { version, target, sha256, file: "restow-agent" };
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

/** Candidate folders that hold the install scripts, most specific first. */
export function installScriptFolders(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const folders: string[] = [];
  if (env.RESTOW_AGENT_INSTALL_DIR?.trim()) {
    folders.push(env.RESTOW_AGENT_INSTALL_DIR.trim());
  }
  folders.push(join(agentRoot(env), "install"));
  // A development checkout: <repo>/agent/install, found from this file and from the working directory.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const start of [here, process.cwd()]) {
    let current = start;
    for (let depth = 0; depth < 10; depth++) {
      folders.push(join(current, "agent", "install"));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return folders;
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

/** One OpenSSH Ed25519 public key line, safe inside single quotes of a shell script. */
const RELEASE_KEY_LINE = /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:={0,2})?(?: [A-Za-z0-9._@-]{1,64})?$/;

/** Whether a line is a usable release signing key (not the placeholder, nothing to escape). */
export function isReleaseKey(line: string): boolean {
  return RELEASE_KEY_LINE.test(line);
}

/**
 * The release signing public key the install scripts verify with: the first
 * key line of `release-signing.pub` next to the install scripts' folder
 * (`/srv/agent/release-signing.pub` in the image, `agent/release-signing.pub`
 * in a checkout). "" when there is none or it is still the placeholder; the
 * scripts then install development builds only.
 */
export async function readReleaseKey(
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const folders = installScriptFolders(env);
  const candidates = [
    ...folders.map((folder) => join(folder, "release-signing.pub")),
    ...folders.map((folder) => join(folder, "..", "release-signing.pub")),
  ];
  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const line = text
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value !== "" && !value.startsWith("#"));
    return line && isReleaseKey(line) ? line : "";
  }
  return "";
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
