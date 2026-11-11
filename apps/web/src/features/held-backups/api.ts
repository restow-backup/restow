import { apiFetch } from "@/lib/api";

/**
 * Contract of `/api/v1/run-size` (apps/api/src/features/run-size/service.ts), kept in sync by
 * hand: the backups the size and space guard held (#99, docs/STORAGE.md "Unusually large runs")
 * and its settings per tenant and per object.
 */

export type HeldObjectKind = "endpoint" | "file_share" | "pve_guest" | "m365";

export interface HeldBackup {
  id: string;
  objectKind: HeldObjectKind;
  objectId: string;
  objectName: string;
  runId: string | null;
  reason: "size" | "space";
  status: "pending" | "approved" | "resolved";
  bytes: number;
  limitBytes: number | null;
  medianBytes: number | null;
  historyRuns: number;
  freeBytes: number | null;
  totalBytes: number | null;
  refusedRuns: number;
  heldAt: string;
  lastRefusedAt: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  note: string | null;
  resolution:
    | "continued"
    | "limit_raised"
    | "guard_off"
    | "settings_changed"
    | "space_freed"
    | "object_removed"
    | null;
  resolvedAt: string | null;
}

export interface HeldBackups {
  open: HeldBackup[];
  recent: HeldBackup[];
}

export interface SizeGuardSettings {
  enabled: boolean;
  factor: number;
  minHistory: number;
  historyRuns: number;
  minBytes: number;
  limitBytes: number | null;
  firstRunBytes: number | null;
  minFreePercent: number;
}

export interface SizeGuardOverride {
  enabled?: boolean;
  factor?: number;
  minBytes?: number;
  limitBytes?: number | null;
  firstRunBytes?: number | null;
  minFreePercent?: number;
}

export interface SizeGuardSettingsView {
  defaults: SizeGuardSettings;
  tenant: SizeGuardOverride | null;
  effective: SizeGuardSettings;
  objects: {
    kind: HeldObjectKind;
    objectId: string;
    objectName: string;
    override: SizeGuardOverride;
    effective: SizeGuardSettings;
  }[];
}

/** What the settings form sends: sizes in GiB, `null` for "none". */
export interface SizeGuardOverrideInput {
  enabled?: boolean;
  factor?: number;
  minGib?: number;
  limitGib?: number | null;
  firstRunGib?: number | null;
  minFreePercent?: number;
}

export const heldBackupKeys = {
  holds: (tenantId: string | null) => ["tenant", tenantId, "run-size", "holds"] as const,
  settings: (tenantId: string | null) => ["tenant", tenantId, "run-size", "settings"] as const,
};

export function fetchHeldBackups(): Promise<HeldBackups> {
  return apiFetch<HeldBackups>("/run-size/holds");
}

export function continueHeldBackup(id: string, note: string | null): Promise<HeldBackup> {
  return apiFetch<HeldBackup>(`/run-size/holds/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    body: { note },
  });
}

export function raiseHeldBackupLimit(id: string, limitGib: number): Promise<HeldBackup> {
  return apiFetch<HeldBackup>(`/run-size/holds/${encodeURIComponent(id)}/raise`, {
    method: "POST",
    body: { limitGib },
  });
}

export function fetchSizeGuardSettings(): Promise<SizeGuardSettingsView> {
  return apiFetch<SizeGuardSettingsView>("/run-size/settings");
}

export function saveSizeGuardSettings(input: {
  kind?: HeldObjectKind;
  objectId?: string;
  override: SizeGuardOverrideInput | null;
}): Promise<SizeGuardSettingsView> {
  return apiFetch<SizeGuardSettingsView>("/run-size/settings", { method: "PUT", body: input });
}

const GIB = 1024 ** 3;

/** A limit to offer when raising: half again what the held run added, in whole GiB. */
export function suggestedLimitGib(hold: Pick<HeldBackup, "bytes" | "limitBytes">): number {
  return Math.max(1, Math.ceil((Math.max(hold.bytes, hold.limitBytes ?? 0) * 1.5) / GIB));
}
