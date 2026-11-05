import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOOT_TEST_WEEKLY_MS,
  DEFAULT_BOOT_TEST_MAX_MEMORY_MIB,
  DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
  MAX_BOOT_TEST_TIMEOUT_SECONDS,
  PVE_BOOT_TEST_CAPABILITY,
  PVE_BOOT_TEST_REASON_OUTCOMES,
  PVE_BOOT_TEST_TRANSIENT_REASONS,
  pveBootTestDue,
  pveBootTestOutcomeOf,
  pveBootTestOverdueMs,
  pveBootTestPlan,
  pveBootTestRating,
  pveBootTestRetry,
  pveBootTestTaskParams,
  pveBootTestTransient,
  pveNodeDeclares,
  pveRestoreCheckBlocker,
  pveRestoreCheckSkipRetryMs,
  pveRestorePointPrivileged,
  pveRestorePointRating,
} from "./boot-test.js";

// Relative to a fixed instant: nothing here reads the clock.
const NOW = new Date(Date.UTC(2030, 0, 15, 12));
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const iso = (ms: number) => ago(ms).toISOString();

describe("the boot test setting of a job", () => {
  it("is off unless the job turned it on, with the default limits", () => {
    expect(pveBootTestPlan(undefined)).toEqual({
      schedule: "off",
      maxMemoryMiB: DEFAULT_BOOT_TEST_MAX_MEMORY_MIB,
      timeoutSeconds: DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
    });
    expect(pveBootTestPlan({ schedule: "weekly" }).schedule).toBe("weekly");
    expect(pveBootTestPlan({ schedule: "after_backup" }).schedule).toBe("after_backup");
  });

  it("keeps the limits within their bounds", () => {
    expect(pveBootTestPlan({ schedule: "weekly", timeoutSeconds: 10 }).timeoutSeconds).toBe(60);
    expect(pveBootTestPlan({ schedule: "weekly", timeoutSeconds: 1e9 }).timeoutSeconds).toBe(
      MAX_BOOT_TEST_TIMEOUT_SECONDS,
    );
    expect(pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 4096 }).maxMemoryMiB).toBe(4096);
    expect(pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 1 }).maxMemoryMiB).toBe(256);
  });
});

describe("which node may run a boot test", () => {
  it("only one that announced the capability; an older node announces nothing", () => {
    expect(pveNodeDeclares({ capabilities: ["boot_test"] }, PVE_BOOT_TEST_CAPABILITY)).toBe(true);
    expect(pveNodeDeclares({ capabilities: [] }, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
    expect(pveNodeDeclares({}, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
    expect(pveNodeDeclares(null, PVE_BOOT_TEST_CAPABILITY)).toBe(false);
  });
});

describe("when a boot test is due", () => {
  const newest = { backupAt: ago(60_000), tested: false };

  it("never while the job has it off, or without a restore point", () => {
    expect(pveBootTestDue({ schedule: "off", lastBootTestAt: null, newest }, NOW)).toBe(false);
    expect(pveBootTestDue({ schedule: "weekly", lastBootTestAt: null, newest: null }, NOW)).toBe(
      false,
    );
  });

  it("after every backup: once per restore point", () => {
    const input = { schedule: "after_backup" as const, lastBootTestAt: ago(1000) };
    expect(pveBootTestDue({ ...input, newest }, NOW)).toBe(true);
    expect(pveBootTestDue({ ...input, newest: { ...newest, tested: true } }, NOW)).toBe(false);
  });

  it("weekly: a week after the last one", () => {
    const weekly = { schedule: "weekly" as const, newest };
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: null }, NOW)).toBe(true);
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: ago(BOOT_TEST_WEEKLY_MS - 1) }, NOW)).toBe(
      false,
    );
    expect(pveBootTestDue({ ...weekly, lastBootTestAt: ago(BOOT_TEST_WEEKLY_MS) }, NOW)).toBe(true);
  });
});

describe("how a boot test rates its restore point", () => {
  it("green only for proof, yellow without an answer, red on failure, nothing when skipped", () => {
    expect(pveBootTestRating({ outcome: "green", checkedAt: iso(0) })).toBe("green");
    expect(pveBootTestRating({ outcome: "yellow", checkedAt: iso(0) })).toBe("yellow");
    expect(pveBootTestRating({ outcome: "red", checkedAt: iso(0) })).toBe("red");
    expect(pveBootTestRating({ outcome: "skipped", checkedAt: iso(0) })).toBeNull();
    expect(pveBootTestRating({ outcome: "error", checkedAt: iso(0) })).toBeNull();
    expect(pveBootTestRating(null)).toBeNull();
  });
});

describe("the rating of a restore point from its read-back and its boot test", () => {
  const readGreen = { checkedAt: iso(5000), mismatched: 0, errors: [] };
  const readRed = { checkedAt: iso(5000), mismatched: 2, errors: [] };

  it("is the read-back alone without a rated boot test (as before boot tests)", () => {
    expect(pveRestorePointRating(readGreen, null)).toEqual({
      readiness: "green",
      checkedAt: readGreen.checkedAt,
      basis: "verify",
    });
    expect(pveRestorePointRating(readGreen, { outcome: "skipped", checkedAt: iso(0) })).toEqual({
      readiness: "green",
      checkedAt: readGreen.checkedAt,
      basis: "verify",
    });
    expect(pveRestorePointRating(null, null)).toEqual({
      readiness: null,
      checkedAt: null,
      basis: null,
    });
  });

  it("is red when either check failed", () => {
    expect(pveRestorePointRating(readRed, { outcome: "green", checkedAt: iso(0) }).readiness).toBe(
      "red",
    );
    const boot = { outcome: "red", checkedAt: iso(0) };
    expect(pveRestorePointRating(readGreen, boot)).toEqual({
      readiness: "red",
      checkedAt: boot.checkedAt,
      basis: "boot_test",
    });
  });

  it("is yellow when the read-back could not run (locked), unless a boot test decides", () => {
    const locked = { mismatched: 0, errors: [], notChecked: { gaveUpAt: iso(6000) } };
    expect(pveRestorePointRating(locked, null)).toEqual({
      readiness: "yellow",
      checkedAt: iso(6000),
      basis: "verify",
    });
    expect(pveRestorePointRating(locked, { outcome: "green", checkedAt: iso(0) })).toMatchObject({
      readiness: "green",
      basis: "boot_test",
    });
    expect(pveRestorePointRating(locked, { outcome: "red", checkedAt: iso(0) }).readiness).toBe(
      "red",
    );
    // While the worker still tries, the earlier read-back stands.
    expect(pveRestorePointRating({ ...readGreen, notChecked: {} }, null).readiness).toBe("green");
  });

  it("is yellow when the guest only started, green when its guest agent answered", () => {
    expect(
      pveRestorePointRating(readGreen, { outcome: "yellow", checkedAt: iso(0) }).readiness,
    ).toBe("yellow");
    expect(pveRestorePointRating(null, { outcome: "green", checkedAt: iso(0) })).toEqual({
      readiness: "green",
      checkedAt: iso(0),
      basis: "boot_test",
    });
  });
});

describe("the task a node gets", () => {
  it("names the restore point, the limits and what the restore writes", () => {
    const plan = pveBootTestPlan({ schedule: "weekly", maxMemoryMiB: 4096 });
    const vm = {
      id: "s1",
      archiveName: "vm/101/2030-01-01T00:00:00Z",
      kind: "vm" as const,
      byteSize: 0,
      disks: [
        { size: 32 * 2 ** 30, dataBlocks: 100 },
        { size: 4 * 2 ** 20, dataBlocks: 1 },
      ],
    };
    expect(pveBootTestTaskParams(vm, 101, plan)).toEqual({
      volname: "vm/101/2030-01-01T00:00:00Z",
      kind: "vm",
      vmid: 101,
      maxMemoryMiB: 4096,
      timeoutSeconds: DEFAULT_BOOT_TEST_TIMEOUT_SECONDS,
      dataBytes: 101 * 4 * 2 ** 20,
      diskBytes: 32 * 2 ** 30 + 4 * 2 ** 20,
      snapshotId: "s1",
    });
    const ct = { ...vm, kind: "ct" as const, byteSize: 5000, disks: [] };
    expect(pveBootTestTaskParams(ct, 200, plan)).toMatchObject({
      dataBytes: 5000,
      diskBytes: 5000,
    });
  });
});

describe("pveRestoreCheckBlocker", () => {
  const now = new Date("2030-05-06T12:00:00Z");
  const seen = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  it("lets a node run a restore check only with restores allowed and seen lately", () => {
    expect(pveRestoreCheckBlocker({ facts: {}, lastSeenAt: seen(1) }, now)).toBeNull();
    expect(
      pveRestoreCheckBlocker({ facts: { restoresAllowed: true }, lastSeenAt: seen(9) }, now),
    ).toBeNull();
    expect(
      pveRestoreCheckBlocker({ facts: { restoresAllowed: false }, lastSeenAt: seen(1) }, now),
    ).toBe("restores_off");
    expect(pveRestoreCheckBlocker({ facts: {}, lastSeenAt: seen(11) }, now)).toBe("node_offline");
    expect(pveRestoreCheckBlocker({ facts: {}, lastSeenAt: null }, now)).toBe("node_offline");
    expect(pveRestoreCheckBlocker(null, now)).toBe("no_node");
  });
});

describe("pveBootTestRetry", () => {
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
  const skip = (reason: string, minutesAgo: number) => ({
    outcome: "skipped",
    reason,
    startedAt: at(minutesAgo),
  });
  it("retries a transient skip or an error with a doubling wait, and gives up after five", () => {
    expect(pveBootTestRetry([])).toMatchObject({ tested: false, retryAt: null });
    expect(pveBootTestRetry([skip("backup_running", 10)])).toEqual({
      tested: false,
      retryAt: at(-20),
      attempts: 1,
      gaveUp: false,
    });
    const twice = pveBootTestRetry([
      { outcome: "error", reason: "node_error", startedAt: at(10) },
      skip("node_memory", 100),
    ]);
    expect(twice).toMatchObject({ tested: false, attempts: 2, retryAt: at(-50) });
    const five = [1, 2, 3, 4, 5].map((n) => skip("boot_test_running", n * 60));
    expect(pveBootTestRetry(five)).toMatchObject({ tested: true, gaveUp: true });
    // The wait is capped at six hours.
    expect(pveBootTestRetry(five.slice(0, 4), { maxMs: 60 * 60_000 }).retryAt).toEqual(at(0));
  });

  it("counts an outcome that stands as tested: rated, a permanent skip, one going", () => {
    expect(pveBootTestRetry([{ outcome: "green", reason: "", startedAt: at(5) }]).tested).toBe(
      true,
    );
    expect(pveBootTestRetry([skip("memory_limit", 5)]).tested).toBe(true);
    expect(pveBootTestRetry([{ outcome: null, reason: "", startedAt: at(5) }]).tested).toBe(true);
    // A transient skip after a red one is retried: only the attempts since count.
    expect(
      pveBootTestRetry([
        skip("backup_running", 5),
        { outcome: "red", reason: "", startedAt: at(90) },
      ]).tested,
    ).toBe(false);
  });

  it("raises the overdue alert after two days (after every backup) or eight (weekly)", () => {
    expect(pveBootTestOverdueMs("after_backup")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(pveBootTestOverdueMs("weekly")).toBe(8 * 24 * 60 * 60 * 1000);
    expect(pveBootTestOverdueMs("off")).toBeNull();
  });
});

describe("a restore point of a privileged container", () => {
  const ct = (guestConfig: string) => ({ kind: "ct", guestConfig });

  it("is decided by the restore point's own configuration, not by the guest now", () => {
    expect(pveRestorePointPrivileged(ct("arch: amd64\nunprivileged: 1\n"), true)).toBe(false);
    expect(pveRestorePointPrivileged(ct("arch: amd64\nhostname: db\n"), false)).toBe(true);
    expect(pveRestorePointPrivileged(ct("arch: amd64\nunprivileged: 0\n"), false)).toBe(true);
    // Only the main section counts, not a snapshot's.
    expect(
      pveRestorePointPrivileged(ct("arch: amd64\n\n[before-upgrade]\nunprivileged: 1\n"), false),
    ).toBe(true);
    expect(pveRestorePointPrivileged(ct("unprivileged: 1\n\n[old]\narch: amd64\n"), true)).toBe(
      false,
    );
  });

  it("falls back to the inventory's flag without a configuration, and never blocks a VM", () => {
    expect(pveRestorePointPrivileged(ct(""), true)).toBe(true);
    expect(pveRestorePointPrivileged(ct(""), false)).toBe(false);
    expect(pveRestorePointPrivileged({ kind: "vm", guestConfig: "" }, true)).toBe(false);
  });
});

/** The reasons restow-pve sends: the constants of agent/internal/pve/bootreasons.go. */
function agentBootTestReasons(): Map<string, string> {
  const source = readFileSync(
    new URL("../../../../agent/internal/pve/bootreasons.go", import.meta.url),
    "utf8",
  );
  const block = /\nconst \(([\s\S]*?)\n\)/.exec(source)?.[1] ?? "";
  const reasons = new Map<string, string>();
  let group = "";
  for (const line of block.split("\n")) {
    const comment = /^\s*\/\/\s*(green|yellow|red|skipped|error)\b/.exec(line);
    if (comment?.[1]) {
      group = comment[1];
    }
    const constant = /^\s*reason\w+\s*=\s*"([a-z_]+)"\s*$/.exec(line);
    if (constant?.[1]) {
      reasons.set(constant[1], group);
    }
  }
  return reasons;
}

describe("the boot test reasons of the node and the server", () => {
  const agent = agentBootTestReasons();
  // A node before 0.5.0 still sends these; the server records node_error itself.
  const older = ["init_running"];
  const server = ["node_error"];

  it("reads the reasons of the Go agent", () => {
    expect(agent.size).toBeGreaterThan(20);
    expect(agent.get("agent_answered")).toBe("green");
    expect(agent.get("storage_io_error")).toBe("skipped");
  });

  it("knows every reason restow-pve sends, with the outcome the node files it under", () => {
    for (const [reason, group] of agent) {
      expect(PVE_BOOT_TEST_REASON_OUTCOMES[reason], reason).toBe(group);
    }
  });

  it("lists no reason that no node sends", () => {
    for (const reason of Object.keys(PVE_BOOT_TEST_REASON_OUTCOMES)) {
      expect(agent.has(reason) || older.includes(reason) || server.includes(reason), reason).toBe(
        true,
      );
    }
    for (const reason of PVE_BOOT_TEST_TRANSIENT_REASONS) {
      expect(PVE_BOOT_TEST_REASON_OUTCOMES[reason], reason).toBe("skipped");
    }
  });
});

describe("what a boot test's reason stands for", () => {
  it("never reads green for a reason that proves nothing", () => {
    for (const reason of [
      "custom_qemu_args",
      "host_disk",
      "bridge_not_isolated",
      "node_resources",
      "storage_space",
      "storage_io_error",
    ]) {
      expect(pveBootTestOutcomeOf("green", reason)).toBe("skipped");
      expect(pveBootTestOutcomeOf("red", reason)).toBe("skipped");
    }
    expect(pveBootTestOutcomeOf("red", "node_error")).toBe("error");
    for (const reason of [
      "no_guest_agent",
      "agent_not_answering",
      "guest_paused",
      "system_degraded",
      "system_starting",
      "system_unknown",
      "init_running_unverified",
      "init_unknown",
    ]) {
      expect(pveBootTestOutcomeOf("green", reason)).toBe("yellow");
      // A yellow reason never makes a red any better.
      expect(pveBootTestOutcomeOf("red", reason)).toBe("red");
    }
    for (const reason of [
      "restore_failed",
      "start_failed",
      "guest_stopped",
      "guest_panicked",
      "guest_internal_error",
      "system_maintenance",
    ]) {
      expect(pveBootTestOutcomeOf("green", reason)).toBe("red");
      expect(pveBootTestOutcomeOf("yellow", reason)).toBe("red");
    }
  });

  it("keeps the node's outcome for a proof and for a reason it does not know", () => {
    expect(pveBootTestOutcomeOf("green", "agent_answered")).toBe("green");
    expect(pveBootTestOutcomeOf("green", "system_running")).toBe("green");
    expect(pveBootTestOutcomeOf("green", "init_running")).toBe("green");
    // A proof never makes anything better.
    expect(pveBootTestOutcomeOf("yellow", "agent_answered")).toBe("yellow");
    expect(pveBootTestOutcomeOf("yellow", "a_reason_of_a_newer_node")).toBe("yellow");
    expect(pveBootTestOutcomeOf("green", "")).toBe("green");
  });

  it("tries a test skipped for the node's resources or the storage's I/O again", () => {
    expect(pveBootTestTransient({ outcome: "skipped", reason: "node_resources" })).toBe(true);
    expect(pveBootTestTransient({ outcome: "skipped", reason: "storage_io_error" })).toBe(true);
    expect(pveBootTestTransient({ outcome: "skipped", reason: "custom_qemu_args" })).toBe(false);
    expect(pveBootTestTransient({ outcome: "error", reason: "node_error" })).toBe(true);
  });
});

describe("the wait after a skipped restore check", () => {
  it("is a day, then doubles for the same reason in a row, at most a week", () => {
    const day = 24 * 60 * 60 * 1000;
    expect([1, 2, 3, 4, 5, 9].map((n) => pveRestoreCheckSkipRetryMs(n) / day)).toEqual([
      1, 2, 4, 7, 7, 7,
    ]);
    expect(pveRestoreCheckSkipRetryMs(0)).toBe(day);
  });
});
