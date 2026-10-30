import type { Role } from "../../middleware/rbac.js";
import type { TenantSummaryDto } from "../../routes/v1/status.js";
import type { FailureDto } from "../failures/dto.js";
import type { RunningNowDto } from "../running/dto.js";

/**
 * GET /api/v1/dashboard response. One document serves the whole start page:
 * `widgets` holds exactly the widgets that apply to the viewer (a key that is
 * absent does not apply; the page renders nothing for it), each either with
 * its data or as a failed widget, so one failing query never blanks the page.
 */

/** Every tenant widget the dashboard knows, in page order. */
export const TENANT_WIDGET_IDS = [
  "setup",
  "lastBackup",
  "readiness",
  "running",
  "protectedObjects",
  "storage",
  "mailboxUsage",
  "endpoints",
  "backupTrend",
  "verificationHistory",
  "storageGrowth",
  "retention",
  "recentJobs",
] as const;
export type TenantWidgetId = (typeof TENANT_WIDGET_IDS)[number];

/** A widget's data, or the fact that it could not be loaded (the cause stays in the server log). */
export type WidgetResult<T> = { state: "ok"; data: T } | { state: "error" };

export type Readiness = "green" | "yellow" | "red";
export type TenantStatus = "active" | "suspended" | "deleting";
export type TenantKind = "customer" | "internal";

// ---------------------------------------------------------------------------
// Tenant widgets
// ---------------------------------------------------------------------------

/** Active protected objects per kind, so a type nobody uses is not shown as "never backed up". */
export interface ObjectKindCounts {
  mailbox: number;
  onedrive: number;
  imap: number;
  site: number;
  group: number;
}

export interface LastBackupWidget {
  /** Newest successful run per type (a run that left failed items does not count). */
  lastSuccess: TenantSummaryDto["lastSuccess"];
  protectedKinds: ObjectKindCounts;
  /** Servers and clients backed up by the agent: how many are protected and their newest good backup. */
  machines: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /** VMs and containers of Proxmox VE: in an enabled job, in none, and their newest good backup. */
  guests: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /** File shares (SMB, NFS): in an enabled job, in none, and their newest good backup. */
  fileShares: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /**
   * After how many hours without a successful backup a type reads as overdue, from the
   * schedules of the tenant's enabled jobs (twice the longest planned gap, two days without any).
   */
  staleAfterHours: { mail: number; machines: number; guests: number; fileShares: number };
}

/**
 * Protected objects and how their latest runs ended, with the servers and clients next to them:
 * a machine in a backup job is protected like a mailbox, one in no job is not.
 */
export type ProtectedObjectsWidget = TenantSummaryDto["objects"] & {
  /**
   * Mailboxes, OneDrives, sites, groups and IMAP accounts in no enabled backup job that keep a
   * backup: nothing backs them up any more, whatever their old backups score.
   */
  withoutJob: number;
  machines: { protected: number; withoutJob: number; failedLastBackup: number };
  /**
   * VMs and containers of Proxmox VE: in an enabled job (protected), in none, with a failed newest
   * backup, and the restore points kept for them.
   */
  guests: {
    protected: number;
    withoutJob: number;
    failedLastBackup: number;
    restorePoints: number;
  };
  /**
   * File shares: in an enabled job (protected), in none, with a failed newest backup, with
   * warnings nobody acknowledged, and the restore points kept for them.
   */
  fileShares: {
    protected: number;
    withoutJob: number;
    failedLastBackup: number;
    warnings: number;
    restorePoints: number;
  };
  /** Protected objects, machines, guests and shares without any backup yet (no run can have been fine). */
  noBackup: number;
};

export interface ReadinessWidget {
  /** Worst rating over all objects; null without protected objects. */
  overall: Readiness | null;
  total: number;
  green: number;
  yellow: number;
  red: number;
  /** A backup exists but its newest snapshot was never read back: not proven restorable. */
  unverified: number;
  noBackup: number;
  overdue: number;
  /** Machines and mail objects in no backup job; any of them keeps `overall` from green. */
  withoutJob: number;
  /** The mailboxes, OneDrives, sites, groups and IMAP accounts among `withoutJob`. */
  objectsWithoutJob: number;
  /** VMs and containers in no backup job that keep a restore point; they keep `overall` from green too. */
  guestsWithoutJob: number;
  /** File shares in no backup job that keep a restore point; they keep `overall` from green too. */
  sharesWithoutJob: number;
  /** Objects no longer backed up that wait for an admin's confirmation; they keep `overall` from green too. */
  toConfirm: number;
  running: number;
  lastCheckedAt: string | null;
}

/**
 * What is being copied or backed up right now: every run that goes on (mail, machines, Proxmox
 * VE guests, file shares) with its progress and newest measurements, and the next planned start.
 * The page keeps it current from the live channel; this is its first state and the one it falls
 * back to while the channel is off. Admins only: the runs name mailboxes, machines and guests.
 */
export type RunningWidget = RunningNowDto;

/** Where the tenant's chunk store lives and whether the last probe of it succeeded. */
export interface StorageTargetHealth {
  /** `tenant`: the tenant's own primary target; `installation_default`: the server's default. */
  source: "tenant" | "installation_default";
  /** `ok` / `error` / `unverified` (never probed) for a tenant target; `misconfigured` for a broken default. */
  status: "ok" | "error" | "unverified" | "misconfigured";
}

/**
 * Immutable backups on the tenant's repositories (docs/STORAGE.md): how many
 * repositories lock their backups with S3 Object Lock, how many only delay
 * deletion (a directory; not immutable), and how many of those show a warning
 * (an object found without lock, or a renewal that fell behind).
 */
export interface ImmutabilityOverview {
  objectLock: number;
  deletionDelay: number;
  /** How the primary protects new backups; `none` also for the installation default. */
  primary: "object_lock" | "deletion_delay" | "none";
  warnings: number;
}

/**
 * The tenant's primary repository is a directory on the server's system disk (release 0.4.5):
 * backups that fill it stop the database and every service. The figures are the provider's
 * (null for everyone else): the free space at the last check, its trend over the last week and
 * the hourly samples behind it.
 */
export interface SystemDiskWarningDto {
  freeBytes: number | null;
  totalBytes: number | null;
  /** Change of the free space per day (negative: it shrinks) and when it reaches zero at that rate. */
  trend: { bytesPerDay: number; fullOn: string | null; basisHours: number } | null;
  samples: { at: string; freeBytes: number }[];
}

export interface StorageWidget {
  logicalBytes: number;
  /** Everything stored: the chunk store and the restic repositories. */
  physicalBytes: number;
  /** The restic repositories of machines, file shares and containers (not in logicalBytes). */
  repositoryBytes: number;
  target: StorageTargetHealth;
  immutability: ImmutabilityOverview;
  /** Set when the primary repository lies on the server's system disk; null otherwise. */
  systemDisk: SystemDiskWarningDto | null;
}

export interface RecentJobDto {
  id: string;
  queue: string;
  status: "queued" | "active" | "completed" | "failed" | "cancelled";
  object: {
    kind: "mailbox" | "onedrive" | "imap" | "site" | "group";
    displayName: string | null;
  } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: { total: number; done: number; failed: number } | null;
  /** Microsoft Graph asked the job to wait until then (shown, never hidden). */
  throttledUntil: string | null;
  /** Why the job failed (or its last attempt did), classified; null for a job that did not fail. */
  failure: FailureDto | null;
  /** A failed backup a service held back: shown held back, not failed (jobs DTO `serviceLimited`). */
  serviceLimited: boolean;
  /** A failed backup that did not back up: the account is disabled or unlicensed (jobs DTO `notBackedUp`). */
  notBackedUp: "account_disabled" | "no_license" | "locked" | "login_refused" | null;
  /** The causes behind a finished job's failed items, most frequent first (at most three). */
  itemCauses: { code: string; count: number }[];
}

export interface RecentJobsWidget {
  items: RecentJobDto[];
}

/** One UTC day of finished backup runs. */
export interface BackupDayDto {
  date: string;
  succeeded: number;
  /** Completed, but some items could not be backed up: not a success. */
  withItemFailures: number;
  failed: number;
}

export interface BackupTrendWidget {
  /** Days in `series` (oldest first, ending today, UTC); the page compares the last N with the N before. */
  days: number;
  series: BackupDayDto[];
}

/** One UTC day of verification reports by rating. */
export interface VerificationDayDto {
  date: string;
  green: number;
  yellow: number;
  red: number;
}

export interface VerificationHistoryWidget {
  days: number;
  series: VerificationDayDto[];
  lastCheckedAt: string | null;
}

export interface StoragePointDto {
  date: string;
  bytes: number;
}

/**
 * The estimate of the growth to come: a straight line through the history,
 * continued from today. An estimate, labelled as one on the page.
 */
export interface StorageForecastDto {
  method: "linear";
  /** Days of history the line was fitted to. */
  basisDays: number;
  slopeBytesPerDay: number;
  /** Days the estimate reaches ahead: the requested horizon, never more than the history. */
  horizonDays: number;
  /** One point per day, week or (about) month after today, as the history is bucketed. */
  points: StoragePointDto[];
  /**
   * From 90 days of history on: the range between the slowest and the fastest growth seen in
   * the history's whole weeks or months, shown instead of the line. Null for shorter windows.
   */
  band: StorageBandDto | null;
}

export interface StorageBandDto {
  slowestBytesPerDay: number;
  fastestBytesPerDay: number;
  points: { date: string; low: number; high: number }[];
}

/**
 * The capacity of the repository where it is known: the free space of a local
 * filesystem, read by the API when the page is loaded. S3 reports none, and
 * the installation default is only reported to a tenant that has it to itself.
 */
export interface StorageCapacityDto {
  source: "filesystem";
  freeBytes: number;
  totalBytes: number;
  /**
   * The days the free space runs out at the growth of the estimate (`YYYY-MM-DD`, each null
   * when more than ten years ahead or there is no growth): `estimate` for the line, `earliest`
   * (fastest growth) and `latest` (slowest) for the band. Null as a whole when machines, VMs
   * and containers or file shares of the tenant write to the repository as well: the chart
   * does not count their data, so any day would be too late.
   */
  runsFull: { estimate: string | null; earliest: string | null; latest: string | null } | null;
}

export interface StorageGrowthWidget {
  /** Days shown: the requested days, clamped to the history that exists (at least 7). */
  days: number;
  /** Days the request asked for (`storageDays`, 30 by default). */
  requestedDays: number;
  /** How the series is bucketed: per day up to a month, per ISO week up to half a year, else per month. */
  granularity: "day" | "week" | "month";
  /**
   * Bytes stored at the end of each bucket, by the day the data was written, dated with the
   * bucket's last day (today for the current one).
   */
  series: StoragePointDto[];
  /** Bytes written during the window. */
  growthBytes: number;
  forecast: StorageForecastDto | null;
  capacity: StorageCapacityDto | null;
}

export interface RetentionPolicyDto {
  name: string;
  /** Snapshots older than this are pruned; null keeps them regardless of age. */
  keepDays: number | null;
  /** The newest N snapshots of each object are always kept (at least 1). */
  keepLast: number;
}

export interface RetentionWidget {
  /** The tenant-wide snapshot policy; null means every snapshot is kept (no policy yet). */
  policy: RetentionPolicyDto | null;
  /** Policies limited to single objects. */
  scopedPolicies: number;
  /** Active legal holds; they suspend pruning. */
  activeHolds: number;
  snapshots: { active: number; pruned: number; oldestAt: string | null };
  lastRun: { at: string; status: "completed" | "failed" } | null;
}

export const SETUP_ITEM_IDS = [
  "storage",
  "source",
  "objects",
  "schedules",
  "firstBackup",
  "firstVerification",
  "notificationMail",
] as const;
export type SetupItemId = (typeof SETUP_ITEM_IDS)[number];

export interface SetupItemDto {
  id: SetupItemId;
  /**
   * `attention`: something is set up but broken (failed probe, source error, failed test mail).
   * `not_needed`: an optional step the installation does not want (see `reason`); it counts as
   * settled, like `done`.
   */
  state: "done" | "open" | "attention" | "not_needed";
  /** Machine-readable detail for the page, e.g. `target_error`; null when the state says it all. */
  reason: string | null;
  /** The viewer's role may fix this item; otherwise it is shown as information. */
  actionable: boolean;
}

export interface SetupWidget {
  /** Every item is settled: done, or not needed. */
  complete: boolean;
  /** Items settled so far (done, or not needed). */
  done: number;
  total: number;
  items: SetupItemDto[];
}

export interface MailboxUsageWidget {
  /**
   * `installation`: the mailboxes of the whole installation (provider admins);
   * `tenant`: the viewer's own tenant (everyone else). Nothing limits the
   * number of mailboxes.
   */
  scope: "installation" | "tenant";
  /** Protected mailboxes in the scope. */
  used: number;
  /** The viewer's tenant; `cap` is the number the provider agreed with the customer, never enforced. */
  tenant: { used: number; cap: number | null };
}

/**
 * Servers and clients backed up by the agent (docs/AGENT.md). They also count
 * in the `readiness` widget's totals; this one says which of them need an
 * admin. The API returns it with zeros when the tenant has no endpoint; the
 * page shows the card only for `machines > 0`.
 */
export interface EndpointsWidget {
  /** Machines under protection: endpoints that are not revoked and belong to a backup job. */
  protected: number;
  /** Endpoints that are not revoked, in a job or not; the page shows the card for `machines > 0`. */
  machines: number;
  /** Machines in no backup job: nothing backs them up, so they are not protected. */
  withoutJob: number;
  servers: number;
  clients: number;
  /**
   * The protected machines by the rating of their newest backup, as the
   * recovery-readiness page rates them (a machine without a backup is
   * `noBackup`, a backup no restore test has read back is `unverified`).
   */
  readiness: {
    green: number;
    yellow: number;
    red: number;
    unverified: number;
    noBackup: number;
  };
  /** Machines not proven restorable: red, unverified and without a backup. */
  notReady: number;
  /** Machines whose newest backup run failed (a restart of the agent is no failure). */
  failedLastBackup: number;
  /** Machines with at least one reason to look at them (silent, overdue, failed, damaged ...). */
  needingAttention: number;
  /** Machines with a reason to look at them other than being in no backup job. */
  otherAttention: number;
  /** Newest good backup of any protected machine; null when none exists. */
  lastSuccessAt: string | null;
}

export interface TenantWidgetsDto {
  setup?: WidgetResult<SetupWidget>;
  lastBackup?: WidgetResult<LastBackupWidget>;
  readiness?: WidgetResult<ReadinessWidget>;
  running?: WidgetResult<RunningWidget>;
  protectedObjects?: WidgetResult<ProtectedObjectsWidget>;
  storage?: WidgetResult<StorageWidget>;
  mailboxUsage?: WidgetResult<MailboxUsageWidget>;
  endpoints?: WidgetResult<EndpointsWidget>;
  backupTrend?: WidgetResult<BackupTrendWidget>;
  verificationHistory?: WidgetResult<VerificationHistoryWidget>;
  storageGrowth?: WidgetResult<StorageGrowthWidget>;
  retention?: WidgetResult<RetentionWidget>;
  recentJobs?: WidgetResult<RecentJobsWidget>;
}

// ---------------------------------------------------------------------------
// Provider view
// ---------------------------------------------------------------------------

/** What the matrix knows about every tenant, read or not: identity and mailbox usage. */
interface ProviderTenantRowBase {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  /** `internal`: the operator's own organisation, which is not one of the provider's customers. */
  kind: TenantKind;
  /** Protected mailboxes (counted with the mailbox usage, so known even when the figures are not). */
  mailboxes: number;
  /** The cap the provider agreed with this customer; null = none. Never enforced. */
  mailboxCap: number | null;
}

/** A tenant whose figures were read. */
export interface LoadedTenantRowDto extends ProviderTenantRowBase {
  loaded: true;
  /** Worst rating over the tenant's objects; null without protected objects. */
  readiness: Readiness | null;
  protectedObjects: number;
  /**
   * Mailboxes, OneDrives, sites, groups and IMAP accounts in no enabled backup job that keep a
   * backup: nothing backs them up any more. Also counted in `protectedObjects`.
   */
  objectsWithoutJob: number;
  /** Objects by state, as the recovery-readiness page rates them (they add up to the objects rated). */
  ready: number;
  needsAttention: number;
  notRestorable: number;
  unverified: number;
  noBackup: number;
  /**
   * Jobs of any kind, and backups and restores of servers and clients, of VMs and containers and
   * of file shares, that failed in the last 24 hours.
   */
  failures24h: number;
  /** The same count for the 24 hours before, for the trend. */
  failuresPrevious24h: number;
  /**
   * Newest successful backup of any type (mail, OneDrive, IMAP, servers and clients, VMs and
   * containers, file shares); null when there is none.
   */
  lastBackupAt: string | null;
  /** After how many hours without a successful backup the tenant reads as stale (by its jobs' schedules). */
  staleAfterHours: number;
  /** Servers and clients in a backup job. */
  machines: number;
  /** Servers and clients in no backup job: nothing backs them up. */
  machinesWithoutJob: number;
  /** Servers and clients whose newest backup run failed. */
  machinesFailed: number;
  /** VMs and containers of Proxmox VE in an enabled backup job. */
  guests: number;
  /** VMs and containers in no enabled backup job: nothing backs them up. */
  guestsWithoutJob: number;
  /** Protected VMs and containers whose newest backup run failed. */
  guestsFailed: number;
  /** File shares in an enabled backup job. */
  fileShares: number;
  /** File shares in no enabled backup job: nothing backs them up. */
  fileSharesWithoutJob: number;
  /** Protected file shares whose newest backup run failed. */
  fileSharesFailed: number;
  physicalBytes: number;
  storageError: boolean;
  /** Repositories of the tenant with S3 Object Lock on (immutable backups). */
  immutableRepositories: number;
  /** Of those, the ones with a warning (an object without lock, a renewal behind). */
  immutabilityWarnings: number;
  /**
   * Objects no longer backed up (removed, disabled, unlicensed, locked) that the tenant did not
   * confirm as intended yet: apart from the rated states, they keep `readiness` from green.
   */
  toConfirm: number;
  /**
   * IMAP accounts whose login keeps being refused and whose question "was this account shut
   * down?" waits for an answer: the provider sees "answer needed" for the tenant until an admin
   * answers (docs/IMAP.md). The accounts are active and failing, so `failures24h` and the
   * readiness already show them; this says what the tenant has to do.
   */
  loginQuestions: number;
}

/**
 * A tenant whose figures could not be read. Every figure is null: unknown,
 * never a zero that would read as "nothing wrong".
 */
export interface UnavailableTenantRowDto extends ProviderTenantRowBase {
  loaded: false;
  readiness: null;
  protectedObjects: null;
  objectsWithoutJob: null;
  ready: null;
  needsAttention: null;
  notRestorable: null;
  unverified: null;
  noBackup: null;
  failures24h: null;
  failuresPrevious24h: null;
  lastBackupAt: null;
  staleAfterHours: null;
  machines: null;
  machinesWithoutJob: null;
  machinesFailed: null;
  guests: null;
  guestsWithoutJob: null;
  guestsFailed: null;
  fileShares: null;
  fileSharesWithoutJob: null;
  fileSharesFailed: null;
  physicalBytes: null;
  storageError: null;
  immutableRepositories: null;
  immutabilityWarnings: null;
  toConfirm: null;
  loginQuestions: null;
}

export type ProviderTenantRowDto = LoadedTenantRowDto | UnavailableTenantRowDto;

export const PROVIDER_ALERT_KINDS = [
  "unavailable",
  "storage_error",
  "not_restorable",
  "failed_jobs",
  "over_cap",
  "unverified",
  "no_backup",
  "stale_backup",
  "machine_backup_failed",
  "machines_without_job",
  "objects_without_job",
  "guest_backup_failed",
  "guests_without_job",
  "file_share_backup_failed",
  "file_shares_without_job",
  "needs_attention",
  "inactive_to_confirm",
  "login_question",
  "nothing_protected",
  "immutability_warning",
] as const;
export type ProviderAlertKind = (typeof PROVIDER_ALERT_KINDS)[number];

export interface ProviderAlertDto {
  tenantId: string;
  tenantName: string;
  kind: ProviderAlertKind;
  severity: "destructive" | "warning";
  /** How many objects, jobs or mailboxes; null when the alert is not a count. */
  count: number | null;
  /** When it started, where known (e.g. the last successful backup of a stale tenant). */
  since: string | null;
}

/**
 * Provider-wide figures. The sums over tenant figures (readiness, objects,
 * failures, storage) cover the tenants that could be read; `unavailableTenants`
 * says how many are missing from them, so a total is never passed off as
 * complete. Tenants and mailboxes are always complete.
 */
export interface ProviderKpisDto {
  /** The provider's customers: the operator's own organisation (`kind = internal`) is not counted. */
  tenants: number;
  /** Suspended customers. */
  suspendedTenants: number;
  /** Tenants whose figures could not be read and are left out of the sums below. */
  unavailableTenants: number;
  /** Customers whose overall readiness is red (something cannot be restored or is unproven). */
  tenantsNotReady: number;
  /**
   * The objects of every tenant that could be read, the operator's own organisation included
   * (it is protected like any other), by state: the sum behind the readiness tile.
   */
  readiness: {
    total: number;
    green: number;
    yellow: number;
    red: number;
    unverified: number;
    noBackup: number;
  };
  protectedObjects: number;
  unverifiedObjects: number;
  failures24h: number;
  /** Failed jobs in the 24 hours before, over the same tenants, for the trend. */
  failuresPrevious24h: number;
  /** Protected mailboxes across all tenants. */
  mailboxes: number;
  physicalBytes: number;
  /** Customers with at least one repository under S3 Object Lock (immutable backups). */
  tenantsWithImmutableBackups: number;
}

export interface ProviderViewDto {
  kpis: ProviderKpisDto;
  tenants: ProviderTenantRowDto[];
  alerts: ProviderAlertDto[];
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export interface DashboardViewerDto {
  role: Role;
  isProviderAdmin: boolean;
  /** Tenant admin or provider admin: sees the admin widgets and can act on the setup items. */
  canAdminister: boolean;
}

export interface DashboardDto {
  generatedAt: string;
  viewer: DashboardViewerDto;
  tenant: { id: string; name: string; slug: string; status: TenantStatus };
  widgets: TenantWidgetsDto;
  /** Present only when requested (`?provider=true`) and allowed. */
  provider: WidgetResult<ProviderViewDto> | null;
}
