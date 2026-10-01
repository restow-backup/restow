import type { Failure } from "@/features/failures/api";
import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/verify (apps/api/src/features/verify). The shapes
 * mirror the API DTOs one to one; query keys carry the tenant so a tenant
 * switch never shows another tenant's ratings.
 */

export type Readiness = "green" | "yellow" | "red";
export type ObjectState = Readiness | "unverified" | "no_backup";
export type ObjectKind = "mailbox" | "onedrive" | "imap";
export type ObjectStatus = "active" | "excluded" | "orphaned";
export type CheckKind = "verify" | "health_check";
export type ReportOrigin = "verify" | "scrub" | "unknown";
export type SampleCategory = "mail" | "file" | "event" | "contact";
export type ScrubMode = "sample" | "full";

export interface VerifyObject {
  id: string;
  kind: ObjectKind;
  displayName: string | null;
  /**
   * `externalId` is a stable identifier, not something to show: for a
   * mailbox and a OneDrive it is the owning Entra user's object id or drive
   * id (opaque, GUID-like), never the address. Only for `imap` is it itself
   * the human login. Use `presenters.ts`' `objectName`/`objectAddress`
   * instead of reading these fields directly.
   */
  externalId: string;
  status: ObjectStatus;
  /** The linked directory user's primary address, when known. */
  email: string | null;
  upn: string | null;
}

export interface Reason {
  code: string;
  severity: "yellow" | "red";
  count: number | null;
  ageHours: number | null;
  /**
   * The reason explained: why it is not green, what happened and what to do
   * (a `verify.*` cause with steps). Null for a code this server does not
   * know; the translated reason text stands alone then.
   */
  failure: Failure | null;
}

export interface CountSummary {
  checked: number;
  verified: number;
  failed: number;
}

export interface LatestReport {
  id: string;
  kind: CheckKind;
  origin: ReportOrigin;
  reasons: Reason[];
  counts: CountSummary | null;
}

export interface RunningCheck {
  jobId: string;
  status: "queued" | "active";
  kind: CheckKind;
}

/** The verification of one backup (snapshot): its rating, or `unverified` until a check read it. */
export type VerificationState = Readiness | "unverified";

export interface SnapshotVerification {
  state: VerificationState;
  checkedAt: string | null;
  reportId: string | null;
}

/** The newest check of an older backup, shown while the newest backup is not verified yet. */
export interface PreviousCheck {
  reportId: string;
  readiness: Readiness;
  checkedAt: string;
  snapshotId: string | null;
}

/**
 * The readiness of one object. `state`, `readiness`, `checkedAt` and
 * `report` describe the newest backup: after a new backup they read
 * `unverified` / null until a check of that backup ran.
 */
export interface ObjectReadiness {
  object: VerifyObject;
  state: ObjectState;
  readiness: Readiness | null;
  checkedAt: string | null;
  overdue: boolean;
  latestSnapshotAt: string | null;
  report: LatestReport | null;
  running: RunningCheck | null;
  latestSnapshotId: string | null;
  previousCheck: PreviousCheck | null;
}

export interface ReadinessSummary {
  total: number;
  green: number;
  yellow: number;
  red: number;
  unverified: number;
  noBackup: number;
  overdue: number;
  overall: Readiness | null;
  lastCheckedAt: string | null;
  running: number;
}

export interface TargetCheck {
  target: number;
  status: string;
  detail: string | null;
  repaired: boolean;
}

export interface PackCheck {
  path: string;
  targets: TargetCheck[];
}

export type GcResult =
  | {
      status: "completed";
      packsRewritten: number;
      packsRemoved: number;
      chunksDropped: number;
      bytesReclaimed: number;
      conflicts: number;
      interruptedBy: string | null;
      skipped: number;
    }
  | { status: "skipped"; reason: string };

export interface ScrubRun {
  jobId: string;
  completedAt: string | null;
  mode: ScrubMode;
  packsTotal: number;
  packsChecked: number;
  bytesChecked: number;
  ok: number;
  repaired: PackCheck[];
  corrupt: PackCheck[];
  /** Damaged packs retired because later backups wrote their content again. */
  retired: number;
  gc: GcResult | null;
  orphans: { removed: number; bytes: number; kept: number } | null;
  durationMs: number | null;
}

export type StorageState = "ok" | "repaired" | "corrupt" | "never";

export interface StorageIntegrity {
  state: StorageState;
  latest: ScrubRun | null;
  lastFullAt: string | null;
  running: { jobId: string; status: "queued" | "active"; mode: ScrubMode } | null;
  lastFailure: { jobId: string; at: string | null; message: string | null } | null;
}

/** An enabled schedule with its next due time; null in the overview when none exists. */
export interface Schedule {
  nextRunAt: string | null;
}

/**
 * A server or client in the readiness overview (apps/api features/endpoints
 * overview.ts): rated by the restore test of its newest good backup, like the
 * mailboxes, and counted in the summary.
 */
export interface EndpointReadinessRow {
  id: string;
  hostname: string;
  displayName: string | null;
  profile: "server" | "client";
  os: "linux" | "windows" | "darwin";
  state: ObjectState;
  /** The rating of the newest backup; null while it is unverified or without a backup. */
  readiness: Readiness | null;
  checkedAt: string | null;
  overdue: boolean;
  latestBackupAt: string | null;
  latestSnapshotId: string | null;
}

export interface ReadinessOverview {
  summary: ReadinessSummary;
  objects: ObjectReadiness[];
  /** Servers and clients; absent from servers that predate endpoint backup. */
  endpoints?: EndpointReadinessRow[];
  storage: StorageIntegrity;
  schedules: { backup: Schedule | null; verify: Schedule | null; scrub: Schedule | null };
}

export interface ReportSummary {
  id: string;
  object: VerifyObject;
  kind: CheckKind;
  origin: ReportOrigin;
  readiness: Readiness;
  checkedAt: string;
  jobId: string | null;
  /** The backup the report checked; null for storage findings and reports that name none. */
  snapshotId: string | null;
  reasons: Reason[];
  counts: CountSummary | null;
}

export type CategoryCounts = Record<SampleCategory, number>;

export interface CheckedItem {
  path: string;
  id: string | null;
  category: SampleCategory;
  size: number;
  bytesRead: number;
  chunks: number;
  status: "verified" | "mismatch" | "missing" | "unreadable";
  objectHash: "matched" | "mismatched" | "not_recorded" | "not_reached";
  reason: string | null;
  /** Why this item did not come back intact (why, what to do); null for a verified item. */
  failure: Failure | null;
}

export interface VerifyDetails {
  origin: "verify";
  kind: CheckKind;
  scope: "sample" | "all";
  seed: number | null;
  snapshot: {
    id: string;
    sequence: number;
    completedAt: string | null;
    itemCount: number;
    packCount: number;
  } | null;
  /** Why the manifest of the checked backup could not be read, when it could not. */
  manifestFailure: Failure | null;
  counts: {
    eligible: CategoryCounts;
    sampled: CategoryCounts;
    checked: number;
    verified: number;
    mismatch: number;
    missing: number;
    unreadable: number;
    bytesRead: number;
  };
  items: CheckedItem[];
  itemsOmitted: number;
  damagedPacks: string[];
  testRestore: {
    target: string;
    items: {
      path: string;
      status: "confirmed" | "unconfirmed" | "failed";
      reason: string | null;
      /** Why the target did not take the item; null when it did or the cause is unknown. */
      failure: Failure | null;
    }[];
  } | null;
  startedAt: string | null;
  durationMs: number | null;
}

export interface ScrubFinding {
  origin: "scrub";
  scrubJobId: string | null;
  packs: PackCheck[];
}

export type ReportDetails = VerifyDetails | ScrubFinding | { origin: "unknown" };

/** The object's newest backup next to a report of an older one. */
export interface LatestBackup {
  snapshotId: string;
  sequence: number;
  completedAt: string | null;
  verification: SnapshotVerification;
}

export interface ReportDetail extends ReportSummary {
  details: ReportDetails;
  /** Set when the object has a newer backup than the one this report checked. */
  latestBackup: LatestBackup | null;
}

export interface ReportPage {
  items: ReportSummary[];
  next: string | null;
}

export type SkipReason = "no_backup" | "excluded" | "already_queued";

export interface RunVerifyResult {
  queued: {
    jobId: string;
    protectedObjectId: string;
    displayName: string | null;
    kind: CheckKind;
  }[];
  skipped: { protectedObjectId: string; displayName: string | null; reason: SkipReason }[];
}

export interface RunVerifyRequest {
  protectedObjectId?: string;
  kind?: CheckKind;
  /** Without an object: check only the objects whose newest backup is not verified yet. */
  unverifiedOnly?: boolean;
}

// --- Query keys ---------------------------------------------------------------

export const verifyKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "verify"] as const,
  overview: (tenantId: string | null) => ["tenant", tenantId, "verify", "overview"] as const,
  reports: (tenantId: string | null, objectId: string | null) =>
    ["tenant", tenantId, "verify", "reports", objectId] as const,
  report: (tenantId: string | null, reportId: string) =>
    ["tenant", tenantId, "verify", "report", reportId] as const,
};

// --- Endpoints ----------------------------------------------------------------

export function fetchReadinessOverview(): Promise<ReadinessOverview> {
  return apiFetch<ReadinessOverview>("/verify/latest");
}

export function fetchReports(options: {
  objectId?: string;
  cursor?: string;
  limit?: number;
}): Promise<ReportPage> {
  const params = new URLSearchParams();
  if (options.objectId) params.set("objectId", options.objectId);
  if (options.cursor) params.set("cursor", options.cursor);
  params.set("limit", String(options.limit ?? 20));
  return apiFetch<ReportPage>(`/verify/reports?${params.toString()}`);
}

export function fetchReport(reportId: string): Promise<ReportDetail> {
  return apiFetch<ReportDetail>(`/verify/reports/${encodeURIComponent(reportId)}`);
}

export function startVerify(request: RunVerifyRequest): Promise<RunVerifyResult> {
  return apiFetch<RunVerifyResult>("/verify", { method: "POST", body: request });
}

export function startScrub(mode: ScrubMode): Promise<{ jobId: string; mode: ScrubMode }> {
  return apiFetch<{ jobId: string; mode: ScrubMode }>("/verify/scrub", {
    method: "POST",
    body: { mode },
  });
}
