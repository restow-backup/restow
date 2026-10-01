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
 * The policy is the endpoint's own: daily, weekly and monthly snapshots to
 * keep, 30 / 12 / 12 unless an admin changed them, counted in the tenant's
 * time zone. The run also measures the bytes the repository takes (the
 * storage budget counts them) and keeps the sealed repository password next
 * to the repository.
 */
import {
  DEFAULT_ENDPOINT_RETENTION,
  DEFAULT_SCHEDULE_TIMEZONE,
  type EndpointJobPayload,
  type RepositoryAccess,
  ResticError,
  type ResticSnapshot,
  type SnapshotFlag,
  applyRetentionPolicy,
  auditSnapshots,
  isValidTimeZone,
  listRepositoryObjects,
  measureRepositoryBytes,
  resticForget,
  resticPrune,
  resticSnapshots,
  resticUnlock,
  withRepository,
} from "@restow/core";
import { type Endpoint, endpointRuns, endpointSnapshotFlags, endpoints, tenants } from "@restow/db";
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { withTenantTx } from "../handlers/framework.js";
import { raiseEvents } from "../reporting.js";
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

/** Snapshot ids an alert names at most (the count says how many there are). */
const ALERT_SNAPSHOT_IDS = 10;

async function tenantTimeZone(deps: EndpointJobDeps, tenantId: string): Promise<string> {
  const [row] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tenantId)),
  );
  const zone = row?.timeZone ?? "";
  return zone && isValidTimeZone(zone) ? zone : DEFAULT_SCHEDULE_TIMEZONE;
}

/** The snapshots backup runs of this endpoint reported, and when each run ended. */
async function recordedSnapshots(deps: EndpointJobDeps, tenantId: string, endpointId: string) {
  const rows = await withTenantTx(deps.db, tenantId, (tx) =>
    tx
      .select({ snapshotId: endpointRuns.snapshotId, finishedAt: endpointRuns.finishedAt })
      .from(endpointRuns)
      .where(
        and(
          eq(endpointRuns.endpointId, endpointId),
          eq(endpointRuns.kind, "backup"),
          isNotNull(endpointRuns.snapshotId),
        ),
      ),
  );
  return rows.map((row) => ({ snapshotId: row.snapshotId as string, finishedAt: row.finishedAt }));
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
  // Never beside the check or a restore test of the same repository.
  await withMaintenanceLock(deps, endpointId, "exclusive", () =>
    retain(deps, payload, endpoint, access),
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
    const result = await withRepository(access, async (session) => {
      // Locks restic itself calls stale (by their content) go as well.
      await resticUnlock(session).catch(() => undefined);
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
      const audit = auditSnapshots({
        stored: stored.map((snapshot) => ({ id: snapshot.name, storedAt: snapshot.storedAt })),
        recorded: await recordedSnapshots(deps, tenantId, endpointId),
        claimed,
        now,
      });
      await recordSnapshotFlags(deps, endpoint, audit.flags, now, listing === null);
      if (listing !== null) {
        throw listing;
      }
      const decision = applyRetentionPolicy(audit.dated, policy, timeZone);
      if (decision.remove.length > 0) {
        await resticForget(session, decision.remove, { signal });
        await resticPrune(session, { signal });
      }
      return { audit, decision, total: stored.length };
    });
    await recordMaintenanceUnlocked(deps, tenantId, endpointId);
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
        summary: { errorMessage: reportableMessage(error) },
      },
      now,
    ).catch(() => undefined);
    throw error;
  }
}
