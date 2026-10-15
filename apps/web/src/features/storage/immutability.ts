import type { Tone } from "./presenters";
import type {
  ImmutabilityDto,
  ImmutabilityMode,
  RestorePointImmutability,
  StorageKind,
} from "./types";

/**
 * Immutable backups as the repository page and the restore points show them
 * (docs/STORAGE.md, "Immutable backups"). Pure: i18n keys of the `storage`
 * namespace with their values, and tones. Never green here: a repository's
 * setting is a promise; only a restore point's retention the storage itself
 * confirmed ({@link restorePointBadge}) is proof.
 */

export interface ImmutabilityLine {
  tone: Tone;
  key: string;
  values?: Record<string, string | number>;
}

/** The modes a repository of `kind` can be given. */
export function availableModes(kind: StorageKind): readonly ImmutabilityMode[] {
  return kind === "s3" ? ["compliance", "governance"] : ["delayed_deletion"];
}

const STRENGTH: Record<ImmutabilityMode, number> = {
  delayed_deletion: 1,
  governance: 2,
  compliance: 3,
};

/** Whether the change weakens what is written from now on (fewer days, weaker mode, off). */
export function lowers(
  current: { mode: ImmutabilityMode | null; days: number },
  next: { mode: ImmutabilityMode | null; days: number },
): boolean {
  if (!current.mode || current.days <= 0) {
    return false;
  }
  if (!next.mode || next.days <= 0) {
    return true;
  }
  return next.days < current.days || STRENGTH[next.mode] < STRENGTH[current.mode];
}

/** The headline of the setting on the repository card. */
export function immutabilityHeadline(
  immutability: ImmutabilityDto | undefined,
  kind: StorageKind,
  objectLockEnabled: boolean,
): ImmutabilityLine {
  if (!immutability?.mode) {
    if (kind === "s3") {
      return {
        tone: "neutral",
        key: objectLockEnabled ? "immutability.offObjectLock" : "immutability.offNoObjectLock",
      };
    }
    return { tone: "neutral", key: "immutability.offDirectory" };
  }
  if (immutability.kind === "deletion_delay") {
    return {
      tone: "neutral",
      key: "immutability.deletionDelayOn",
      values: { days: immutability.days },
    };
  }
  return {
    tone: "ok",
    key:
      immutability.mode === "compliance"
        ? "immutability.complianceOn"
        : "immutability.governanceOn",
    values: { days: immutability.days },
  };
}

/** What the worker last found out, and warnings first. */
export function immutabilityDetails(
  immutability: ImmutabilityDto | undefined,
  format: { date: (iso: string) => string },
): ImmutabilityLine[] {
  if (!immutability) {
    return [];
  }
  const lines: ImmutabilityLine[] = [];
  const verification = immutability.verification;
  const active = immutability.mode !== null && immutability.kind === "object_lock";
  if (active && verification && verification.unlocked > 0) {
    lines.push({
      tone: "warning",
      key: "immutability.unlockedFound",
      values: { count: verification.unlocked, sampled: verification.sampled },
    });
  }
  if (active && verification && verification.weakerMode > 0) {
    lines.push({
      tone: "warning",
      key: "immutability.weakerModeFound",
      values: { count: verification.weakerMode },
    });
  }
  if (active && immutability.renewalOverdue) {
    lines.push({
      tone: "warning",
      key: "immutability.renewalOverdue",
      values: { days: immutability.days },
    });
  }
  if (active && immutability.renewal && immutability.renewal.failed > 0) {
    lines.push({
      tone: "warning",
      key: "immutability.renewalFailed",
      values: { count: immutability.renewal.failed },
    });
  }
  if (active && immutability.renewedAt) {
    lines.push({
      tone: "neutral",
      key: "immutability.renewedAt",
      values: { date: format.date(immutability.renewedAt) },
    });
  } else if (active) {
    lines.push({ tone: "neutral", key: "immutability.notRenewedYet" });
  }
  if (active && verification && verification.unlocked === 0 && verification.weakerMode === 0) {
    lines.push({
      tone: "neutral",
      key: "immutability.verifiedAt",
      values: {
        date: format.date(verification.checkedAt),
        locked: verification.locked,
        sampled: verification.sampled,
      },
    });
  }
  if (immutability.deferredDeletions > 0) {
    lines.push({
      tone: "neutral",
      key: "immutability.deferred",
      values: { count: immutability.deferredDeletions },
    });
  }
  return lines;
}

/**
 * The badge of a restore point. `proven` (green) only for a COMPLIANCE
 * retention the storage itself reported beyond now; a GOVERNANCE lock and a
 * directory's deletion delay are shown, but neutral.
 */
export function restorePointBadge(
  result: RestorePointImmutability | undefined,
): { tone: "proven" | "neutral" | "none"; key: string; until: string | null } | null {
  if (!result || result.targets.length === 0) {
    // No immutable repository: nothing to say on every restore point.
    return null;
  }
  switch (result.state) {
    case "immutable":
      return { tone: "proven", key: "immutability.badge.immutable", until: result.until };
    case "governance":
      return { tone: "neutral", key: "immutability.badge.governance", until: result.until };
    case "delayed":
      return { tone: "neutral", key: "immutability.badge.delayed", until: result.until };
    default:
      return { tone: "none", key: "immutability.badge.none", until: null };
  }
}
