import { pveJobOfGuest } from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  endpoints,
  fileShares,
  pveGuests,
  pveJobs,
} from "@restow/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { PROTECTED_SHARE_SQL } from "../file-shares/protection.js";

/**
 * The protected units of one tenant besides its mailboxes (0.5.0), as the price per unit counts
 * them (settings/pricing-estimate.ts). Like the mailbox count (@restow/core
 * `countProtectedMailboxes`, usage/service.ts) a unit counts while it is protected now, by the
 * same rule the overviews of its kind use; what is no longer protected does not count, its
 * backups stay restorable regardless:
 *
 *   servers, clients  agent machines (`endpoints`) by their profile (`server` or `client`, as
 *                     enrolled): active (not revoked), not removed from Restow (`removed_at`
 *                     null) and a member of a backup job (the machines widget's "protected",
 *                     dashboard/endpoints.ts; an endpoint job is always `selected`)
 *   vms, containers   Proxmox VE guests by their kind: not retired (`retired_at` null, a VMID
 *                     PVE gave to another guest), and in an enabled PVE job, their own or the one
 *                     for all guests (@restow/core `pveJobOfGuest`: present on its node, no VM
 *                     template, not excluded, no restored copy outside a job)
 *   fileShares        file shares that are not retired and are a member of an enabled share job
 *                     (file-shares/protection.ts `PROTECTED_SHARE_SQL`)
 *
 * A unit counts once, whatever number of backups or restore points it has; whether a backup ran
 * in the month does not matter (as for the mailboxes). Call inside the tenant's pinned
 * transaction; three queries, four with Proxmox VE guests.
 */
export interface ProtectedUnits {
  servers: number;
  clients: number;
  vms: number;
  containers: number;
  fileShares: number;
}

export const NO_PROTECTED_UNITS: ProtectedUnits = {
  servers: 0,
  clients: 0,
  vms: 0,
  containers: 0,
  fileShares: 0,
};

export async function countProtectedUnits(
  tx: DbExecutor,
  tenantId: string,
): Promise<ProtectedUnits> {
  const counts = { ...NO_PROTECTED_UNITS };

  const machines = await tx
    .select({ profile: endpoints.profile, count: sql<number>`count(*)::int` })
    .from(endpoints)
    .where(
      and(
        eq(endpoints.tenantId, tenantId),
        eq(endpoints.status, "active"),
        isNull(endpoints.removedAt),
        sql`exists (
          select 1 from ${backupJobMembers} m join ${backupJobs} j on j.id = m.job_id
           where m.endpoint_id = ${endpoints.id} and j.kind = 'endpoint')`,
      ),
    )
    .groupBy(endpoints.profile);
  for (const row of machines) {
    if (row.profile === "server") {
      counts.servers = Number(row.count);
    } else if (row.profile === "client") {
      counts.clients = Number(row.count);
    }
  }

  const guests = await tx
    .select({
      kind: pveGuests.kind,
      jobId: pveGuests.jobId,
      template: pveGuests.template,
      present: pveGuests.present,
      excludedAt: pveGuests.excludedAt,
      pool: pveGuests.pool,
      tags: pveGuests.tags,
    })
    .from(pveGuests)
    .where(and(eq(pveGuests.tenantId, tenantId), isNull(pveGuests.retiredAt)));
  if (guests.length > 0) {
    const jobs = await tx
      .select({ id: pveJobs.id, enabled: pveJobs.enabled, scopeAll: pveJobs.scopeAll })
      .from(pveJobs)
      .where(eq(pveJobs.tenantId, tenantId));
    for (const guest of guests) {
      if (pveJobOfGuest(guest, jobs) === null) {
        continue;
      }
      if (guest.kind === "vm") {
        counts.vms += 1;
      } else if (guest.kind === "ct") {
        counts.containers += 1;
      }
    }
  }

  const [shares] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(fileShares)
    .where(and(eq(fileShares.tenantId, tenantId), PROTECTED_SHARE_SQL));
  counts.fileShares = Number(shares?.count ?? 0);

  return counts;
}
