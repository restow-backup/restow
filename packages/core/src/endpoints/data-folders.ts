/**
 * Data folders an agent reports and whether a machine's folders back them up (#59).
 *
 * An agent of release 0.4.0 or later looks at a fixed, small set of folders where Linux
 * applications keep their data and reports the ones that exist and hold at least one file
 * ({@link DATA_FOLDER_CANDIDATES}; agent/internal/sysinfo/datafolders.go has the same list). It
 * reports names only: no file names, no sizes. The job editor and the machine's page say which of
 * them a job leaves out and offer to add them.
 *
 * Whether a folder is backed up follows restic: a folder of the job covers everything below it,
 * and an exclusion pattern takes out what it matches and everything below
 * ({@link isFolderBackedUp}). The Linux defaults exclude `/var/lib/docker` (images are pulled
 * again), which also takes out Docker's named volumes; adding them to a job rewrites that
 * exclusion so that only the volumes come back ({@link withDataFolder}).
 */

import type { EndpointOsName, EndpointProfileName } from "./config.js";

/**
 * The folders an agent checks, per operating system. Linux only: macOS keeps its data under
 * /Users, which both profiles back up, and Windows is not enrolled yet (a guess at data drives
 * would warn about what an administrator left out on purpose).
 *
 * Not in the list on purpose: /var/lib as a whole (every system has package state there; the
 * databases are named instead), /var/backups (dpkg's own copies), /home and /root (in every
 * default and full of dot files on every machine).
 */
export const DATA_FOLDER_CANDIDATES: Readonly<Record<EndpointOsName, readonly string[]>> = {
  linux: [
    "/opt",
    "/usr/local",
    "/srv",
    "/var/www",
    "/var/lib/docker/volumes",
    "/var/lib/containers/storage/volumes",
    "/var/lib/postgresql",
    "/var/lib/pgsql",
    "/var/lib/mysql",
    "/var/lib/mongodb",
  ],
  darwin: [],
  windows: [],
};

/**
 * The folders of a report the server keeps: the candidates of the machine's system, each once, in
 * the order of {@link DATA_FOLDER_CANDIDATES}. Anything else an agent sends (a later release may
 * check more) is dropped. Null when the agent sent no report (releases before 0.4.0).
 */
export function cleanDataFolderReport(os: string, folders: unknown): string[] | null {
  if (!Array.isArray(folders)) {
    return null;
  }
  const candidates = DATA_FOLDER_CANDIDATES[os as EndpointOsName] ?? [];
  const reported = new Set(folders.filter((folder) => typeof folder === "string"));
  return candidates.filter((candidate) => reported.has(candidate));
}

/** The folders and exclusions a machine backs up with. */
export interface FolderSelection {
  paths: readonly string[];
  excludes: readonly string[];
}

function partsOf(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

/** A path without trailing slashes; `/` stays. */
function normalize(path: string): string {
  const clean = path.trim();
  return clean === "/" ? clean : clean.replace(/\/+$/, "") || clean;
}

/** Whether `path` is `folder` or lies below it (POSIX paths). */
export function isInsideFolder(folder: string, path: string): boolean {
  const base = partsOf(normalize(folder));
  const target = partsOf(normalize(path));
  if (!folder.trim().startsWith("/") || !path.trim().startsWith("/")) {
    return false;
  }
  return base.length <= target.length && base.every((part, index) => part === target[index]);
}

const GLOB_CHARS = /[*?[\\]/;

function componentRegex(component: string): RegExp {
  let source = "";
  for (let index = 0; index < component.length; index++) {
    const char = component[index] as string;
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "\\" && index + 1 < component.length) {
      index++;
      source += (component[index] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "[") {
      const end = component.indexOf("]", index + 1);
      if (end > index + 1) {
        const body = component
          .slice(index + 1, end)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        source += `[${body}]`;
        index = end;
      } else {
        source += "\\[";
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/**
 * Whether a restic exclude pattern (without its `!`) matches `path`. As restic does: a pattern
 * matches a path when it matches the path or one of its parents; a pattern that does not start
 * with `/` may match from any folder on (`*.tmp`, `**\/.cache`), and `**` stands for any number of
 * folders.
 */
export function excludePatternMatches(pattern: string, path: string): boolean {
  const clean = pattern.trim();
  const parts = partsOf(clean);
  const pat = clean.startsWith("/") ? parts : ["**", ...parts];
  const target = partsOf(path);
  const memo = new Map<string, boolean>();
  const match = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (pi === pat.length) {
      // The pattern matched the path or one of its parents.
      result = si > 0 || pat.length === 0;
    } else if (pat[pi] === "**") {
      result = false;
      for (let next = si; next <= target.length && !result; next++) {
        result = match(pi + 1, next);
      }
    } else if (si === target.length) {
      result = false;
    } else {
      result =
        componentRegex(pat[pi] as string).test(target[si] as string) && match(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return parts.length > 0 && match(0, 0);
}

/** Whether restic leaves out `path` itself: the last pattern that matches it decides (`!` takes it back in). */
export function isExcludedPath(excludes: readonly string[], path: string): boolean {
  let excluded = false;
  for (const raw of excludes) {
    const pattern = raw.trim();
    if (pattern === "" || pattern.startsWith("#")) continue;
    const negated = pattern.startsWith("!");
    if (excludePatternMatches(negated ? pattern.slice(1) : pattern, path)) {
      excluded = !negated;
    }
  }
  return excluded;
}

/**
 * Whether a backup with these folders and exclusions contains `folder`: a folder of the job is it
 * or one of its parents, and restic does not leave out the folder or a folder on the way to it.
 */
export function isFolderBackedUp(selection: FolderSelection, folder: string): boolean {
  const target = partsOf(folder);
  return selection.paths.some((path) => {
    if (!isInsideFolder(path, folder)) return false;
    for (let depth = partsOf(path).length; depth <= target.length; depth++) {
      if (isExcludedPath(selection.excludes, `/${target.slice(0, depth).join("/")}`)) {
        return false;
      }
    }
    return true;
  });
}

/** The reported folders a machine's folders and exclusions do not back up, in their order. */
export function missingDataFolders(
  reported: readonly string[],
  selection: FolderSelection,
): string[] {
  return reported.filter((folder) => !isFolderBackedUp(selection, folder));
}

/**
 * The folders and exclusions with `folder` added. The folder joins the paths unless one of them
 * already covers it (the paths below it go: it covers them). An exclusion that names the folder
 * goes; one that names a parent of it (`/var/lib/docker` for the Docker volumes) is narrowed to
 * everything in that parent but the way to the folder, with restic's `!` patterns:
 * `/var/lib/docker/*` and `!/var/lib/docker/volumes`. Exclusions with wildcards stay as they are.
 */
export function withDataFolder(selection: FolderSelection, folder: string): FolderSelection {
  const target = normalize(folder);
  const covered = selection.paths.some((path) => isInsideFolder(path, target));
  const paths = covered
    ? [...selection.paths]
    : [...selection.paths.filter((path) => !isInsideFolder(target, path)), target];
  const excludes: string[] = [];
  const targetParts = partsOf(target);
  for (const raw of selection.excludes) {
    const pattern = normalize(raw);
    const literal = pattern.startsWith("/") && !GLOB_CHARS.test(pattern);
    if (!literal || !isInsideFolder(pattern, target)) {
      excludes.push(raw);
      continue;
    }
    // The exclusion is the folder itself or a parent of it.
    for (let depth = partsOf(pattern).length; depth < targetParts.length; depth++) {
      const level = `/${targetParts.slice(0, depth).join("/")}`;
      const next = `/${targetParts.slice(0, depth + 1).join("/")}`;
      for (const line of [`${level}/*`, `!${next}`]) {
        if (!excludes.includes(line)) excludes.push(line);
      }
    }
  }
  return { paths, excludes };
}

/** How the agent sees the machine it runs on (agent 0.4.0 and later). */
export interface MachineFacts {
  /** `container` (LXC, Docker, Podman, systemd-nspawn), `vm`, or `none`. */
  virtualization: "container" | "vm" | "none";
  /** What it runs in, as `systemd-detect-virt` names it (`lxc`, `kvm`, `vmware`); empty when unknown. */
  technology: string;
  /** A graphical desktop session is installed (a session file in /usr/share/xsessions or wayland-sessions). */
  desktop: boolean;
}

/** Why the server took the server profile for a machine enrolled as a client. */
export type ProfileDetectionReason = "container" | "vm";

/**
 * The profile a machine gets at enrollment. The enrollment token names one ("Add server" or "Add
 * client"); a Linux machine enrolled as a client that runs in a container, or in a virtual machine
 * without a desktop, runs services and gets the server profile: its defaults include the folders
 * where applications keep their data (#59). Without facts (an agent before 0.4.0) the token decides.
 */
export function enrollmentProfile(
  requested: EndpointProfileName,
  os: string,
  facts: MachineFacts | null | undefined,
): { profile: EndpointProfileName; reason: ProfileDetectionReason | null } {
  if (requested !== "client" || os !== "linux" || !facts || facts.desktop) {
    return { profile: requested, reason: null };
  }
  if (facts.virtualization === "container" || facts.virtualization === "vm") {
    return { profile: "server", reason: facts.virtualization };
  }
  return { profile: requested, reason: null };
}
