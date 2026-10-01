import type { BadgeProps } from "@/components/ui/badge";
import { ApiError, errorMessageKey } from "@/lib/api";
import type {
  CopyCompleteness,
  MigrationStatus,
  ObjectLockCapability,
  ProbeResult,
  StorageKind,
  StorageMigrationDto,
  StorageTargetDto,
  StorageTargetList,
  TargetStatus,
} from "./types";

/**
 * Pure view logic for the storage page: badges, the one-line health and WORM
 * summaries of a card, what the add dialog may offer, and how API problems
 * map to messages. Everything returns i18n keys (namespace `storage`) with
 * their values, never text.
 */

/**
 * `ok`: in order, which is a state and not a proof (the text colour, a check
 * mark); `neutral`: nothing to say or not known. Neither is the green of a
 * passed restore check (brand guide, section 4).
 */
export type Tone = "neutral" | "ok" | "warning" | "destructive";

/** An i18n key with its interpolation values. */
export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

export interface ToneMessage extends Message {
  tone: Tone;
}

export const STATUS_VARIANT: Record<TargetStatus, NonNullable<BadgeProps["variant"]>> = {
  ok: "outline",
  error: "destructive",
  unverified: "muted",
};

/** What the last test says about a target. */
export function healthSummary(
  target: Pick<StorageTargetDto, "status" | "lastProbe" | "configValid">,
): ToneMessage {
  if (!target.configValid) {
    return { key: "health.configInvalid", tone: "destructive" };
  }
  const probe = target.lastProbe;
  if (!probe || target.status === "unverified") {
    return { key: "health.notTested", tone: "warning" };
  }
  return probeSummary(probe);
}

/** The headline of a probe: working, or the classified reason it failed. */
export function probeSummary(probe: ProbeResult): ToneMessage {
  if (probe.ok) {
    return probe.warnings.length > 0
      ? { key: "health.okWithWarnings", tone: "warning" }
      : { key: "health.ok", tone: "ok" };
  }
  return {
    key: `health.errors.${probe.errorCode ?? "unknown"}`,
    tone: "destructive",
  };
}

/** Where the probe stopped, as a step label key; null when it passed. */
export function failedStepKey(probe: ProbeResult): string | null {
  return probe.failedStep ? `health.steps.${probe.failedStep}` : null;
}

/**
 * The name shown for a target. The placeholder standing for a retired
 * installation default (docs/STORAGE.md: role `previous`, kind
 * `installation_default`) never has a name or an addressing of its own
 * (`storage_targets.name` is null, `config` is `{}`), so it falls back to its
 * kind label (`kindLong.installation_default`) rather than showing an empty
 * string — this is purely a display choice; the DTO's own `name` is
 * unchanged for every other target.
 */
export function targetDisplayName(
  target: Pick<StorageTargetDto, "name" | "kind">,
  t: (key: string) => string,
): string {
  return target.kind === "installation_default" ? t("kindLong.installation_default") : target.name;
}

/** The WORM line of a card. A filesystem is never WORM, whatever else is true. */
export function objectLockSummary(
  kind: StorageKind,
  capability: ObjectLockCapability | null,
): ToneMessage {
  if (kind === "installation_default") {
    // A placeholder for a retired environment default (docs/STORAGE.md): it
    // was never a target of its own to test, so there is nothing to report.
    return { key: "objectLock.retired", tone: "neutral" };
  }
  if (kind === "local") {
    return { key: "objectLock.filesystem", tone: "warning" };
  }
  if (!capability) {
    return { key: "objectLock.notChecked", tone: "neutral" };
  }
  switch (capability.status) {
    case "enabled":
      return { key: "objectLock.enabled", tone: "ok" };
    case "disabled":
      return { key: "objectLock.disabled", tone: "neutral" };
    case "unsupported":
      return { key: "objectLock.unsupported", tone: "neutral" };
    default:
      return capability.reason === "access_denied"
        ? { key: "objectLock.unknownAccess", tone: "warning" }
        : { key: "objectLock.unknownError", tone: "warning" };
  }
}

/** The default retention of an Object Lock bucket, or null when none is configured. */
export function defaultRetention(
  capability: ObjectLockCapability | null,
): { unit: "years" | "days"; count: number } | null {
  if (capability?.status !== "enabled") {
    return null;
  }
  if (capability.defaultRetentionYears) {
    return { unit: "years", count: capability.defaultRetentionYears };
  }
  if (capability.defaultRetentionDays) {
    return { unit: "days", count: capability.defaultRetentionDays };
  }
  return null;
}

/**
 * Why the add dialog cannot offer "primary": the tenant already has one, or
 * its data lives on the installation default (add a copy, then promote it).
 */
export function primaryBlockedReason(
  list: Pick<StorageTargetList, "items" | "tenantHasData">,
): "primaryExists" | "tenantHasData" | null {
  if (list.items.some((target) => target.role === "primary")) {
    return "primaryExists";
  }
  return list.tenantHasData ? "tenantHasData" : null;
}

/** True when backups exist in more than one place (a copy target, or the default's copy path). */
export function hasSecondLocation(
  list: Pick<StorageTargetList, "items" | "installationDefault">,
): boolean {
  if (list.items.some((target) => target.role === "copy")) {
    return true;
  }
  return list.installationDefault.inUse && list.installationDefault.hasCopy;
}

// --- Storage migrations (docs/STORAGE.md, "Replace the primary") ------------------

const MIGRATION_ACTIVE_STATUSES: ReadonlySet<MigrationStatus> = new Set([
  "queued",
  "copying",
  "verifying",
  "switching",
]);

/** Whether a migration is still moving (queued counts: it will start any moment). */
export function isMigrationActive(status: MigrationStatus): boolean {
  return MIGRATION_ACTIVE_STATUSES.has(status);
}

/**
 * Whether a migration is actually running right now: an active status, and
 * not stalled (see {@link StorageMigrationDto.stalled}) — a stalled one
 * still reads as an active status in the database, but nothing is really
 * copying or verifying any more, so it must not show progress or the
 * "shaping" orb as if it were.
 */
export function isMigrationRunning(
  migration: Pick<StorageMigrationDto, "status" | "stalled">,
): boolean {
  return isMigrationActive(migration.status) && !migration.stalled;
}

/**
 * Whether a failed migration can be tried again without deleting and
 * re-adding the destination (which `location_overlap` would refuse anyway
 * while it is still there): only a failed `move` has a job to re-queue —
 * `keep` never has one (it switches synchronously) and any other status is
 * either still running or already settled.
 */
export function isMigrationRetryable(
  migration: Pick<StorageMigrationDto, "status" | "mode">,
): boolean {
  return migration.status === "failed" && migration.mode === "move";
}

/** `hours`/`minutes`/`seconds` remaining, split the same way job progress is (features/jobs/presenters.ts). */
export type MigrationEtaUnit = "hours" | "minutes" | "seconds";

/** The `migration.eta.<unit>` i18n key and plural values for a remaining-time estimate. */
export function migrationEtaParts(totalSeconds: number): {
  key: `migration.eta.${MigrationEtaUnit}`;
  values: { hours: number; minutes: number; seconds: number };
} {
  const safe = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const values = { hours, minutes, seconds };
  if (hours > 0) {
    return { key: "migration.eta.hours", values };
  }
  if (minutes > 0) {
    return { key: "migration.eta.minutes", values };
  }
  return { key: "migration.eta.seconds", values };
}

/**
 * The one-line state of a migration for a target's card: 'Migrating 42 %',
 * 'Verifying', 'Switched' (with the date shown next to it, not baked into the
 * string — `RelativeTime` carries its own tooltip), a plain failure or
 * cancellation. `role` picks the wording: the destination reads "taking
 * over", the retired source reads "replaced". A stalled migration (the
 * background job died but `status` was never reconciled — `stalled` on the
 * DTO) reads distinctly from an ordinary in-progress one, whatever `status`
 * still says, because nothing is actually moving any more.
 */
export function migrationSummary(migration: StorageMigrationDto): ToneMessage {
  const forSource = migration.role === "source";
  if (migration.stalled) {
    return {
      key: forSource ? "migration.stalledSource" : "migration.stalled",
      tone: "destructive",
    };
  }
  switch (migration.status) {
    case "queued":
      return { key: forSource ? "migration.queuedSource" : "migration.queued", tone: "neutral" };
    case "copying":
      return migration.percent === null
        ? { key: "migration.copyingUnknown", tone: "neutral" }
        : { key: "migration.copying", tone: "neutral", values: { percent: migration.percent } };
    case "verifying":
      return { key: "migration.verifying", tone: "neutral" };
    case "switching":
      return { key: "migration.switching", tone: "neutral" };
    case "completed":
      return { key: forSource ? "migration.retired" : "migration.switched", tone: "ok" };
    case "failed":
      return {
        key: forSource ? "migration.failedSource" : "migration.failed",
        tone: "destructive",
      };
    case "cancelled":
      return {
        key: forSource ? "migration.cancelledSource" : "migration.cancelled",
        tone: "neutral",
      };
  }
}

// --- API problems -------------------------------------------------------------------

const PROBLEM_PREFIX = "urn:restow:problem:storage-";

const PROBLEM_KEYS: Record<string, string> = {
  "local-requires-provider-admin": "storage:errors.localRequiresProviderAdmin",
  "primary-exists": "storage:errors.primaryExists",
  "tenant-has-data": "storage:errors.tenantHasData",
  "location-overlap": "storage:errors.locationOverlap",
  "location-locked": "storage:errors.locationLocked",
  "primary-holds-data": "storage:errors.primaryHoldsData",
  "already-primary": "storage:errors.alreadyPrimary",
  "not-verified": "storage:errors.notVerified",
  "copy-incomplete": "storage:errors.copyIncomplete",
  "invalid-location": "storage:errors.invalidLocation",
  "endpoint-not-allowed": "storage:errors.endpointNotAllowed",
  "target-not-found": "storage:errors.targetNotFound",
  "credentials-not-applicable": "storage:errors.credentialsNotApplicable",
  "credentials-required": "storage:errors.credentialsRequired",
  "config-invalid": "storage:errors.configInvalid",
  "credentials-unusable": "storage:errors.credentialsUnusable",
  "default-misconfigured": "storage:errors.defaultMisconfigured",
  unreachable: "storage:errors.unreachable",
  "migration-in-progress": "storage:errors.migrationInProgress",
  "not-a-copy": "storage:errors.notACopy",
  "migration-not-found": "storage:errors.migrationNotFound",
  "migration-not-cancellable": "storage:errors.migrationNotCancellable",
  "migration-not-retryable": "storage:errors.migrationNotRetryable",
  "keep-target-unreachable": "storage:errors.keepTargetUnreachable",
  "keep-blocked-by-active-job": "storage:errors.keepBlockedByActiveJob",
  "previous-holds-exclusive-data": "storage:errors.previousHoldsExclusiveData",
  "previous-holds-endpoint-repositories": "storage:errors.previousHoldsEndpointRepositories",
  "active-endpoints": "storage:errors.activeEndpoints",
  "installation-default-readonly": "storage:errors.installationDefaultReadonly",
  "queue-not-ready": "storage:errors.queueNotReady",
};

/** The fully qualified i18n key for a failed call: storage problems first, else the common mapping. */
export function storageErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem?.type.startsWith(PROBLEM_PREFIX)) {
    const key = PROBLEM_KEYS[error.problem.type.slice(PROBLEM_PREFIX.length)];
    if (key) {
      return key;
    }
  }
  if (
    error instanceof ApiError &&
    error.problem?.type === "urn:restow:problem:master-key-missing"
  ) {
    return "storage:errors.masterKeyMissing";
  }
  return `common:${errorMessageKey(error)}`;
}

export interface FieldProblem {
  field: string;
  reason: string;
}

/** The form fields an API problem names (invalid location, endpoint policy, credentials). */
export function problemFields(error: unknown): FieldProblem[] {
  if (!(error instanceof ApiError) || !error.problem) {
    return [];
  }
  const { fields, field, reason } = error.problem;
  if (Array.isArray(fields)) {
    return fields.filter(
      (entry): entry is FieldProblem =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as FieldProblem).field === "string" &&
        typeof (entry as FieldProblem).reason === "string",
    );
  }
  return typeof field === "string" && typeof reason === "string" ? [{ field, reason }] : [];
}

/** The completeness a refused promotion carried (409 copy-incomplete), or null. */
export function completenessOf(error: unknown): CopyCompleteness | null {
  if (
    error instanceof ApiError &&
    error.problem?.type === `${PROBLEM_PREFIX}copy-incomplete` &&
    typeof error.problem.completeness === "object" &&
    error.problem.completeness !== null
  ) {
    return error.problem.completeness as CopyCompleteness;
  }
  return null;
}
