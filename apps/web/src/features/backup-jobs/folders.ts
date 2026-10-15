import { LIMITS } from "./api.js";
import { hasControlCharacters } from "./exclusions.js";

/**
 * The folders of a machine job as a list of absolute paths, and the rules the
 * folder tree and the typed paths share. A folder covers everything below it, so
 * a path below a chosen folder adds nothing and choosing a folder takes the paths
 * below it out of the list.
 */

/** The same absolute-path rule as the API: starts with `/` or a drive letter. */
export function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/])/.test(value);
}

export type PathProblem = "empty" | "controlCharacters" | "notAbsolute" | "tooLong";

/** What the API would refuse about one path (absolute, no control characters, at most 1024 characters). */
export function pathProblem(path: string): PathProblem | null {
  const clean = path.trim();
  if (clean === "") return "empty";
  if (hasControlCharacters(clean)) return "controlCharacters";
  if (!isAbsolutePath(clean)) return "notAbsolute";
  if (clean.length > LIMITS.pathLength) return "tooLong";
  return null;
}

/** A path without its trailing separators (`/var/www/` is `/var/www`); a root stays as it is. */
export function normalizePath(path: string): string {
  const clean = path.trim();
  if (clean === "/" || /^[A-Za-z]:[\\/]$/.test(clean)) {
    return clean;
  }
  return clean.replace(/[\\/]+$/, "") || clean;
}

function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Whether `path` is `folder` or lies below it. */
export function isInside(folder: string, path: string): boolean {
  const base = normalizePath(folder);
  const target = normalizePath(path);
  if (target === base) {
    return true;
  }
  const separator = separatorOf(base);
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  return target.startsWith(prefix);
}

/** Whether a chosen folder covers `path` (or is `path`). */
export function isCovered(paths: readonly string[], path: string): boolean {
  return paths.some((chosen) => isInside(chosen, path));
}

/** Whether `path` itself is in the list. */
export function isChosen(paths: readonly string[], path: string): boolean {
  const target = normalizePath(path);
  return paths.some((chosen) => normalizePath(chosen) === target);
}

/** The list with `path` added; the paths below it go (it covers them), a covered path adds nothing. */
export function addFolder(paths: readonly string[], path: string): string[] {
  const target = normalizePath(path);
  if (isCovered(paths, target)) {
    return [...paths];
  }
  return [...paths.filter((chosen) => !isInside(target, chosen)), target];
}

/** The list without `path` itself (a folder below a chosen folder cannot be taken out of it). */
export function removeFolder(paths: readonly string[], path: string): string[] {
  const target = normalizePath(path);
  return paths.filter((chosen) => normalizePath(chosen) !== target);
}

/** The check box of the tree: chosen folders come out, others go in. */
export function toggleFolder(paths: readonly string[], path: string): string[] {
  return isChosen(paths, path) ? removeFolder(paths, path) : addFolder(paths, path);
}

/** The names a path is made of, for the label of a tree row. */
export function baseName(path: string): string {
  const clean = normalizePath(path);
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.length === 0 ? clean : (parts[parts.length - 1] as string);
}

export type PathsProblem =
  | { code: "none" }
  | { code: "tooMany"; max: number }
  | { code: PathProblem; value: string; max?: number };

/** The first thing wrong with the whole list of folders, or null. */
export function pathsProblem(paths: readonly string[]): PathsProblem | null {
  if (paths.length === 0) {
    return { code: "none" };
  }
  if (paths.length > LIMITS.paths) {
    return { code: "tooMany", max: LIMITS.paths };
  }
  for (const path of paths) {
    const problem = pathProblem(path);
    if (problem) {
      return {
        code: problem,
        value: path,
        ...(problem === "tooLong" ? { max: LIMITS.pathLength } : {}),
      };
    }
  }
  return null;
}

/**
 * Where Linux applications keep their data: software and its files under /opt
 * and /usr/local, databases under /var/lib (PostgreSQL, MySQL; Docker's own
 * folders there are excluded by default), dumps under /var/backups, web roots and service data under
 * /srv and /var/www, and the home folders. The server profile's default folders
 * beyond /etc (packages/core/src/endpoints/config.ts); a job without them backs
 * up little more than the configuration of a server or LXC container.
 */
export const LINUX_DATA_FOLDERS = [
  "/home",
  "/root",
  "/srv",
  "/var/www",
  "/opt",
  "/usr/local",
  "/var/lib",
  "/var/backups",
] as const;

/** The Linux data folders `paths` does not cover, in the order of {@link LINUX_DATA_FOLDERS}. */
export function uncoveredDataFolders(paths: readonly string[]): string[] {
  return LINUX_DATA_FOLDERS.filter((folder) => !isCovered(paths, folder));
}

// --- Data folders an agent found (#59) --------------------------------------------------------
// The same rules as @restow/core `endpoints/data-folders.ts` (the server checks with those): a
// folder of the job covers what is below it, a restic exclusion takes out what it matches and
// everything below, the last matching pattern decides and `!` takes a path back in.

function partsOf(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
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

/** Whether a restic exclude pattern (without its `!`) matches `path` or one of its parents. */
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
      result = si > 0;
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

/** Whether restic leaves out `path` itself: the last matching pattern decides. */
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

/** Whether these folders and exclusions back up `folder` (and every folder on the way to it). */
export function isFolderBackedUp(
  paths: readonly string[],
  excludes: readonly string[],
  folder: string,
): boolean {
  const target = partsOf(folder);
  return paths.some((path) => {
    if (!path.startsWith("/") || !isInside(path, folder)) return false;
    for (let depth = partsOf(path).length; depth <= target.length; depth++) {
      if (isExcludedPath(excludes, `/${target.slice(0, depth).join("/")}`)) return false;
    }
    return true;
  });
}

/**
 * The folders and exclusions with a data folder added: it joins the paths unless one covers it,
 * an exclusion that names it goes, and one that names a parent of it is narrowed to everything in
 * that parent but the way to it (`/var/lib/docker/*`, `!/var/lib/docker/volumes`).
 */
export function withDataFolder(
  selection: { paths: readonly string[]; excludes: readonly string[] },
  folder: string,
): { paths: string[]; excludes: string[] } {
  const target = normalizePath(folder);
  const paths = addFolder(selection.paths, target);
  const targetParts = partsOf(target);
  const excludes: string[] = [];
  for (const raw of selection.excludes) {
    const pattern = normalizePath(raw);
    const literal = pattern.startsWith("/") && !GLOB_CHARS.test(pattern);
    if (!literal || !isInside(pattern, target)) {
      excludes.push(raw);
      continue;
    }
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

/** A data folder a job leaves out, with the machines that have it. */
export interface MissingDataFolder {
  folder: string;
  machines: string[];
}

/**
 * The data folders the machines' agents found that these folders and exclusions do not back up,
 * each with the names of the machines that have it, in the order of first appearance. Machines
 * with folders or exclusions of their own in the job are left to their own settings.
 */
export function missingReportedFolders(
  machines: readonly { name: string; folders: readonly string[] | null }[],
  paths: readonly string[],
  excludes: readonly string[],
): MissingDataFolder[] {
  const found = new Map<string, string[]>();
  for (const machine of machines) {
    for (const folder of machine.folders ?? []) {
      if (isFolderBackedUp(paths, excludes, folder)) continue;
      const names = found.get(folder) ?? [];
      if (!names.includes(machine.name)) names.push(machine.name);
      found.set(folder, names);
    }
  }
  return [...found].map(([folder, names]) => ({ folder, machines: names }));
}
