import type { Failure, ItemCauseCount } from "@/features/failures/api";
import type { Role } from "@/lib/api";
import { apiFetch } from "@/lib/api";

/**
 * GET /api/v1/dashboard: the whole start page in one response (see
 * apps/api/src/features/dashboard/dto.ts for the server side). `widgets`
 * holds exactly the widgets that apply to the viewer; a key that is absent
 * does not apply and renders nothing. Each widget carries its data or the
 * fact that it failed, so one failing source never blanks the page.
 */

export type WidgetResult<T> = { state: "ok"; data: T } | { state: "error" };

export type Readiness = "green" | "yellow" | "red";
export type TenantStatus = "active" | "suspended" | "deleting";
export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";
export type ObjectKind = "mailbox" | "onedrive" | "imap" | "site" | "group";

export interface LastBackupWidget {
  lastSuccess: {
    mail: string | null;
    onedrive: string | null;
    imap: string | null;
    /** SharePoint sites (absent from an older server). */
    sharepoint?: string | null;
    /** Group mailboxes of Microsoft 365 groups and teams (absent from an older server). */
    groups?: string | null;
    archive: string | null;
  };
  /** `site` and `group` are absent from an older server. */
  protectedKinds: Record<Exclude<ObjectKind, "site" | "group">, number> & {
    site?: number;
    group?: number;
  };
  /** Servers and clients: how many a backup job protects, how many are in none, their newest good backup. */
  machines: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /**
   * VMs and containers of Proxmox VE: in an enabled job, in none, their newest good backup
   * (absent from an older server).
   */
  guests?: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /** File shares: in an enabled job, in none, their newest good backup (absent from an older server). */
  fileShares?: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /** Hours without a successful backup after which a type reads as overdue (from its jobs' schedules). */
  staleAfterHours: { mail: number; machines: number; guests?: number; fileShares?: number };
}

export interface ProtectedObjectsWidget {
  total: number;
  active: number;
  excluded: number;
  orphaned: number;
  failed: number;
  /** Objects whose newest backup left items behind, without an acknowledgement that covers it. */
  withItemFailures: number;
  /** Objects whose warning an administrator acknowledged (absent from an older server). */
  acknowledgedWarnings?: number;
  runningBackups: number;
  /** Servers and clients: in a backup job (protected), in none, and with a failed newest backup. */
  machines: { protected: number; withoutJob: number; failedLastBackup: number };
  /**
   * VMs and containers of Proxmox VE: in an enabled job, in none, with a failed newest backup,
   * and their restore points (absent from an older server).
   */
  guests?: {
    protected: number;
    withoutJob: number;
    failedLastBackup: number;
    restorePoints: number;
  };
  /**
   * File shares: in an enabled job, in none, with a failed newest backup, with warnings nobody
   * acknowledged, and their restore points (absent from an older server).
   */
  fileShares?: {
    protected: number;
    withoutJob: number;
    failedLastBackup: number;
    warnings: number;
    restorePoints: number;
  };
  /** Protected objects, machines, guests and shares without any backup yet. */
  noBackup: number;
}

export interface ReadinessWidget {
  overall: Readiness | null;
  total: number;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
  overdue: number;
  /** Machines in no backup job; any of them keeps `overall` from green. */
  withoutJob: number;
  /** VMs and containers in no backup job that keep a restore point (absent from an older server). */
  guestsWithoutJob?: number;
  /** File shares in no backup job that keep a restore point (absent from an older server). */
  sharesWithoutJob?: number;
  /**
   * Objects no longer backed up that wait for an admin's confirmation; they keep `overall` from
   * green (absent from an older server).
   */
  toConfirm?: number;
  running: number;
  lastCheckedAt: string | null;
}

export interface StorageWidget {
  logicalBytes: number;
  /** Everything stored: the chunk store and the restic repositories. */
  physicalBytes: number;
  /** The restic repositories of machines, file shares and containers (absent from an older api). */
  repositoryBytes?: number;
  target: {
    source: "tenant" | "installation_default";
    status: "ok" | "error" | "unverified" | "misconfigured";
  };
  /** Immutable backups on the tenant's repositories (absent from an older api). */
  immutability?: {
    objectLock: number;
    deletionDelay: number;
    primary: "object_lock" | "deletion_delay" | "none";
    warnings: number;
  };
  /**
   * The primary repository lies on the server's system disk (0.4.5); null when not, absent from
   * an older api. The figures only for provider admins (null otherwise).
   */
  systemDisk?: SystemDiskWarning | null;
}

export interface SystemDiskWarning {
  freeBytes: number | null;
  totalBytes: number | null;
  /** Change of the free space per day (negative: shrinking) and the day it reaches zero. */
  trend: { bytesPerDay: number; fullOn: string | null; basisHours: number } | null;
  samples: { at: string; freeBytes: number }[];
}

export interface RecentJob {
  id: string;
  queue: string;
  status: JobStatus;
  object: { kind: ObjectKind; displayName: string | null } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress: { total: number; done: number; failed: number } | null;
  throttledUntil: string | null;
  /** Why the job failed (classified); null when it did not or only text exists. */
  failure?: Failure | null;
  /**
   * A failed backup that Graph or the storage held back (throttled, unavailable): no fault of
   * the object, the next scheduled run tries again. Missing on servers before 0.4.7.
   */
  serviceLimited?: boolean;
  /** A backup of a disabled or unlicensed account: neutral, never failed. Missing before 0.4.7. */
  notBackedUp?: "account_disabled" | "no_license" | "locked" | null;
  /** The causes behind a finished job's failed items, most frequent first. */
  itemCauses?: ItemCauseCount[];
}

export interface RecentJobsWidget {
  items: RecentJob[];
}

export interface BackupDay {
  date: string;
  succeeded: number;
  withItemFailures: number;
  failed: number;
}

export interface BackupTrendWidget {
  days: number;
  series: BackupDay[];
}

export interface VerificationDay {
  date: string;
  green: number;
  yellow: number;
  red: number;
}

export interface VerificationHistoryWidget {
  days: number;
  series: VerificationDay[];
  lastCheckedAt: string | null;
}

export interface StoragePoint {
  date: string;
  bytes: number;
}

export interface StorageForecast {
  method: "linear";
  /** Days of history the estimate rests on. */
  basisDays: number;
  slopeBytesPerDay: number;
  /** Days the estimate reaches ahead (absent from an older server: as many as `points`). */
  horizonDays?: number;
  points: StoragePoint[];
  /**
   * From 90 days of history on: the range between the slowest and the fastest growth of the
   * history, drawn instead of the line (absent from an older server).
   */
  band?: {
    slowestBytesPerDay: number;
    fastestBytesPerDay: number;
    points: { date: string; low: number; high: number }[];
  } | null;
}

/** The free space of a local repository, and when it runs out at the estimated growth. */
export interface StorageCapacity {
  source: "filesystem";
  freeBytes: number;
  totalBytes: number;
  /** Null when other data (machines, guests, file shares) is written there as well: no day is named. */
  runsFull: { estimate: string | null; earliest: string | null; latest: string | null } | null;
}

export type StorageGranularity = "day" | "week" | "month";

export interface StorageGrowthWidget {
  /** Days shown: the requested days, clamped to the history that exists. */
  days: number;
  /** Days asked for (absent from an older server: as many as shown). */
  requestedDays?: number;
  /** Points per day, ISO week or month (absent from an older server: per day). */
  granularity?: StorageGranularity;
  /** Bytes stored at the end of each bucket, dated with its last day. */
  series: StoragePoint[];
  growthBytes: number;
  forecast: StorageForecast | null;
  /** Absent from an older server, null where the capacity is not known (S3, a shared default). */
  capacity?: StorageCapacity | null;
}

export interface RetentionWidget {
  policy: { name: string; keepDays: number | null; keepLast: number } | null;
  scopedPolicies: number;
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

export interface SetupItem {
  id: SetupItemId;
  /** `not_needed`: an optional step the installation does not want; it counts as settled, like `done`. */
  state: "done" | "open" | "attention" | "not_needed";
  reason: string | null;
  actionable: boolean;
}

export interface SetupWidget {
  /** Every item is settled: done, or not needed. */
  complete: boolean;
  /** Items settled so far (done, or not needed). */
  done: number;
  total: number;
  items: SetupItem[];
}

/**
 * Protected mailboxes: of the whole installation for a provider admin
 * (`installation`), of the active tenant for everyone else (`tenant`).
 */
export interface MailboxUsageWidget {
  scope: "installation" | "tenant";
  /** Protected mailboxes in the scope. */
  used: number;
  /** The viewer's tenant; `cap` is the number the provider agreed with the customer, never enforced. */
  tenant: { used: number; cap: number | null };
}

/**
 * Servers and clients backed up by the agent. They also count in the
 * readiness widget's totals. The server answers with zeros for a tenant
 * without endpoints; the page shows the card only when `machines > 0`.
 */
export interface EndpointsWidget {
  /** Machines under protection: endpoints that are not revoked and belong to a backup job. */
  protected: number;
  /** Endpoints that are not revoked, in a job or not. */
  machines: number;
  /** Machines in no backup job: nothing backs them up. */
  withoutJob: number;
  servers: number;
  clients: number;
  /** The protected machines by the rating of their newest backup (as the verify page rates them). */
  readiness: {
    green: number;
    yellow: number;
    red: number;
    unverified: number;
    noBackup: number;
  };
  /** Red, unverified and without a backup: not proven restorable. */
  notReady: number;
  /** Machines whose newest backup run failed (a restart of the agent is no failure). */
  failedLastBackup: number;
  /** Machines with at least one reason to look at them. */
  needingAttention: number;
  /** Machines with a reason to look at them other than being in no backup job. */
  otherAttention: number;
  /** Newest good backup of any protected machine. */
  lastSuccessAt: string | null;
}

/** Every widget the page knows, by id. */
export interface WidgetData {
  setup: SetupWidget;
  lastBackup: LastBackupWidget;
  readiness: ReadinessWidget;
  protectedObjects: ProtectedObjectsWidget;
  storage: StorageWidget;
  mailboxUsage: MailboxUsageWidget;
  endpoints: EndpointsWidget;
  backupTrend: BackupTrendWidget;
  verificationHistory: VerificationHistoryWidget;
  storageGrowth: StorageGrowthWidget;
  retention: RetentionWidget;
  recentJobs: RecentJobsWidget;
}

export type WidgetId = keyof WidgetData;

export type TenantWidgets = { [K in WidgetId]?: WidgetResult<WidgetData[K]> };

export type TenantKind = "customer" | "internal";

interface ProviderTenantRowBase {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  /** `internal`: the operator's own organisation, which is not one of the provider's customers. */
  kind: TenantKind;
  /** Protected mailboxes, known for every tenant (counted with the mailbox usage). */
  mailboxes: number;
  mailboxCap: number | null;
}

/** A tenant whose figures were read. */
export interface LoadedTenantRow extends ProviderTenantRowBase {
  loaded: true;
  readiness: Readiness | null;
  protectedObjects: number;
  /** Objects by state, as Recovery readiness rates them. */
  ready: number;
  needsAttention: number;
  notRestorable: number;
  unverified: number;
  noBackup: number;
  failures24h: number;
  failuresPrevious24h: number;
  lastBackupAt: string | null;
  /** Hours without a successful backup after which the tenant reads as stale (by its schedules). */
  staleAfterHours: number;
  /** Servers and clients in a backup job, in none, and with a failed newest backup. */
  machines: number;
  machinesWithoutJob: number;
  machinesFailed: number;
  /** VMs and containers in an enabled job, in none, and with a failed newest backup (absent from an older server). */
  guests?: number;
  guestsWithoutJob?: number;
  guestsFailed?: number;
  /** File shares in an enabled job, in none, and with a failed newest backup (absent from an older server). */
  fileShares?: number;
  fileSharesWithoutJob?: number;
  fileSharesFailed?: number;
  /** Objects no longer backed up that wait for a confirmation (absent from an older server). */
  toConfirm?: number;
  physicalBytes: number;
  storageError: boolean;
}

/** A tenant whose figures could not be read: every figure is unknown (null), never zero. */
export interface UnavailableTenantRow extends ProviderTenantRowBase {
  loaded: false;
  readiness: null;
  protectedObjects: null;
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
  guests?: null;
  guestsWithoutJob?: null;
  guestsFailed?: null;
  fileShares?: null;
  fileSharesWithoutJob?: null;
  fileSharesFailed?: null;
  toConfirm?: null;
  physicalBytes: null;
  storageError: null;
}

export type ProviderTenantRow = LoadedTenantRow | UnavailableTenantRow;

export type ProviderAlertKind =
  | "unavailable"
  | "storage_error"
  | "not_restorable"
  | "failed_jobs"
  | "over_cap"
  | "unverified"
  | "no_backup"
  | "stale_backup"
  | "machine_backup_failed"
  | "machines_without_job"
  | "guest_backup_failed"
  | "guests_without_job"
  | "file_share_backup_failed"
  | "file_shares_without_job"
  | "needs_attention"
  | "inactive_to_confirm"
  | "nothing_protected"
  | "immutability_warning";

export interface ProviderAlert {
  tenantId: string;
  tenantName: string;
  kind: ProviderAlertKind;
  severity: "destructive" | "warning";
  count: number | null;
  since: string | null;
}

/**
 * Provider-wide figures. Sums over tenant figures leave out the
 * `unavailableTenants` whose figures could not be read.
 */
export interface ProviderKpis {
  /** The provider's customers: the own organisation is not counted. */
  tenants: number;
  suspendedTenants: number;
  unavailableTenants: number;
  /** Customers whose overall readiness is red. */
  tenantsNotReady: number;
  /** The objects of every tenant that could be read, the own organisation included, by state. */
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
  failuresPrevious24h: number;
  mailboxes: number;
  physicalBytes: number;
  /** Customers with at least one repository under S3 Object Lock. */
  tenantsWithImmutableBackups?: number;
}

export interface ProviderView {
  kpis: ProviderKpis;
  tenants: ProviderTenantRow[];
  alerts: ProviderAlert[];
}

export interface Dashboard {
  generatedAt: string;
  viewer: { role: Role; isProviderAdmin: boolean; canAdminister: boolean };
  tenant: { id: string; name: string; slug: string; status: TenantStatus };
  widgets: TenantWidgets;
  provider: WidgetResult<ProviderView> | null;
}

/** What the page asks for: the active tenant's widgets, or only the provider view ("All tenants"). */
export type DashboardMode = "tenant" | "all";

export const dashboardKeys = {
  page: (tenantId: string | null, mode: DashboardMode, params: Record<string, string> = {}) =>
    ["tenant", tenantId, "dashboard", { mode, ...params }] as const,
  /** The sidebar's Start checklist: the setup widget alone. */
  setup: (tenantId: string | null) => ["tenant", tenantId, "dashboard", "setup"] as const,
};

/**
 * The start page of the active tenant. `all` asks for the provider view alone
 * (`provider=only`): the sum across tenants and the tenant matrix, without
 * reading the active tenant's own widgets. `params` are the tenant page's
 * chart windows (ranges.ts `storageRangeParams`).
 */
export function fetchDashboard(
  mode: DashboardMode = "tenant",
  params: Record<string, string> = {},
): Promise<Dashboard> {
  if (mode === "all") {
    return apiFetch<Dashboard>("/dashboard?provider=only");
  }
  const query = new URLSearchParams(params).toString();
  return apiFetch<Dashboard>(query ? `/dashboard?${query}` : "/dashboard");
}

/** The setup checklist alone (`widgets=setup`), which is all the sidebar's Start entry needs. */
export function fetchSetup(): Promise<Dashboard> {
  return apiFetch<Dashboard>("/dashboard?widgets=setup");
}

/** Mark the notification mail as not needed, or take the mark back (installation owners). */
export function setMailNotNeeded(notNeeded: boolean): Promise<{ notNeeded: boolean }> {
  return apiFetch<{ notNeeded: boolean }>("/settings/mail/not-needed", {
    method: "PUT",
    body: { notNeeded },
    // An installation setting: it belongs to no tenant.
    tenantId: null,
  });
}
