import { describe, expect, it } from "vitest";
import { buildEndpointConfig, endpointPolicyFor } from "../backup-jobs/endpoint-config.js";
import {
  AGENT_POLICY_KEYS,
  type AgentPolicySettings,
  agentPolicyIssues,
  agentPolicyWire,
  cleanAgentPolicySettings,
  DEFAULT_AGENT_POLICY,
  endpointPolicyOf,
  type GlobalAgentPolicy,
  JOB_POLICY_KEYS,
  lockedKeysSet,
  machineAgentPolicy,
  policyBandwidthDefault,
  policyOnlyOnAcPower,
  resolveAgentPolicy,
} from "./agent-policy.js";
import { defaultEndpointConfig } from "./config.js";

const night = { days: [5, 1, 2, 3, 4, 1], from: "20:00", to: "06:00" };

describe("resolveAgentPolicy", () => {
  it("is the default everywhere when no level sets anything", () => {
    const resolved = resolveAgentPolicy(null, null, null);
    for (const key of AGENT_POLICY_KEYS) {
      expect(resolved[key]).toEqual({
        value: DEFAULT_AGENT_POLICY[key],
        source: "default",
        locked: false,
      });
    }
    expect(endpointPolicyOf(resolved)).toBeUndefined();
  });

  it("takes the lowest level that sets a value", () => {
    const global: GlobalAgentPolicy = { settings: { retries: 2, backupWindow: night }, locks: [] };
    const resolved = resolveAgentPolicy(
      global,
      { retries: 3, onlyOnAcPower: true },
      { retries: 7, backupWindow: null },
    );
    expect(resolved.retries).toEqual({ value: 7, source: "job", locked: false });
    expect(resolved.backupWindow).toEqual({ value: null, source: "job", locked: false });
    expect(resolved.onlyOnAcPower).toEqual({ value: true, source: "tenant", locked: false });
    expect(resolved.catchUp.source).toBe("default");
  });

  it("a lock keeps the installation's value whatever the levels below say", () => {
    const global: GlobalAgentPolicy = {
      settings: { backupWindow: night },
      locks: ["backupWindow", "retries"],
    };
    const resolved = resolveAgentPolicy(
      global,
      { backupWindow: null, retries: 1 },
      { backupWindow: null, retries: 9 },
    );
    expect(resolved.backupWindow).toEqual({ value: night, source: "global", locked: true });
    // Locking a value the installation does not set locks the default.
    expect(resolved.retries).toEqual({ value: 5, source: "default", locked: true });
  });

  it("a job never sets the bandwidth through its policy", () => {
    const resolved = resolveAgentPolicy({ settings: { bandwidthKbps: 1000 }, locks: [] }, null, {
      bandwidthKbps: 5,
    } as never);
    expect(resolved.bandwidthKbps).toEqual({ value: 1000, source: "global", locked: false });
    expect(JOB_POLICY_KEYS).not.toContain("bandwidthKbps");
  });
});

describe("the stored policy", () => {
  it("normalizes the window and keeps the locks of bandwidth and AC power", () => {
    const policy = endpointPolicyOf(
      resolveAgentPolicy(
        { settings: { backupWindow: night, bandwidthKbps: 2000 }, locks: ["bandwidthKbps"] },
        null,
        null,
      ),
    );
    expect(policy).toEqual({
      backupWindow: { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" },
      catchUp: { enabled: true, mode: "asap", maxAgeHours: null },
      retries: 5,
      bandwidthKbps: 2000,
      bandwidthLocked: true,
      onlyOnAcPower: false,
      onlyOnAcPowerLocked: false,
    });
    if (!policy) throw new Error("no policy");
    expect(agentPolicyWire(policy, "Europe/Berlin")).toEqual({
      backupWindow: {
        days: [1, 2, 3, 4, 5],
        from: "20:00",
        to: "06:00",
        timeZone: "Europe/Berlin",
      },
      catchUp: { enabled: true, mode: "asap" },
      maxRetries: 5,
    });
  });

  it("snapshotOnFailure: continue is the default and stays off the wire, fail goes along", () => {
    expect(resolveAgentPolicy(null, null, null).snapshotOnFailure).toEqual({
      value: "continue",
      source: "default",
      locked: false,
    });
    expect(
      endpointPolicyOf(resolveAgentPolicy(null, { snapshotOnFailure: "continue" }, null)),
    ).toBe(undefined);
    const job = resolveAgentPolicy(
      null,
      { snapshotOnFailure: "continue" },
      { snapshotOnFailure: "fail" },
    );
    expect(job.snapshotOnFailure.source).toBe("job");
    const policy = endpointPolicyOf(job);
    expect(policy?.snapshotOnFailure).toBe("fail");
    expect(agentPolicyWire(policy as NonNullable<typeof policy>, "UTC").snapshotOnFailure).toBe(
      "fail",
    );
    // A lock of the installation wins over the job.
    const locked = resolveAgentPolicy(
      { settings: { snapshotOnFailure: "continue" }, locks: ["snapshotOnFailure"] },
      null,
      { snapshotOnFailure: "fail" },
    );
    expect(locked.snapshotOnFailure).toEqual({ value: "continue", source: "global", locked: true });
    expect(agentPolicyIssues({ snapshotOnFailure: "maybe" })).toEqual([
      { code: "snapshot_on_failure", key: "snapshotOnFailure" },
    ]);
    expect(agentPolicyIssues({ snapshotOnFailure: "fail" }, JOB_POLICY_KEYS)).toEqual([]);
  });

  it("a lock alone makes a policy to store", () => {
    expect(
      endpointPolicyOf(resolveAgentPolicy({ settings: {}, locks: ["onlyOnAcPower"] }, null, null)),
    ).toMatchObject({ onlyOnAcPower: false, onlyOnAcPowerLocked: true });
  });

  it("buildEndpointConfig writes the policy only when asked and only when not the default", () => {
    const current = defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" });
    const schedule = { kind: "daily" as const, timeOfDay: "22:00", timeZone: "Europe/Berlin" };
    const without = buildEndpointConfig(current, schedule, {});
    expect(without.policy).toBeUndefined();
    const none = buildEndpointConfig(current, schedule, {}, { global: null, tenant: null });
    expect("policy" in none).toBe(false);
    const withJob = buildEndpointConfig(
      current,
      schedule,
      { policy: { retries: 1 } },
      { global: null, tenant: {} },
    );
    expect(withJob.policy?.retries).toBe(1);
    // Back to the default: the key goes away again.
    expect(
      "policy" in buildEndpointConfig(withJob, schedule, {}, { global: null, tenant: {} }),
    ).toBe(false);
    expect(endpointPolicyFor({ global: null, tenant: { retries: 5 } }, null)).toBeUndefined();
  });
});

describe("what the agent is told", () => {
  const policy = (over: Partial<Parameters<typeof policyBandwidthDefault>[2] & object> = {}) => ({
    backupWindow: null,
    catchUp: { enabled: true, mode: "asap" as const, maxAgeHours: null },
    retries: 5,
    bandwidthKbps: 500,
    bandwidthLocked: false,
    onlyOnAcPower: true,
    onlyOnAcPowerLocked: false,
    ...over,
  });

  it.each([
    ["no policy keeps the job's", null, false, undefined, { kbps: null, windows: false }],
    ["the job's own limit wins", 800, false, policy(), { kbps: 800, windows: false }],
    ["the job's windows win", null, true, policy(), { kbps: null, windows: true }],
    ["without its own, the policy's", null, false, policy(), { kbps: 500, windows: false }],
    [
      "the job's explicit unlimited beats the policy's",
      0,
      false,
      policy(),
      { kbps: null, windows: false },
    ],
    ["explicit unlimited without a policy", 0, false, undefined, { kbps: null, windows: false }],
    [
      "explicit unlimited with windows keeps them",
      0,
      true,
      policy(),
      { kbps: null, windows: true },
    ],
    [
      "a lock beats explicit unlimited",
      0,
      false,
      policy({ bandwidthLocked: true }),
      { kbps: 500, windows: false },
    ],
    [
      "a lock beats limit and windows",
      800,
      true,
      policy({ bandwidthLocked: true }),
      { kbps: 500, windows: false },
    ],
    [
      "a lock of unlimited",
      800,
      false,
      policy({ bandwidthLocked: true, bandwidthKbps: null }),
      { kbps: null, windows: false },
    ],
  ] as const)("%s", (_name, own, windows, p, expected) => {
    expect(policyBandwidthDefault(own, windows, p)).toEqual(expected);
  });

  it("AC power: either asks, a lock decides alone", () => {
    expect(policyOnlyOnAcPower(false, undefined)).toBe(false);
    expect(policyOnlyOnAcPower(true, undefined)).toBe(true);
    expect(policyOnlyOnAcPower(false, policy())).toBe(true);
    expect(policyOnlyOnAcPower(true, policy({ onlyOnAcPower: false }))).toBe(true);
    expect(
      policyOnlyOnAcPower(true, policy({ onlyOnAcPower: false, onlyOnAcPowerLocked: true })),
    ).toBe(false);
  });
});

describe("validation", () => {
  it("accepts good settings", () => {
    expect(
      agentPolicyIssues({
        backupWindow: night,
        catchUp: { enabled: true, mode: "next_window", maxAgeHours: 12 },
        bandwidthKbps: 1000,
        onlyOnAcPower: true,
        retries: 0,
      }),
    ).toEqual([]);
    expect(agentPolicyIssues({ backupWindow: null, bandwidthKbps: null })).toEqual([]);
  });

  it.each([
    [{ backupWindow: { days: [], from: "20:00", to: "06:00" } }, "window_days"],
    [{ backupWindow: { days: [8], from: "20:00", to: "06:00" } }, "window_days"],
    [{ backupWindow: { days: [1], from: "24:00", to: "06:00" } }, "window_time"],
    [{ catchUp: { enabled: true, mode: "later", maxAgeHours: null } }, "catch_up_mode"],
    [{ catchUp: { enabled: true, mode: "asap", maxAgeHours: 0 } }, "catch_up_max_age"],
    [{ bandwidthKbps: 0 }, "bandwidth"],
    [{ retries: 11 }, "retries"],
    [{ retries: 1.5 }, "retries"],
    [{ somethingElse: 1 }, "unknown_key"],
  ])("refuses %j", (settings, code) => {
    expect(agentPolicyIssues(settings as Record<string, unknown>).map((i) => i.code)).toContain(
      code,
    );
  });

  it("a job may not set the bandwidth through its policy", () => {
    expect(agentPolicyIssues({ bandwidthKbps: 10 }, JOB_POLICY_KEYS)).toEqual([
      { code: "unknown_key", key: "bandwidthKbps" },
    ]);
  });

  it("finds locked keys and cleans settings", () => {
    expect(
      lockedKeysSet(
        { retries: 1, catchUp: undefined },
        { settings: {}, locks: ["retries", "catchUp"] },
      ),
    ).toEqual(["retries"]);
    expect(cleanAgentPolicySettings({ backupWindow: night, retries: undefined })).toEqual({
      backupWindow: { days: [1, 2, 3, 4, 5], from: "20:00", to: "06:00" },
    });
  });
});

describe("one machine's view", () => {
  const resolved = (global: GlobalAgentPolicy | null, tenant: AgentPolicySettings | null) =>
    resolveAgentPolicy(global, tenant, null);
  const own = { bandwidthKbps: null, bandwidthWindows: 0, onlyOnAcPower: false };

  it("takes the policy where the machine has nothing of its own", () => {
    const view = machineAgentPolicy(resolved(null, { bandwidthKbps: 800 }), own, true);
    expect(view.effective.bandwidthKbps).toEqual({ value: 800, source: "tenant", locked: false });
    expect(view.effective.onlyOnAcPower).toEqual({
      value: false,
      source: "default",
      locked: false,
    });
    expect(view.bandwidthWindows).toBe(false);
  });

  it("names the job's limit, its explicit unlimited and its windows", () => {
    const above = resolved(null, { bandwidthKbps: 800 });
    expect(
      machineAgentPolicy(above, { ...own, bandwidthKbps: 0 }, true).effective.bandwidthKbps,
    ).toEqual({ value: null, source: "job", locked: false });
    const windows = machineAgentPolicy(above, { ...own, bandwidthWindows: 2 }, true);
    expect(windows.effective.bandwidthKbps).toEqual({ value: null, source: "job", locked: false });
    expect(windows.bandwidthWindows).toBe(true);
    // A machine in no job: its own limit.
    expect(
      machineAgentPolicy(above, { ...own, bandwidthKbps: 300 }, false).effective.bandwidthKbps,
    ).toEqual({ value: 300, source: "machine", locked: false });
  });

  it("adds the machine's own AC power switch, and a lock decides alone", () => {
    expect(
      machineAgentPolicy(resolved(null, null), { ...own, onlyOnAcPower: true }, true).effective
        .onlyOnAcPower,
    ).toEqual({ value: true, source: "machine", locked: false });
    const locked = resolved(
      {
        settings: { onlyOnAcPower: false, bandwidthKbps: 100 },
        locks: ["onlyOnAcPower", "bandwidthKbps"],
      },
      null,
    );
    const view = machineAgentPolicy(
      locked,
      { bandwidthKbps: 0, bandwidthWindows: 1, onlyOnAcPower: true },
      true,
    );
    expect(view.effective.onlyOnAcPower).toEqual({ value: false, source: "global", locked: true });
    expect(view.effective.bandwidthKbps).toEqual({ value: 100, source: "global", locked: true });
    expect(view.bandwidthWindows).toBe(false);
  });
});
