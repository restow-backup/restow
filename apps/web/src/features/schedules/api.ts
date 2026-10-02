import { apiFetch } from "@/lib/api";

/**
 * Typed client for /api/v1/schedules (apps/api/src/features/schedules). The
 * shapes mirror the API DTOs one to one; query keys carry the tenant so a
 * tenant switch never shows another tenant's schedules.
 */

export type ScheduleKind = "backup" | "verify" | "retention" | "scrub" | "directory" | "archive";

/** Kinds a schedule can have (an existing backup or verify schedule can still be edited); archive sync is not offered yet. */
export type OfferedKind = Exclude<ScheduleKind, "archive">;
/**
 * Kinds an administrator can create. Backups and restore checks are backup jobs
 * since 0.2.0 (features/backup-jobs); the API creates no backup or verify schedule
 * any more, so only maintenance is offered here.
 */
export const OFFERED_KINDS: readonly OfferedKind[] = ["scrub", "directory", "retention"];
/** What a new schedule starts as. */
export const DEFAULT_NEW_KIND: OfferedKind = "scrub";

/** Kinds that can be narrowed to one protected object. */
export const OBJECT_SCOPED_KINDS: readonly ScheduleKind[] = ["backup", "verify"];

export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";
export type ObjectKind = "mailbox" | "onedrive" | "imap";

/**
 * The one object a schedule is narrowed to. Tenant users see another
 * person's object by its kind only (id and name are null).
 */
export type ScheduleObject =
  | { id: string; name: string; kind: ObjectKind }
  | { id: null; name: null; kind: ObjectKind };

export interface ScheduleLastJob {
  /** Null for viewers who may not open jobs (tenant users). */
  id: string | null;
  status: JobStatus;
  finishedAt: string | null;
}

export interface ScheduleItem {
  id: string;
  kind: ScheduleKind;
  protectedObject: ScheduleObject | null;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
  /** Null while the schedule is switched off. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJob: ScheduleLastJob | null;
  /**
   * The backup job that took over this backup or verify schedule (release 0.2.0);
   * null when nothing did. Absent on servers from before 0.2.0, which read as null.
   */
  supersededByJobId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleList {
  items: ScheduleItem[];
  /** Recommended kinds without a schedule; "apply recommended" adds them. */
  missingKinds: ScheduleKind[];
}

export interface ScheduleInput {
  kind: OfferedKind;
  protectedObjectId: string | null;
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
  enabled: boolean;
}

export type SchedulePatch = Partial<Omit<ScheduleInput, "kind">>;

export interface PreviewRequest {
  intervalMinutes: number | null;
  cron: string | null;
  timezone: string;
}

export interface SchedulePreview {
  next: string[];
}

export interface ApplyRecommendedResult {
  created: ScheduleItem[];
  /**
   * The default mail job the recommended set created when no job covered all objects (release 0.2.0);
   * null when none was needed. Absent on servers from before 0.2.0.
   */
  jobCreated?: { id: string; name: string } | null;
  missingKinds: ScheduleKind[];
}

/** A protected object a backup or verify schedule can be narrowed to. */
export interface ScopeCandidate {
  id: string;
  name: string;
  detail: string | null;
  kind: ObjectKind;
}

// --- Query keys ---------------------------------------------------------------

export const scheduleKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "schedules"] as const,
  list: (tenantId: string | null) => ["tenant", tenantId, "schedules", "list"] as const,
  preview: (tenantId: string | null, request: PreviewRequest) =>
    ["tenant", tenantId, "schedules", "preview", request] as const,
  scope: (tenantId: string | null, search: string) =>
    ["tenant", tenantId, "schedules", "scope", search] as const,
};

// --- Endpoints ----------------------------------------------------------------

const base = "/schedules";

export function fetchSchedules(): Promise<ScheduleList> {
  return apiFetch<ScheduleList>(base);
}

export function createSchedule(input: ScheduleInput): Promise<ScheduleItem> {
  return apiFetch<ScheduleItem>(base, { method: "POST", body: input });
}

export function updateSchedule(id: string, patch: SchedulePatch): Promise<ScheduleItem> {
  return apiFetch<ScheduleItem>(`${base}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteSchedule(id: string): Promise<void> {
  return apiFetch<void>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function previewSchedule(request: PreviewRequest): Promise<SchedulePreview> {
  return apiFetch<SchedulePreview>(`${base}/preview`, { method: "POST", body: request });
}

export function applyRecommendedSchedules(timezone: string): Promise<ApplyRecommendedResult> {
  return apiFetch<ApplyRecommendedResult>(`${base}/recommended`, {
    method: "POST",
    body: { timezone },
  });
}

interface DirectoryObject {
  id: string;
  kind: ObjectKind;
  displayName: string | null;
  email: string | null;
  externalId: string;
}

/**
 * Active protected objects matching `search`, from the directory
 * (GET /directory/objects, tenant administrators only), for the scope picker.
 */
export async function searchScopeCandidates(search: string): Promise<ScopeCandidate[]> {
  const params = new URLSearchParams({
    status: "active",
    pageSize: "20",
    sort: "name",
    order: "asc",
  });
  if (search.trim()) {
    params.set("search", search.trim());
  }
  const page = await apiFetch<{ items: DirectoryObject[] }>(
    `/directory/objects?${params.toString()}`,
  );
  return page.items.map((object) => {
    const detail = object.email ?? object.externalId;
    const name = object.displayName?.trim() || detail;
    return { id: object.id, kind: object.kind, name, detail: name === detail ? null : detail };
  });
}
