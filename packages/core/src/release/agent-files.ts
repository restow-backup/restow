/**
 * The agent releases this installation ships, and the release signing key (docs/AGENT.md,
 * "Distribution"; docs/BAREMETAL.md 8.5). Moved here from apps/api so the worker reads the same
 * files with the same rules: the image ships `/srv/agent/<version>/` with the signed `SHA256SUMS`
 * of each release, and `release-signing.pub` next to the install scripts. `RESTOW_AGENT_DIR` and
 * `RESTOW_AGENT_INSTALL_DIR` move either; a development checkout reads `agent/dist` and
 * `agent/install` of the repository.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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

export function isAgentVersion(value: string): boolean {
  return VERSION.test(value);
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
export async function flatAgentVersion(root: string): Promise<string | null> {
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
  const flat = await flatAgentVersion(root);
  if (flat && !versions.includes(flat)) {
    versions.push(flat);
  }
  return versions.sort((a, b) => compareAgentVersions(b, a));
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
  if ((await flatAgentVersion(root)) === version) {
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
