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
 *
 * The file system snapshot (Windows: shadow copy, VSS; the same codes serve LVM, btrfs and
 * APFS, docs/AGENT.md):
 *
 *   snapshot_failed          the snapshot of one volume (`path`) failed; under the policy
 *                            `continue` that volume was read live and the run is partial,
 *                            under `fail` the backup was stopped.
 *   snapshot_unavailable     no snapshot could be taken at all (service, rights); under
 *                            `continue` the backup ran without one.
 *   snapshot_cleanup_failed  a snapshot was not deleted after the run: a note, not a
 *                            reason for `partial`, and never the explanation of a run.
 *
 * A whole machine backup (docs/BAREMETAL.md 5.6):
 *
 *   layout_capture_failed    the disk layout could not be recorded; the machine's mount points
 *                            were backed up anyway and the run is partial.
 *   layout_too_large         the layout is larger than the server takes (512 KiB): it is in the
 *                            snapshot, but not on the server. Partial, never the explanation.
 *   layout_rejected          set by the server when it refuses the layout the agent sent: a hint
 *                            that leaves the status alone and is never the explanation.
 *
 * A machine for which no snapshot method exists (a partition, a full volume group) is no error at
 * all: its file systems are listed in the run's consistency report as read live.
 *
 * Backup paths that exist but cannot be backed up as configured (agent 0.5.0); each makes the
 * run partial, failed when no path is left:
 *
 *   source_unreadable      the path (`path`) cannot be read: a drive locked by BitLocker,
 *                          offline or not ready, no access, a link of a kind restic does not
 *                          follow, too many junctions; or restic backed up no file from a
 *                          linked folder that holds files.
 *   source_is_mount_point  the path is a folder a volume without a drive letter is mounted at;
 *                          restic would back up only the mount point.
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
  "snapshot_failed",
  "snapshot_unavailable",
  "snapshot_cleanup_failed",
  "layout_capture_failed",
  "layout_too_large",
  "layout_rejected",
  "source_unreadable",
  "source_is_mount_point",
] as const;

/** A note about a snapshot left behind: never the explanation of a run. */
export const SNAPSHOT_CLEANUP_RUN_CODE = "snapshot_cleanup_failed";

/** The server refused the layout the agent sent: a hint on the run (docs/BAREMETAL.md 4.3). */
export const LAYOUT_REJECTED_RUN_CODE = "layout_rejected";

/** Codes that are notes beside the outcome of a run and never its explanation. */
export const NOTE_RUN_CODES: ReadonlySet<string> = new Set([
  SNAPSHOT_CLEANUP_RUN_CODE,
  LAYOUT_REJECTED_RUN_CODE,
  "layout_too_large",
]);

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
