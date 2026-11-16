import { endpoints, loadRecoveryLab, type RecoveryLabState } from "@restow/db";
import { and, asc, eq } from "drizzle-orm";
import { providerDb } from "../../db.js";
import type { Transaction } from "../../lib/tenant-context.js";
import { jobsOfEndpoints } from "../backup-jobs/membership.js";
import { isFirstBackupOverdue, type RatedObject } from "../verify/summary.js";
import { type BaremetalState, baremetalStateOf } from "./baremetal.js";
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
  /** The newest backup recorded no sample files: no restore test of it is possible. */
  noSamples: boolean;
  /** The machine belongs to a backup job; false: nothing backs it up. */
  inJob: boolean;
  /**
   * The bare metal rating (docs/BAREMETAL.md 12.4), apart from the files' readiness; null for a
   * machine its job does not back up as a whole.
   */
  baremetal: BaremetalState | null;
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
  // The lab is read once, and only when some machine is backed up as a whole.
  let lab: RecoveryLabState | null | undefined;
  for (const endpoint of list) {
    const found = readiness.get(endpoint.id);
    if (!found) {
      continue;
    }
    if (lab === undefined && endpoint.config.wholeMachine === true) {
      lab = await loadRecoveryLab(providerDb);
    }
    const baremetal =
      endpoint.config.wholeMachine === true
        ? await baremetalStateOf(tx, endpoint, lab ?? null, now)
        : null;
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
      noSamples: found.noSamples,
      inJob: jobs.has(endpoint.id),
      baremetal,
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
