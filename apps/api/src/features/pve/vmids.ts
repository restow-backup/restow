import { sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * VMIDs a node must not hand to a restore, a restore check or a boot test (docs/PVE.md, "A VMID
 * used again"): those of guests PVE no longer has but Restow still holds, with restore points
 * or a job. PVE's /cluster/nextid hands out the lowest free VMID, which is often such a deleted
 * guest's; a copy under it would take over that guest's history in the next inventory. Bounded:
 * the lowest {@link PVE_AVOID_VMIDS_MAX}.
 */
export const PVE_AVOID_VMIDS_MAX = 1000;

export async function avoidVmids(tx: Transaction, clusterId: string): Promise<number[]> {
  const rows = await tx.execute<{ vmid: number }>(sql`
    SELECT DISTINCT g.vmid FROM pve_guests g
     WHERE g.cluster_id = ${clusterId} AND g.present = false
       AND (g.job_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM pve_snapshots s WHERE s.guest_id = g.id AND s.status <> 'pruned'))
     ORDER BY g.vmid LIMIT ${PVE_AVOID_VMIDS_MAX}`);
  return rows.rows.map((r) => Number(r.vmid));
}

/** The absent guest with restore points or a job that holds this VMID, or null. */
export async function heldVmid(
  tx: Transaction,
  clusterId: string,
  vmid: number,
): Promise<{ id: string; name: string | null; kind: string } | null> {
  const rows = await tx.execute<{ id: string; name: string | null; kind: string }>(sql`
    SELECT g.id, g.name, g.kind FROM pve_guests g
     WHERE g.cluster_id = ${clusterId} AND g.vmid = ${vmid} AND g.present = false
       AND (g.job_id IS NOT NULL OR EXISTS (
         SELECT 1 FROM pve_snapshots s WHERE s.guest_id = g.id AND s.status <> 'pruned'))
     ORDER BY g.retired_at NULLS FIRST LIMIT 1`);
  return rows.rows[0] ?? null;
}
