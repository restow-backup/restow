/**
 * The error codes the agent puts on a run (`errors[].code`, docs/AGENT.md).
 * The server keeps the codes as they come (a newer agent may send more), the
 * web app words the ones it knows (`endpoints:runErrors.<code>`), and one of
 * them changes what the server does:
 *
 *   interrupted   the agent was restarted while the run was going (an update,
 *                 a reboot, a stopped service) and resumes by itself. It is
 *                 not a failed backup: no alert, no `job.failed` webhook, no
 *                 "last backup failed" on the machine.
 */
export const ENDPOINT_RUN_ERROR_CODES = [
  "interrupted",
  "no_paths",
  "pre_hook_failed",
  "post_hook_failed",
  "hooks_not_allowed",
  "timeout",
  "target_not_empty",
  "invalid_task",
  "hash_mismatch",
  "missing",
  "not_regular",
  "read_error",
  "agent_stopped",
] as const;

export const INTERRUPTED_RUN_CODE = "interrupted";

/** `restic_exit_<n>`: restic ended with a non-zero exit code `n`. */
export function resticExitCodeOf(code: string | undefined): number | null {
  const match = /^restic_exit_(\d{1,3})$/.exec(code ?? "");
  return match ? Number(match[1]) : null;
}

/** A run that only says it was interrupted: the agent picks the work up again. */
export function isInterruptedOnly(errors: readonly { code?: string | null }[]): boolean {
  return errors.length > 0 && errors.every((error) => error.code === INTERRUPTED_RUN_CODE);
}
