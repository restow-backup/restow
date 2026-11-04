import type { PveRun } from "./api.js";
import { bootTestVariant } from "./boot-test.js";

/**
 * Green only for proof: a restore or a restore check that completed. A
 * backup that completed is neutral, running work is informational. A boot
 * test is green only when the restored guest answered (its outcome decides).
 */
export function runTone(
  run: Pick<PveRun, "kind" | "status" | "stats">,
): "success" | "outline" | "destructive" | "info" | "warning" | "muted" {
  if (run.status === "running") {
    return "info";
  }
  if (run.kind === "boot_test" && run.stats?.bootTest) {
    return bootTestVariant(run.stats.bootTest.outcome);
  }
  if (run.status === "failed") {
    return "destructive";
  }
  if (run.status === "cancelled") {
    return "muted";
  }
  return run.kind === "backup" ? "outline" : "success";
}

/** The label of a run's status; a finished boot test says how it ended. */
export function runStatusKey(run: Pick<PveRun, "kind" | "status" | "stats">): string {
  if (run.status !== "running" && run.kind === "boot_test" && run.stats?.bootTest) {
    return `guest.bootTestOutcome.${run.stats.bootTest.outcome}`;
  }
  return `guest.${run.status}`;
}
