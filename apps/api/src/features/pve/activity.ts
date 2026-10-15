import type { Database } from "@restow/db";
import { sql } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";

/**
 * What the sidebar's "VMs & containers" entry shows (GET /api/v1/pve/activity): the guests that
 * back up now, by name, and how many wait for their node. It counts the same as the overview
 * (service.ts `overview`: a guest with a running backup runs, one with an open backup task that
 * does not run waits) but reads only that: the running backups (pve_runs_status_idx) and the
 * open backup tasks (pve_tasks_open_backup_idx), never the guests' restore points or history.
 */
export interface PveActivityGuestDto {
  id: string;
  vmid: number;
  name: string | null;
  /** The job the guest is in, as the overview names it. */
  jobName: string | null;
}

export interface PveActivityDto {
  /** Whether the tenant has a Proxmox VE cluster at all (else the entry stops asking). */
  connected: boolean;
  running: PveActivityGuestDto[];
  queued: number;
}

interface ActivityRow extends Record<string, unknown> {
  connected: boolean;
  queued: number;
  running: PveActivityGuestDto[];
}

export async function pveActivity(database: Database, tenantId: string): Promise<PveActivityDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const result = await tx.execute<ActivityRow>(sql`
      WITH running AS (
        SELECT DISTINCT guest_id FROM pve_runs WHERE status = 'running' AND kind = 'backup'
      )
      SELECT
        EXISTS (SELECT 1 FROM pve_clusters) AS connected,
        (SELECT count(DISTINCT t.guest_id)::int FROM pve_tasks t
          WHERE t.kind = 'backup' AND t.status IN ('pending', 'delivered')
            AND t.guest_id IS NOT NULL
            AND t.guest_id NOT IN (SELECT guest_id FROM running)) AS queued,
        coalesce((
          SELECT json_agg(json_build_object(
                   'id', g.id, 'vmid', g.vmid, 'name', g.name, 'jobName', j.name
                 ) ORDER BY g.vmid, g.id)
            FROM running r
            JOIN pve_guests g ON g.id = r.guest_id
            LEFT JOIN pve_jobs j ON j.id = g.job_id
        ), '[]'::json) AS running`);
    const row = result.rows[0];
    return {
      connected: row?.connected === true,
      running: row?.running ?? [],
      queued: Number(row?.queued ?? 0),
    };
  });
}
