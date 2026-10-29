import type { BadgeProps } from "@/components/ui/badge";
import type { Failure } from "@/features/failures/api";
import { ApiError, errorMessageKey } from "@/lib/api";
import { protectedObjectAddress, protectedObjectName } from "@/lib/protected-object";

import type {
  CredentialStatus,
  DirectorySource,
  ImapProbeResult,
  ObjectStatus,
  ObjectStatusReason,
  ProtectedObject,
  ProtectionRules,
  RecoveryReadiness,
  SyncQueueResult,
} from "./types";

/**
 * Pure presentation helpers of the directory feature: what a status looks
 * like, which i18n key describes an outcome, how the exclusion list is typed.
 * Components stay thin; everything here is unit-tested.
 */

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/**
 * A protected object is in scope and backed up, which is a state, not a proof:
 * its badge is the neutral outline. Green is for the readiness column, a passed
 * restore check (brand guide, section 4).
 */
export const STATUS_VARIANT: Record<ObjectStatus, BadgeVariant> = {
  active: "outline",
  excluded: "muted",
  orphaned: "warning",
};

/**
 * A `per_mailbox` mailbox with no working password of its own: not actually
 * protected, whatever its stored status or last-verified readiness otherwise
 * suggest (docs/IMAP.md). `shared`/`master_user` mailboxes have no password
 * of their own, so this is never true for them regardless of `status`.
 */
export function hasCredentialProblem(object: ProtectedObject): boolean {
  const credential = object.credential;
  return (
    object.kind === "imap" &&
    credential?.authMode === "per_mailbox" &&
    (!credential.hasPassword || credential.status === "failed")
  );
}

/**
 * What the status column shows: the stored status, except a `selected`-mode
 * object nothing chose reads as "Not selected" rather than "Excluded" — that
 * mode's default is not a decision made against it, and an `active`
 * `per_mailbox` mailbox with no working password of its own reads as
 * "Needs attention" rather than the plain "Protected" its status alone
 * would otherwise show (it is in scope, but no backup will actually run).
 * `suffix` is not a full translation key (unlike {@link readinessView}'s
 * `key`): the caller looks it up under both `status.` and `statusHint.`.
 */
export function objectStatusView(object: ProtectedObject): {
  variant: BadgeVariant;
  suffix: string;
} {
  if (object.notSelected) {
    return { variant: "muted", suffix: "not_selected" };
  }
  // No longer backed up (removed, disabled, unlicensed, locked at the source): amber until an
  // admin confirms it is intended, then grey; the reason and date are a line of their own
  // (inactiveDetail). An older server without the confirmation keeps the earlier display.
  if (object.status === "orphaned" && object.inactiveState) {
    return object.inactiveState === "to_confirm"
      ? { variant: "warning", suffix: "to_confirm" }
      : { variant: "muted", suffix: "confirmed" };
  }
  // Disabled or unlicensed: neutral, nothing to fix here, backups resume by themselves.
  if (object.status === "orphaned" && object.statusReason) {
    return { variant: "muted", suffix: `inactive_${object.statusReason}` };
  }
  if (object.status === "active" && hasCredentialProblem(object)) {
    return { variant: "warning", suffix: "needs_credential" };
  }
  // In scope is not protected: only a job that runs on a schedule backs it up.
  if (object.status === "active" && object.coverage === "none") {
    return { variant: "warning", suffix: "no_job" };
  }
  if (object.status === "active" && object.coverage === "unscheduled") {
    return { variant: "warning", suffix: "unscheduled" };
  }
  return { variant: STATUS_VARIANT[object.status], suffix: object.status };
}

/**
 * The line under the status of an object no longer backed up: why (`inactive.reason.*`, keyed
 * by the reason, `removed` when it left the source), since when, a hint at the owner's account
 * for a locked OneDrive, and who confirmed it when (the upgrade backfill and the exclusion
 * case are automatic: `migration`, `excluded`). Null for every other object.
 */
export function inactiveDetail(object: ProtectedObject): {
  reasonKey: string;
  since: string | null;
  hintKey: string | null;
  confirmed: { by: string; at: string; byMigration: boolean; byExclusion: boolean } | null;
} | null {
  if (object.status !== "orphaned" || !object.inactiveState) {
    return null;
  }
  const by = object.statusConfirmedBy ?? null;
  const at = object.statusConfirmedAt ?? null;
  return {
    reasonKey: `inactive.reason.${object.statusReason ?? "removed"}`,
    since: object.inactiveSince ?? null,
    hintKey:
      object.statusReason === "locked" && object.lockHint
        ? `inactive.lockHint.${object.lockHint}`
        : null,
    confirmed:
      object.inactiveState === "confirmed" && by && at
        ? { by, at, byMigration: by === "migration", byExclusion: by === "excluded" }
        : null,
  };
}

export const READINESS_VARIANT: Record<RecoveryReadiness, BadgeVariant> = {
  green: "success",
  yellow: "warning",
  red: "destructive",
};

/** Primary line of an object: its name, else its address, else its id. */
export function objectTitle(object: ProtectedObject): string {
  return protectedObjectName(object);
}

/** Secondary line: the address (or IMAP login) when it adds information. */
export function objectSubtitle(object: ProtectedObject): string | null {
  return protectedObjectAddress(object);
}

export type BackupState =
  | { kind: "running" }
  | { kind: "limited"; at: string }
  | { kind: "not_backed_up"; reason: ObjectStatusReason; at: string | null }
  | { kind: "failed"; at: string }
  | { kind: "done"; at: string }
  | { kind: "never" };

/**
 * What the "last backup" column says. A failed latest run is shown even when
 * an older snapshot exists: the object is not protected as recently as the
 * date suggests, and the UI must not hide that. A run a service held back
 * (`serviceLimited`) is no failure: it reads amber "held back", as in the
 * jobs and history views, never as a red "backup failed"; an object that
 * stays held back for long is caught by the readiness and overdue rules.
 */
export function backupState(object: ProtectedObject): BackupState {
  const job = object.latestBackupJob;
  if (job && (job.status === "queued" || job.status === "active")) {
    return { kind: "running" };
  }
  // The account is disabled or unlicensed: neutral, the newest backup (if any) still stands.
  const inactive =
    (job?.status === "failed" ? job.notBackedUp : null) ??
    (object.status === "orphaned" ? object.statusReason : null);
  if (inactive) {
    return { kind: "not_backed_up", reason: inactive, at: object.lastBackupAt };
  }
  if (job?.status === "failed") {
    return job.serviceLimited ? { kind: "limited", at: job.at } : { kind: "failed", at: job.at };
  }
  return object.lastBackupAt ? { kind: "done", at: object.lastBackupAt } : { kind: "never" };
}

/**
 * Readiness badge: an unverified backup is shown as such, never as fine, and
 * a `per_mailbox` mailbox with no working password of its own never reads as
 * ready even from an older verified restore point (a migration from
 * `shared`, or a password that stopped working) - it is not currently
 * protected, whatever an earlier snapshot once proved.
 */
export function readinessView(object: ProtectedObject): {
  variant: BadgeVariant;
  key: string;
} {
  if (hasCredentialProblem(object)) {
    return { variant: "warning", key: "readiness.needs_credential" };
  }
  if (object.readiness) {
    return {
      variant: READINESS_VARIANT[object.readiness.rating],
      key: `readiness.${object.readiness.rating}`,
    };
  }
  return object.snapshotCount > 0
    ? { variant: "warning", key: "readiness.unverified" }
    : { variant: "muted", key: "readiness.none" };
}

/**
 * Why the latest backup run of an object failed, when the server knows; null
 * for a run that is fine, still going, or failed without a recorded cause.
 */
export function backupFailure(object: Pick<ProtectedObject, "latestBackupJob">): Failure | null {
  const job = object.latestBackupJob;
  return job?.status === "failed" ? (job.failure ?? null) : null;
}

/**
 * Why the last login test of an IMAP account failed, when the server knows;
 * null while the login works, was never tested, or failed without a recorded cause.
 */
export function credentialFailure(object: Pick<ProtectedObject, "credential">): Failure | null {
  const credential = object.credential;
  return credential?.status === "failed" ? (credential.failure ?? null) : null;
}

export const CREDENTIAL_VARIANT: Record<CredentialStatus, BadgeVariant> = {
  untested: "muted",
  ok: "outline",
  failed: "destructive",
};

/**
 * What the credential column shows for an IMAP account. Only `per_mailbox`
 * mailboxes carry their own password: there, no password set is "needs
 * attention" (never a quiet blank), otherwise the last test-login result,
 * never reading as fine before a password is both set and tested. `shared` and
 * `master_user` mailboxes never have a password of their own — `hasPassword`
 * is always false there and is not a missing-credential signal — so they show
 * only the last test-login result, or nothing before one has run. Null for
 * every non-IMAP object.
 */
export function credentialView(
  object: ProtectedObject,
): { variant: BadgeVariant; key: string } | null {
  const credential = object.credential;
  if (object.kind !== "imap" || !credential) {
    return null;
  }
  if (credential.authMode === "per_mailbox" && !credential.hasPassword) {
    return { variant: "warning", key: "credential.status.missing" };
  }
  if (!credential.status) {
    return credential.authMode === "per_mailbox"
      ? { variant: "muted", key: "credential.status.untested" }
      : null;
  }
  return {
    variant: CREDENTIAL_VARIANT[credential.status],
    key: `credential.status.${credential.status}`,
  };
}

/** Whether the "Set password" row action makes sense: only `per_mailbox` mailboxes have one of their own. */
export function canSetCredential(object: ProtectedObject): boolean {
  return object.kind === "imap" && object.credential?.authMode === "per_mailbox";
}

/**
 * Whether "Test login" can run at all: a `per_mailbox` mailbox with no
 * password yet has no login to test (the API answers 409
 * `imap-credential-not-configured`, see {@link objectErrorKey}). `shared` and
 * `master_user` mailboxes always have a login to test, from the source.
 */
export function canTestCredentialLogin(object: ProtectedObject): boolean {
  return (
    object.kind === "imap" &&
    !(object.credential?.authMode === "per_mailbox" && !object.credential.hasPassword)
  );
}

/** i18n key (namespace `directory`) for a failed "test login" probe's reason. */
export function credentialProbeFailureKey(probe: Extract<ImapProbeResult, { ok: false }>): string {
  return `credential.probeReasons.${probe.reason}`;
}

/** Which protection actions make sense for an object. */
export function availableActions(object: ProtectedObject): {
  include: boolean;
  exclude: boolean;
  reset: boolean;
  remove: boolean;
  /** "Yes, intended": the object is no longer backed up and nobody confirmed that yet. */
  confirmInactive: boolean;
} {
  const m365 = object.sourceKind === "m365";
  // A disabled or unlicensed mailbox is still in the directory: a decision about it holds once
  // the account is back (the status stays orphaned until then).
  const live = object.status !== "orphaned" || (m365 && Boolean(object.statusReason));
  return {
    include: live && (m365 ? object.override !== "include" : object.status !== "active"),
    exclude: live && (m365 ? object.override !== "exclude" : object.status !== "excluded"),
    reset: m365 && object.override !== null,
    remove: object.origin === "manual",
    confirmInactive: object.status === "orphaned" && object.inactiveState === "to_confirm",
  };
}

/**
 * Why removing a manual account must not just delete it: a legal hold beats
 * backups. Restow never deletes backups as a side effect, so such an account
 * is excluded from protection instead (the API refuses the delete with 409
 * `account-has-backups`); null when a plain delete is fine.
 */
export function removalBlock(object: ProtectedObject): "legal_hold" | "has_backups" | null {
  if (object.legalHold) {
    return "legal_hold";
  }
  return object.snapshotCount > 0 ? "has_backups" : null;
}

/**
 * Parse the exclusion list as typed: one entry per line (commas and
 * semicolons also separate), trimmed, de-duplicated case-insensitively.
 */
export function parseExclusionText(text: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const entry = raw.trim();
    const key = entry.toLowerCase();
    if (entry && !seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  return entries;
}

export function formatExclusionText(entries: readonly string[]): string {
  return entries.join("\n");
}

/** i18n key (namespace `directory`) describing what happened to the sync a change asked for. */
export function syncResultKey(result: SyncQueueResult): string {
  if (result.status === "not_queued") {
    return `sync.result.notQueued.${result.reason}`;
  }
  return result.status === "queued" ? "sync.result.queued" : "sync.result.alreadyQueued";
}

export type SourceHealth =
  | "disabled"
  | "consent_outstanding"
  | "syncing"
  | "error"
  | "never_synced"
  | "healthy"
  | "manual";

/** One word for the state of a source, in the order an admin must act on. */
export function sourceHealth(source: DirectorySource): SourceHealth {
  if (source.kind === "imap") {
    return source.status === "disabled" ? "disabled" : "manual";
  }
  if (source.status === "disabled") {
    return "disabled";
  }
  if (!source.consentGranted) {
    return "consent_outstanding";
  }
  if (source.sync?.pendingJob) {
    return "syncing";
  }
  if (source.status === "error" || source.sync?.lastRun?.ok === false) {
    return "error";
  }
  return source.sync?.lastRun ? "healthy" : "never_synced";
}

/**
 * A classified problem of a source's directory sync or connection, ready to
 * explain. `sync`: the last run failed (its own cause first, then the
 * source's). `source`: the last run was fine (or there is none) but the
 * source is in error, so the connection is what is broken. Null without a
 * classified cause: the card then keeps its old text.
 */
export interface SourceProblem {
  kind: "sync" | "source";
  failure: Failure;
  /** The recorded message; a detail of the explanation. */
  message: string | null;
  at: string | null;
}

export function describeSourceProblem(source: DirectorySource): SourceProblem | null {
  const lastRun = source.sync?.lastRun ?? null;
  if (lastRun && !lastRun.ok) {
    const failure = lastRun.failure ?? source.failure ?? null;
    return failure
      ? { kind: "sync", failure, message: lastRun.error, at: lastRun.finishedAt }
      : null;
  }
  if (source.status === "error") {
    const failure = source.failure ?? null;
    return failure
      ? { kind: "source", failure, message: source.errorMessage, at: source.lastSyncAt }
      : null;
  }
  return null;
}

export const HEALTH_VARIANT: Record<SourceHealth, BadgeVariant> = {
  disabled: "muted",
  consent_outstanding: "warning",
  syncing: "secondary",
  error: "destructive",
  never_synced: "warning",
  healthy: "outline",
  manual: "outline",
};

/** A rule set the editor can save: only group mode needs anything more (a group). */
export function rulesComplete(rules: ProtectionRules): boolean {
  return rules.mode !== "group" || (rules.groupId !== null && rules.groupId.length > 0);
}

/** Equality of two rule sets as the API stores them (exclusions compare case-insensitively). */
export function sameRules(a: ProtectionRules, b: ProtectionRules): boolean {
  const list = (rules: ProtectionRules) =>
    rules.exclude.map((entry) => entry.toLowerCase()).join("\n");
  return (
    a.mode === b.mode &&
    (a.mode === "all" || a.groupId === b.groupId) &&
    a.includeSharedMailboxes === b.includeSharedMailboxes &&
    (a.sites ?? "all") === (b.sites ?? "all") &&
    (a.groups ?? "selected") === (b.groups ?? "selected") &&
    list(a) === list(b)
  );
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

// --- API problems -------------------------------------------------------------------

/**
 * The 409s `set/test credential` can answer (apps/api/src/features/directory/
 * service.ts `requirePerMailboxObject`, `credentialConfigProblem`): every
 * generic 409 otherwise maps to the common "conflicts with the current
 * state" text, which drops the actual, non-secret cause the API already
 * gives (e.g. "This mailbox has no password yet").
 */
const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:imap-not-per-mailbox": "directory:errors.imapNotPerMailbox",
  "urn:restow:problem:imap-credential-not-configured":
    "directory:errors.imapCredentialNotConfigured",
  // Backups, or a legal hold (also a released one), keep the account: the
  // dialog already explains this for active holds and snapshots it knows of.
  "urn:restow:problem:account-has-backups": "directory:errors.accountHasBackups",
};

/** The fully qualified i18n key for a failed call: feature problems first, else the common mapping. */
export function objectErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}
