import type { PveRun } from "./api.js";
import { bootTestVariant } from "./boot-test.js";

type RunFacts = Pick<PveRun, "kind" | "status" | "stats"> & Partial<Pick<PveRun, "warnings">>;

/**
 * What a restore or restore check that succeeded reported beside it (docs/PVE-PROTOCOL.md,
 * "Task `restore`"), most serious first. Any of it keeps the run from green: the restore ran,
 * but it did not prove all it should, or it left something to do.
 */
export type RestoreFinding =
  | "leftover"
  | "notStarted"
  | "omittedMounts"
  | "warnings"
  | "skippedLxc"
  | "keptDevices";

export function restoreFindings(run: RunFacts): RestoreFinding[] {
  if (run.status !== "succeeded" || (run.kind !== "restore" && run.kind !== "restore_test")) {
    return [];
  }
  const stats = run.stats ?? {};
  const out: RestoreFinding[] = [];
  if (run.kind === "restore_test" && stats.deleted === false) {
    out.push("leftover");
  }
  if (stats.started === false || stats.startError || stats.startSkipped) {
    out.push("notStarted");
  }
  if ((stats.omittedMounts ?? []).length > 0) {
    out.push("omittedMounts");
  }
  if ((stats.warnings ?? []).length > 0 || (run.warnings ?? []).length > 0) {
    out.push("warnings");
  }
  if ((stats.skippedLxc ?? []).length > 0) {
    out.push("skippedLxc");
  }
  if ((stats.keptDevices ?? []).length > 0) {
    out.push("keptDevices");
  }
  return out;
}

/**
 * Green only for proof: a restore or a restore check that completed and reported nothing
 * beside it. One with warnings, mount points left out, a temporary guest it could not remove
 * or a start that did not happen is amber. A backup that completed is neutral (amber with
 * vzdump's warnings), running work is informational. A boot test is green only when the
 * restored guest answered (its outcome decides).
 */
export function runTone(
  run: RunFacts,
): "success" | "outline" | "destructive" | "info" | "warning" | "muted" {
  if (run.status === "running") {
    return "info";
  }
  if (run.kind === "boot_test") {
    // Without an outcome nothing was proven (a run an older server closed as stale).
    return run.stats?.bootTest
      ? bootTestVariant(run.stats.bootTest.outcome)
      : run.status === "failed"
        ? "destructive"
        : "muted";
  }
  if (run.status === "failed") {
    // A restore check the node did not run (its storage, restores off) says nothing about the
    // restore point: not checked, neither red nor green.
    return run.kind === "restore_test" && run.stats?.skipped ? "muted" : "destructive";
  }
  if (run.status === "cancelled") {
    return "muted";
  }
  if (run.kind === "backup") {
    return (run.warnings ?? run.stats?.warnings ?? []).length > 0 ? "warning" : "outline";
  }
  return restoreFindings(run).length > 0 ? "warning" : "success";
}

/** The label of a run's status (an i18n key of the pve namespace and its values). */
export function runStatusLabel(run: RunFacts): { key: string; values?: Record<string, unknown> } {
  if (run.status !== "running" && run.kind === "boot_test" && run.stats?.bootTest) {
    return { key: `guest.bootTestOutcome.${run.stats.bootTest.outcome}` };
  }
  if (
    run.status === "succeeded" &&
    run.kind === "backup" &&
    (run.warnings ?? run.stats?.warnings ?? []).length > 0
  ) {
    return { key: "guests.succeededWithWarnings" };
  }
  if (run.status === "failed" && run.kind === "restore_test" && run.stats?.skipped) {
    return { key: "guest.restoreCheckSkipped", values: { reason: run.stats.skipped.reason } };
  }
  const [first] = restoreFindings(run);
  if (first) {
    const check = run.kind === "restore_test";
    const stats = run.stats ?? {};
    switch (first) {
      case "leftover":
        return {
          key: "guest.restoreFinding.leftover",
          values: { vmid: stats.leftoverVmid ?? stats.vmid ?? "?" },
        };
      case "notStarted":
        return { key: "guest.restoreFinding.notStarted" };
      case "omittedMounts":
        return {
          key: check
            ? "guest.restoreFinding.checkedWithoutMounts"
            : "guest.restoreFinding.restoredWithoutMounts",
          values: { count: stats.omittedMounts?.length ?? 0 },
        };
      default:
        return {
          key: check
            ? "guest.restoreFinding.checkedWithWarnings"
            : "guest.restoreFinding.restoredWithWarnings",
        };
    }
  }
  return { key: `guest.${run.status}` };
}

/** The label key of a run's status; a finished boot test says how it ended. */
export function runStatusKey(run: RunFacts): string {
  return runStatusLabel(run).key;
}
