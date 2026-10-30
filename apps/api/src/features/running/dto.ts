import type { PveGuestKind, PveRunKind } from "@restow/db";
import type { RunDto } from "../history/dto.js";

/**
 * "Running now": what is being copied or backed up this moment, for the start page's widget
 * (GET /api/v1/dashboard, `running`), for the "All tenants" view (GET /api/v1/tenant-running)
 * and, for Proxmox VE, inside the live channel (features/history/live.ts). All times are
 * ISO 8601 in UTC; the shapes are the contract of the web app (apps/web/src/features/dashboard).
 *
 * Mail, machine and file share runs are the same {@link RunDto} History and the live channel
 * carry, with their progress, throughput and newest measurements. Proxmox VE keeps its runs in
 * a table of their own and reports how far a backup is as a node's last figure, so it has a
 * small shape of its own.
 */

/** Most runs one tenant lists; `truncated` says that more were running. */
export const RUNNING_LIMIT = 50;

/** A run of a Proxmox VE guest that is going on. */
export interface PveRunningDto {
  id: string;
  kind: PveRunKind;
  guest: { id: string; vmid: number; name: string | null; kind: PveGuestKind };
  /** The backup job the guest is in. */
  jobName: string | null;
  startedAt: string;
  /** A stop was asked for and the node has not stopped the run yet. */
  cancelling: boolean;
  /** What the node reported last; all null before its first report (or from an older node). */
  progress: {
    bytesDone: number;
    bytesTotal: number | null;
    bytesUploaded: number | null;
    /** The read throughput between the node's last two reports. */
    bytesPerSecond: number | null;
    at: string;
  } | null;
}

/** What runs in one tenant. */
export interface RunningNowDto {
  generatedAt: string;
  runs: RunDto[];
  pve: PveRunningDto[];
  /** More runs were going on than listed ({@link RUNNING_LIMIT}). */
  truncated: boolean;
  /** The earliest planned start of an enabled job; null when none is scheduled. */
  nextRunAt: string | null;
}

/** One tenant of the "All tenants" view that has something running. */
export interface TenantRunningDto extends Omit<RunningNowDto, "generatedAt"> {
  tenantId: string;
  name: string;
}

/** GET /api/v1/tenant-running */
export interface AllTenantsRunningDto {
  generatedAt: string;
  /** Only tenants with something running, by name. */
  tenants: TenantRunningDto[];
  /** The earliest planned start over the tenants the member may enter. */
  next: { at: string; tenantId: string; name: string } | null;
  /** Tenants whose runs could not be read this time (the others still show). */
  unavailable: number;
}
