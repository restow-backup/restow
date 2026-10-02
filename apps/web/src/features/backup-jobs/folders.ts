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
