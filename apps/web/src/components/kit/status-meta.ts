import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Info,
  type LucideIcon,
  Pause,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldOff,
  ShieldQuestionMark,
  ShieldX,
  TriangleAlert,
  Unplug,
  Wrench,
} from "lucide-react";

// The labels live in the `ui` namespace (and the feature namespaces some families keep).
import "./i18n.js";
import type { StatusTone } from "./status-badge.js";

/**
 * The single source of the UI's status vocabulary (UI rework, phase 1): every
 * status of a family (an object's readiness, a tenant's overall readiness, one
 * backup's verification, a run, a job, ...) maps to a severity, a label, an
 * icon and a pattern here, and the severity to one tone (status-badge.tsx),
 * so badges, dots, bar segments, legends, chips, table columns and filters say
 * the same thing in the same colour on every page. Colour never carries the
 * meaning alone: every entry has its own icon, and Unverified is hatched.
 *
 * The readiness rule mirrors packages/core/src/verify/readiness-aggregate.ts
 * (the web cannot import @restow/core); status-meta.test.ts tests the same
 * cases as the core's test.
 *
 * Out of scope for phase 1, so their own maps stay where they are: updates,
 * integrations, accounts, the tenant status, sources, the journal, the archive
 * stream and the notification level. They are not readiness, run, job,
 * verification, storage, machine, guest, share or mailbox families and move in
 * the page pass (phase 4).
 */

// -- severities and tones --------------------------------------------------------------

/** How severe a status is, worst first (= StatusSeverity of @restow/core). */
export type Severity =
  | "danger"
  | "attention"
  | "warning"
  | "info"
  | "neutral"
  | "success"
  | "muted";

/** Sort rank of a severity: the worst first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  danger: 0,
  attention: 1,
  warning: 2,
  info: 3,
  neutral: 4,
  success: 5,
  muted: 6,
};

/** The tone that shows a severity. */
export const SEVERITY_TONE: Readonly<Record<Severity, StatusTone>> = {
  danger: "destructive",
  attention: "attention",
  warning: "warning",
  info: "info",
  neutral: "neutral",
  success: "success",
  muted: "muted",
};

/** Solid where the tone fills its segment; hatched (stripes over the track) for Unverified. */
export type StatusPattern = "solid" | "hatched";

export interface StatusMeta {
  /** Stable name of the entry, rendered as `data-category` (tests and styles find it by that). */
  id: string;
  severity: Severity;
  /** Fully qualified translation key (`ns:key`), e.g. `ui:status.readiness.ready`. */
  labelKey: string;
  icon: LucideIcon;
  pattern: StatusPattern;
  /** Something runs right now: a pulsing dot instead of the icon in a badge. */
  live?: boolean;
}

export function toneOf(meta: Pick<StatusMeta, "severity">): StatusTone {
  return SEVERITY_TONE[meta.severity];
}

/** The solid fill of each tone: bar segments, dots and legend swatches. */
export const STATUS_FILL: Readonly<Record<StatusTone, string>> = {
  success: "bg-success",
  attention: "bg-attention-fg",
  warning: "bg-warning",
  destructive: "bg-destructive",
  info: "bg-info",
  muted: "bg-muted-foreground",
  neutral: "bg-foreground",
};

/**
 * The text-safe colour of each tone, for icons and words beside a figure (tiles, legends,
 * finding lists). The `-text` tokens keep 4.5:1 on the card and the page in every look,
 * which the base tones (amber, green) do not in light.
 */
export const STATUS_TEXT: Readonly<Record<StatusTone, string>> = {
  success: "text-success-text",
  attention: "text-attention-fg",
  warning: "text-warning-text",
  destructive: "text-destructive-text",
  info: "text-info-text",
  muted: "text-muted-foreground",
  neutral: "text-foreground",
};

/**
 * Diagonal stripes in the current text colour over the bar's track: the pattern of a hatched
 * segment (functional, not decorative: it tells Unverified from Needs attention without colour).
 */
export const HATCH_CLASS =
  "bg-[repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_4px)]";

/** How a status fills a bar segment or a swatch: solid in its tone, or hatched in its tone. */
export function fillClass(meta: Pick<StatusMeta, "severity" | "pattern">): string {
  const tone = toneOf(meta);
  return meta.pattern === "hatched" ? `${STATUS_TEXT[tone]} ${HATCH_CLASS}` : STATUS_FILL[tone];
}

/** A category with nothing in it: dimmed, its icon and swatch in the muted colour. */
export const EMPTY_ICON_CLASS = "text-muted-foreground";
export const EMPTY_FILL_CLASS = "bg-muted-foreground/40";

// -- readiness of one object -------------------------------------------------------------

/** The state of one rated object (the API's names; `/verify?state=` uses them too). */
export type ReadinessObjectState =
  | "green"
  | "yellow"
  | "red"
  | "unverified"
  | "no_backup"
  | "empty";

/** The five categories, in the order the overview tiles show them. */
export const READINESS_CATEGORIES = [
  "ready",
  "needs_attention",
  "unverified",
  "not_restorable",
  "no_backup",
] as const;
export type ReadinessCategory = (typeof READINESS_CATEGORIES)[number];

/** The category of each object state; a confirmed-empty object is in none. */
export const READINESS_CATEGORY_OF_STATE: Readonly<
  Record<ReadinessObjectState, ReadinessCategory | null>
> = {
  green: "ready",
  yellow: "needs_attention",
  unverified: "unverified",
  red: "not_restorable",
  no_backup: "no_backup",
  empty: null,
};

/**
 * One object's readiness. Needs attention (orange, the attention tone) and Unverified (amber,
 * the warning tone, hatched) are different things and never share a colour, icon or pattern.
 */
export const READINESS_CATEGORY_META: Readonly<Record<ReadinessObjectState, StatusMeta>> = {
  green: {
    id: "ready",
    severity: "success",
    labelKey: "ui:status.readiness.ready",
    icon: ShieldCheck,
    pattern: "solid",
  },
  yellow: {
    id: "needs_attention",
    severity: "attention",
    labelKey: "ui:status.readiness.needsAttention",
    icon: ShieldAlert,
    pattern: "solid",
  },
  unverified: {
    id: "unverified",
    severity: "warning",
    labelKey: "ui:status.readiness.unverified",
    icon: ShieldQuestionMark,
    pattern: "hatched",
  },
  red: {
    id: "not_restorable",
    severity: "danger",
    labelKey: "ui:status.readiness.notRestorable",
    icon: ShieldX,
    pattern: "solid",
  },
  no_backup: {
    id: "no_backup",
    severity: "danger",
    labelKey: "ui:status.readiness.noBackup",
    icon: ShieldOff,
    pattern: "solid",
  },
  // Not a category: a sixth, neutral row, listed only while there are some.
  empty: {
    id: "empty",
    severity: "muted",
    labelKey: "ui:status.readiness.empty",
    icon: CircleDashed,
    pattern: "solid",
  },
};

/** A `no_backup` object inside its first-backup grace period: not a fault yet, just new. */
export const WAITING_FOR_FIRST_BACKUP_META: StatusMeta = {
  id: "waiting_for_first_backup",
  severity: "warning",
  labelKey: "ui:status.readiness.waitingForFirstBackup",
  icon: ShieldEllipsis,
  pattern: "solid",
};

/** Flags beside an object's readiness badge; they never change its category. */
export const READINESS_FLAG_META = {
  overdue: {
    id: "overdue",
    severity: "attention",
    labelKey: "ui:status.readiness.overdue",
    icon: Clock,
    pattern: "solid",
  },
  noJob: {
    id: "no_job",
    severity: "attention",
    labelKey: "ui:status.readiness.noJob",
    icon: Unplug,
    pattern: "solid",
  },
} as const satisfies Record<string, StatusMeta>;

/** The overview's tiles and legend rows, in this order (the empty row follows while > 0). */
export const READINESS_TILE_ORDER = ["green", "yellow", "unverified", "red", "no_backup"] as const;

/** The segments of a readiness bar, worst first. */
export const READINESS_BAR_ORDER = [
  "red",
  "no_backup",
  "yellow",
  "unverified",
  "green",
  "empty",
] as const satisfies readonly ReadinessObjectState[];

/** An object's readiness badge: its category, or "Waiting for first backup" inside the grace. */
export function readinessBadgeMeta(item: {
  state: ReadinessObjectState;
  overdue: boolean;
}): StatusMeta {
  if (item.state === "no_backup" && !item.overdue) {
    return WAITING_FOR_FIRST_BACKUP_META;
  }
  return READINESS_CATEGORY_META[item.state];
}

/** Sort rank of an object state: worst first (Not restorable, No backup yet, ...). */
export function readinessStateRank(state: ReadinessObjectState): number {
  return (READINESS_BAR_ORDER as readonly ReadinessObjectState[]).indexOf(state);
}

// -- the aggregate (mirror of packages/core/src/verify/readiness-aggregate.ts) ------------------

/** An aggregate readiness on the wire (tenant, user, machine set): unchanged v1 values. */
export type OverallReadiness = "green" | "yellow" | "red";

/** Objects per rated state; `empty` never decides the aggregate. */
export interface ReadinessStateCounts {
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
}

/**
 * The worst category that actually has objects (UI rework, decision 1): `red` (Not
 * restorable) when an object cannot be restored or has no backup yet, else `yellow` (Not
 * proven) when one needs attention or is unverified, else `green` (Ready); null when nothing
 * is rated. `rated` counts every rated object, confirmed-empty ones included. Overdue checks,
 * objects in no job and objects to confirm do not change it (decision 2). Mirrors
 * `aggregateReadiness` of packages/core/src/verify/readiness-aggregate.ts.
 */
export function aggregateReadiness(
  counts: ReadinessStateCounts,
  rated: number,
): OverallReadiness | null {
  if (rated === 0) {
    return null;
  }
  if (counts.red > 0 || counts.noBackup > 0) {
    return "red";
  }
  if (counts.yellow > 0 || counts.unverified > 0) {
    return "yellow";
  }
  return "green";
}

/**
 * The aggregate readiness. Its `yellow` is "Not proven", a warning (amber), and never the
 * object state `yellow` ("Needs attention", orange): show `overall` only through this meta.
 */
export const OVERALL_META: Readonly<Record<OverallReadiness | "none", StatusMeta>> = {
  green: {
    id: "ready",
    severity: "success",
    labelKey: "ui:status.overall.ready",
    icon: ShieldCheck,
    pattern: "solid",
  },
  yellow: {
    id: "not_proven",
    severity: "warning",
    labelKey: "ui:status.overall.notProven",
    icon: ShieldQuestionMark,
    pattern: "solid",
  },
  red: {
    id: "not_restorable",
    severity: "danger",
    labelKey: "ui:status.overall.notRestorable",
    icon: ShieldX,
    pattern: "solid",
  },
  none: {
    id: "none",
    severity: "muted",
    labelKey: "ui:status.overall.none",
    icon: CircleDashed,
    pattern: "solid",
  },
};

/** The meta of an aggregate readiness; null (or an unknown value) is "Nothing to rate". */
export function overallMeta(readiness: string | null | undefined): StatusMeta {
  return readiness === "green" || readiness === "yellow" || readiness === "red"
    ? OVERALL_META[readiness]
    : OVERALL_META.none;
}

/** Sort rank of an aggregate readiness: red, yellow, green, then nothing to rate. */
export function overallRank(readiness: string | null | undefined): number {
  return SEVERITY_RANK[overallMeta(readiness).severity];
}

// -- one backup's verification ---------------------------------------------------------

export type VerificationState = "green" | "yellow" | "red" | "unverified";

/** The rating of one backup or one check report (snapshot lists, job rows). */
export const VERIFICATION_META: Readonly<Record<VerificationState, StatusMeta>> = {
  green: {
    id: "green",
    severity: "success",
    labelKey: "verify:snapshot.state.green",
    icon: ShieldCheck,
    pattern: "solid",
  },
  yellow: {
    id: "yellow",
    severity: "attention",
    labelKey: "verify:snapshot.state.yellow",
    icon: ShieldAlert,
    pattern: "solid",
  },
  red: {
    id: "red",
    severity: "danger",
    labelKey: "verify:snapshot.state.red",
    icon: ShieldX,
    pattern: "solid",
  },
  unverified: {
    id: "unverified",
    severity: "warning",
    labelKey: "verify:snapshot.state.unverified",
    icon: ShieldQuestionMark,
    pattern: "hatched",
  },
};

/** How a restore check read one item back (`CheckedItem.status` of a report). */
export type CheckedItemStatus = "verified" | "mismatch" | "missing" | "unreadable";

/**
 * The verification each read-back item stands for (report page): byte-exact is proof, an item
 * that differs, is missing or cannot be read cannot be restored.
 */
export const CHECKED_ITEM_STATE: Readonly<Record<CheckedItemStatus, VerificationState>> = {
  verified: "green",
  mismatch: "red",
  missing: "red",
  unreadable: "red",
};

/** How one item of a test restore ended (`testRestore.items[].status` of a report). */
export type TestRestoreItemStatus = "confirmed" | "unconfirmed" | "failed";

/**
 * The verification each test-restored item stands for: confirmed is proof, one not confirmed
 * is not proven (Unverified, amber), one that failed cannot be restored.
 */
export const TEST_RESTORE_ITEM_STATE: Readonly<Record<TestRestoreItemStatus, VerificationState>> = {
  confirmed: "green",
  unconfirmed: "unverified",
  failed: "red",
};

// -- the restore check of a run (History) ------------------------------------------------------

export const RESTORE_CHECK_STATES = [
  "passed",
  "warning",
  "failed",
  "queued",
  "running",
  "unverified",
  "none",
] as const;
export type RestoreCheckState = (typeof RESTORE_CHECK_STATES)[number];

export const RESTORE_CHECK_META: Readonly<Record<RestoreCheckState, StatusMeta>> = {
  passed: {
    id: "passed",
    severity: "success",
    labelKey: "history:restoreCheck.passed",
    icon: ShieldCheck,
    pattern: "solid",
  },
  warning: {
    id: "warning",
    severity: "attention",
    labelKey: "history:restoreCheck.warning",
    icon: ShieldAlert,
    pattern: "solid",
  },
  failed: {
    id: "failed",
    severity: "danger",
    labelKey: "history:restoreCheck.failed",
    icon: ShieldX,
    pattern: "solid",
  },
  running: {
    id: "running",
    severity: "info",
    labelKey: "history:restoreCheck.running",
    icon: ShieldEllipsis,
    pattern: "solid",
    live: true,
  },
  queued: {
    id: "queued",
    severity: "muted",
    labelKey: "history:restoreCheck.queued",
    icon: Clock,
    pattern: "solid",
  },
  unverified: {
    id: "unverified",
    severity: "warning",
    labelKey: "history:restoreCheck.unverified",
    icon: ShieldQuestionMark,
    pattern: "hatched",
  },
  none: {
    id: "none",
    severity: "muted",
    labelKey: "history:restoreCheck.none",
    icon: CircleDashed,
    pattern: "solid",
  },
};

// -- storage ------------------------------------------------------------------------------

export const STORAGE_INTEGRITY_STATES = [
  "ok",
  "repaired",
  "unreadable",
  "corrupt",
  "never",
] as const;
export type StorageIntegrityState = (typeof STORAGE_INTEGRITY_STATES)[number];

/** The storage check of a tenant's packs (Recovery readiness). */
export const STORAGE_INTEGRITY_META: Readonly<Record<StorageIntegrityState, StatusMeta>> = {
  ok: {
    id: "ok",
    severity: "success",
    labelKey: "verify:storage.state.ok",
    icon: ShieldCheck,
    pattern: "solid",
  },
  repaired: {
    id: "repaired",
    severity: "warning",
    labelKey: "verify:storage.state.repaired",
    icon: Wrench,
    pattern: "solid",
  },
  unreadable: {
    id: "unreadable",
    severity: "warning",
    labelKey: "verify:storage.state.unreadable",
    icon: TriangleAlert,
    pattern: "solid",
  },
  corrupt: {
    id: "corrupt",
    severity: "danger",
    labelKey: "verify:storage.state.corrupt",
    icon: ShieldX,
    pattern: "solid",
  },
  never: {
    id: "never",
    severity: "muted",
    labelKey: "verify:storage.state.never",
    icon: CircleDashed,
    pattern: "solid",
  },
};

export const STORAGE_TARGET_STATES = ["ok", "error", "unverified"] as const;
export type StorageTargetState = (typeof STORAGE_TARGET_STATES)[number];

/**
 * A repository (storage target): working is neutral (a working connection proves nothing about
 * a restore), failing is danger, one never tested is a warning, on the storage page and on the
 * overview alike.
 */
export const STORAGE_TARGET_META: Readonly<Record<StorageTargetState, StatusMeta>> = {
  ok: {
    id: "ok",
    severity: "neutral",
    labelKey: "storage:status.ok",
    icon: CircleCheck,
    pattern: "solid",
  },
  error: {
    id: "error",
    severity: "danger",
    labelKey: "storage:status.error",
    icon: CircleX,
    pattern: "solid",
  },
  unverified: {
    id: "unverified",
    severity: "warning",
    labelKey: "storage:status.unverified",
    icon: TriangleAlert,
    pattern: "solid",
  },
};

// -- runs and jobs ------------------------------------------------------------------------

/** The states of a run as History shows them (`history:state.<key>`). */
export const RUN_STATUS_KEYS = [
  "running",
  "queued",
  "succeeded",
  "restored",
  "partial",
  "failed",
  "cancelled",
  "incomplete",
  "limited",
  "notBackedUp_account_disabled",
  "notBackedUp_no_license",
  "notBackedUp_locked",
  "notBackedUp_login_refused",
] as const;
export type RunStatusKey = (typeof RUN_STATUS_KEYS)[number];

const notBackedUp = (key: string): StatusMeta => ({
  id: key,
  severity: "muted",
  labelKey: `history:state.${key}`,
  icon: Pause,
  pattern: "solid",
});

/**
 * A run: running is info (Lapis, live); a backup that completed is neutral (no restore check
 * has read it back) and only a restore that completed is a success; held back by a service is
 * a warning, never a failure; an account that is not backed up on purpose is muted.
 */
export const RUN_STATUS_META: Readonly<Record<RunStatusKey, StatusMeta>> = {
  running: {
    id: "running",
    severity: "info",
    labelKey: "history:state.running",
    icon: Info,
    pattern: "solid",
    live: true,
  },
  queued: {
    id: "queued",
    severity: "muted",
    labelKey: "history:state.queued",
    icon: Clock,
    pattern: "solid",
  },
  succeeded: {
    id: "succeeded",
    severity: "neutral",
    labelKey: "history:state.succeeded",
    icon: CircleCheck,
    pattern: "solid",
  },
  restored: {
    id: "restored",
    severity: "success",
    labelKey: "history:state.restored",
    icon: CircleCheck,
    pattern: "solid",
  },
  partial: {
    id: "partial",
    severity: "warning",
    labelKey: "history:state.partial",
    icon: TriangleAlert,
    pattern: "solid",
  },
  failed: {
    id: "failed",
    severity: "danger",
    labelKey: "history:state.failed",
    icon: CircleX,
    pattern: "solid",
  },
  cancelled: {
    id: "cancelled",
    severity: "muted",
    labelKey: "history:state.cancelled",
    icon: CircleDashed,
    pattern: "solid",
  },
  incomplete: {
    id: "incomplete",
    severity: "info",
    labelKey: "history:state.incomplete",
    icon: RotateCcw,
    pattern: "solid",
  },
  limited: {
    id: "limited",
    severity: "warning",
    labelKey: "history:state.limited",
    icon: Clock,
    pattern: "solid",
  },
  notBackedUp_account_disabled: notBackedUp("notBackedUp_account_disabled"),
  notBackedUp_no_license: notBackedUp("notBackedUp_no_license"),
  notBackedUp_locked: notBackedUp("notBackedUp_locked"),
  notBackedUp_login_refused: notBackedUp("notBackedUp_login_refused"),
};

/** The states of a queue job (`dashboard:recentJobs.status.<key>`). */
export const JOB_STATUS_KEYS = [
  "queued",
  "active",
  "throttled",
  "completed",
  "completedWithFailures",
  "failed",
  "limited",
  "notBackedUp_account_disabled",
  "notBackedUp_no_license",
  "notBackedUp_locked",
  "notBackedUp_login_refused",
  "cancelled",
] as const;
export type JobStatusKey = (typeof JOB_STATUS_KEYS)[number];

const jobNotBackedUp = (key: string): StatusMeta => ({
  id: key,
  severity: "muted",
  labelKey: `dashboard:recentJobs.status.${key}`,
  icon: Pause,
  pattern: "solid",
});

/**
 * A queue job: active is info (live), a completed job neutral (a completed restore is a
 * success, see `jobStatusMeta`), cancelled muted on every page.
 */
export const JOB_STATUS_META: Readonly<Record<JobStatusKey, StatusMeta>> = {
  queued: {
    id: "queued",
    severity: "muted",
    labelKey: "dashboard:recentJobs.status.queued",
    icon: Clock,
    pattern: "solid",
  },
  active: {
    id: "active",
    severity: "info",
    labelKey: "dashboard:recentJobs.status.active",
    icon: Info,
    pattern: "solid",
    live: true,
  },
  throttled: {
    id: "throttled",
    severity: "warning",
    labelKey: "dashboard:recentJobs.status.throttled",
    icon: Clock,
    pattern: "solid",
    live: true,
  },
  completed: {
    id: "completed",
    severity: "neutral",
    labelKey: "dashboard:recentJobs.status.completed",
    icon: CircleCheck,
    pattern: "solid",
  },
  completedWithFailures: {
    id: "completedWithFailures",
    severity: "warning",
    labelKey: "dashboard:recentJobs.status.completedWithFailures",
    icon: TriangleAlert,
    pattern: "solid",
  },
  failed: {
    id: "failed",
    severity: "danger",
    labelKey: "dashboard:recentJobs.status.failed",
    icon: CircleX,
    pattern: "solid",
  },
  limited: {
    id: "limited",
    severity: "warning",
    labelKey: "dashboard:recentJobs.status.limited",
    icon: Clock,
    pattern: "solid",
  },
  notBackedUp_account_disabled: jobNotBackedUp("notBackedUp_account_disabled"),
  notBackedUp_no_license: jobNotBackedUp("notBackedUp_no_license"),
  notBackedUp_locked: jobNotBackedUp("notBackedUp_locked"),
  notBackedUp_login_refused: jobNotBackedUp("notBackedUp_login_refused"),
  cancelled: {
    id: "cancelled",
    severity: "muted",
    labelKey: "dashboard:recentJobs.status.cancelled",
    icon: CircleDashed,
    pattern: "solid",
  },
};

/** The plain queue statuses of the API (`JobStatus`): queued, active, completed, failed, cancelled. */
export type QueueJobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

/** The tone of a plain queue status; a completed restore is a success (the data is back). */
export function jobStatusTone(status: QueueJobStatus, queue?: string): StatusTone {
  if (status === "completed" && queue === "restore") {
    return "success";
  }
  return toneOf(JOB_STATUS_META[status]);
}

// -- severities that arrive from the API -------------------------------------------------------

/** The provider view's alert severities (ee/api provider-dashboard/health.ts). */
export const PROVIDER_ALERT_SEVERITY: Readonly<Record<"destructive" | "warning", Severity>> = {
  destructive: "danger",
  warning: "warning",
};
