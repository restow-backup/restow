import type { BackupJob } from "@restow/db";
import type { JobKindName } from "./dto.js";

/**
 * The job kinds this feature manages: mail jobs, machine jobs, file share jobs (`share`) and
 * scheduled copy jobs (`copy`, docs/FILESHARES.md 4.10, 7.5). A copy job has no members; its two
 * shares are columns of the job.
 */
export const SUPPORTED_JOB_KINDS: readonly JobKindName[] = ["mail", "endpoint", "share", "copy"];

export type SupportedJob = BackupJob & { kind: JobKindName };

export function isSupportedJob<T extends Pick<BackupJob, "kind">>(
  job: T,
): job is T & { kind: JobKindName } {
  return (SUPPORTED_JOB_KINDS as readonly string[]).includes(job.kind);
}

/** The jobs of the kinds this feature manages. */
export function supportedJobs<T extends Pick<BackupJob, "kind">>(
  jobs: readonly T[],
): (T & { kind: JobKindName })[] {
  return jobs.filter(isSupportedJob);
}

/** Narrow a job row to the kinds this feature manages (every kind of the database). */
export function assertSupportedJob<T extends Pick<BackupJob, "kind">>(
  job: T,
): asserts job is T & { kind: JobKindName } {
  if (!isSupportedJob(job)) {
    throw new Error(`unknown backup job kind ${String((job as Pick<BackupJob, "kind">).kind)}`);
  }
}

/** Kinds whose members are file shares, machines or protected objects (a copy job has none). */
export function hasMembers(kind: JobKindName): boolean {
  return kind !== "copy";
}
