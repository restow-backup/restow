/**
 * Why a restore check could not run, as the suffix of its translation keys (namespace `pve`):
 * `guest.verifyNotChecked…`, `guest.verifyPostponed…` and `readiness.result.notChecked…`.
 * `error` (the check could not start) comes from servers from 0.5.0.
 */
export function notCheckedSuffix(reason: string | undefined): "Locked" | "Interrupted" | "Error" {
  return reason === "locked" ? "Locked" : reason === "error" ? "Error" : "Interrupted";
}
