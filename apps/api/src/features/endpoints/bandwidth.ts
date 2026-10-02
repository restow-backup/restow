import {
  type BandwidthWindow,
  type BandwidthWindowIssue,
  MAX_BANDWIDTH_KBPS,
  MAX_BANDWIDTH_WINDOWS,
  bandwidthWindowIssues,
  normalizeBandwidthWindows,
} from "@restow/core";

/**
 * What is wrong with the time windows of an upload limit, as an API problem: where (the path of
 * the offending field in the request), a code the web app words in the viewer's language, and an
 * English sentence for everybody else. The rules themselves are @restow/core's
 * (backup-jobs/bandwidth.ts); a job, a member's own setting and a machine without a job all go
 * through this one place.
 */
export interface BandwidthWindowsProblem {
  readonly path: string[];
  readonly code: string;
  readonly message: string;
}

function problemOf(issue: BandwidthWindowIssue, base: readonly string[]): BandwidthWindowsProblem {
  const where = issue.index === null ? [...base] : [...base, String(issue.index), issue.field];
  switch (issue.code) {
    case "too_many":
      return {
        path: where,
        code: "bandwidth_windows_too_many",
        message: `At most ${MAX_BANDWIDTH_WINDOWS} time windows are possible.`,
      };
    case "days_required":
      return {
        path: where,
        code: "bandwidth_window_days_required",
        message: "Choose at least one day for the time window.",
      };
    case "days_invalid":
      return {
        path: where,
        code: "bandwidth_window_days_invalid",
        message: "Days are numbered from 1 (Monday) to 7 (Sunday).",
      };
    case "time_invalid":
      return {
        path: where,
        code: "bandwidth_window_time_invalid",
        message: "Use a time such as 08:00.",
      };
    case "kbps_invalid":
      return {
        path: where,
        code: "bandwidth_window_kbps_invalid",
        message: `The limit is a whole number of kbit/s from 0 (unlimited) to ${MAX_BANDWIDTH_KBPS}.`,
      };
    default:
      return {
        path: where,
        code: "bandwidth_window_overlap",
        message: `This time window overlaps window ${(issue.other ?? 0) + 1}. Windows must not overlap; let one end where the next begins.`,
      };
  }
}

/** The first problem of a list of windows, or null when it can be saved. `base` is the path of the list. */
export function bandwidthWindowsProblem(
  windows: readonly BandwidthWindow[],
  base: readonly string[],
): BandwidthWindowsProblem | null {
  const issue = bandwidthWindowIssues(windows)[0];
  return issue ? problemOf(issue, base) : null;
}

/**
 * The windows as they are stored: checked (a refusal is `fail(problem)`'s to throw) and in the
 * normal order, so a list that means the same as the stored one is the same list. An empty list
 * comes back as undefined unless `keepEmpty`: a job without windows stores none, while a member's
 * own setting states "no windows" explicitly next to its own limit.
 */
export function checkedBandwidthWindows(
  windows: readonly BandwidthWindow[] | undefined,
  base: readonly string[],
  fail: (problem: BandwidthWindowsProblem) => Error,
  options: { keepEmpty?: boolean } = {},
): BandwidthWindow[] | undefined {
  if (windows === undefined) {
    return undefined;
  }
  const problem = bandwidthWindowsProblem(windows, base);
  if (problem) {
    throw fail(problem);
  }
  if (windows.length === 0) {
    return options.keepEmpty ? [] : undefined;
  }
  return normalizeBandwidthWindows(windows);
}
