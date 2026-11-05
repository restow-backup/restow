import { RUN_STATUS_META, type StatusMeta } from "@/components/kit";

import type { PveRun } from "./api.js";
import { bootTestMeta } from "./boot-test.js";

/**
 * The look of a run, from the status meta (RUN_STATUS_META, UI rework phase 1). Green only for
 * proof: a restore or a restore check that completed (the meta's `restored`). A backup that
 * completed is neutral, running work is informational and live, a backup vzdump warned about is
 * the amber of a partial run. A finished boot test is green only when the restored guest answered
 * (its outcome decides, in the look of a verification).
 */
export function runMeta(
  run: Pick<PveRun, "kind" | "status" | "stats">,
  options: { warnings?: boolean } = {},
): StatusMeta {
  if (run.status === "running") {
    return RUN_STATUS_META.running;
  }
  if (run.kind === "boot_test" && run.stats?.bootTest) {
    return bootTestMeta(run.stats.bootTest.outcome);
  }
  if (run.status === "failed") {
    return RUN_STATUS_META.failed;
  }
  if (run.status === "cancelled") {
    return RUN_STATUS_META.cancelled;
  }
  if (options.warnings) {
    return RUN_STATUS_META.partial;
  }
  return run.kind === "backup" ? RUN_STATUS_META.succeeded : RUN_STATUS_META.restored;
}

/** The label of a run's status; a finished boot test says how it ended. */
export function runStatusKey(run: Pick<PveRun, "kind" | "status" | "stats">): string {
  if (run.status !== "running" && run.kind === "boot_test" && run.stats?.bootTest) {
    return `guest.bootTestOutcome.${run.stats.bootTest.outcome}`;
  }
  return `guest.${run.status}`;
}
