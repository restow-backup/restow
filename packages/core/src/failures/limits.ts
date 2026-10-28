/**
 * Runs that a service held back: Microsoft Graph throttled the app or was unavailable, or the
 * storage answered "slow down" (429, 503). Restow waited and retried inside the run and then
 * again with the job's retries; when that was not enough, the run ends without a backup, but
 * nothing about the object, the source or the configuration is wrong, and the next scheduled
 * run tries again. Such a run reads "held back by the service, retried" instead of failed: it
 * is left out of the failed counts (statistics, dashboard), does not end a warning's
 * acknowledgement or make a warning red, and raises no `backup.failed` alert. An object that
 * stays held back for longer is caught by the overdue and readiness rules, which look at the
 * age of the newest backup, not at single runs.
 */

/** The causes of a run a service held back (see the module comment). */
export const SERVICE_LIMIT_CAUSES = [
  "graph.throttled",
  "graph.service_unavailable",
  "storage.rate_limited",
] as const;

export type ServiceLimitCause = (typeof SERVICE_LIMIT_CAUSES)[number];

const LIMITS: ReadonlySet<string> = new Set(SERVICE_LIMIT_CAUSES);

/** True when a failure with this cause code means a service held the run back. */
export function isServiceLimitCause(code: string | null | undefined): code is ServiceLimitCause {
  return typeof code === "string" && LIMITS.has(code);
}

/** True for a failed run whose cause is a service limit. */
export function isServiceLimitedFailure(
  status: string,
  failure: { readonly code?: string | null } | null | undefined,
): boolean {
  return status === "failed" && isServiceLimitCause(failure?.code);
}
