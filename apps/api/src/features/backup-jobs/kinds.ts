import type { BackupJob } from "@restow/db";
import { ProblemError } from "../../problem.js";
import type { JobKindName } from "./dto.js";

/**
 * The job kinds this feature manages. File share jobs (`share`) and scheduled copy jobs (`copy`)
 * exist in the database since the file share release (docs/FILESHARES.md 7.2); the scheduler and
 * the worker run them, but creating and changing them through these routes comes with the file
 * share routes (Phase C, docs/FILESHARES.md section 17). Until then they are left out of every
 * list here, and a route that names one answers {@link UNSUPPORTED_JOB_KIND_PROBLEM}.
 */
export const SUPPORTED_JOB_KINDS: readonly JobKindName[] = ["mail", "endpoint"];

export const UNSUPPORTED_JOB_KIND_PROBLEM = "urn:restow:problem:backup-job-kind-unsupported";

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

/** Refuse a job of a kind this feature does not manage yet (409). */
export function assertSupportedJob<T extends Pick<BackupJob, "kind">>(
  job: T,
): asserts job is T & { kind: JobKindName } {
  if (!isSupportedJob(job)) {
    throw new ProblemError(409, "Job kind not supported here yet", {
      type: UNSUPPORTED_JOB_KIND_PROBLEM,
      detail: `This is a ${job.kind === "copy" ? "file share copy" : "file share"} job. This version manages file share jobs on the file share pages, not through the backup job routes.`,
      extensions: { kind: job.kind },
    });
  }
}
