import { endpointErrorKey } from "@/features/endpoints/presenters";
import type { FieldProblem } from "@/features/schedules/presenters";
import { ApiError } from "@/lib/api";

import { INVALID_JOB_PROBLEM, IN_OTHER_JOB_PROBLEM } from "./api.js";

/**
 * What the jobs API says when it refuses a request, in the shapes the forms
 * need: the field a 422 names (`field`, `issues[0].path`), the objects a 409
 * names that already belong to another job, and the text of every other
 * failure. A request is worded by its problem type and code, never by its title.
 */

export interface JobProblem {
  /** Path of the offending field in the request, e.g. `["schedule", "timeOfDay"]`. */
  path: string[];
  code: string;
  /** The server's own words (English): the last resort when no translation exists. */
  message: string;
}

/** The field a refused request names, or null when the failure is not about one field. */
export function jobProblemOf(error: unknown): JobProblem | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.problem) {
    return null;
  }
  const issues = error.problem.issues;
  const first = Array.isArray(issues)
    ? (issues[0] as Record<string, unknown> | undefined)
    : undefined;
  const rawPath = first && Array.isArray(first.path) ? first.path : null;
  const field = typeof error.problem.field === "string" ? error.problem.field : null;
  const path = rawPath ? rawPath.map(String) : field ? [field] : null;
  if (!path || path.length === 0) {
    return null;
  }
  const code =
    typeof first?.code === "string"
      ? first.code
      : typeof error.problem.code === "string"
        ? error.problem.code
        : "invalid";
  const message =
    typeof first?.message === "string" ? first.message : (error.problem.detail ?? error.message);
  return { path, code, message };
}

/** The editor field a path of the request belongs to. */
export type ProblemTarget =
  | "name"
  | "schedule"
  | "verifySchedule"
  | "scope"
  | "paths"
  | "excludes"
  | "larger"
  | "bandwidth"
  | "bandwidthWindows"
  | "hooks"
  | "retention"
  | "retentionPolicy"
  | "general";

export function problemTarget(path: readonly string[]): ProblemTarget {
  const [first, second] = path;
  switch (first) {
    case "name":
      return "name";
    case "schedule":
      return "schedule";
    case "verifySchedule":
      return "verifySchedule";
    case "scope":
      return "scope";
    case "retentionPolicyId":
      return "retentionPolicy";
    case "settings":
      switch (second) {
        case "paths":
          return "paths";
        case "excludes":
          return "excludes";
        case "excludeLargerThanGib":
          return "larger";
        case "bandwidthKbps":
          return "bandwidth";
        case "bandwidthWindows":
          return "bandwidthWindows";
        case "hooks":
          return "hooks";
        case "retention":
          return "retention";
        default:
          return "general";
      }
    default:
      return "general";
  }
}

/** The codes the schedules page words (apps/api core `validateCadence`), reused for a job's cadence. */
const CADENCE_CODES = new Set([
  "cadence_missing",
  "cadence_ambiguous",
  "interval_not_integer",
  "interval_out_of_range",
  "cron_invalid",
  "cron_never_matches",
  "cron_too_frequent",
  "timezone_unknown",
]);

/**
 * A refused schedule as the cadence fields show it: `field` is the part of the
 * schedule (`cron`, `intervalMinutes`, `timeZone`, ...), `key` the text in the
 * schedules namespace.
 */
export function cadenceProblemOf(
  problem: JobProblem | null,
  which: "schedule" | "verifySchedule",
): FieldProblem | null {
  if (!problem || problem.path[0] !== which) {
    return null;
  }
  return {
    field: problem.path[1] ?? "cadence",
    key: CADENCE_CODES.has(problem.code) ? `problems.${problem.code}` : "problems.generic",
  };
}

export interface MemberConflict {
  targetId: string;
  jobId: string;
  jobName: string;
}

/** The objects or machines a refused request could not take because another job has them. */
export function conflictsOf(error: unknown): MemberConflict[] | null {
  if (
    !(error instanceof ApiError) ||
    error.status !== 409 ||
    error.problem?.type !== IN_OTHER_JOB_PROBLEM
  ) {
    return null;
  }
  const raw = error.problem.conflicts;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry): MemberConflict[] => {
    const item = entry as Record<string, unknown>;
    return typeof item.targetId === "string" &&
      typeof item.jobId === "string" &&
      typeof item.jobName === "string"
      ? [{ targetId: item.targetId, jobId: item.jobId, jobName: item.jobName }]
      : [];
  });
}

/** A machine job cannot be paused: the agent decides when to back up. */
export function isPauseNotSupported(error: unknown): boolean {
  return jobProblemOf(error)?.code === "pause_not_supported";
}

/** Whether the request was refused as an invalid job (422 of the jobs API). */
export function isInvalidJob(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 422 &&
    (error.problem?.type === INVALID_JOB_PROBLEM || jobProblemOf(error) !== null)
  );
}

/**
 * The fully qualified i18n key that words a failed request that is not about
 * one field: the jobs' own problems, the machine problems (hooks), the recent
 * sign-in, else the general message of the app.
 */
export function jobErrorKey(error: unknown): string {
  if (error instanceof ApiError) {
    if (conflictsOf(error) !== null) {
      return "backupjobs:errors.inOtherJob";
    }
    if (isPauseNotSupported(error)) {
      return "backupjobs:errors.pauseNotSupported";
    }
    if (error.problem?.type === "urn:restow:problem:backup-job-state") {
      return error.problem.code === "all_job_exists"
        ? "backupjobs:errors.allJobExists"
        : "backupjobs:errors.state";
    }
    if (isInvalidJob(error)) {
      return "backupjobs:errors.invalid";
    }
  }
  return endpointErrorKey(error);
}
