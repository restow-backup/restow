import {
  type EndpointReadinessResult,
  type ReadinessReportFact,
  endpointReadiness,
  endpointVerifyOverdue,
} from "@restow/core";
import { endpointReports, endpointRuns } from "@restow/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * Recovery readiness of endpoints, loaded for the lists and the readiness
 * overview. The rule itself is pure and lives in @restow/core
 * (`endpointReadiness`); this module gathers what it needs in three queries:
 * the newest good backup per endpoint, the restore tests of exactly those
 * backups and the newest repository check.
 */

export interface EndpointReadinessDto extends EndpointReadinessResult {
  overdue: boolean;
  latestSnapshotId: string | null;
  latestBackupAt: Date | null;
}

export async function loadEndpointReadiness(
  tx: Transaction,
  tenantId: string,
  endpointIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, EndpointReadinessDto>> {
  const result = new Map<string, EndpointReadinessDto>();
  if (endpointIds.length === 0) {
    return result;
  }
  const ids = [...endpointIds];
  const latestBackups = await tx
    .selectDistinctOn([endpointRuns.endpointId], {
      endpointId: endpointRuns.endpointId,
      snapshotId: endpointRuns.snapshotId,
      status: endpointRuns.status,
      finishedAt: endpointRuns.finishedAt,
    })
    .from(endpointRuns)
    .where(
      and(
        eq(endpointRuns.tenantId, tenantId),
        eq(endpointRuns.kind, "backup"),
        inArray(endpointRuns.endpointId, ids),
        inArray(endpointRuns.status, ["succeeded", "partial"]),
        isNotNull(endpointRuns.snapshotId),
      ),
    )
    .orderBy(endpointRuns.endpointId, desc(endpointRuns.finishedAt));

  const snapshotIds = latestBackups.map((run) => run.snapshotId).filter((id): id is string => !!id);
  const tests =
    snapshotIds.length === 0
      ? []
      : await tx
          .select({
            endpointId: endpointReports.endpointId,
            kind: endpointReports.kind,
            origin: endpointReports.origin,
            snapshotId: endpointReports.snapshotId,
            readiness: endpointReports.readiness,
            checkedAt: endpointReports.checkedAt,
          })
          .from(endpointReports)
          .where(
            and(
              eq(endpointReports.tenantId, tenantId),
              eq(endpointReports.kind, "restore_test"),
              inArray(endpointReports.endpointId, ids),
              inArray(endpointReports.snapshotId, snapshotIds),
            ),
          )
          .orderBy(desc(endpointReports.checkedAt));
  const checks = await tx
    .selectDistinctOn([endpointReports.endpointId], {
      endpointId: endpointReports.endpointId,
      kind: endpointReports.kind,
      origin: endpointReports.origin,
      snapshotId: endpointReports.snapshotId,
      readiness: endpointReports.readiness,
      checkedAt: endpointReports.checkedAt,
    })
    .from(endpointReports)
    .where(
      and(
        eq(endpointReports.tenantId, tenantId),
        eq(endpointReports.kind, "repository_check"),
        inArray(endpointReports.endpointId, ids),
      ),
    )
    .orderBy(endpointReports.endpointId, desc(endpointReports.checkedAt));

  const factsByEndpoint = new Map<string, ReadinessReportFact[]>();
  for (const row of [...tests, ...checks]) {
    const list = factsByEndpoint.get(row.endpointId) ?? [];
    list.push({
      kind: row.kind,
      origin: row.origin,
      snapshotId: row.snapshotId,
      readiness: row.readiness,
      checkedAt: row.checkedAt,
    });
    factsByEndpoint.set(row.endpointId, list);
  }
  const backupByEndpoint = new Map(latestBackups.map((run) => [run.endpointId, run]));
  for (const id of ids) {
    const backup = backupByEndpoint.get(id);
    const rated = endpointReadiness({
      latestSnapshotId: backup?.snapshotId ?? null,
      latestBackupPartial: backup?.status === "partial",
      reports: factsByEndpoint.get(id) ?? [],
    });
    result.set(id, {
      ...rated,
      overdue: endpointVerifyOverdue(rated.checkedAt, now),
      latestSnapshotId: backup?.snapshotId ?? null,
      latestBackupAt: backup?.finishedAt ?? null,
    });
  }
  return result;
}
