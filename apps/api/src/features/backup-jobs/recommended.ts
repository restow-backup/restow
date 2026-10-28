import {
  DEFAULT_ENDPOINT_RETENTION,
  DEFAULT_SCHEDULE_TIMEZONE,
  type JobSchedule,
  jobScheduleFromCadence,
  pveGuestCounted,
  pveJobOfGuest,
  recommendedSchedules,
} from "@restow/core";
import {
  backupJobMembers,
  backupJobs,
  type CaptureKind,
  type Database,
  endpoints,
  mailboxCaptureWay,
  type PveJobSchedule,
  type PveJobSettings,
  pveGuests,
  pveJobs,
  tenants,
} from "@restow/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { assignJob, saveJob } from "../pve/service.js";
import { coverageOf, loadMailCoverage } from "./coverage.js";
import { ensureDefaultMailJob } from "./defaults.js";
import type { RepositoryDto } from "./dto.js";
import { loadPrimaryTarget, loadSnapshotPolicies, repositoryDto } from "./loaders.js";
import { endpointGroupName, languageOf, mailJobName, pveJobName, uniqueName } from "./names.js";
import { machineJobDefaults } from "./read.js";
import { createBackupJobSchema } from "./schemas.js";
import { BACKUP_JOB_AUDIT_ACTIONS, type JobActor, type JobContext } from "./service-types.js";
import { addMembers, createBackupJob, enableMailArchive, tenantCaptureKinds } from "./write.js";

/**
 * "Create recommended job" (#52): one click protects what has no backup job, with the job Restow
 * recommends for its kind. The preview (GET) says what the click would do, the apply (POST) does
 * exactly that.
 *
 *   mail       one job over every mail object (ensureDefaultMailJob): backup every 8 h, restore
 *              check weekly (Sunday 03:00), the primary repository, the tenant's default retention
 *              policy. Nothing to do when a job over all objects exists already.
 *   endpoint   one job per operating system and profile (`endpoint:<os>:<profile>`), from the
 *              defaults of a new machine job: that system's folders and excludes, servers daily
 *              22:00, clients when they connect (at most every 4 h), 30 daily / 12 weekly / 12
 *              monthly restore points, the primary repository. A machine joins the existing
 *              recommended job of its group.
 *   pve        one job for VMs and containers: daily 22:00 in the tenant's zone, snapshot mode
 *              (incremental through the dirty bitmaps; the node reads in full when a bitmap is
 *              gone), 7 daily / 4 weekly / 6 monthly restore points. The weekly restore check (a
 *              sample of the newest restore point read back) runs for every guest anyway.
 *   archive    (0.4.7, only while the installation offers `archive.mailboxCapture`) the mail
 *              job over all objects archives too, with the default capture ways: Graph for
 *              Microsoft 365 mailboxes, IMAP for the other accounts (the ways that need nothing
 *              set up in the tenant; journaling and forwarding stay a choice in the editor). A
 *              new recommended mail job is made archiving; an existing one over all objects that
 *              does not archive yet is switched on ("enable", audited as an edit of the job).
 *              Mail jobs over selected objects are never changed: they were set up by hand.
 *              Nothing is planned while the tenant has no mail object an archive could capture.
 *
 * Idempotent: the apply takes the tenant row's lock first, so two clicks run one after the other
 * and the second finds the job of the first (by its key, `backup_jobs.recommended` and
 * `pve_jobs.recommended`, which a partial unique index keeps to one per tenant). Objects that are
 * in a job already are never moved: they are skipped and named. Every job made and every member
 * added is audited as a change in the editor would be, plus one entry for the click.
 */

export type RecommendedKind = "mail" | "endpoint" | "pve" | "archive";

export interface RecommendedScope {
  /** The mail job over all objects. */
  mail: boolean;
  /** Machines to protect. */
  endpointIds: readonly string[];
  /** VMs and containers to protect. */
  guestIds: readonly string[];
  /** Everything without a job: mail objects, machines and guests ("Protect everything"). */
  everything: boolean;
  /** With `everything`: only these kinds (a list's notice protects its own kind); empty = all. */
  kinds?: readonly RecommendedKind[];
}

/** Whether `everything` covers a kind. */
function allOf(scope: RecommendedScope, kind: RecommendedKind): boolean {
  return (
    scope.everything && (!scope.kinds || scope.kinds.length === 0 || scope.kinds.includes(kind))
  );
}

export interface RecommendedMember {
  id: string;
  name: string;
}

export interface RecommendedJobPlanDto {
  kind: RecommendedKind;
  /** `mail`, `endpoint:<os>:<profile>`, `pve` or `archive`. */
  key: string;
  /** Make the job, add to the recommended job that exists, or switch archiving on in it. */
  action: "create" | "add" | "enable";
  jobId: string | null;
  name: string;
  /** Machines: the system and the profile of the group. */
  os: string | null;
  profile: "server" | "client" | null;
  /** Null only for a job that switches archiving on and runs by hand (it keeps its schedule). */
  schedule: JobSchedule | PveJobSchedule | null;
  /** Mail: the restore-check schedule. */
  verifySchedule: JobSchedule | null;
  /** Machines and guests: the restore points kept; mail follows `retentionPolicy`. */
  retention: { keepDaily: number; keepWeekly: number; keepMonthly: number } | null;
  /** Mail: the name of the tenant's default retention policy (null: none set). */
  retentionPolicy: string | null;
  /** Mail and machines: where the job writes. Guests write to their cluster's repository. */
  repository: RepositoryDto | null;
  /** Guests: the backup mode. */
  mode: PveJobSettings["mode"] | null;
  /** Machines: the folders backed up. */
  paths: string[];
  /** What the click protects: machines or guests by name; mail objects only as a count. */
  members: RecommendedMember[];
  memberCount: number;
  /** Mail: the job archives as well (with the default capture ways). */
  archive: boolean;
  /** Mail that archives: the kinds of mail object the archive captures, each its default way. */
  captureKinds: CaptureKind[];
}

export interface RecommendedSkipDto {
  kind: RecommendedKind;
  id: string;
  name: string | null;
  /**
   * in_job: already in a backup job (archive: a mail job over selected objects that does not
   * archive); unavailable: unknown, revoked, a template or gone; covered: mail has a job over all
   * objects (archive: it archives already); no_capture_way: the job over all objects has its
   * capture ways chosen by hand (Graph or the IMAP sync off), so it is left for the editor.
   */
  reason: "in_job" | "unavailable" | "covered" | "no_capture_way";
}

export interface RecommendedPlanDto {
  items: RecommendedJobPlanDto[];
  skipped: RecommendedSkipDto[];
}

export interface RecommendedAppliedDto {
  items: {
    kind: RecommendedKind;
    key: string;
    jobId: string;
    name: string;
    created: boolean;
    added: number;
  }[];
  skipped: RecommendedSkipDto[];
}

const MEMBERS_SHOWN = 50;

const KNOWN_OS = new Set(["linux", "darwin", "windows"]);

/** The recommended Proxmox VE job's schedule and settings. */
export const PVE_RECOMMENDED_TIME = "22:00";
export const PVE_RECOMMENDED_SETTINGS: PveJobSettings = {
  mode: "snapshot",
  retention: { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 },
};

export function endpointKey(os: string, profile: "server" | "client"): string {
  return `endpoint:${KNOWN_OS.has(os) ? os : "linux"}:${profile}`;
}

interface Planned {
  plan: RecommendedJobPlanDto;
  /** The ids the apply adds (all of them, not only the ones shown). */
  targetIds: string[];
  /** Mail: the recommended schedules handed to ensureDefaultMailJob. */
  mail?: ReturnType<typeof recommendedSchedules>;
}

/** What the installation offers that the plan depends on. */
export interface RecommendedOptions {
  /** `archive.mailboxCapture` is on (lib/features.ts): archiving is part of the recommendation. */
  archive: boolean;
}

async function plan(
  tx: Transaction,
  tenantId: string,
  scope: RecommendedScope,
  options: RecommendedOptions,
): Promise<{ planned: Planned[]; skipped: RecommendedSkipDto[] }> {
  const [tenant] = await tx
    .select({ timeZone: tenants.timeZone, language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const timeZone = tenant?.timeZone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const language = languageOf({ language: tenant?.language ?? null });
  const planned: Planned[] = [];
  const skipped: RecommendedSkipDto[] = [];
  const primary = await loadPrimaryTarget(tx, tenantId);

  // --- Mail -------------------------------------------------------------------
  const mailWanted = scope.mail || allOf(scope, "mail");
  const archiveWanted = options.archive && allOf(scope, "archive");
  const mailJobs =
    mailWanted || archiveWanted
      ? await tx
          .select({
            id: backupJobs.id,
            name: backupJobs.name,
            scopeMode: backupJobs.scopeMode,
            enabled: backupJobs.enabled,
            archive: backupJobs.archive,
            archiveCapture: backupJobs.archiveCapture,
            schedule: backupJobs.schedule,
            verifySchedule: backupJobs.verifySchedule,
          })
          .from(backupJobs)
          .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "mail")))
      : [];
  const allJob = mailJobs.find((job) => job.scopeMode === "all");
  // What an archive would capture; nothing while the installation does not offer it.
  const captureKinds =
    options.archive && (mailWanted || archiveWanted) ? await tenantCaptureKinds(tx, tenantId) : [];
  // The recommended mail job over all objects, archiving when there is something to capture.
  const createMailPlan = async (
    kind: "mail" | "archive",
    memberCount: number,
  ): Promise<Planned> => {
    const recommended = recommendedSchedules({
      timezone: timeZone,
      hasMicrosoftSource: false,
    }).filter((entry) => entry.kind === "backup" || entry.kind === "verify");
    const backup = recommended.find((entry) => entry.kind === "backup");
    const verify = recommended.find((entry) => entry.kind === "verify");
    const policies = await loadSnapshotPolicies(tx, tenantId);
    return {
      mail: recommended,
      targetIds: [],
      plan: {
        kind,
        key: kind,
        action: "create",
        jobId: null,
        name: uniqueName(language, mailJobName(language), new Set(mailJobs.map((job) => job.name))),
        os: null,
        profile: null,
        schedule: backup
          ? jobScheduleFromCadence(backup)
          : { kind: "interval", intervalMinutes: 480, timeZone },
        verifySchedule: verify ? jobScheduleFromCadence(verify) : null,
        retention: null,
        retentionPolicy: policies.find((policy) => policy.isDefault)?.name ?? null,
        repository: repositoryDto(primary),
        mode: null,
        paths: [],
        members: [],
        memberCount,
        archive: captureKinds.length > 0,
        captureKinds,
      },
    };
  };
  let mailCreated = false;
  // The mail objects in no job: what a new job over all objects would cover.
  const uncovered =
    mailWanted || archiveWanted
      ? await loadMailCoverage(tx, tenantId).then(({ objects, links }) =>
          objects.filter((object) => coverageOf(object, links) === "none"),
        )
      : [];
  if (mailWanted) {
    if (allJob) {
      if (scope.mail) {
        skipped.push({ kind: "mail", id: allJob.id, name: allJob.name, reason: "covered" });
      }
    } else if (scope.mail || uncovered.length > 0) {
      planned.push(await createMailPlan("mail", uncovered.length));
      mailCreated = true;
    }
  }

  // --- Mail archive ---------------------------------------------------------------
  if (archiveWanted && captureKinds.length > 0) {
    // Only a click that names the archive hears what it leaves alone.
    const named = scope.kinds?.includes("archive") ?? false;
    if (allJob) {
      if (allJob.archive) {
        if (named) {
          skipped.push({ kind: "archive", id: allJob.id, name: allJob.name, reason: "covered" });
        }
      } else if (
        // The ways were chosen by hand (Graph or the IMAP sync switched off, journaling or
        // forwarding instead, or still waiting for a choice since 0.4.4): the job stays as it is.
        captureKinds.some((kind) => mailboxCaptureWay(kind, allJob.archiveCapture) === null)
      ) {
        skipped.push({
          kind: "archive",
          id: allJob.id,
          name: allJob.name,
          reason: "no_capture_way",
        });
      } else {
        planned.push({
          targetIds: [],
          plan: {
            kind: "archive",
            key: "archive",
            action: "enable",
            jobId: allJob.id,
            name: allJob.name,
            os: null,
            profile: null,
            // Its schedules stay as they are: the archive runs with its backups. A paused job
            // runs by hand only (the scheduler skips it), so its schedule is not named as one it
            // keeps running on: null makes the preview say "by hand only, as the job did".
            schedule: allJob.enabled ? allJob.schedule : null,
            verifySchedule: allJob.verifySchedule,
            retention: null,
            retentionPolicy: null,
            repository: null,
            mode: null,
            paths: [],
            members: [],
            memberCount: 0,
            archive: true,
            captureKinds,
          },
        });
      }
    } else if (!mailCreated && uncovered.length > 0) {
      // A new job over all objects covers only what is in no job yet.
      planned.push(await createMailPlan("archive", uncovered.length));
    }
    // Hand-picked jobs keep their setting; the preview names them.
    for (const job of mailJobs) {
      if (job.scopeMode === "selected" && !job.archive) {
        skipped.push({ kind: "archive", id: job.id, name: job.name, reason: "in_job" });
      }
    }
  }

  // --- Machines -----------------------------------------------------------------
  const memberRows = await tx
    .select({ endpointId: backupJobMembers.endpointId })
    .from(backupJobMembers)
    .where(and(eq(backupJobMembers.tenantId, tenantId), isNotNull(backupJobMembers.endpointId)));
  const inJob = new Set(memberRows.map((row) => row.endpointId as string));
  const wantedMachines = allOf(scope, "endpoint")
    ? await tx
        .select()
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), eq(endpoints.status, "active")))
    : scope.endpointIds.length > 0
      ? await tx
          .select()
          .from(endpoints)
          .where(
            and(eq(endpoints.tenantId, tenantId), inArray(endpoints.id, [...scope.endpointIds])),
          )
      : [];
  const found = new Set(wantedMachines.map((row) => row.id));
  for (const id of scope.endpointIds) {
    if (!found.has(id)) skipped.push({ kind: "endpoint", id, name: null, reason: "unavailable" });
  }
  const groups = new Map<
    string,
    { os: string; profile: "server" | "client"; machines: typeof wantedMachines }
  >();
  for (const machine of wantedMachines) {
    const name = machine.displayName?.trim() || machine.hostname;
    if (machine.status !== "active") {
      skipped.push({ kind: "endpoint", id: machine.id, name, reason: "unavailable" });
      continue;
    }
    if (inJob.has(machine.id)) {
      // "Everything" means everything without a job: a machine in a job is not news.
      if (!allOf(scope, "endpoint")) {
        skipped.push({ kind: "endpoint", id: machine.id, name, reason: "in_job" });
      }
      continue;
    }
    const os = KNOWN_OS.has(machine.os) ? machine.os : "linux";
    const key = endpointKey(os, machine.profile);
    const group = groups.get(key) ?? { os, profile: machine.profile, machines: [] };
    group.machines.push(machine);
    groups.set(key, group);
  }
  if (groups.size > 0) {
    const existing = await tx
      .select({ id: backupJobs.id, name: backupJobs.name, recommended: backupJobs.recommended })
      .from(backupJobs)
      .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "endpoint")));
    const taken = new Set(existing.map((job) => job.name));
    for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const job = existing.find((row) => row.recommended === key);
      const defaults = machineJobDefaults([{ os: group.os, profile: group.profile }], timeZone);
      const schedule = defaults.schedule as JobSchedule;
      const name =
        job?.name ??
        uniqueName(language, endpointGroupName(language, group.os, group.profile, schedule), taken);
      taken.add(name);
      const members = group.machines.map((machine) => ({
        id: machine.id,
        name: machine.displayName?.trim() || machine.hostname,
      }));
      planned.push({
        targetIds: members.map((member) => member.id),
        plan: {
          kind: "endpoint",
          key,
          action: job ? "add" : "create",
          jobId: job?.id ?? null,
          name,
          os: group.os,
          profile: group.profile,
          schedule,
          verifySchedule: null,
          retention: { ...DEFAULT_ENDPOINT_RETENTION },
          retentionPolicy: null,
          repository: repositoryDto(primary),
          mode: null,
          paths: defaults.paths,
          members: members.slice(0, MEMBERS_SHOWN),
          memberCount: members.length,
          archive: false,
          captureKinds: [],
        },
      });
    }
  }

  // --- VMs and containers ---------------------------------------------------------
  if (allOf(scope, "pve") || scope.guestIds.length > 0) {
    const jobs = await tx.select().from(pveJobs).where(eq(pveJobs.tenantId, tenantId));
    const guests = allOf(scope, "pve")
      ? await tx.select().from(pveGuests).where(eq(pveGuests.tenantId, tenantId))
      : await tx
          .select()
          .from(pveGuests)
          .where(and(eq(pveGuests.tenantId, tenantId), inArray(pveGuests.id, [...scope.guestIds])));
    const known = new Set(guests.map((guest) => guest.id));
    for (const id of scope.guestIds) {
      if (!known.has(id)) skipped.push({ kind: "pve", id, name: null, reason: "unavailable" });
    }
    const chosen: RecommendedMember[] = [];
    for (const guest of guests) {
      const name = guest.name?.trim() || `${guest.kind === "vm" ? "VM" : "CT"} ${guest.vmid}`;
      // Absent, a VM template, or excluded from backup by an administrator.
      if (!pveGuestCounted(guest)) {
        if (!allOf(scope, "pve"))
          skipped.push({ kind: "pve", id: guest.id, name, reason: "unavailable" });
        continue;
      }
      // In a job of its own (also a paused one: that is a decision), or in an enabled job over all guests.
      if (guest.jobId !== null || pveJobOfGuest(guest, jobs)) {
        if (!allOf(scope, "pve"))
          skipped.push({ kind: "pve", id: guest.id, name, reason: "in_job" });
        continue;
      }
      chosen.push({ id: guest.id, name });
    }
    if (chosen.length > 0) {
      const job = jobs.find((row) => row.recommended);
      planned.push({
        targetIds: chosen.map((member) => member.id),
        plan: {
          kind: "pve",
          key: "pve",
          action: job ? "add" : "create",
          jobId: job?.id ?? null,
          name:
            job?.name ??
            uniqueName(
              language,
              pveJobName(language, PVE_RECOMMENDED_TIME),
              new Set(jobs.map((row) => row.name)),
            ),
          os: null,
          profile: null,
          schedule: job?.schedule ?? { kind: "daily", timeOfDay: PVE_RECOMMENDED_TIME, timeZone },
          verifySchedule: null,
          retention: job?.settings.retention ?? PVE_RECOMMENDED_SETTINGS.retention ?? null,
          retentionPolicy: null,
          repository: null,
          mode: job?.settings.mode ?? PVE_RECOMMENDED_SETTINGS.mode ?? null,
          paths: [],
          members: chosen.slice(0, MEMBERS_SHOWN),
          memberCount: chosen.length,
          archive: false,
          captureKinds: [],
        },
      });
    }
  }
  return { planned, skipped };
}

/** What "Create recommended job" would do for `scope`; writes nothing. */
export async function previewRecommendedJobs(
  db: Database,
  tenantId: string,
  scope: RecommendedScope,
  options: RecommendedOptions = { archive: false },
): Promise<RecommendedPlanDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const { planned, skipped } = await plan(tx, tenantId, scope, options);
    return { items: planned.map((entry) => entry.plan), skipped };
  });
}

/** Make the recommended jobs for `scope`, or add to them (see the file comment for the rules). */
export async function applyRecommendedJobs(
  db: Database,
  tenantId: string,
  scope: RecommendedScope,
  actor: JobActor,
  context: JobContext,
  options: RecommendedOptions = { archive: false },
): Promise<RecommendedAppliedDto> {
  const { now } = context;
  return withTenantTx(db, tenantId, async (tx) => {
    // One click at a time per tenant: the second waits here and then plans against the first's jobs.
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for("update");
    const { planned, skipped } = await plan(tx, tenantId, scope, options);
    const items: RecommendedAppliedDto["items"] = [];
    for (const { plan: item, targetIds, mail } of planned) {
      if (item.kind === "archive" && item.action === "enable" && item.jobId) {
        // As an edit in the editor would: the capture ways checked, audited as a change.
        await enableMailArchive(tx, tenantId, item.jobId, actor);
        items.push({
          kind: "archive",
          key: "archive",
          jobId: item.jobId,
          name: item.name,
          created: false,
          added: 0,
        });
        continue;
      }
      if (item.kind === "mail" || item.kind === "archive") {
        const job = await ensureDefaultMailJob(tx, tenantId, mail ?? [], now, {
          recommended: "mail",
          archive: item.archive,
        });
        if (job) {
          await audit(tx, {
            tenantId,
            actor: actor.label,
            actorUserId: actor.userId,
            ip: actor.ip,
            action: BACKUP_JOB_AUDIT_ACTIONS.created,
            target: job.id,
            targetType: "backup_job",
            details: {
              kind: "mail",
              name: job.name,
              scopeMode: "all",
              schedule: item.schedule,
              verifySchedule: item.verifySchedule,
              recommended: "mail",
              ...(item.archive ? { archive: true } : {}),
            },
          });
          items.push({
            kind: item.kind,
            key: item.kind,
            jobId: job.id,
            name: job.name,
            created: true,
            added: 0,
          });
        }
        continue;
      }
      if (item.kind === "endpoint") {
        if (item.jobId) {
          await addMembers(
            tx,
            tenantId,
            item.jobId,
            { members: targetIds.map((id) => ({ id })), move: false },
            actor,
            context,
            { revealHooks: false },
          );
          items.push({
            kind: "endpoint",
            key: item.key,
            jobId: item.jobId,
            name: item.name,
            created: false,
            added: targetIds.length,
          });
        } else {
          const job = await createBackupJob(
            tx,
            tenantId,
            // Through the route's schema: the same defaults and limits as a job from the editor.
            createBackupJobSchema.parse({
              kind: "endpoint",
              name: item.name,
              schedule: item.schedule as JobSchedule,
              verifySchedule: null,
              scope: { mode: "selected", members: targetIds.map((id) => ({ id })) },
              storageTargetId: null,
              retentionPolicyId: null,
              settings: {
                paths: item.paths,
                excludes: machineJobDefaults(
                  [{ os: item.os ?? "linux", profile: item.profile ?? "server" }],
                  (item.schedule as JobSchedule).timeZone,
                ).excludes,
                bandwidthKbps: null,
                retention: { ...DEFAULT_ENDPOINT_RETENTION },
              },
              enabled: true,
              archive: false,
              moveMembers: false,
            }),
            actor,
            { ...context, recommended: item.key },
            { revealHooks: false },
          );
          items.push({
            kind: "endpoint",
            key: item.key,
            jobId: job.id,
            name: job.name,
            created: true,
            added: targetIds.length,
          });
        }
        continue;
      }
      // Proxmox VE: the job (once), then each guest into it.
      let jobId = item.jobId;
      if (!jobId) {
        const job = await saveJob(
          tx,
          tenantId,
          null,
          {
            name: item.name,
            scopeAll: false,
            schedule: item.schedule as PveJobSchedule,
            enabled: true,
            settings: { ...PVE_RECOMMENDED_SETTINGS },
          },
          actor,
          now,
          { recommended: true },
        );
        jobId = job.id;
      }
      let added = 0;
      for (const guestId of targetIds) {
        // The Restow server's own VM stays out unless an admin confirmed it (docs/PVE.md).
        const { assigned } = await assignJob(tx, tenantId, guestId, jobId, actor, {
          skipRestowServer: true,
        });
        added += assigned ? 1 : 0;
      }
      items.push({
        kind: "pve",
        key: "pve",
        jobId,
        name: item.name,
        created: item.jobId === null,
        added,
      });
    }
    if (items.length > 0) {
      await audit(tx, {
        tenantId,
        actor: actor.label,
        actorUserId: actor.userId,
        ip: actor.ip,
        action: BACKUP_JOB_AUDIT_ACTIONS.recommendedApplied,
        target: tenantId,
        targetType: "tenant",
        details: {
          everything: scope.everything,
          ...(scope.kinds && scope.kinds.length > 0 ? { kinds: scope.kinds } : {}),
          jobs: items,
          skipped: skipped.length,
        },
      });
    }
    return { items, skipped };
  });
}
