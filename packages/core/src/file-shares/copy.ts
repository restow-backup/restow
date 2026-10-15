/**
 * Scheduled copy jobs (docs/FILESHARES.md 4.10): which restore point a run copies and the safety
 * rules, checked when the job is saved (the api), when a run starts (the dispatcher) and again
 * in the runner (restow-share), since settings can change between them. Pure.
 *
 *   1  the target share allows restores                         share.restore_not_allowed
 *   2  source and target are not the same location              share.copy_unsafe_target
 *   3  mirror never into a share root                           share.copy_unsafe_target
 *   4  mirror needs the job's marker or a confirmation          (runner; the api on save)
 *   5  mirror never copies an empty restore point               share.copy_empty_source
 *   6  mirror refuses fewer than half the files of the last     share.copy_empty_source
 *      copy, unless run by hand with "Copy anyway"
 */
import { isVerifiedRestorePoint } from "./readiness.js";

export interface CopyShareFacts {
  id: string;
  protocol: "smb" | "nfs";
  server: string;
  /** The pinned address, when known (the dispatcher resolved it). */
  address?: string | null;
  shareName: string | null;
  exportPath: string | null;
  subfolder: string;
  allowRestore: boolean;
  retiredAt?: Date | null;
}

export interface CopyJobFacts {
  mode: "overwrite" | "mirror";
  targetFolder: string;
}

export type CopyRule = "restore_not_allowed" | "same_share" | "share_root" | "retired";

export type CopyRuleResult =
  | { ok: true }
  | {
      ok: false;
      code: "share.restore_not_allowed" | "share.copy_unsafe_target";
      rule: CopyRule;
    };

function segments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

/** Whether one segment list is a prefix of the other (case-insensitive for SMB). */
function overlaps(a: readonly string[], b: readonly string[], caseInsensitive: boolean): boolean {
  const n = Math.min(a.length, b.length);
  for (let index = 0; index < n; index++) {
    const left = caseInsensitive ? a[index]?.toLowerCase() : a[index];
    const right = caseInsensitive ? b[index]?.toLowerCase() : b[index];
    if (left !== right) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the target folder lies in the same place as the source (rule 2): the same share, or
 * the same protocol, server (or pinned address) and share or export with overlapping folders.
 */
export function sameShareLocation(
  source: CopyShareFacts,
  target: CopyShareFacts,
  targetFolder: string,
): boolean {
  if (source.id === target.id) {
    return true;
  }
  if (source.protocol !== target.protocol) {
    return false;
  }
  const smb = source.protocol === "smb";
  const sameHost =
    source.server.toLowerCase() === target.server.toLowerCase() ||
    (Boolean(source.address) && source.address === target.address);
  if (!sameHost) {
    return false;
  }
  const sourceRoot = smb ? source.shareName : source.exportPath;
  const targetRoot = smb ? target.shareName : target.exportPath;
  if (!sourceRoot || !targetRoot) {
    return false;
  }
  const rootsEqual = smb
    ? sourceRoot.toLowerCase() === targetRoot.toLowerCase()
    : segments(sourceRoot).join("/") === segments(targetRoot).join("/");
  if (!rootsEqual) {
    return false;
  }
  return overlaps(
    segments(source.subfolder),
    [...segments(target.subfolder), ...segments(targetFolder)],
    smb,
  );
}

/** Rules 1 to 3 (and a retired share): what can be decided from the configuration alone. */
export function checkCopyRules(
  source: CopyShareFacts,
  target: CopyShareFacts,
  job: CopyJobFacts,
): CopyRuleResult {
  if (source.retiredAt || target.retiredAt) {
    return { ok: false, code: "share.copy_unsafe_target", rule: "retired" };
  }
  if (!target.allowRestore) {
    return { ok: false, code: "share.restore_not_allowed", rule: "restore_not_allowed" };
  }
  if (sameShareLocation(source, target, job.targetFolder)) {
    return { ok: false, code: "share.copy_unsafe_target", rule: "same_share" };
  }
  if (job.mode === "mirror" && segments(job.targetFolder).length === 0) {
    return { ok: false, code: "share.copy_unsafe_target", rule: "share_root" };
  }
  return { ok: true };
}

/** Rules 5 and 6: whether a mirror may copy a restore point of `files` files. */
export function checkMirrorCount(
  files: number,
  lastCopiedFiles: number | null,
  force: boolean,
): { ok: true } | { ok: false; code: "share.copy_empty_source"; rule: "empty" | "halved" } {
  if (files <= 0) {
    return { ok: false, code: "share.copy_empty_source", rule: "empty" };
  }
  if (!force && lastCopiedFiles !== null && lastCopiedFiles > 0 && files < lastCopiedFiles / 2) {
    return { ok: false, code: "share.copy_empty_source", rule: "halved" };
  }
  return { ok: true };
}

export interface CopyCandidate {
  id: string;
  resticSnapshotId: string;
  sequence: number;
  files: number;
}

export interface CopyReportFact {
  kind: "restore_test" | "repository_check" | "retention";
  snapshotId: string | null;
  readiness: "green" | "yellow" | "red" | null;
  checkedAt: Date;
}

/** The newest restore point whose restore check passed (4.10), or null. */
export function pickCopyRestorePoint<T extends CopyCandidate>(
  snapshots: readonly T[],
  reports: readonly CopyReportFact[],
): T | null {
  const ordered = [...snapshots].sort((a, b) => b.sequence - a.sequence);
  return ordered.find((snap) => isVerifiedRestorePoint(snap.resticSnapshotId, reports)) ?? null;
}

/** A target folder relative to the target share root, cleaned (`/a//b/` -> `a/b`). */
export function cleanTargetFolder(folder: string): string {
  return segments(folder).join("/");
}
