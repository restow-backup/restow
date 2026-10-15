import { apiFetch } from "@/lib/api";

/**
 * Contract of `/api/v1/suspicions` and `/api/v1/settings/ransomware`
 * (apps/api/src/features/suspicion/service.ts), kept in sync by hand. The worker judges every new
 * restore point for signs of ransomware (docs/RANSOMWARE.md); an administrator can call a finding
 * a false alarm.
 */

/** What a restore point is of: a machine, a file share, a Proxmox VE guest, a mailbox or OneDrive. */
export type SuspicionObjectKind = "endpoint" | "file_share" | "pve_guest" | "m365";

export type SignalState = "clear" | "fired" | "learning" | "unavailable" | "off";
export const SIGNALS = [
  "changeRate",
  "deletions",
  "renames",
  "names",
  "entropy",
  "compressibility",
] as const;
export type Signal = (typeof SIGNALS)[number];

export interface SuspicionFinding {
  code: string;
  value: number;
  threshold: number;
  baseline?: number;
  /** The new data a compression or deduplication ratio was measured on. */
  bytes?: number;
  share?: number;
  examples?: string[];
}

export interface Suspicion {
  id: string;
  objectKind: SuspicionObjectKind;
  objectId: string;
  runId: string;
  restorePointId: string;
  restorePointAt: string;
  verdict: "none" | "suspicious";
  /** Suspicious, and nobody called it a false alarm. */
  active: boolean;
  findings: SuspicionFinding[];
  signals: Partial<Record<Signal, SignalState>>;
  signaturesVersion: string;
  alerted: boolean;
  falseAlarm: { at: string; by: string | null; note: string | null } | null;
  /** Suspicious, no false alarm, not released: it holds the object's retention. */
  holds?: boolean;
  holdReleased?: { at: string; by: string | null; note: string | null } | null;
  judgedAt: string;
}

/** Retention of an object paused by a suspicious restore point nobody resolved. */
export interface RetentionHold {
  /** The oldest suspicious restore point that holds. */
  since: string;
  heldAt: string;
  restorePoints: number;
  remindedAt: string | null;
  reminderDays: number;
  /** What the repository takes now (machines and file shares); null elsewhere. */
  storageBytes: number | null;
}

export interface ObjectSuspicions {
  objectKind: SuspicionObjectKind;
  objectId: string;
  open: boolean;
  openSince: string | null;
  lastClean: { restorePointId: string; restorePointAt: string } | null;
  /** Absent from a server before 0.4.x. */
  hold?: RetentionHold | null;
  restorePoints: Suspicion[];
}

export interface OpenSuspicion {
  objectKind: SuspicionObjectKind;
  objectId: string;
  suspicionId: string;
  restorePointId: string;
  restorePointAt: string;
  findings: SuspicionFinding[];
}

/** The object whose restore points are judged. */
export interface SuspicionTarget {
  kind: SuspicionObjectKind;
  objectId: string;
}

export interface RansomwareSettings {
  enabled: boolean;
  baselineRuns: number;
  minBaselineRuns: number;
  changeRate: {
    enabled: boolean;
    madFactor: number;
    minRatio: number;
    minItems: number;
    minBytes: number;
  };
  deletions: { enabled: boolean; minFiles: number; minShare: number };
  renames: { enabled: boolean; minFiles: number; minShare: number };
  names: { enabled: boolean; minExtensionFiles: number; minNoteCopies: number };
  entropy: { enabled: boolean; minSamples: number; highBits: number; minHighShare: number };
  compressibility: {
    enabled: boolean;
    minBytes: number;
    madFactor: number;
    compressionMinRatio: number;
    compressionMinRise: number;
    dedupMinRatio: number;
    dedupMinRise: number;
  };
  retentionHold: { enabled: boolean; reminderDays: number };
}

export interface RansomwareSettingsView {
  settings: RansomwareSettings;
  defaults: RansomwareSettings;
  ranges: Record<string, [number, number]>;
  signaturesVersion: string;
}

export const suspicionKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "suspicions"] as const,
  object: (tenantId: string | null, target: SuspicionTarget) =>
    ["tenant", tenantId, "suspicions", target.kind, target.objectId] as const,
  open: (tenantId: string | null) => ["tenant", tenantId, "suspicions", "open"] as const,
  settings: ["installation", "ransomware-settings"] as const,
};

export function fetchObjectSuspicions(target: SuspicionTarget): Promise<ObjectSuspicions> {
  const query = new URLSearchParams({ kind: target.kind, objectId: target.objectId });
  return apiFetch(`/suspicions?${query.toString()}`);
}

export function fetchOpenSuspicions(): Promise<{ objects: OpenSuspicion[] }> {
  return apiFetch("/suspicions/open");
}

export function markFalseAlarm(id: string, note: string | null): Promise<Suspicion> {
  return apiFetch(`/suspicions/${encodeURIComponent(id)}/false-alarm`, {
    method: "POST",
    body: { note },
  });
}

export function revokeFalseAlarm(id: string): Promise<Suspicion> {
  return apiFetch(`/suspicions/${encodeURIComponent(id)}/false-alarm`, { method: "DELETE" });
}

/** Release an object's retention hold (a recent sign-in; administrators). */
export function releaseRetentionHold(
  target: SuspicionTarget,
  note: string | null,
): Promise<ObjectSuspicions> {
  return apiFetch("/suspicions/hold/release", {
    method: "POST",
    body: { kind: target.kind, objectId: target.objectId, note },
  });
}

/** Call every finding that holds the object's retention a false alarm. */
export function markHoldFalseAlarm(
  target: SuspicionTarget,
  note: string | null,
): Promise<ObjectSuspicions> {
  return apiFetch("/suspicions/hold/false-alarm", {
    method: "POST",
    body: { kind: target.kind, objectId: target.objectId, note },
  });
}

export function fetchRansomwareSettings(): Promise<RansomwareSettingsView> {
  return apiFetch("/settings/ransomware", { tenantId: null });
}

export function saveRansomwareSettings(
  settings: Partial<RansomwareSettings>,
): Promise<RansomwareSettingsView> {
  return apiFetch("/settings/ransomware", { method: "PUT", body: settings, tenantId: null });
}
