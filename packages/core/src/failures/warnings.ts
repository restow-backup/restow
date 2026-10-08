/**
 * Warnings of protected objects and machines, and what acknowledging one means.
 *
 * A backup run that went through but left items behind (a mail run that
 * completed with failed items, a machine run the agent reported `partial`) is a
 * warning: the object is backed up, only not completely. An operator who has
 * looked at the cause and decided to live with it (a damaged message, a file
 * that is always locked) acknowledges the warning. From then on the warning no
 * longer counts in the overview, the status API, the directory badges and the
 * tile on the start page, until a new and different problem appears:
 *
 *   - a cause that was not acknowledged (another reason for failed items), or
 *   - a later run of the object that failed outright.
 *
 * Then the warning is open again, and the old acknowledgement stays visible as
 * the one that no longer covers it.
 *
 * An acknowledgement never hides a failed backup: a run that failed outright
 * ("not backed up") stays red whatever was acknowledged before, and it cannot
 * be acknowledged at all. A warning says the backup is incomplete; a failure
 * says there is no new backup, and only a successful run ends that.
 *
 * Everything here is pure; apps/api reads the facts and applies these rules
 * in one place (features/warnings).
 */

/** The cause key of an item failure without a classified cause (rows from before causes were kept). */
export const UNKNOWN_WARNING_CAUSE = "unknown";

/** How the newest finished backup run of an object or machine ended. */
export type BackupOutcome = "succeeded" | "partial" | "failed";

export interface LatestBackupFact {
  /** The run (a mail job or a machine run). */
  readonly runId: string;
  readonly outcome: BackupOutcome;
  /** When it finished (ISO 8601). */
  readonly finishedAt: string;
  /** Items (or files) the run could not back up. */
  readonly failedItems: number;
  /** The cause codes behind them, normalised with {@link normalizeCauses}. */
  readonly causes: readonly string[];
}

export interface WarningAckFact {
  /** When the warning was acknowledged (ISO 8601). */
  readonly acknowledgedAt: string;
  /** The causes the acknowledgement covers (normalised). */
  readonly causes: readonly string[];
  /** The run that was looked at when it was acknowledged. */
  readonly runId: string | null;
}

/**
 *   none          nothing to report: no finished backup yet, or the newest one is complete
 *   failed        the newest backup failed outright: red, never covered by an acknowledgement
 *   open          the newest backup left items behind and no acknowledgement covers it
 *   acknowledged  the newest backup left items behind, all for causes someone acknowledged
 */
export type WarningState = "none" | "failed" | "open" | "acknowledged";

export interface WarningEvaluation {
  readonly state: WarningState;
  /** The causes of the newest run's failed items (empty unless open or acknowledged). */
  readonly causes: readonly string[];
  /** Causes of the newest run the acknowledgement does not cover. */
  readonly newCauses: readonly string[];
  /**
   * An acknowledgement exists but no longer counts: a new cause appeared, or a run failed
   * outright after it. The page shows it as superseded; acknowledging again replaces it.
   */
  readonly ackSuperseded: boolean;
}

/** Cause codes as a set: unique, sorted, a missing code read as {@link UNKNOWN_WARNING_CAUSE}. */
export function normalizeCauses(codes: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const code of codes) {
    const trimmed = typeof code === "string" ? code.trim() : "";
    set.add(trimmed.length > 0 && trimmed.length <= 80 ? trimmed : UNKNOWN_WARNING_CAUSE);
  }
  return [...set].sort();
}

/** Whether the newest run of an object is a warning: it went through and left items behind. */
export function isWarning(latest: LatestBackupFact | null): latest is LatestBackupFact {
  return latest !== null && latest.outcome === "partial";
}

/**
 * The warning state of one object or machine.
 *
 * `failedSinceAck` says whether a backup run of the object failed outright after the
 * acknowledgement was given (even if a later run went through again): a failure in between is
 * a new problem, and the warning shows again until someone looks at it anew.
 */
export function evaluateWarning(
  latest: LatestBackupFact | null,
  ack: WarningAckFact | null,
  failedSinceAck: boolean,
): WarningEvaluation {
  if (latest === null || latest.outcome === "succeeded") {
    return { state: "none", causes: [], newCauses: [], ackSuperseded: false };
  }
  if (latest.outcome === "failed") {
    // Never hidden: an acknowledgement covers warnings, not failures.
    return { state: "failed", causes: [], newCauses: [], ackSuperseded: ack !== null };
  }
  const causes = latest.causes.length > 0 ? [...latest.causes] : [UNKNOWN_WARNING_CAUSE];
  if (ack === null) {
    return { state: "open", causes, newCauses: causes, ackSuperseded: false };
  }
  const covered = new Set(ack.causes);
  const newCauses = causes.filter((cause) => !covered.has(cause));
  if (newCauses.length > 0 || failedSinceAck) {
    return { state: "open", causes, newCauses, ackSuperseded: true };
  }
  return { state: "acknowledged", causes, newCauses: [], ackSuperseded: false };
}

export type AcknowledgeRefusal = "no_warning" | "failed";

/**
 * Whether the current state of an object may be acknowledged: only a warning can be. A failed
 * backup cannot (it stays red until a run succeeds); nothing to report needs no acknowledgement.
 */
export function acknowledgeRefusal(latest: LatestBackupFact | null): AcknowledgeRefusal | null {
  if (latest === null || latest.outcome === "succeeded") {
    return "no_warning";
  }
  return latest.outcome === "failed" ? "failed" : null;
}

/** The longest note an acknowledgement keeps. */
export const MAX_ACK_NOTE_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Where a failed item is
// ---------------------------------------------------------------------------

export interface FailedItemLocation {
  /** The area of a mailbox (mail, calendar, contacts) when the path names one. */
  area: "mail" | "calendar" | "contacts" | null;
  /** The folder the item is in, without the area; null at the top. */
  folder: string | null;
  /** The subject, file name or display name, as the path carries it. */
  name: string;
  /** The short id digest (mail) or UID (IMAP) that tells two equal names apart; null when none. */
  itemId: string | null;
}

const AREAS = new Set(["mail", "calendar", "contacts"]);
/** `<name>.<16 hex digest>[.eml|.json]`: the item names of a mailbox snapshot (backup/exchange/paths.ts). */
const DIGEST_NAME = /^(.*)\.([0-9a-f]{16})(?:\.(?:eml|json))?$/;
/** `<uid>.eml`: a message of an IMAP snapshot (backup/imap/paths.ts). */
const UID_NAME = /^(\d+)\.eml$/;

/**
 * Split the reference of a failed item into folder, name and id, so the operator can find it at
 * the source. Works on the object paths the engines record (mailbox items, IMAP messages,
 * OneDrive files); anything else stays whole in `name`.
 */
export function locateFailedItem(itemRef: string): FailedItemLocation {
  const segments = itemRef.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { area: null, folder: null, name: itemRef, itemId: null };
  }
  let area: FailedItemLocation["area"] = null;
  if (segments.length > 1 && AREAS.has(segments[0] as string)) {
    area = segments.shift() as FailedItemLocation["area"];
  }
  const last = segments.pop() as string;
  const folder = segments.length > 0 ? segments.join("/") : null;
  const digest = DIGEST_NAME.exec(last);
  if (digest) {
    return { area, folder, name: digest[1] as string, itemId: digest[2] as string };
  }
  const uid = UID_NAME.exec(last);
  if (uid) {
    return { area, folder, name: last, itemId: uid[1] as string };
  }
  return { area, folder, name: last, itemId: null };
}
