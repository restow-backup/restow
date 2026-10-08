import { endpoints } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";
import { jobsOfEndpoints } from "../backup-jobs/membership.js";
import { type RatedObject, isFirstBackupOverdue } from "../verify/summary.js";
import { loadEndpointReadiness } from "./readiness.js";

/**
 * Endpoints in the recovery readiness overview (features/verify), next to the
 * mailboxes, OneDrives and IMAP accounts: the same green, yellow, red or
 * unverified per protected machine, and the same counting in the tenant
 * summary. An endpoint is rated by the restore test of its newest good backup
 * (`endpointReadiness` in @restow/core); a machine that never delivered a
 * backup has none, and counts as a problem once its grace period is over. A
 * machine in no backup job is not backed up at all (release 0.2.1): it keeps the
 * rating of its old backups but is flagged `inJob: false`, and it never lets
 * the tenant read as fine (`withoutJob` in the summary).
 */

export interface EndpointReadinessRowDto {
  id: string;
  hostname: string;
  displayName: string | null;
  profile: "server" | "client";
  os: "linux" | "windows" | "darwin";
  state: "green" | "yellow" | "red" | "unverified" | "no_backup";
  /** The rating of the newest backup; null while it is unverified or without a backup. */
  readiness: "green" | "yellow" | "red" | null;
  checkedAt: string | null;
  overdue: boolean;
  latestBackupAt: string | null;
  latestSnapshotId: string | null;
  /** The machine belongs to a backup job; false: nothing backs it up. */
  inJob: boolean;
}

export async function loadEndpointOverview(
  tx: Transaction,
  tenantId: string,
  now: Date,
): Promise<{ rows: EndpointReadinessRowDto[]; rated: RatedObject[] }> {
  const list = await tx
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")))
    .orderBy(asc(endpoints.hostname));
  const readiness = await loadEndpointReadiness(
    tx,
    tenantId,
    list.map((endpoint) => endpoint.id),
    now,
  );
  const jobs = await jobsOfEndpoints(
    tx,
    tenantId,
    list.map((endpoint) => endpoint.id),
  );
  const rows: EndpointReadinessRowDto[] = [];
  const rated: RatedObject[] = [];
  for (const endpoint of list) {
    const found = readiness.get(endpoint.id);
    if (!found) {
      continue;
    }
    const overdue =
      found.state === "no_backup" ? isFirstBackupOverdue(endpoint.createdAt, now) : found.overdue;
    rows.push({
      id: endpoint.id,
      hostname: endpoint.hostname,
      displayName: endpoint.displayName,
      profile: endpoint.profile,
      os: endpoint.os,
      state: found.state,
      readiness:
        found.state === "green" || found.state === "yellow" || found.state === "red"
          ? found.state
          : null,
      checkedAt: found.checkedAt?.toISOString() ?? null,
      overdue,
      latestBackupAt: found.latestBackupAt?.toISOString() ?? null,
      latestSnapshotId: found.latestSnapshotId,
      inJob: jobs.has(endpoint.id),
    });
    rated.push({
      state: found.state,
      overdue,
      checkedAt: found.checkedAt,
      withoutJob: !jobs.has(endpoint.id),
    });
  }
  return { rows, rated };
}
