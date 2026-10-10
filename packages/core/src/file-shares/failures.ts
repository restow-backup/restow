/**
 * From the runner's codes to failure explanations (docs/FILESHARES.md section 11), the way
 * `classifyRunError` and `failureOfRun` work for agent runs (../endpoints/run-failures.ts): a
 * run's cause is its finish code (or the mounter's code when it never started), and the per-file
 * items are grouped by code into the warning causes. The texts live in packages/i18n
 * (`failures:cause.share.*`).
 */
import { redactSensitiveText } from "../failures/redact.js";
import type {
  FailureCause,
  FailureCode,
  FailureParams,
  FailureTechnical,
} from "../failures/types.js";
import { shareCauseOf } from "./runner.js";

/** Causes waiting can fix: the run is tried again on the next schedule. */
const TRANSIENT = new Set<FailureCode>([
  "share.unreachable",
  "share.repository_locked",
  "share.mounter_unavailable",
  "share.runner_failed",
  "share.runner_lost",
  "share.runner_stalled",
]);

/** A share cause with its parameters and the redacted technical detail. */
export function shareCause(
  code: FailureCode,
  options: {
    params?: FailureParams;
    detail?: string | null;
    runnerCode?: string | null;
    exitCode?: number | null;
    extraSecrets?: readonly string[];
  } = {},
): FailureCause {
  const technical: FailureTechnical = {};
  if (options.runnerCode) {
    technical.code = options.runnerCode.slice(0, 80);
  }
  if (typeof options.exitCode === "number") {
    technical.exitCode = options.exitCode;
  }
  if (options.detail) {
    let detail = options.detail;
    for (const secret of options.extraSecrets ?? []) {
      if (secret && secret.length >= 4) {
        detail = detail.split(secret).join("***");
      }
    }
    technical.message = redactSensitiveText(detail).slice(0, 500);
  }
  return { code, transient: TRANSIENT.has(code), params: options.params ?? {}, technical };
}

/**
 * The cause of a runner or mounter code (3.6, 4.8), with `reason: expired` for an expired
 * password and the path for a missing include folder.
 */
export function shareCauseOfCode(
  code: string,
  detail: string | null = null,
  extraSecrets: readonly string[] = [],
): FailureCause {
  const mapped = shareCauseOf(code, detail);
  const params: FailureParams = { ...mapped.params };
  if (mapped.cause === "share.include_missing" && detail) {
    const match = /include folder ([^\s"]+|"[^"]+")/.exec(detail);
    if (match?.[1]) {
      params.path = match[1].replace(/^"|"$/g, "").slice(0, 300);
    }
  }
  return shareCause(mapped.cause as FailureCode, {
    params,
    detail,
    runnerCode: code,
    extraSecrets,
  });
}

/** The per-file item codes of the runner (4.8) and the warning cause each one counts towards. */
export const SHARE_ITEM_CAUSES: Readonly<Record<string, FailureCode>> = {
  locked_file: "share.locked_files",
  read_error: "share.read_errors",
  acl_unreadable: "share.acl_partial",
  acl_not_restored: "share.acl_partial",
  acl_format_newer: "share.acl_partial",
  owner_not_restored: "share.acl_partial",
  offline_skipped: "share.offline_skipped",
  name_invalid: "share.restore_partial",
  write_error: "share.restore_partial",
  files_dropped: "share.files_dropped",
};

/** Item causes that are information only and never make a run end "with warnings". */
const INFO_CAUSES = new Set<FailureCode>(["share.offline_skipped"]);

/**
 * The warning causes of a run's items, by count (largest first): what "with warnings" means for
 * this run. Offline files skipped as configured are left out.
 */
export function shareWarningCauses(
  items: Readonly<Record<string, number>> | null | undefined,
): { code: FailureCode; count: number }[] {
  const counts = new Map<FailureCode, number>();
  for (const [item, count] of Object.entries(items ?? {})) {
    if (!(typeof count === "number" && count > 0)) {
      continue;
    }
    const cause = SHARE_ITEM_CAUSES[item] ?? "share.read_errors";
    if (INFO_CAUSES.has(cause)) {
      continue;
    }
    counts.set(cause, (counts.get(cause) ?? 0) + count);
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export interface ShareFinishFacts {
  status: "succeeded" | "warning" | "failed" | "cancelled";
  code?: string | null;
  message?: string | null;
  items?: Readonly<Record<string, number>> | null;
}

/**
 * The cause stored on a finished run: the finish code for a failed run, the largest warning
 * cause for a run with warnings, none for a success or a cancellation.
 */
export function shareRunCause(
  finish: ShareFinishFacts,
  extraSecrets: readonly string[] = [],
): FailureCause | null {
  if (finish.status === "failed") {
    return shareCauseOfCode(finish.code || "internal", finish.message ?? null, extraSecrets);
  }
  if (finish.status === "warning") {
    const [first] = shareWarningCauses(finish.items);
    return first
      ? shareCause(first.code, { params: { count: first.count } })
      : shareCause("share.read_errors");
  }
  return null;
}
