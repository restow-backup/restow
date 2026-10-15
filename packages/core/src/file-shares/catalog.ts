/**
 * The search catalog of a file share (docs/FILESHARES.md 8.5): one row per version of a file,
 * valid from the restore point (sequence) that first had it up to the first one that no longer
 * has it. After each successful backup the worker reads `restic diff --json <previous> <new>`
 * (or, for the first backup, `restic ls --json <new>`), and these pure functions turn restic's
 * lines into what changes: a `+` opens a version, a `-` closes one, any other modifier closes
 * the old version and opens a new one. Only files are catalogued (folders follow from the paths),
 * and only below the share root: the runner's `/.restow` folder is never in it.
 */
import { SHARE_SNAPSHOT_ROOT, shareRelativePath } from "./model.js";

/** A path longer than this is not catalogued (an index entry must fit a btree page). */
export const MAX_CATALOG_PATH_BYTES = 2000;

export interface CatalogChange {
  /** Relative to the share root. */
  path: string;
  /** `open`: a new version from this restore point on; `close`: the version ends here; `both`. */
  action: "open" | "close" | "both";
}

/** One line of `restic diff --json` as a catalog change, or null (folders, statistics, others). */
export function catalogChangeOf(
  line: string,
  root: string = SHARE_SNAPSHOT_ROOT,
): CatalogChange | null {
  if (!line.startsWith("{")) {
    return null;
  }
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.message_type !== "change" || typeof row.path !== "string") {
    return null;
  }
  const path = row.path;
  if (path.endsWith("/")) {
    return null;
  }
  const relative = shareRelativePath(path, root);
  if (relative === null || relative === "" || !catalogPathFits(relative)) {
    return null;
  }
  switch (row.modifier) {
    case "+":
      return { path: relative, action: "open" };
    case "-":
      return { path: relative, action: "close" };
    default:
      return { path: relative, action: "both" };
  }
}

export interface CatalogNode {
  /** Relative to the share root. */
  path: string;
  name: string;
  size: number;
  mtime: Date | null;
}

/** One line of `restic ls --json` as a catalogued file, or null (folders, links, the snapshot). */
export function catalogNodeOf(
  line: string,
  root: string = SHARE_SNAPSHOT_ROOT,
): CatalogNode | null {
  if (!line.startsWith("{")) {
    return null;
  }
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.struct_type === "snapshot" || row.message_type === "snapshot" || row.type !== "file") {
    return null;
  }
  if (typeof row.path !== "string") {
    return null;
  }
  const relative = shareRelativePath(row.path, root);
  if (relative === null || relative === "" || !catalogPathFits(relative)) {
    return null;
  }
  const mtime = typeof row.mtime === "string" ? new Date(row.mtime) : null;
  return {
    path: relative,
    name: typeof row.name === "string" ? row.name : (relative.split("/").at(-1) ?? relative),
    size: typeof row.size === "number" && Number.isFinite(row.size) ? row.size : 0,
    mtime: mtime && !Number.isNaN(mtime.getTime()) ? mtime : null,
  };
}

/** Whether a path can be catalogued at all. */
export function catalogPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= MAX_CATALOG_PATH_BYTES;
}

/** The paths a diff closes and the paths it opens (a path changed twice counts once). */
export function catalogPlan(changes: Iterable<CatalogChange>): { close: string[]; open: string[] } {
  const close = new Set<string>();
  const open = new Set<string>();
  for (const change of changes) {
    if (change.action !== "open") {
      close.add(change.path);
    }
    if (change.action !== "close") {
      open.add(change.path);
    }
  }
  return { close: [...close], open: [...open] };
}

/** Whether a version is in restore point `sequence`. */
export function versionIn(
  version: { firstSeq: number; endSeq: number | null },
  sequence: number,
): boolean {
  return version.firstSeq <= sequence && (version.endSeq === null || version.endSeq > sequence);
}

/**
 * Whether a version is still in any of the active restore points (retention removed the others);
 * a version no active restore point has is deleted from the catalog.
 */
export function versionAlive(
  version: { firstSeq: number; endSeq: number | null },
  activeSequences: readonly number[],
): boolean {
  return activeSequences.some((sequence) => versionIn(version, sequence));
}
