/**
 * `backup.overdue`: no successful backup of a protected object for longer than its schedule
 * allows (docs/ARCHITECTURE.md, Reports and notifications). Without it a backup that silently
 * stopped (a job paused or deleted, a source whose consent was withdrawn, a machine in no job)
 * stayed quiet until a restore check happened to look, if one was scheduled at all.
 *
 * The bound follows the tenant's jobs (`staleBackupHours` in @restow/core: twice the longest
 * planned gap of the most relaxed enabled job of the kind, two days without any schedule), for
 * mailboxes, OneDrives and IMAP accounts by the mail jobs, for servers and clients by the
 * endpoint jobs, for VMs and containers of Proxmox VE by the PVE jobs
 * (`pveStaleBackupHours`), and for file shares by the share jobs (docs/FILESHARES.md 13). An object counts from its newest committed backup, or from when its
 * protection started if it never had one. A guest counts while it is in an enabled PVE job, or
 * once it had a successful backup (it left its job: nothing backs it up any more); a guest the
 * inventory found that nobody ever put into a job is not overdue.
 *
 * Each object is announced once per stretch: an alert is not raised again for an object that
 * was already announced after its newest successful backup. A new backup ends the stretch.
 *
 * A rule may set its own deadline (`overdueAfterHours` of the rule, 24 to 720 hours): it then
 * gets its alerts when nothing was backed up successfully for that long, whatever the schedules
 * say, once per stretch and rule, and never with the alert raised at the schedules' bound
 * (reporting.ts leaves it out there). The bell keeps following the schedules.
 *
 * Runs with the endpoint monitor, every five minutes, across all active tenants.
 */
import {
  overdueDeadlineOf,
  pveGuestBackable,
  pveJobOfGuest,
  pveStaleBackupHours,
  rulesForEvent,
  staleBackupHours,
  subjectKeyOf,
} from "@restow/core";
import {
  type NewNotification,
  backupJobMembers,
  backupJobs,
  endpoints,
  fileShares,
  notifications,
  protectedObjects,
  pveGuests,
  pveJobs,
  pveSnapshots,
  reportRules,
  snapshots,
  sources,
  tenants,
} from "@restow/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { EndpointJobDeps } from "./endpoints/common.js";
import { withTenantTx } from "./handlers/framework.js";
import { lastAlertAt, queueRuleDeliveries, raiseEvents } from "./reporting.js";

const HOUR_MS = 60 * 60 * 1000;
/** At most this many alerts per tenant and pass: an outage of the monitor must not flood. */
const MAX_ALERTS_PER_TENANT = 100;

export interface OverdueCandidate {
  kind: "object" | "endpoint" | "guest" | "file_share";
  id: string;
  name: string;
  /** The newest successful backup, or when protection started without one. */
  since: Date;
  /** Whether a backup ever succeeded. */
  backedUp: boolean;
}

/** After how many hours without a successful backup each kind is overdue, by the schedules. */
export interface OverdueBounds {
  mail: number;
  machines: number;
  /** VMs and containers of Proxmox VE; absent, the machines' bound applies. */
  guests?: number;
  /** File shares (docs/FILESHARES.md 13); absent, the machines' bound applies. */
  fileShares?: number;
}

/** The bound of a candidate's kind. */
export function boundOf(candidate: Pick<OverdueCandidate, "kind">, bounds: OverdueBounds): number {
  switch (candidate.kind) {
    case "endpoint":
      return bounds.machines;
    case "guest":
      return bounds.guests ?? bounds.machines;
    case "file_share":
      return bounds.fileShares ?? bounds.machines;
    default:
      return bounds.mail;
  }
}

/** Whether a candidate has had no successful backup for longer than `hours`. */
export function pastDeadline(candidate: OverdueCandidate, hours: number, now: Date): boolean {
  return now.getTime() - candidate.since.getTime() > hours * HOUR_MS;
}

/** The candidates past their bound, minus those already announced since their last backup. */
export function overdueOf(
  candidates: readonly OverdueCandidate[],
  bounds: OverdueBounds,
  announced: ReadonlyMap<string, Date>,
  now: Date,
): OverdueCandidate[] {
  return candidates.filter((candidate) => {
    if (!pastDeadline(candidate, boundOf(candidate, bounds), now)) {
      return false;
    }
    const last = announced.get(subjectOf(candidate));
    return !last || last.getTime() < candidate.since.getTime();
  });
}

function subjectOf(candidate: Pick<OverdueCandidate, "kind" | "id">): string {
  return `${candidate.kind}:${candidate.id}`;
}

function subjectDetails(candidate: OverdueCandidate): Record<string, string> {
  switch (candidate.kind) {
    case "endpoint":
      return { endpointId: candidate.id };
    case "guest":
      return { pveGuestId: candidate.id };
    case "file_share":
      return { fileShareId: candidate.id };
    default:
      return { protectedObjectId: candidate.id };
  }
}

/**
 * The alert of an overdue candidate. `hours` is the bound it was judged by: its kind's bound
 * from the schedules, or the deadline of the rule it is for.
 */
export function overdueNotification(
  tenantId: string,
  candidate: OverdueCandidate,
  bounds: OverdueBounds,
  hours: number = boundOf(candidate, bounds),
): NewNotification {
  const days = Math.max(1, Math.round(hours / 24));
  return {
    tenantId,
    level: "warning",
    event: "backup.overdue",
    message: candidate.backedUp
      ? `No successful backup of ${candidate.name} for more than ${days} days.`
      : `${candidate.name} has never been backed up successfully in ${days} days of protection.`,
    details: {
      ...subjectDetails(candidate),
      objectName: candidate.name,
      lastSuccessAt: candidate.backedUp ? candidate.since.toISOString() : null,
      boundHours: hours,
      days,
    },
  };
}

/**
 * Whether a rule with its own deadline alerts about a candidate now: past the rule's deadline,
 * and the rule did not alert about it since its newest successful backup (once per stretch).
 */
export function dueForRule(
  candidate: OverdueCandidate,
  deadlineHours: number,
  lastAlert: Date | null,
  now: Date,
): boolean {
  if (!pastDeadline(candidate, deadlineHours, now)) {
    return false;
  }
  return lastAlert === null || lastAlert.getTime() < candidate.since.getTime();
}

const toDate = (value: string | Date | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value);

async function tenantCandidates(
  deps: EndpointJobDeps,
  tenantId: string,
  now: Date,
): Promise<{ candidates: OverdueCandidate[]; bounds: OverdueBounds }> {
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
      // Qualified by hand: in a subquery drizzle writes bare column names, and a bare "id" would
      // be the snapshot's own.
      last: sql<Date | null>`(select max(s.completed_at) from ${snapshots} as s where s.protected_object_id = "protected_objects"."id" and s.manifest_path is not null)`.mapWith(
        toDate,
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

  // VMs and containers of Proxmox VE, by the same rule as every overview (@restow/core pve).
  const pveJobRows = await db
    .select({
      id: pveJobs.id,
      enabled: pveJobs.enabled,
      scopeAll: pveJobs.scopeAll,
      schedule: pveJobs.schedule,
      createdAt: pveJobs.createdAt,
    })
    .from(pveJobs)
    .where(eq(pveJobs.tenantId, tenantId));
  const guests = await db
    .select({
      id: pveGuests.id,
      vmid: pveGuests.vmid,
      kind: pveGuests.kind,
      name: pveGuests.name,
      template: pveGuests.template,
      present: pveGuests.present,
      jobId: pveGuests.jobId,
      createdAt: pveGuests.createdAt,
      lastSuccessAt: pveGuests.lastSuccessAt,
      newest:
        sql<Date | null>`(select max(s.backup_at) from ${pveSnapshots} as s where s.guest_id = "pve_guests"."id" and s.status = 'active')`.mapWith(
          toDate,
        ),
    })
    .from(pveGuests)
    .where(eq(pveGuests.tenantId, tenantId));
  const guestCandidates: OverdueCandidate[] = [];
  for (const guest of guests) {
    if (!pveGuestBackable(guest)) {
      continue;
    }
    const job = pveJobOfGuest(guest, pveJobRows);
    const last =
      guest.lastSuccessAt && guest.newest
        ? guest.lastSuccessAt > guest.newest
          ? guest.lastSuccessAt
          : guest.newest
        : (guest.lastSuccessAt ?? guest.newest);
    if (!job && !last) {
      // Found by the inventory, never put into a job: not meant to be backed up.
      continue;
    }
    const protectedSince = job && job.createdAt > guest.createdAt ? job.createdAt : guest.createdAt;
    guestCandidates.push({
      kind: "guest",
      id: guest.id,
      name: guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`,
      since: last ?? protectedSince,
      backedUp: last !== null,
    });
  }

  // File shares (docs/FILESHARES.md 13): protected while not retired and in an enabled share job;
  // copy jobs are never protection.
  const shareMembers = await db
    .select({
      id: fileShares.id,
      name: fileShares.name,
      createdAt: fileShares.createdAt,
      lastSuccessAt: fileShares.lastSuccessAt,
      jobCreatedAt: backupJobs.createdAt,
    })
    .from(fileShares)
    .innerJoin(backupJobMembers, eq(backupJobMembers.fileShareId, fileShares.id))
    .innerJoin(backupJobs, eq(backupJobs.id, backupJobMembers.jobId))
    .where(
      and(
        eq(fileShares.tenantId, tenantId),
        isNull(fileShares.retiredAt),
        eq(backupJobs.kind, "share"),
        eq(backupJobs.enabled, true),
      ),
    );
  const shareCandidates: OverdueCandidate[] = shareMembers.map((share) => ({
    kind: "file_share",
    id: share.id,
    name: share.name,
    since:
      share.lastSuccessAt ??
      (share.jobCreatedAt > share.createdAt ? share.jobCreatedAt : share.createdAt),
    backedUp: share.lastSuccessAt !== null,
  }));

  return {
    bounds: {
      mail: staleBackupHours(
        schedules.filter((row) => row.kind === "mail").map((row) => row.schedule),
        now,
      ),
      machines: staleBackupHours(
        schedules.filter((row) => row.kind === "endpoint").map((row) => row.schedule),
        now,
      ),
      guests: pveStaleBackupHours(
        pveJobRows.filter((job) => job.enabled).map((job) => job.schedule),
        now,
      ),
      fileShares: staleBackupHours(
        schedules.filter((row) => row.kind === "share").map((row) => row.schedule),
        now,
      ),
    },
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
      ...guestCandidates,
      ...shareCandidates,
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
        : typeof details.pveGuestId === "string"
          ? `guest:${details.pveGuestId}`
          : typeof details.fileShareId === "string"
            ? `file_share:${details.fileShareId}`
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
    const { candidates, bounds } = await tenantCandidates(deps, tenant.id, now);
    if (candidates.length === 0) {
      continue;
    }
    const due = overdueOf(candidates, bounds, await announcedSubjects(deps, tenant.id), now).slice(
      0,
      MAX_ALERTS_PER_TENANT,
    );
    if (due.length > 0) {
      await withTenantTx(deps.db, tenant.id, (tx) =>
        raiseEvents(
          tx,
          due.map((candidate) => overdueNotification(tenant.id, candidate, bounds)),
          now,
        ),
      );
      alerts += due.length;
    }
    alerts += await alertByRuleDeadlines(deps, tenant.id, candidates, bounds, now);
  }
  return alerts;
}

/**
 * The rules of the tenant with their own `backup.overdue` deadline: each alerts about every
 * candidate past its deadline once per stretch, by its own channels. Returns how many alerts
 * (one per rule and candidate) were queued.
 */
async function alertByRuleDeadlines(
  deps: EndpointJobDeps,
  tenantId: string,
  candidates: readonly OverdueCandidate[],
  bounds: OverdueBounds,
  now: Date,
): Promise<number> {
  return withTenantTx(deps.db, tenantId, async (tx) => {
    const rules = rulesForEvent(
      await tx
        .select()
        .from(reportRules)
        .where(
          and(
            eq(reportRules.tenantId, tenantId),
            eq(reportRules.enabled, true),
            eq(reportRules.trigger, "event"),
          ),
        ),
      "backup.overdue",
    );
    let alerted = 0;
    for (const rule of rules) {
      const deadline = overdueDeadlineOf(rule);
      if (deadline === null) {
        continue;
      }
      const raised: NewNotification[] = [];
      for (const candidate of candidates) {
        if (raised.length >= MAX_ALERTS_PER_TENANT || !pastDeadline(candidate, deadline, now)) {
          continue;
        }
        const notification = overdueNotification(tenantId, candidate, bounds, deadline);
        const subjectKey = subjectKeyOf("backup.overdue", notification.details ?? {});
        if (
          dueForRule(candidate, deadline, await lastAlertAt(tx, tenantId, rule.id, subjectKey), now)
        ) {
          raised.push(notification);
        }
      }
      if (raised.length > 0 && (await queueRuleDeliveries(tx, tenantId, rule, raised, now)) > 0) {
        alerted += raised.length;
      }
    }
    return alerted;
  });
}
