import type { Failure } from "@/features/failures/api";
import type { JobThrottle } from "@/features/jobs/api";

/**
 * Contract types of `/api/v1/directory` (apps/api/src/features/directory).
 * Kept in sync by hand; the API is the source of truth.
 */

export type SourceKind = "m365" | "imap";
export type SourceStatus = "pending" | "active" | "error" | "disabled";
export type ObjectKind = "mailbox" | "onedrive" | "imap";
export type ObjectStatus = "active" | "excluded" | "orphaned";
/**
 * `status` as a filter: `not_selected` is not a stored status but a derived
 * one (see {@link ProtectedObject.notSelected}), filtered apart from
 * `excluded` because it is the `selected` mode's default, not a decision.
 */
export type ObjectStatusFilter = ObjectStatus | "not_selected";
export type ObjectOrigin = "directory_sync" | "manual";
/**
 * How an object stands towards the backup jobs: in a job that runs on a schedule, in one that is
 * paused or runs by hand only, or in none.
 */
export type ObjectCoverage = "scheduled" | "unscheduled" | "none";
export type ProtectionOverride = "include" | "exclude";
export type ProtectionAction = ProtectionOverride | "reset";
export type RecoveryReadiness = "green" | "yellow" | "red";
/** Whether an IMAP account's own sealed password (per_mailbox auth) currently works. */
export type CredentialStatus = "untested" | "ok" | "failed";
/** How the mailboxes of an IMAP source authenticate (docs/IMAP.md); "shared" when absent. */
export type ImapAuthMode = "shared" | "per_mailbox" | "master_user";
export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";
export type SyncMode = "initial" | "incremental" | "resync";

export interface ProtectionRules {
  mode: "all" | "group" | "selected";
  groupId: string | null;
  groupName: string | null;
  exclude: string[];
  includeSharedMailboxes: boolean;
}

export interface PlanCounts {
  users: number;
  removedUsers: number;
  guests: number;
  created: number;
  updated: number;
  rescoped: number;
  orphaned: number;
}

interface GraphFailure {
  status: number;
  code: string | null;
  message: string;
}

export type SyncWarning =
  | (GraphFailure & { kind: "group_unresolved"; groupId: string })
  | (GraphFailure & {
      kind: "mailbox_probe_failed" | "drive_probe_failed" | "user_fetch_failed";
      userId: string;
      user: string | null;
    });

export interface DirectoryLastRun {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  mode: SyncMode | null;
  counts: PlanCounts | null;
  warnings: SyncWarning[];
  warningCount: number;
  error: string | null;
  /** Why the run failed and what to do; null for a green run or a run stored before causes were kept. */
  failure: Failure | null;
}

export interface ObjectCounts {
  total: number;
  active: number;
  excluded: number;
  orphaned: number;
  mailbox: number;
  onedrive: number;
  imap: number;
}

export interface PendingSync {
  id: string;
  status: "queued" | "active";
  startedAt: string | null;
  /** While Microsoft Graph makes the running sync wait. */
  throttle: JobThrottle | null;
}

export interface DirectorySource {
  id: string;
  name: string;
  kind: SourceKind;
  status: SourceStatus;
  errorMessage: string | null;
  /** The classified cause behind `errorMessage`; null for a healthy source or a text-only row. */
  failure: Failure | null;
  lastSyncAt: string | null;
  consentGranted: boolean;
  rules: ProtectionRules | null;
  overrideCount: number;
  sync: {
    lastRun: DirectoryLastRun | null;
    lastFullSyncAt: string | null;
    fullSyncPending: boolean;
    pendingJob: PendingSync | null;
  } | null;
  /** Null for M365 sources; `"shared"` when absent, same default as everywhere else (docs/IMAP.md). */
  imapAuthMode: ImapAuthMode | null;
  counts: ObjectCounts;
}

export interface ProtectedObject {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: SourceKind;
  kind: ObjectKind;
  origin: ObjectOrigin;
  status: ObjectStatus;
  externalId: string;
  displayName: string | null;
  userId: string | null;
  email: string | null;
  upn: string | null;
  sharedOrBlocked: boolean;
  override: ProtectionOverride | null;
  /** `excluded` only by the `selected` mode's default, not by a decision. */
  notSelected: boolean;
  lastBackupAt: string | null;
  snapshotCount: number;
  /** An active legal hold sits on this object: it cannot be removed and its backups are kept. */
  legalHold: boolean;
  latestBackupJob: {
    id: string;
    status: JobStatus;
    at: string;
    /** Why that backup failed, when it did and the cause is known. */
    failure: Failure | null;
  } | null;
  readiness: { rating: RecoveryReadiness; checkedAt: string } | null;
  /** The backup job that covers it; null when none does (or an older server). */
  job?: { id: string; name: string; scheduled: boolean } | null;
  /** Null when it may not be backed up at all (excluded, orphaned, source not working). */
  coverage?: ObjectCoverage | null;
  /**
   * The newest finished backup went through but left items behind (apps/api features/warnings):
   * `open` is a warning, `acknowledged` was looked at and accepted for its causes. Null (or absent,
   * from an older server) when the newest backup is complete, failed outright or missing.
   */
  warning?: ObjectWarning | null;
  /**
   * The account's own login (per_mailbox or master-user test); null for
   * non-IMAP objects. `authMode` is the parent source's mode: only
   * `per_mailbox` mailboxes ever have their own password, so `hasPassword`
   * only means "not protected" there — on `shared`/`master_user` sources it
   * is always false and carries no signal.
   */
  credential: {
    authMode: ImapAuthMode;
    hasPassword: boolean;
    status: CredentialStatus | null;
    checkedAt: string | null;
    error: string | null;
    /** `error`'s reason as a translation key suffix (`credential.probeReasons.*`); null when unknown. */
    errorReason: ImapProbeFailure | null;
    /** The classified cause of a failed login test (why, what to do); null when it passed or was never tested. */
    failure: Failure | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectWarning {
  state: "open" | "acknowledged";
  /** The run that left the items behind. */
  runId: string;
  failedItems: number;
  causes: { code: string; count: number }[];
  newCauses: string[];
  acknowledgement: {
    acknowledgedAt: string;
    acknowledgedBy: string;
    note: string | null;
    causes: string[];
    runId: string | null;
    superseded: boolean;
  } | null;
}

export interface ObjectsPage {
  items: ProtectedObject[];
  total: number;
  page: number;
  pageSize: number;
}

export type ObjectSort = "name" | "kind" | "status" | "createdAt" | "updatedAt";

export interface ObjectsQuery {
  search?: string;
  kind?: ObjectKind;
  status?: ObjectStatusFilter;
  sourceId?: string;
  job?: ObjectCoverage;
  sharedOrBlocked?: boolean;
  page: number;
  pageSize: number;
  sort: ObjectSort;
  order: "asc" | "desc";
}

/** The filter fields of {@link ObjectsQuery}, without paging: what a bulk "select all matching" sends. */
export interface ObjectsFilter {
  search?: string;
  kind?: ObjectKind;
  status?: ObjectStatusFilter;
  sourceId?: string;
  job?: ObjectCoverage;
  sharedOrBlocked?: boolean;
}

export type EnqueueOutcome =
  | { status: "queued"; jobId: string }
  | { status: "already_queued"; jobId: string | null };

export type SyncNotQueuedReason = "source_disabled" | "consent_outstanding" | "queue_unavailable";

export type SyncQueueResult =
  | EnqueueOutcome
  | { status: "not_queued"; reason: SyncNotQueuedReason };

export interface RulesResult {
  rules: ProtectionRules;
  sync: SyncQueueResult;
}

export interface ProtectionResult {
  object: ProtectedObject;
  sync: SyncQueueResult | null;
}

/** A bulk decision on one source: either explicit ids, or everything a filter matches. */
export type BulkProtectionTarget = { objectIds: string[] } | { filter: ObjectsFilter };

export type BulkProtectionInput = BulkProtectionTarget & {
  action: ProtectionAction;
  reason?: string;
};

export interface BulkProtectionResult {
  sourceId: string;
  action: ProtectionAction;
  matched: number;
  updated: number;
  sync: SyncQueueResult | null;
}

export type GroupKind = "microsoft365" | "security" | "mail_security" | "distribution";

/**
 * A person of the tenant's protection directory (synced from Microsoft 365 or added by hand),
 * not a login account: what a machine can be assigned to (`GET /directory/people`).
 */
export interface DirectoryPerson {
  id: string;
  displayName: string | null;
  email: string;
}

export interface PeoplePage {
  items: DirectoryPerson[];
  /** More people match than were returned: narrow the search. */
  more: boolean;
}

export interface GroupSummary {
  id: string;
  displayName: string | null;
  description: string | null;
  mail: string | null;
  kind: GroupKind;
}

export type AccountIssueReason = "missing_login" | "duplicate_login" | "invalid_email";

export interface AccountIssue {
  line: number | null;
  reason: AccountIssueReason;
  value: string | null;
}

export interface ImportedAccount {
  login: string;
  email: string;
  displayName: string | null;
  state: "new" | "existing";
  /** Whether this row carried a password (per_mailbox auth); never the password itself. */
  hasPassword: boolean;
}

/** Body of adding an IMAP account by hand; `password` only matters for a per_mailbox source. */
export interface ImapAccountRequest {
  login: string;
  email?: string | null;
  displayName?: string | null;
  password?: string;
}

/** Result of setting or testing one IMAP account's own login. */
export interface CredentialTestResult {
  object: ProtectedObject;
  probe: ImapProbeResult;
}

export type ImapProbeFailure =
  | "blocked_address"
  | "auth"
  | "timeout"
  | "tls"
  | "starttls_unavailable"
  | "dns"
  | "refused"
  | "unknown";

export type ImapProbeResult =
  | {
      ok: true;
      checkedAt: string;
      secure: boolean;
      server: { name: string | null; vendor: string | null; version: string | null } | null;
      mailboxes: number;
      specialUse: string[];
      capabilities: string[];
    }
  | {
      ok: false;
      checkedAt: string;
      reason: ImapProbeFailure;
      code: string | null;
      message: string;
    };

export interface CsvImportOutcome {
  created: number;
  existing: number;
  accounts: ImportedAccount[];
  issues: AccountIssue[];
  dryRun: boolean;
  hasHeader: boolean;
  delimiter: "," | ";" | "\t";
}
