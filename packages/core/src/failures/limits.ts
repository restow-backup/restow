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

/**
 * Runs that ended without a backup because the mailbox's account is disabled or has no
 * Exchange Online licence (docs/MICROSOFT.md "Deaktivierte und unlizenzierte Konten"): the backup
 * found Microsoft answering "no mailbox" for a user who is still in the directory
 * (`graph.mailbox_inactive`), Microsoft locked the OneDrive or site (HTTP 423 resourceLocked,
 * `graph.object_locked`; it does so for the OneDrive of an unlicensed account; neutral only once
 * a probe confirmed it, worker backup.ts turns an unconfirmed lock into a counted
 * `graph.request_rejected`), or the object was
 * already marked so and the run was turned away (`config.object_inactive`). Nothing is broken and nothing is held back: the object is not
 * backed up until the account is enabled or licensed again, and its backups are kept. Such a
 * run counts neither as failed nor as held back, ends no warning acknowledgement and raises no
 * `backup.failed` alert or `job.failed` webhook; the UI shows it neutral ("not backed up").
 * Kept apart from {@link SERVICE_LIMIT_CAUSES}, which read amber "held back, retried".
 */
export const NOT_BACKED_UP_CAUSES = [
  "graph.mailbox_inactive",
  "graph.object_locked",
  "config.object_inactive",
] as const;

export type NotBackedUpCause = (typeof NOT_BACKED_UP_CAUSES)[number];

const NOT_BACKED_UP: ReadonlySet<string> = new Set(NOT_BACKED_UP_CAUSES);

/** True when a failure with this cause code means the object is inactive at the source. */
export function isNotBackedUpCause(code: string | null | undefined): code is NotBackedUpCause {
  return typeof code === "string" && NOT_BACKED_UP.has(code);
}

/** True for a failed run that ended because the object is inactive at the source. */
export function isNotBackedUpFailure(
  status: string,
  failure: { readonly code?: string | null } | null | undefined,
): boolean {
  return status === "failed" && isNotBackedUpCause(failure?.code);
}

/** Why an object is not backed up while still at the source (`protected_objects.status_reason`). */
export type NotBackedUpReason = "account_disabled" | "no_license" | "locked";

/**
 * Why such a run did not back up (`account_disabled`, `no_license`, `locked`), from its failure
 * code and parameters; null for any other run. An unknown or missing reason reads `no_license`.
 */
export function notBackedUpReason(
  status: string,
  failure:
    | { readonly code?: string | null; readonly params?: Record<string, unknown> | null }
    | null
    | undefined,
): NotBackedUpReason | null {
  if (!isNotBackedUpFailure(status, failure)) {
    return null;
  }
  const reason = failure?.params?.reason;
  if (failure?.code === "graph.object_locked" || reason === "locked") {
    return "locked";
  }
  return reason === "account_disabled" ? "account_disabled" : "no_license";
}
