import type { Failure, ItemCauseCount } from "@/features/failures/api";
import { apiFetch } from "@/lib/api";
import type { Role } from "@/lib/api";

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
export type ObjectKind = "mailbox" | "onedrive" | "imap";

export interface LastBackupWidget {
  lastSuccess: {
    mail: string | null;
    onedrive: string | null;
    imap: string | null;
    archive: string | null;
  };
  protectedKinds: Record<ObjectKind, number>;
  /** Servers and clients: how many a backup job protects, how many are in none, their newest good backup. */
  machines: { protected: number; withoutJob: number; lastSuccessAt: string | null };
  /** Hours without a successful backup after which a type reads as overdue (from its jobs' schedules). */
  staleAfterHours: { mail: number; machines: number };
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
  /** Protected objects and machines without any backup yet. */
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
  running: number;
  lastCheckedAt: string | null;
}

export interface StorageWidget {
  logicalBytes: number;
  physicalBytes: number;
  target: {
    source: "tenant" | "installation_default";
    status: "ok" | "error" | "unverified" | "misconfigured";
  };
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

export interface StorageGrowthWidget {
  days: number;
  series: StoragePoint[];
  growthBytes: number;
  forecast: {
    method: "linear";
    basisDays: number;
    slopeBytesPerDay: number;
    points: StoragePoint[];
  } | null;
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
  | "needs_attention"
  | "nothing_protected";

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
  page: (tenantId: string | null, mode: DashboardMode) =>
    ["tenant", tenantId, "dashboard", { mode }] as const,
  /** The sidebar's Start checklist: the setup widget alone. */
  setup: (tenantId: string | null) => ["tenant", tenantId, "dashboard", "setup"] as const,
};

/**
 * The start page of the active tenant. `all` asks for the provider view alone
 * (`provider=only`): the sum across tenants and the tenant matrix, without
 * reading the active tenant's own widgets.
 */
export function fetchDashboard(mode: DashboardMode = "tenant"): Promise<Dashboard> {
  return apiFetch<Dashboard>(mode === "all" ? "/dashboard?provider=only" : "/dashboard");
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
