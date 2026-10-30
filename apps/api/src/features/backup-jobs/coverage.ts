import { mailJobObjectIds, mailObjectsInNoJob } from "@restow/core";
import { type BackupJob, type BackupJobMember, backupJobs } from "@restow/db";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "../../lib/tenant-context.js";
import { loadAllMembers, loadObjectInfos, type ObjectInfo } from "./loaders.js";

/**
 * Which backup job backs up which mail object, and whether on a schedule. An object that may be
 * backed up (eligible) is protected only when a job covers it AND that job runs on a schedule:
 * a paused job, or one that runs by hand only, backs up nothing on its own. The directory and
 * the jobs list both say so from here.
 */

/** The job that covers an object. */
export interface ObjectJobLink {
  id: string;
  name: string;
  /** The job is on and has a schedule (its own, or one the member sets for itself). */
  scheduled: boolean;
}

/** How an object stands towards the jobs: in a scheduled job, in one that does not run, in none. */
export type ObjectCoverage = "scheduled" | "unscheduled" | "none";

type MemberRow = Pick<BackupJobMember, "jobId" | "protectedObjectId" | "overrides">;

/** Whether a job backs up one of its members on its own (see {@link ObjectJobLink.scheduled}). */
export function runsOnSchedule(
  job: Pick<BackupJob, "enabled" | "schedule">,
  member: Pick<BackupJobMember, "overrides"> | undefined,
): boolean {
  return job.enabled && (job.schedule !== null || Boolean(member?.overrides?.schedule));
}

/**
 * Per covered mail object, its job. An object covered by several jobs (two `all` jobs of
 * different releases) gets a scheduled one when there is one.
 */
export function mailCoverageOf(
  jobs: readonly Pick<BackupJob, "id" | "name" | "kind" | "enabled" | "schedule" | "scopeMode">[],
  members: readonly MemberRow[],
  objects: readonly Pick<ObjectInfo, "id" | "eligible">[],
): Map<string, ObjectJobLink> {
  const mailMembers = members.filter(
    (member) => member.protectedObjectId !== null,
  ) as (MemberRow & {
    protectedObjectId: string;
  })[];
  const memberOf = new Map(
    mailMembers.map((member) => [`${member.jobId}:${member.protectedObjectId}`, member]),
  );
  const result = new Map<string, ObjectJobLink>();
  for (const job of jobs) {
    if (job.kind !== "mail") continue;
    for (const objectId of mailJobObjectIds(job, mailMembers, objects)) {
      const scheduled = runsOnSchedule(job, memberOf.get(`${job.id}:${objectId}`));
      const known = result.get(objectId);
      if (!known || (!known.scheduled && scheduled)) {
        result.set(objectId, { id: job.id, name: job.name, scheduled });
      }
    }
  }
  return result;
}

/** How one object stands; null for an object that may not be backed up at all (not eligible). */
export function coverageOf(
  object: Pick<ObjectInfo, "id" | "eligible">,
  links: ReadonlyMap<string, ObjectJobLink>,
): ObjectCoverage | null {
  if (!object.eligible) {
    return null;
  }
  const link = links.get(object.id);
  return link ? (link.scheduled ? "scheduled" : "unscheduled") : "none";
}

/**
 * The tenant's mail objects with the job of each, and the ones in no backup job: eligible and
 * covered by no ENABLED mail job (@restow/core `mailObjectsInNoJob`, the one rule of the
 * readiness overview, the directory, the dashboard, the integration API and the provider view).
 * A job that is paused or runs by hand only still counts as a job there when it is enabled; a
 * disabled one does not. Inside the caller's transaction.
 */
export async function loadMailCoverage(
  tx: Transaction,
  tenantId: string,
): Promise<{
  objects: ObjectInfo[];
  links: Map<string, ObjectJobLink>;
  withoutJob: Set<string>;
}> {
  const jobs = await tx
    .select()
    .from(backupJobs)
    .where(and(eq(backupJobs.tenantId, tenantId), eq(backupJobs.kind, "mail")));
  const objects = await loadObjectInfos(tx, tenantId);
  if (jobs.length === 0) {
    return {
      objects,
      links: new Map(),
      withoutJob: new Set(objects.filter((object) => object.eligible).map((o) => o.id)),
    };
  }
  const members = await loadAllMembers(tx, tenantId);
  return {
    objects,
    links: mailCoverageOf(jobs, members, objects),
    withoutJob: mailObjectsInNoJob(
      jobs,
      members.flatMap((member) =>
        member.protectedObjectId === null
          ? []
          : [{ jobId: member.jobId, protectedObjectId: member.protectedObjectId }],
      ),
      objects,
    ),
  };
}

/** The mail objects in no backup job (see {@link loadMailCoverage}). */
export async function loadMailWithoutJob(tx: Transaction, tenantId: string): Promise<Set<string>> {
  return (await loadMailCoverage(tx, tenantId)).withoutJob;
}
