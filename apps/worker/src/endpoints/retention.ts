/**
 * `endpoint-retention`: keep an endpoint's repository to its retention policy
 * (docs/AGENT.md, "Aufbewahrung"). The agent is append-only and never
 * deletes; only this job, through the full-access listener, forgets snapshots
 * and prunes.
 *
 * The server decides what to forget, never restic's `--keep-*` rules: those
 * sort snapshots by the time the agent wrote into them, so a compromised
 * machine could date a few dozen snapshots in the future and have every
 * genuine backup forgotten. The decision (@restow/core `auditSnapshots`,
 * `applyRetentionPolicy`) uses only what the server controls: the snapshots
 * backup runs reported, dated by the earlier of the moment the storage
 * received their files and the end of the reporting run. restic is then told
 * to forget exactly those ids. Snapshots no run reported are never deleted;
 * they, and snapshots dated in the future, are flagged and announced once
 * (`endpoint.suspicious_snapshot`).
 *
 * While the endpoint has an unresolved suspicious restore point, or a backup
 * the ransomware judgement has not seen yet, nothing is forgotten
 * (suspicion/holds.ts, docs/RANSOMWARE.md "Retention hold"); the run still
 * audits the snapshots and measures the repository.
 *
 * The policy is the endpoint's own: daily, weekly and monthly snapshots to
 * keep, 30 / 12 / 12 unless an admin changed them, counted in the tenant's
 * time zone. It applies to each retention group on its own (@restow/core
 * `applyGroupedRetention`, W2a): `files` for the snapshots of backup runs,
 * `sql:<instance>` for those of the native SQL Server backup (one snapshot per
 * instance and run), so neither pushes the other out. A SQL snapshot is
 * recorded by its `sql` run and by its rows in `endpoint_sql_backups`, never
 * flagged `unrecorded`; a forgotten one turns its rows `pruned`. The prune follows the one
 * policy for a target short of space (@restow/core `resticPrune`, docs/STORAGE.md "Volles
 * Speicherziel"): it only deletes when the repack does not fit, and a prune still due (repacking
 * deferred, or a prune the full target stopped) runs again even when nothing is forgotten. The
 * report says how it went, and "target full" when not even that freed space. The run also measures the bytes the repository takes (the
 * storage budget counts them) and keeps the sealed repository password next
 * to the repository.
 */
import {
  applyGroupedRetention,
  auditSnapshots,
  DEFAULT_ENDPOINT_RETENTION,
  DEFAULT_SCHEDULE_TIMEZONE,
  deletionDecision,
  type EndpointJobPayload,
  FILES_RETENTION_GROUP,
  type GroupedSnapshot,
  isValidTimeZone,
  listRepositoryObjects,
  measureRepositoryBytes,
  type RepositoryAccess,
  ResticError,
  type ResticSnapshot,
  resticForget,
  resticPrune,
  resticSnapshots,
  resticUnlock,
  type SnapshotFlag,
  splitLockedSnapshots,
  sqlRetentionGroup,
  storageShortOfSpace,
  withDeletionPermit,
  withRepository,
} from "@restow/core";
import {
  type Endpoint,
  endpointReports,
  endpointRuns,
  endpointSnapshotFlags,
  endpointSqlBackups,
  endpointSqlDatabases,
  endpoints,
  tenants,
} from "@restow/db";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { primaryWriteOnce, withTenantTx } from "../handlers/framework.js";
import { recordDeferredDeletion } from "../handlers/immutability.js";
import { raiseEvents } from "../reporting.js";
import {
  loadRetentionHolds,
  retentionHeld,
  retentionHoldMode,
  retentionHoldSummary,
} from "../suspicion/holds.js";
import {
  type EndpointJobDeps,
  openEndpointRepository,
  reportableMessage,
  withMaintenanceLock,
  writeReport,
} from "./common.js";
import {
  clearLocksBeforeMaintenance,
  keepRepositoryPasswordFile,
  recordMaintenanceLocked,
  recordMaintenanceUnlocked,
} from "./maintenance.js";
import { endpointName } from "./monitor.js";
import { pruneFailureSummary, pruneSummary, targetFull } from "./prune-summary.js";

/** Snapshot ids an alert names at most (the count says how many there are). */
const ALERT_SNAPSHOT_IDS = 10;

async function tenantTimeZone(deps: EndpointJobDeps, tenantId: string): Promise<string> {
  const [row] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tenantId)),
  );
  const zone = row?.timeZone ?? "";
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_SCHEDULE_TIMEZONE;
}

/**
 * The snapshots the runs of this endpoint reported, when each run ended, and the retention group
 * each belongs to: backup runs are `files`; `sql` runs and the active rows of
 * `endpoint_sql_backups` (whose run may be gone) are `sql:<instance>`.
 */
async function recordedSnapshots(deps: EndpointJobDeps, tenantId: string, endpointId: string) {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const runs = await tx
      .select({
        kind: endpointRuns.kind,
        snapshotId: endpointRuns.snapshotId,
        finishedAt: endpointRuns.finishedAt,
        stats: endpointRuns.stats,
      })
      .from(endpointRuns)
      .where(
        and(
          eq(endpointRuns.endpointId, endpointId),
          inArray(endpointRuns.kind, ["backup", "sql"]),
          isNotNull(endpointRuns.snapshotId),
        ),
      );
    const backups = await tx
      .select({
        snapshotId: endpointSqlBackups.resticSnapshotId,
        backupFinish: endpointSqlBackups.backupFinish,
        instance: endpointSqlDatabases.instance,
        runFinishedAt: endpointRuns.finishedAt,
      })
      .from(endpointSqlBackups)
      .innerJoin(endpointSqlDatabases, eq(endpointSqlDatabases.id, endpointSqlBackups.databaseId))
      .leftJoin(endpointRuns, eq(endpointRuns.id, endpointSqlBackups.runId))
      .where(
        and(eq(endpointSqlBackups.endpointId, endpointId), eq(endpointSqlBackups.status, "active")),
      );
    const recorded = [
      ...runs.map((row) => ({ snapshotId: row.snapshotId as string, finishedAt: row.finishedAt })),
      // A backup row is dated by its run as the server recorded it, never by the agent's time.
      ...backups.flatMap((row) =>
        row.runFinishedAt ? [{ snapshotId: row.snapshotId, finishedAt: row.runFinishedAt }] : [],
      ),
    ];
    // The backup rows first: they name the instance even where a run's statistics do not.
    const groups: GroupedSnapshot[] = [
      ...backups.map((row) => ({
        snapshotId: row.snapshotId,
        group: sqlRetentionGroup(row.instance),
      })),
      ...runs.map((row) => ({
        snapshotId: row.snapshotId as string,
        group:
          row.kind === "sql" && row.stats?.sql?.instance
            ? sqlRetentionGroup(row.stats.sql.instance)
            : row.kind === "sql"
              ? sqlRetentionGroup("")
              : FILES_RETENTION_GROUP,
      })),
    ];
    return { recorded, groups };
  });
}

/**
 * Whether the last retention run left a prune due: it only deleted and deferred the repack, or the
 * full target stopped its prune after the snapshots were forgotten (nothing is left to forget then).
 */
async function prunePending(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
): Promise<boolean> {
  const [last] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({ summary: endpointReports.summary })
      .from(endpointReports)
      .where(and(eq(endpointReports.endpointId, endpointId), eq(endpointReports.kind, "retention")))
      .orderBy(desc(endpointReports.checkedAt))
      .limit(1),
  );
  return last?.summary.prunePending === true;
}

/** The SQL backups whose snapshot retention forgot: `pruned`, so nothing offers them again. */
async function markPrunedSqlBackups(
  deps: EndpointJobDeps,
  tenantId: string,
  endpointId: string,
  removed: readonly string[],
): Promise<number> {
  if (removed.length === 0) {
    return 0;
  }
  const pruned = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .update(endpointSqlBackups)
      .set({ status: "pruned" })
      .where(
        and(
          eq(endpointSqlBackups.endpointId, endpointId),
          eq(endpointSqlBackups.status, "active"),
          inArray(endpointSqlBackups.resticSnapshotId, [...removed]),
        ),
      )
      .returning({ id: endpointSqlBackups.id }),
  );
  return pruned.length;
}

/**
 * Remember the suspicious snapshots and tell the admin about the new ones, in
 * one transaction: each snapshot is announced once.
 */
async function recordSnapshotFlags(
  deps: EndpointJobDeps,
  endpoint: Endpoint,
  flags: readonly SnapshotFlag[],
  now: Date,
  /** Drop the marks of snapshots no longer flagged (only when the audit saw everything). */
  sync: boolean,
): Promise<number> {
  const tenantId = endpoint.tenantId;
  return withTenantTx(deps.db, tenantId, async (tx) => {
    if (sync) {
      // A snapshot that is no longer suspicious (its run reported it late, or it is gone) loses its mark.
      const current = flags.map((flag) => flag.id);
      await tx
        .delete(endpointSnapshotFlags)
        .where(
          and(
            eq(endpointSnapshotFlags.endpointId, endpoint.id),
            current.length > 0 ? notInArray(endpointSnapshotFlags.snapshotId, current) : undefined,
          ),
        );
    }
    for (const flag of flags) {
      await tx
        .insert(endpointSnapshotFlags)
        .values({
          tenantId,
          endpointId: endpoint.id,
          snapshotId: flag.id,
          reasons: flag.reasons,
          snapshotTime: flag.snapshotTime,
          storedAt: flag.storedAt,
        })
        .onConflictDoUpdate({
          target: [endpointSnapshotFlags.endpointId, endpointSnapshotFlags.snapshotId],
          set: { reasons: flag.reasons, snapshotTime: flag.snapshotTime, storedAt: flag.storedAt },
        });
    }
    const fresh = await tx
      .select()
      .from(endpointSnapshotFlags)
      .where(
        and(
          eq(endpointSnapshotFlags.endpointId, endpoint.id),
          isNull(endpointSnapshotFlags.alertedAt),
        ),
      );
    if (fresh.length === 0) {
      return 0;
    }
    const name = endpointName(endpoint);
    const unrecorded = fresh.filter((flag) => flag.reasons.includes("unrecorded")).length;
    const future = fresh.filter((flag) => flag.reasons.includes("future_time")).length;
    const parts = [
      unrecorded > 0 ? `${unrecorded} not reported by any backup run` : null,
      future > 0 ? `${future} dated in the future` : null,
    ].filter(Boolean);
    await raiseEvents(
      tx,
      [
        {
          tenantId,
          level: "error",
          event: "endpoint.suspicious_snapshot",
          message: `The repository of ${name} holds ${fresh.length} suspicious snapshot(s): ${parts.join(", ")}. The times in snapshots decide nothing, and retention never deletes a snapshot no run reported. Check the machine; it may be compromised.`,
          details: {
            endpointId: endpoint.id,
            objectName: name,
            count: fresh.length,
            unrecorded,
            future,
            snapshotIds: fresh
              .slice(0, ALERT_SNAPSHOT_IDS)
              .map((flag) => flag.snapshotId.slice(0, 8)),
          },
        },
      ],
      now,
    );
    await tx
      .update(endpointSnapshotFlags)
      .set({ alertedAt: now })
      .where(
        and(
          eq(endpointSnapshotFlags.endpointId, endpoint.id),
          isNull(endpointSnapshotFlags.alertedAt),
        ),
      );
    return fresh.length;
  });
}

export async function endpointRetention(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { endpoint, access } = await openEndpointRepository(deps, tenantId, endpointId);
  if (endpoint.status !== "active") {
    return;
  }
  // Write-once storage (docs/STORAGE.md, "Write-once storage"): restic forget and prune would
  // only fail on every deletion; every snapshot stays, and the machine's page says so.
  if (primaryWriteOnce(await deps.runtime.storage.get(tenantId))) {
    deps.runtime.logger.info(
      "endpoint retention: not applied, the primary storage target of the tenant is write-once",
      { tenantId, endpointId },
    );
    return;
  }
  // Restore mode after restoring a database dump (docs/STORAGE.md): restic forget and prune do
  // not run while the restored database may lack holds and decisions made after the dump.
  const deletions = await deletionDecision({ pass: "endpoint_retention", tenantId });
  if (!deletions.allowed) {
    deps.runtime.logger.warn("endpoint retention held: deleting is paused", {
      tenantId,
      endpointId,
      reason: deletions.reason,
    });
    return;
  }
  // Never beside the check or a restore test of the same repository. restic's deletes through
  // the loopback carry this permit (storage/deletion-guard.ts).
  await withDeletionPermit({ pass: "endpoint_retention", tenantId }, () =>
    withMaintenanceLock(deps, endpointId, "exclusive", () =>
      retain(deps, payload, endpoint, access),
    ),
  );
}

async function retain(
  deps: EndpointJobDeps,
  payload: EndpointJobPayload,
  endpoint: Endpoint,
  access: RepositoryAccess,
): Promise<void> {
  const { tenantId, endpointId } = payload;
  const { logger } = deps.runtime;
  const policy = endpoint.settings.retention ?? DEFAULT_ENDPOINT_RETENTION;
  const now = deps.runtime.now();
  const signal = deps.runtime.shutdownSignal;
  await keepRepositoryPasswordFile(deps, tenantId, endpointId, access);
  try {
    const removedLocks = await clearLocksBeforeMaintenance(deps, tenantId, endpointId, access, now);
    const timeZone = await tenantTimeZone(deps, tenantId);
    const mode = await retentionHoldMode(deps.providerDb);
    const holds = await withTenantTx(deps.db, tenantId, (tx) =>
      loadRetentionHolds(tx, {
        tenantId,
        kind: "endpoint",
        objectIds: [endpointId],
        now,
        mode,
      }),
    );
    // A deletion the storage refuses because of Object Lock or the deletion delay is recorded,
    // so the renewal lets it run out (docs/STORAGE.md, "Immutable backups").
    const lockedAccess: RepositoryAccess = {
      ...access,
      onDeletionDeferred: (key, retainUntil) =>
        recordDeferredDeletion(deps.db, tenantId, access.storage, key, retainUntil),
    };
    const pending =
      (await prunePending(deps, tenantId, endpointId)) ||
      (await storageShortOfSpace(access.storage));
    const result = await withRepository(lockedAccess, async (session) => {
      // Locks restic itself calls stale (by their content) go as well.
      await resticUnlock(session, { signal: deps.runtime.shutdownSignal }).catch(() => undefined);
      const stored = await listRepositoryObjects(access.storage, access.prefix, "snapshots");
      // What restic reads from the snapshots (their times, which the agent writes) only flags;
      // without it, snapshots no run reported are still flagged, and nothing is decided.
      let claimed: ResticSnapshot[] = [];
      let listing: unknown = null;
      try {
        claimed = await resticSnapshots(session, { noLock: true });
      } catch (error) {
        listing = error;
      }
      const reported = await recordedSnapshots(deps, tenantId, endpointId);
      const audit = auditSnapshots({
        stored: stored.map((snapshot) => ({ id: snapshot.name, storedAt: snapshot.storedAt })),
        recorded: reported.recorded,
        claimed,
        now,
      });
      await recordSnapshotFlags(deps, endpoint, audit.flags, now, listing === null);
      if (listing !== null) {
        throw listing;
      }
      const planned = applyGroupedRetention(audit.dated, reported.groups, policy, timeZone);
      // Held on suspicion: every snapshot stays (and with it every pack it references).
      const held = retentionHeld(holds, endpointId);
      // Snapshots the storage still locks stay until a later run (restic cannot remove them).
      const split = held
        ? { remove: [] as string[], locked: [] as { id: string; until: Date }[] }
        : await splitLockedSnapshots(access.storage, access.prefix, planned.remove);
      const decision = { ...planned, remove: split.remove };
      if (decision.remove.length > 0) {
        await resticForget(session, decision.remove, { signal });
      }
      const prune =
        decision.remove.length > 0 || pending
          ? await resticPrune(session, { signal, storage: access.storage })
          : null;
      return {
        prune,
        audit,
        decision,
        heldBack: planned.remove.length,
        total: stored.length,
        deferredByLock: split.locked.length,
      };
    });
    await recordMaintenanceUnlocked(deps, tenantId, endpointId);
    const prunedSqlBackups = await markPrunedSqlBackups(
      deps,
      tenantId,
      endpointId,
      result.decision.remove,
    );
    const repositoryBytes = await measureRepositoryBytes(access.storage, access.prefix);
    const removed = result.decision.remove.length;
    await writeReport(
      deps,
      tenantId,
      {
        endpointId,
        kind: "retention",
        origin: "server",
        readiness: null,
        summary: {
          removedSnapshots: removed,
          keptSnapshots: result.total - removed,
          repositoryBytes,
          unrecordedSnapshots: result.audit.unrecorded.length,
          futureSnapshots: result.audit.flags.filter((flag) => flag.reasons.includes("future_time"))
            .length,
          removedLocks,
          deferredByLock: result.deferredByLock,
          ...(prunedSqlBackups > 0 ? { prunedSqlBackups } : {}),
          ...pruneSummary(result.prune),
          ...(retentionHeld(holds, endpointId)
            ? { ...retentionHoldSummary(holds, endpointId), heldBackSnapshots: result.heldBack }
            : {}),
        },
      },
      now,
    );
    await withTenantTx(deps.db, tenantId, (tx) =>
      tx
        .update(endpoints)
        .set({ lastRetentionAt: now, repositoryBytes, repositoryMeasuredAt: now })
        .where(eq(endpoints.id, endpointId)),
    );
    logger.info("endpoint retention finished", {
      tenantId,
      endpointId,
      removed,
      kept: result.total - removed,
      unrecorded: result.audit.unrecorded.length,
    });
  } catch (error) {
    // A repository a backup holds locked is not a failure of the policy: pg-boss tries again later.
    if (error instanceof ResticError && error.failure === "locked") {
      await recordMaintenanceLocked(deps, tenantId, endpointId, "retention", now);
      throw error;
    }
    await writeReport(
      deps,
      tenantId,
      {
        endpointId,
        kind: "retention",
        origin: "server",
        readiness: null,
        summary: { errorMessage: reportableMessage(error), ...pruneFailureSummary(error) },
      },
      now,
    ).catch(() => undefined);
    if (targetFull(error)) {
      logger.warn("endpoint retention could not free space: the storage target is full", {
        tenantId,
        endpointId,
      });
    }
    throw error;
  }
}
