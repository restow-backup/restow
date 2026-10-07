/**
 * `backup.overdue`: no successful backup of a protected object for longer than its schedule
 * allows (docs/ARCHITECTURE.md, Reports and notifications). Without it a backup that silently
 * stopped (a job paused or deleted, a source whose consent was withdrawn, a machine in no job)
 * stayed quiet until a restore check happened to look, if one was scheduled at all.
 *
 * The bound follows the tenant's jobs (`staleBackupHours` in @restow/core: twice the longest
 * planned gap of the most relaxed enabled job of the kind, two days without any schedule), for
 * mailboxes, OneDrives and IMAP accounts by the mail jobs and for servers and clients by the
 * endpoint jobs. An object counts from its newest committed backup, or from when its protection
 * started if it never had one.
 *
 * Each object is announced once per stretch: an alert is not raised again for an object that
 * was already announced after its newest successful backup. A new backup ends the stretch.
 * Runs with the endpoint monitor, every five minutes, across all active tenants.
 */
import { staleBackupHours } from "@restow/core";
import {
  type NewNotification,
  backupJobs,
  endpoints,
  notifications,
  protectedObjects,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { withTenantTx } from "./handlers/framework.js";
import { raiseEvents } from "./reporting.js";

const HOUR_MS = 60 * 60 * 1000;
/** At most this many alerts per tenant and pass: an outage of the monitor must not flood. */
const MAX_ALERTS_PER_TENANT = 100;

export interface OverdueCandidate {
  kind: "object" | "endpoint";
  id: string;
  name: string;
  /** The newest successful backup, or when protection started without one. */
  since: Date;
  /** Whether a backup ever succeeded. */
  backedUp: boolean;
}

/** The candidates past their bound, minus those already announced since their last backup. */
export function overdueOf(
  candidates: readonly OverdueCandidate[],
  bounds: { mail: number; machines: number },
  announced: ReadonlyMap<string, Date>,
  now: Date,
): OverdueCandidate[] {
  return candidates.filter((candidate) => {
    const hours = candidate.kind === "endpoint" ? bounds.machines : bounds.mail;
    if (now.getTime() - candidate.since.getTime() <= hours * HOUR_MS) {
      return false;
    }
    const last = announced.get(subjectOf(candidate));
    return !last || last.getTime() < candidate.since.getTime();
  });
}

function subjectOf(candidate: Pick<OverdueCandidate, "kind" | "id">): string {
  return `${candidate.kind}:${candidate.id}`;
}

export function overdueNotification(
  tenantId: string,
  candidate: OverdueCandidate,
  bounds: { mail: number; machines: number },
): NewNotification {
  const hours = candidate.kind === "endpoint" ? bounds.machines : bounds.mail;
  const days = Math.max(1, Math.round(hours / 24));
  return {
    tenantId,
    level: "warning",
    event: "backup.overdue",
    message: candidate.backedUp
      ? `No successful backup of ${candidate.name} for more than ${days} days.`
      : `${candidate.name} has never been backed up successfully in ${days} days of protection.`,
    details: {
      ...(candidate.kind === "endpoint"
        ? { endpointId: candidate.id }
        : { protectedObjectId: candidate.id }),
      objectName: candidate.name,
      lastSuccessAt: candidate.backedUp ? candidate.since.toISOString() : null,
      boundHours: hours,
      days,
    },
  };
}

async function tenantCandidates(
  deps: EndpointJobDeps,
  tenantId: string,
): Promise<{ candidates: OverdueCandidate[]; schedules: { kind: string; schedule: unknown }[] }> {
  const db = deps.providerDb;
  const schedules = await db
    .select({ kind: backupJobs.kind, schedule: backupJobs.schedule })
    .from(backupJobs)
    .where(
      and(
        eq(backupJobs.tenantId, tenantId),
        eq(backupJobs.enabled, true),
        isNotNull(backupJobs.schedule),
      ),
    );
  const objects = await db
    .select({
      id: protectedObjects.id,
      name: sql<string>`coalesce(nullif(trim(${protectedObjects.displayName}), ''), ${protectedObjects.externalId})`,
      since:
        sql<Date>`coalesce(${protectedObjects.activeSince}, ${protectedObjects.createdAt})`.mapWith(
          (value: string | Date) => new Date(value),
        ),
      last: sql<Date | null>`(select max(${snapshots.completedAt}) from ${snapshots} where ${snapshots.protectedObjectId} = ${protectedObjects.id} and ${snapshots.manifestPath} is not null)`.mapWith(
        (value: string | Date | null) => (value === null ? null : new Date(value)),
      ),
    })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.status, "active"),
        // Imported mailboxes are never backed up: they are never overdue.
        sql`${protectedObjects.sourceId} not in (select ${sources.id} from ${sources} where ${sources.kind} = 'import')`,
      ),
    );
  const machines = await db
    .select({
      id: endpoints.id,
      hostname: endpoints.hostname,
      displayName: endpoints.displayName,
      createdAt: endpoints.createdAt,
      lastSuccessAt: endpoints.lastSuccessAt,
    })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")));
  return {
    schedules,
    candidates: [
      ...objects.map((object) => ({
        kind: "object" as const,
        id: object.id,
        name: object.name,
        since: object.last ?? object.since,
        backedUp: object.last !== null,
      })),
      ...machines.map((machine) => ({
        kind: "endpoint" as const,
        id: machine.id,
        name: machine.displayName?.trim() || machine.hostname,
        since: machine.lastSuccessAt ?? machine.createdAt,
        backedUp: machine.lastSuccessAt !== null,
      })),
    ],
  };
}

/** When each subject of the tenant was last announced as overdue. */
async function announcedSubjects(
  deps: EndpointJobDeps,
  tenantId: string,
): Promise<Map<string, Date>> {
  const rows = await deps.providerDb
    .select({ details: notifications.details, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.tenantId, tenantId), eq(notifications.event, "backup.overdue")));
  const announced = new Map<string, Date>();
  for (const row of rows) {
    const details = row.details ?? {};
    const key =
      typeof details.endpointId === "string"
        ? `endpoint:${details.endpointId}`
        : typeof details.protectedObjectId === "string"
          ? `object:${details.protectedObjectId}`
          : null;
    if (key && (!announced.get(key) || (announced.get(key) as Date) < row.createdAt)) {
      announced.set(key, row.createdAt);
    }
  }
  return announced;
}

/** Raise `backup.overdue` for every active tenant; returns how many alerts were raised. */
export async function alertOverdueBackups(deps: EndpointJobDeps, now: Date): Promise<number> {
  const active = await deps.providerDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  let alerts = 0;
  for (const tenant of active) {
    const { candidates, schedules } = await tenantCandidates(deps, tenant.id);
    if (candidates.length === 0) {
      continue;
    }
    const bounds = {
      mail: staleBackupHours(
        schedules.filter((row) => row.kind === "mail").map((row) => row.schedule as never),
        now,
      ),
      machines: staleBackupHours(
        schedules.filter((row) => row.kind === "endpoint").map((row) => row.schedule as never),
        now,
      ),
    };
    const due = overdueOf(candidates, bounds, await announcedSubjects(deps, tenant.id), now).slice(
      0,
      MAX_ALERTS_PER_TENANT,
    );
    if (due.length === 0) {
      continue;
    }
    await withTenantTx(deps.db, tenant.id, (tx) =>
      raiseEvents(
        tx,
        due.map((candidate) => overdueNotification(tenant.id, candidate, bounds)),
        now,
      ),
    );
    alerts += due.length;
  }
  return alerts;
}
