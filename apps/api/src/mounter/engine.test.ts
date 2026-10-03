import { beforeEach, describe, expect, it } from "vitest";
import { memoryLogger } from "../updater/logger.js";
import { type Clock, OpsError, type ServiceState } from "../updater/ops.js";
import { Redactor } from "../updater/redact.js";
import { MountEngine, MountEngineError, healthOf } from "./engine.js";
import type { ManagedVolume, MountOps, ProbeOutcome } from "./ops.js";
import { managedMountsOf, renderOverride, volumeKeyOf } from "./override.js";
import { type MountSpec, mountSpecSchema } from "./protocol.js";
import { MemoryOperationStore } from "./store.js";

const ACTOR = { userId: "u1", label: "owner@example.com", ip: "192.0.2.1" };
const PROJECT = "restow";

function nfs(name: string, extra: Record<string, unknown> = {}): MountSpec {
  return mountSpecSchema.parse({
    protocol: "nfs",
    name,
    server: "10.0.0.5",
    export: "/srv/backup",
    ...extra,
  });
}

const HEALTHY: ServiceState[] = [
  { service: "api", state: "running", health: "healthy", exitCode: null },
  { service: "worker", state: "running", health: null, exitCode: null },
  { service: "postgres", state: "running", health: "healthy", exitCode: null },
];

/** A compose project in memory: the override file, the volumes Compose made, the service states. */
class FakeOps implements MountOps {
  readonly runnerKind = "helper" as const;
  calls: string[] = [];
  override: string | null = null;
  volumes: ManagedVolume[] = [];
  probeOutcome: ProbeOutcome = { ok: true, code: null, detail: null, wrote: true };
  /** States `servicesState` answers, one per call; the last one repeats. */
  states: ServiceState[][] = [HEALTHY];
  failValidate = false;
  /** Fail `composeUp` this many times. */
  failUp = 0;
  failRemoveVolume = false;
  pingFails = false;
  composeFilePresent = true;
  composeFileVariable = false;

  async ping() {
    if (this.pingFails) {
      throw new OpsError("Docker is not reachable.", "connect ENOENT /var/run/docker.sock");
    }
  }
  async readiness() {
    return { ready: true, detail: null };
  }
  async composeFile() {
    return this.composeFilePresent ? "docker-compose.yml" : null;
  }
  async composeFileVariableSet() {
    return this.composeFileVariable;
  }
  async overrideFile() {
    return "docker-compose.override.yml";
  }
  async readOverride() {
    return this.override;
  }
  async writeOverride(text: string | null) {
    this.calls.push(
      `write:${
        text === null
          ? "null"
          : managedMountsOf(text)
              .map((m) => m.name)
              .join(",") || "none"
      }`,
    );
    this.override = text;
  }
  async validateConfig() {
    this.calls.push("config");
    if (this.failValidate) {
      throw new OpsError("Checking the compose configuration failed (exit code 15).", "yaml: bad");
    }
  }
  async composeUp(services: readonly string[]) {
    this.calls.push(`up:${services.join(",")}`);
    if (this.failUp > 0) {
      this.failUp -= 1;
      throw new OpsError("Recreating the services failed (exit code 1).", "mount failed");
    }
    // Compose creates the volumes the override names.
    for (const mount of managedMountsOf(this.override)) {
      const key = volumeKeyOf(mount);
      if (!this.volumes.some((volume) => volume.key === key)) {
        this.volumes.push({ name: `${PROJECT}_${key}`, key });
      }
    }
  }
  async servicesState() {
    this.calls.push("ps");
    return (this.states.length > 1 ? this.states.shift() : this.states[0]) as ServiceState[];
  }
  async probe(spec: MountSpec) {
    this.calls.push(`probe:${spec.name}`);
    return this.probeOutcome;
  }
  async managedVolumes() {
    return [...this.volumes];
  }
  async removeVolume(name: string) {
    this.calls.push(`rmvol:${name}`);
    if (this.failRemoveVolume) {
      throw new Error("volume is in use");
    }
    this.volumes = this.volumes.filter((volume) => volume.name !== name);
  }
}

class FakeClock implements Clock {
  ms = Date.parse("2026-10-01T10:00:00Z");
  now() {
    return new Date(this.ms);
  }
  async sleep(ms: number) {
    this.ms += ms;
  }
  setTimer() {
    return { cancel: () => undefined };
  }
}

let ops: FakeOps;
let store: MemoryOperationStore;
let clock: FakeClock;
let engine: MountEngine;

function makeEngine() {
  const redactor = new Redactor();
  return new MountEngine({
    ops,
    store,
    clock,
    logger: memoryLogger(redactor),
    redactor,
    healthTimeoutMs: 60_000,
    probeTimeoutMs: 10_000,
    pollIntervalMs: 5000,
  });
}

beforeEach(() => {
  ops = new FakeOps();
  store = new MemoryOperationStore();
  clock = new FakeClock();
  engine = makeEngine();
});

async function run(start: Promise<unknown>) {
  await start;
  await engine.whenIdle();
  return store.operation;
}

describe("adding a share", () => {
  it("runs probe, write, config check, recreate, health and cleanup in that order", async () => {
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(ops.calls).toEqual(["probe:nas", "write:nas", "config", "up:api,worker", "ps"]);
    expect(operation?.status).toBe("succeeded");
    expect(operation?.steps.map((step) => [step.id, step.status])).toEqual([
      ["validate", "done"],
      ["probe", "done"],
      ["write", "done"],
      ["apply", "done"],
      ["health", "done"],
      ["cleanup", "done"],
    ]);
    expect(operation?.requestedBy).toEqual(ACTOR);
    expect(managedMountsOf(ops.override)).toEqual([nfs("nas")]);
    expect((await engine.mounts()).map((view) => view.path)).toEqual(["/mnt/restow/nas"]);
  });

  it("waits until the api is healthy", async () => {
    ops.states = [
      [{ service: "api", state: "running", health: "starting", exitCode: null }],
      [
        { service: "api", state: "running", health: "starting", exitCode: null },
        { service: "worker", state: "running", health: null, exitCode: null },
      ],
      HEALTHY,
    ];
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(operation?.status).toBe("succeeded");
    expect(ops.calls.filter((call) => call === "ps")).toHaveLength(3);
  });

  it("stops after a failed probe and changes nothing", async () => {
    ops.probeOutcome = {
      ok: false,
      code: "probe.mount_failed",
      detail: "mount.nfs: access denied by server",
      wrote: false,
    };
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(ops.calls).toEqual(["probe:nas"]);
    expect(ops.override).toBeNull();
    expect(operation?.status).toBe("failed");
    expect(operation?.failure).toEqual({
      code: "probe.mount_failed",
      step: "probe",
      detail: "mount.nfs: access denied by server",
    });
    expect(operation?.steps.find((step) => step.id === "write")?.status).toBe("skipped");
  });

  it("puts the previous override back when Compose refuses the new one", async () => {
    ops.override = "services:\n  caddy:\n    ports: ['8443:443']\n";
    const before = ops.override;
    ops.failValidate = true;
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(ops.calls).toEqual(["probe:nas", "write:nas", "config", "write:none"]);
    expect(ops.override).toBe(before);
    expect(operation?.status).toBe("rolled_back");
    expect(operation?.failure?.code).toBe("write.config_invalid");
  });

  it("recreates the services with the previous override when the recreate fails", async () => {
    ops.failUp = 1;
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(ops.calls).toEqual([
      "probe:nas",
      "write:nas",
      "config",
      "up:api,worker",
      "write:null",
      "up:api,worker",
      "ps",
    ]);
    expect(ops.override).toBeNull();
    expect(operation?.status).toBe("rolled_back");
    expect(operation?.failure?.code).toBe("apply.failed");
  });

  it("rolls back when the api does not become healthy in time", async () => {
    ops.states = [
      [
        { service: "api", state: "running", health: "starting", exitCode: null },
        { service: "worker", state: "running", health: null, exitCode: null },
      ],
    ];
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(operation?.failure?.code).toBe("health.timeout");
    // The rollback waits as well and also times out: the operator has to look.
    expect(operation?.status).toBe("needs_attention");
    expect(ops.override).toBeNull();
  });

  it("rolls back when the worker stops, and removes the new volume again", async () => {
    ops.states = [
      [
        { service: "api", state: "running", health: "healthy", exitCode: null },
        { service: "worker", state: "exited", health: null, exitCode: 1 },
      ],
      HEALTHY,
    ];
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(operation?.failure?.code).toBe("health.crashed");
    expect(operation?.status).toBe("rolled_back");
    expect(ops.calls.slice(-4)).toEqual([
      "write:null",
      "up:api,worker",
      "ps",
      `rmvol:${PROJECT}_${volumeKeyOf(nfs("nas"))}`,
    ]);
    expect(ops.volumes).toEqual([]);
  });

  it("needs attention when the rollback fails as well", async () => {
    ops.failUp = 2;
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(operation?.status).toBe("needs_attention");
    expect(operation?.warnings.join(" ")).toContain("Rollback failed");
  });

  it("refuses a second change while one runs", async () => {
    let release: () => void = () => undefined;
    ops.probe = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, code: null, detail: null, wrote: true };
    };
    await engine.add(nfs("one"), ACTOR);
    await expect(engine.add(nfs("two"), ACTOR)).rejects.toMatchObject({ code: "busy" });
    release();
    await engine.whenIdle();
    expect(engine.isBusy).toBe(false);
  });

  it("refuses a name that exists, a clash and a blocked project before anything runs", async () => {
    ops.override = renderOverride(null, [nfs("nas")]);
    await expect(engine.add(nfs("nas", { export: "/other" }), ACTOR)).rejects.toMatchObject({
      code: "exists",
    });
    ops.override = "services:\n  worker:\n    volumes:\n      - /srv:/mnt/restow/data\n";
    await expect(engine.add(nfs("data"), ACTOR)).rejects.toMatchObject({ code: "conflict" });
    ops.override = null;
    ops.composeFileVariable = true;
    await expect(engine.add(nfs("x"), ACTOR)).rejects.toMatchObject({ code: "blocked" });
    ops.composeFileVariable = false;
    ops.pingFails = true;
    await expect(engine.add(nfs("x"), ACTOR)).rejects.toBeInstanceOf(MountEngineError);
    expect(ops.calls).toEqual([]);
    expect(store.operation).toBeNull();
    expect(engine.isBusy).toBe(false);
  });

  it("succeeds with a warning when an old volume cannot be removed", async () => {
    ops.volumes = [{ name: `${PROJECT}_restow-nfs-old-12345678`, key: "restow-nfs-old-12345678" }];
    ops.failRemoveVolume = true;
    const operation = await run(engine.add(nfs("nas"), ACTOR));
    expect(operation?.status).toBe("succeeded");
    expect(operation?.warnings[0]).toContain("could not be removed");
  });
});

describe("removing a share", () => {
  it("skips the probe and removes the volume no service uses any more", async () => {
    ops.override = renderOverride(null, [nfs("a"), nfs("b")]);
    ops.volumes = [nfs("a"), nfs("b")].map((mount) => ({
      name: `${PROJECT}_${volumeKeyOf(mount)}`,
      key: volumeKeyOf(mount),
    }));
    const operation = await run(engine.remove("a", ACTOR));
    expect(ops.calls).toEqual([
      "write:b",
      "config",
      "up:api,worker",
      "ps",
      `rmvol:${PROJECT}_${volumeKeyOf(nfs("a"))}`,
    ]);
    expect(operation?.steps.find((step) => step.id === "probe")?.status).toBe("skipped");
    expect(operation?.status).toBe("succeeded");
    expect(ops.volumes.map((volume) => volume.key)).toEqual([volumeKeyOf(nfs("b"))]);
  });

  it("refuses a share that does not exist", async () => {
    await expect(engine.remove("nope", ACTOR)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("history and restarts", () => {
  it("keeps finished operations in the history, newest first", async () => {
    await run(engine.add(nfs("a"), ACTOR));
    await run(engine.add(nfs("b"), ACTOR));
    expect(store.operation?.name).toBe("b");
    expect(engine.history().map((operation) => operation.name)).toEqual(["a"]);
  });

  it("closes an operation a restart interrupted", async () => {
    let release: () => void = () => undefined;
    ops.probe = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, code: null, detail: null, wrote: true };
    };
    await engine.add(nfs("a"), ACTOR);
    const restarted = makeEngine();
    await restarted.init();
    expect(store.operation?.status).toBe("needs_attention");
    expect(store.operation?.failure?.code).toBe("interrupted");
    expect(store.operation?.failure?.step).toBe("probe");
    release();
  });
});

describe("testing a share", () => {
  it("probes settings or a configured share without changing anything", async () => {
    expect((await engine.test({ mount: nfs("x") })).ok).toBe(true);
    ops.override = renderOverride(null, [nfs("nas")]);
    expect((await engine.test({ name: "nas" })).ok).toBe(true);
    await expect(engine.test({ name: "missing" })).rejects.toMatchObject({ code: "not_found" });
    expect(ops.calls).toEqual(["probe:x", "probe:nas"]);
  });
});

describe("healthOf", () => {
  it("reads the compose states", () => {
    expect(healthOf(HEALTHY).state).toBe("healthy");
    expect(healthOf([]).state).toBe("waiting");
    expect(
      healthOf([
        { service: "api", state: "running", health: "unhealthy", exitCode: null },
        { service: "worker", state: "running", health: null, exitCode: null },
      ]).state,
    ).toBe("crashed");
    expect(
      healthOf([
        { service: "api", state: "restarting", health: null, exitCode: null },
        { service: "worker", state: "running", health: null, exitCode: null },
      ]).state,
    ).toBe("waiting");
  });
});
