import { describe, expect, it } from "vitest";

import type { PveRun } from "./api";
import { restoreFindings, runStatusKey, runStatusLabel, runTone } from "./run-status";

type Run = Pick<PveRun, "kind" | "status" | "stats"> & Partial<Pick<PveRun, "warnings">>;
const run = (over: Partial<Run>): Run => ({ kind: "restore", status: "succeeded", ...over });

describe("runTone: green only for proof", () => {
  it("a failed restore or restore check is red, never green", () => {
    for (const kind of ["restore", "restore_test"] as const) {
      expect(runTone(run({ kind, status: "failed" }))).toBe("destructive");
      expect(runStatusKey(run({ kind, status: "failed" }))).toBe("guest.failed");
    }
  });

  it("a cancelled restore or restore check is muted", () => {
    for (const kind of ["restore", "restore_test"] as const) {
      expect(runTone(run({ kind, status: "cancelled" }))).toBe("muted");
    }
  });

  it("a restore or restore check that completed is green; a backup stays neutral", () => {
    expect(runTone(run({ kind: "restore" }))).toBe("success");
    expect(runTone(run({ kind: "restore_test" }))).toBe("success");
    expect(runTone(run({ kind: "backup" }))).toBe("outline");
  });

  it("running work is informational", () => {
    expect(runTone(run({ status: "running" }))).toBe("info");
  });

  it("a boot test is green only with its outcome; one closed without a result never is", () => {
    expect(runTone(run({ kind: "boot_test", status: "succeeded" }))).toBe("muted");
    expect(
      runTone(
        run({
          kind: "boot_test",
          status: "failed",
          stats: { bootTest: { outcome: "error" } as never },
        }),
      ),
    ).toBe("muted");
    expect(
      runTone(run({ kind: "boot_test", stats: { bootTest: { outcome: "green" } as never } })),
    ).toBe("success");
  });

  it("a restore or restore check that reported anything beside its success is amber, never green", () => {
    const cases: [Partial<NonNullable<Run["stats"]>>, string][] = [
      [{ warnings: ["WARN: something"] }, "warnings"],
      [{ skippedLxc: ["lxc.cgroup2.devices.allow: c 226:* rwm"] }, "skippedLxc"],
      [{ omittedMounts: ["mp0: /srv/share,mp=/data"] }, "omittedMounts"],
      [{ keptDevices: ["hostpci0: 0000:01:00.0"] }, "keptDevices"],
      [{ startError: "start failed: no such bridge" }, "notStarted"],
      [{ started: false, startSkipped: "omitted_mounts" }, "notStarted"],
    ];
    for (const kind of ["restore", "restore_test"] as const) {
      for (const [stats, finding] of cases) {
        const r = run({ kind, stats });
        expect(runTone(r), `${kind} ${finding}`).toBe("warning");
        expect(restoreFindings(r)).toContain(finding);
        expect(runStatusKey(r)).not.toBe("guest.succeeded");
      }
    }
    // A check whose temporary guest is still there.
    const leftover = run({ kind: "restore_test", stats: { deleted: false, leftoverVmid: 105 } });
    expect(runTone(leftover)).toBe("warning");
    expect(runStatusLabel(leftover)).toEqual({
      key: "guest.restoreFinding.leftover",
      values: { vmid: 105 },
    });
    // The labels say what it was.
    expect(
      runStatusLabel(run({ kind: "restore_test", stats: { omittedMounts: ["mp0: /a,mp=/a"] } })),
    ).toEqual({ key: "guest.restoreFinding.checkedWithoutMounts", values: { count: 1 } });
    expect(runStatusKey(run({ kind: "restore", stats: { warnings: ["x"] } }))).toBe(
      "guest.restoreFinding.restoredWithWarnings",
    );
    expect(runStatusKey(run({ kind: "restore", stats: { startError: "x" } }))).toBe(
      "guest.restoreFinding.notStarted",
    );
  });

  it("green only when nothing applies; informational facts keep it green", () => {
    const clean = run({
      kind: "restore_test",
      stats: { deleted: true, warnings: [], omittedMounts: [], started: true, onbootCleared: true },
    });
    expect(restoreFindings(clean)).toEqual([]);
    expect(runTone(clean)).toBe("success");
    expect(runStatusKey(clean)).toBe("guest.succeeded");
    // A failed one stays red whatever it reported.
    expect(runTone(run({ status: "failed", stats: { warnings: ["x"] } }))).toBe("destructive");
  });

  it("a backup with vzdump's warnings is amber, without them neutral", () => {
    expect(runTone(run({ kind: "backup", warnings: ["WARN: x"] }))).toBe("warning");
    expect(runStatusKey(run({ kind: "backup", warnings: ["WARN: x"] }))).toBe(
      "guests.succeededWithWarnings",
    );
  });

  it("a restore check the node skipped is not checked: muted, never red or green", () => {
    const skipped = run({
      kind: "restore_test",
      status: "failed",
      stats: { skipped: { reason: "storage_content", message: "no rootdir" } },
    });
    expect(runTone(skipped)).toBe("muted");
    expect(runStatusLabel(skipped)).toEqual({
      key: "guest.restoreCheckSkipped",
      values: { reason: "storage_content" },
    });
  });
});
