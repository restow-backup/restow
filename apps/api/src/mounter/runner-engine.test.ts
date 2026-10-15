import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ContainerInspect,
  ContainerLogs,
  ContainerSummary,
  CreateContainerBody,
  CreateVolumeBody,
  VolumeSummary,
} from "../updater/engine-api.js";
import type { Logger } from "../updater/logger.js";
import type { Clock } from "../updater/ops.js";
import { Redactor } from "../updater/redact.js";
import {
  FINISHED_RETENTION_MS,
  FileRunnerRunStore,
  MemoryRunnerRunStore,
  RUNNER_STATE_FILE,
  type RunnerDocker,
  RunnerEngine,
  RunnerError,
  parseLastJson,
} from "./runner-engine.js";
import {
  RUNNER_DEADLINE_LABEL,
  RUNNER_KIND_LABEL,
  RUNNER_LABEL,
  RUNNER_SHARE_LABEL,
  RUNNER_VOLUME_LABEL,
  type RunnerRunRequest,
  type ShareSpec,
} from "./runner-protocol.js";

const RUN_ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const RUN_2 = "1f1e2d3c-4b5a-4968-8776-655443322111";
const SHARE_ID = "5b0c6f0e-9f5c-4c8a-9d55-1a2b3c4d5e6f";
const TOKEN = "T0kenT0kenT0kenT0kenT0kenT0kenT0kenT0kenABC";
const PASSWORD = "Pa,ss w=rd!";

const SMB: ShareSpec = {
  protocol: "smb",
  server: "fs1.corp.example",
  address: "10.0.0.5",
  share: "Data",
  subfolder: "",
  username: "backup",
  password: PASSWORD,
  domain: "CORP",
  smbVersion: "3.1.1",
  seal: false,
};

interface FakeContainer {
  id: string;
  name: string;
  body: CreateContainerBody | null;
  labels: Record<string, string>;
  state: "created" | "running" | "exited";
  exitCode: number;
  stdout: string;
  stderr: string;
  created: number;
  waiters: ((code: number) => void)[];
}

/** An in-memory Docker for the runner. */
class FakeDocker implements RunnerDocker {
  containers = new Map<string, FakeContainer>();
  volumes = new Map<string, CreateVolumeBody>();
  removedVolumes: string[] = [];
  removedContainers: string[] = [];
  networks = new Set(["restow_runners"]);
  apiImage: string | null = "sha256:apiimage";
  startError: string | null = null;
  /** What the next started container does: exit at once with this, or keep running (null). */
  nextExit: { code: number; stdout?: string; stderr?: string } | null = null;
  pingError = false;
  hangExec = false;
  private next = 1;

  async ping(): Promise<void> {
    if (this.pingError) {
      throw new Error("Cannot connect to the Docker daemon");
    }
  }
  async listContainers(labels: readonly string[]): Promise<ContainerSummary[]> {
    const out: ContainerSummary[] = [];
    if (labels.includes("com.docker.compose.service=api")) {
      return this.apiImage
        ? [{ Id: "api", Labels: {}, State: "running", ImageID: this.apiImage, Created: 0 }]
        : [];
    }
    for (const c of this.containers.values()) {
      const match = labels.every((label) => {
        const [key, value] = label.split("=");
        return value === undefined ? (key ?? "") in c.labels : c.labels[key ?? ""] === value;
      });
      if (match) {
        out.push({ Id: c.id, Labels: c.labels, State: c.state, ImageID: "x", Created: c.created });
      }
    }
    return out;
  }
  async inspectContainer(id: string): Promise<ContainerInspect | null> {
    const c = this.containers.get(id);
    return c
      ? {
          Id: c.id,
          State: { Status: c.state, Running: c.state === "running", ExitCode: c.exitCode },
        }
      : null;
  }
  async networkExists(name: string): Promise<boolean> {
    return this.networks.has(name);
  }
  async createVolume(spec: CreateVolumeBody): Promise<string> {
    this.volumes.set(spec.Name, spec);
    return spec.Name;
  }
  async removeVolume(name: string): Promise<void> {
    this.volumes.delete(name);
    this.removedVolumes.push(name);
  }
  async listVolumes(labels: readonly string[]): Promise<VolumeSummary[]> {
    return [...this.volumes.values()]
      .filter((v) => labels.every((label) => label in (v.Labels ?? {})))
      .map((v) => ({ Name: v.Name, Labels: v.Labels ?? {} }));
  }
  async createContainer(body: CreateContainerBody, name: string): Promise<string> {
    const id = `c${this.next++}`;
    this.containers.set(id, {
      id,
      name,
      body,
      labels: body.Labels ?? {},
      state: "created",
      exitCode: 0,
      stdout: "",
      stderr: "",
      created: 1_760_000_000,
      waiters: [],
    });
    return id;
  }
  /** A container that is already there (adoption tests). */
  add(labels: Record<string, string>, state: "running" | "exited", exitCode = 0): string {
    const id = `c${this.next++}`;
    this.containers.set(id, {
      id,
      name: id,
      body: null,
      labels,
      state,
      exitCode,
      stdout: "",
      stderr: "stderr of a past run",
      created: 1_760_000_000,
      waiters: [],
    });
    return id;
  }
  async startContainer(id: string): Promise<void> {
    if (this.startError) {
      throw new Error(this.startError);
    }
    const c = this.containers.get(id);
    if (!c) {
      throw new Error("no such container");
    }
    c.state = "running";
    const exit = this.nextExit;
    if (exit && !(this.hangExec && c.body?.Cmd[0] !== "run")) {
      c.stdout = exit.stdout ?? "";
      c.stderr = exit.stderr ?? "";
      this.exit(id, exit.code);
    }
  }
  exit(id: string, code: number): void {
    const c = this.containers.get(id);
    if (!c) {
      return;
    }
    c.state = "exited";
    c.exitCode = code;
    for (const waiter of c.waiters.splice(0)) {
      waiter(code);
    }
  }
  async waitContainer(id: string, signal?: AbortSignal): Promise<number> {
    const c = this.containers.get(id);
    if (!c) {
      throw new Error("no such container");
    }
    if (c.state === "exited") {
      return c.exitCode;
    }
    return await new Promise<number>((resolve, reject) => {
      c.waiters.push(resolve);
      signal?.addEventListener("abort", () => reject(new Error("Aborted")));
    });
  }
  async killContainer(id: string): Promise<void> {
    this.exit(id, 137);
  }
  async stopContainer(id: string): Promise<void> {
    this.exit(id, 143);
  }
  async removeContainer(id: string): Promise<void> {
    this.containers.delete(id);
    this.removedContainers.push(id);
  }
  async containerLogs(id: string): Promise<ContainerLogs> {
    const c = this.containers.get(id);
    return { stdout: c?.stdout ?? "", stderr: c?.stderr ?? "", stdoutTruncated: false };
  }
  byName(prefix: string): FakeContainer | undefined {
    return [...this.containers.values()].find((c) => c.name.startsWith(prefix));
  }
}

const logged: string[] = [];
const recording: Logger = {
  info: (m) => logged.push(m),
  warn: (m) => logged.push(m),
  error: (m) => logged.push(m),
};

function clockAt(start: Date): Clock & { advance(ms: number): void } {
  let now = start.getTime();
  return {
    now: () => new Date(now),
    sleep: async () => undefined,
    setTimer: () => ({ cancel: () => undefined }),
    advance(ms: number) {
      now += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function request(overrides: Partial<RunnerRunRequest> = {}): RunnerRunRequest {
  return {
    runId: RUN_ID,
    kind: "backup",
    mounts: [{ role: "source", share: SMB, readOnly: true }],
    token: TOKEN,
    limits: {
      memoryMiB: 2048,
      goMemLimitMiB: 1638,
      deadline: "2026-10-12T22:00:00Z",
      cacheKey: SHARE_ID,
    },
    ...overrides,
  };
}

describe("RunnerEngine", () => {
  let docker: FakeDocker;
  let store: MemoryRunnerRunStore;
  let clock: ReturnType<typeof clockAt>;
  let engine: RunnerEngine;

  beforeEach(() => {
    docker = new FakeDocker();
    store = new MemoryRunnerRunStore();
    clock = clockAt(new Date("2026-10-10T22:00:00Z"));
    logged.length = 0;
    engine = new RunnerEngine({
      docker,
      config: {
        maxRunners: 2,
        apiUrl: "http://api:3000",
        networkKey: "runners",
        execTimeoutMs: 200,
        maxMemoryMiB: 4096,
        selinux: false,
      },
      projectName: "restow",
      store,
      clock,
      logger: recording,
      redactor: new Redactor(),
      newSuffix: () => "abcdef0123456789",
    });
  });

  it("reports what blocks it", async () => {
    expect((await engine.capabilities(true)).ready).toBe(true);
    docker.networks.clear();
    docker.apiImage = null;
    const caps = await engine.capabilities(true);
    expect(caps.ready).toBe(false);
    expect(caps.blockers.map((b) => b.code).sort()).toEqual([
      "runner_image_unknown",
      "runner_network_missing",
    ]);
    await expect(engine.start(request())).rejects.toMatchObject({
      code: "runner.image",
      status: 409,
    });
    docker.apiImage = "sha256:apiimage";
    await engine.capabilities(true);
    await expect(engine.start(request())).rejects.toMatchObject({ code: "runner.network" });
    docker.pingError = true;
    const down = await engine.capabilities(true);
    expect(down.blockers[0]?.code).toBe("docker_unreachable");
  });

  it("starts a run: volumes, container from the api image, labels, limits clamped", async () => {
    const started = await engine.start(
      request({
        limits: {
          memoryMiB: 99_999,
          goMemLimitMiB: 99_999,
          deadline: "2027-12-31T00:00:00Z",
          cacheKey: SHARE_ID,
        },
      }),
    );
    expect(started.runId).toBe(RUN_ID);
    const share = docker.volumes.get("restow-share-0f1e2d3c-source");
    expect(share?.DriverOpts?.type).toBe("cifs");
    expect(share?.DriverOpts?.o).toContain("password=Pa,,ss w=rd!");
    expect(share?.Labels?.[RUNNER_VOLUME_LABEL]).toBe("1");
    expect(docker.volumes.has(`restow-share-scratch-${RUN_ID}`)).toBe(true);
    expect(docker.volumes.has(`restow-share-cache-${SHARE_ID}`)).toBe(true);
    const container = docker.byName("restow-runner-") as FakeContainer;
    expect(container.body?.Image).toBe("sha256:apiimage");
    expect(container.body?.HostConfig.Memory).toBe(4096 * 1024 * 1024);
    expect(container.body?.Env).toContain("GOMEMLIMIT=4096MiB");
    // At most 336 hours.
    expect(container.labels[RUNNER_DEADLINE_LABEL]).toBe("2026-10-24T22:00:00.000Z");
    expect(engine.list()).toEqual([
      expect.objectContaining({ runId: RUN_ID, kind: "backup", state: "running", exitCode: null }),
    ]);
    // The persisted record holds no secret.
    const persisted = JSON.stringify(store.runs);
    expect(persisted).not.toContain(PASSWORD);
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain("password");
    // Runs never make the mounter busy and are never logged with their spec.
    expect(logged.join("\n")).not.toContain(PASSWORD);
  });

  it("refuses a second run with the same id and runs past the limit", async () => {
    await engine.start(request());
    await expect(engine.start(request())).rejects.toMatchObject({ code: "exists" });
    await engine.start(request({ runId: RUN_2 }));
    await expect(
      engine.start(request({ runId: "2f1e2d3c-4b5a-4968-8776-655443322112" })),
    ).rejects.toMatchObject({ code: "runner.limit", status: 409 });
  });

  it("classifies a mount failure at start, cleans up and redacts it", async () => {
    docker.startError =
      "failed to mount local volume: mount //fs1.corp.example/Data:/var/lib/docker/volumes/x/_data, data: addr=10.0.0.5,username=backup,password=Pa,,ss w=rd!: permission denied";
    const error = await engine.start(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as RunnerError).code).toBe("mount.auth_failed");
    expect((error as RunnerError).status).toBe(422);
    expect((error as RunnerError).message).not.toContain("Pa,");
    expect((error as RunnerError).message).not.toContain("w=rd");
    expect((error as RunnerError).message).toContain("permission denied");
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has("restow-share-0f1e2d3c-source")).toBe(false);
    expect(docker.volumes.has(`restow-share-scratch-${RUN_ID}`)).toBe(false);
    expect(engine.list()).toEqual([]);
  });

  it("removes the container and the share volume at once when the run exits", async () => {
    await engine.start(request());
    const container = docker.byName("restow-runner-") as FakeContainer;
    container.stderr = `restic: done; token ${TOKEN}`;
    docker.exit(container.id, 0);
    await flush();
    await flush();
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has("restow-share-0f1e2d3c-source")).toBe(false);
    expect(docker.volumes.has(`restow-share-scratch-${RUN_ID}`)).toBe(false);
    // The cache stays for the next run.
    expect(docker.volumes.has(`restow-share-cache-${SHARE_ID}`)).toBe(true);
    const detail = engine.get(RUN_ID);
    expect(detail).toMatchObject({ state: "exited", exitCode: 0, stopReason: null });
    expect(detail?.stderrTail).toBe("restic: done; token [redacted]");
    expect(store.runs[0]?.state).toBe("exited");
  });

  it("kills a run past its deadline and forgets finished runs after a day", async () => {
    await engine.start(request());
    clock.advance(3 * 24 * 3600_000);
    await engine.sweep();
    await flush();
    await flush();
    expect(engine.get(RUN_ID)).toMatchObject({
      state: "exited",
      exitCode: 137,
      stopReason: "deadline",
    });
    clock.advance(FINISHED_RETENTION_MS);
    await engine.sweep();
    expect(engine.get(RUN_ID)).toBeNull();
  });

  it("stops a run on request, idempotently", async () => {
    await engine.start(request());
    await engine.stop(RUN_ID);
    await flush();
    await flush();
    expect(engine.get(RUN_ID)).toMatchObject({
      state: "exited",
      stopReason: "stopped",
      exitCode: 143,
    });
    await engine.stop(RUN_ID);
    await engine.stop(RUN_2);
  });

  it("adopts running runners after a restart and removes the rest", async () => {
    const future = "2026-10-11T22:00:00.000Z";
    const past = "2026-10-10T21:00:00.000Z";
    const labels = (runId: string, deadline: string) => ({
      [RUNNER_LABEL]: runId,
      [RUNNER_KIND_LABEL]: "backup",
      [RUNNER_DEADLINE_LABEL]: deadline,
      [RUNNER_SHARE_LABEL]: SHARE_ID,
    });
    const alive = docker.add(labels(RUN_ID, future), "running");
    const late = docker.add(labels(RUN_2, past), "running");
    const done = docker.add(labels("2f1e2d3c-4b5a-4968-8776-655443322112", future), "exited", 3);
    const volumeLabels = (runId: string) => ({ [RUNNER_LABEL]: runId, [RUNNER_VOLUME_LABEL]: "1" });
    await docker.createVolume({
      Name: "restow-share-0f1e2d3c-source",
      Driver: "local",
      Labels: volumeLabels(RUN_ID),
    });
    await docker.createVolume({
      Name: "restow-share-1f1e2d3c-source",
      Driver: "local",
      Labels: volumeLabels(RUN_2),
    });
    await docker.createVolume({ Name: "orphan", Driver: "local", Labels: volumeLabels("gone") });

    await engine.init();
    expect(docker.containers.has(alive)).toBe(true);
    expect(docker.containers.has(late)).toBe(false);
    expect(docker.containers.has(done)).toBe(false);
    expect([...docker.volumes.keys()]).toEqual(["restow-share-0f1e2d3c-source"]);
    expect(engine.get(RUN_2)).toMatchObject({ state: "exited", stopReason: "deadline" });
    expect(engine.get("2f1e2d3c-4b5a-4968-8776-655443322112")).toMatchObject({ exitCode: 3 });
    expect(engine.running).toBe(1);
    // The adopted run is watched again: its exit is recorded and cleaned up.
    docker.exit(alive, 0);
    await flush();
    await flush();
    expect(engine.get(RUN_ID)).toMatchObject({ state: "exited", exitCode: 0 });
    expect(docker.volumes.size).toBe(0);
  });

  it("marks a run the state file knew but Docker lost", async () => {
    store.runs = [
      {
        runId: RUN_ID,
        kind: "restore",
        shareId: SHARE_ID,
        containerId: "gone",
        volumes: [],
        state: "running",
        startedAt: "2026-10-10T20:00:00.000Z",
        deadline: "2026-10-11T20:00:00.000Z",
        exitCode: null,
        finishedAt: null,
        stopReason: null,
        stderrTail: null,
      },
    ];
    await engine.init();
    expect(engine.get(RUN_ID)).toMatchObject({ state: "exited", exitCode: null });
  });

  it("tests a share: no network, output parsed, everything removed", async () => {
    docker.nextExit = {
      code: 0,
      stdout: `noise\n${JSON.stringify({ ok: true, fsType: "cifs", entries: [{ name: "Finance" }] })}\n`,
    };
    const result = await engine.exec({ op: "probe", share: SMB });
    expect(result).toEqual({
      ok: true,
      code: null,
      detail: null,
      output: { ok: true, fsType: "cifs", entries: [{ name: "Finance" }] },
    });
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
    expect(docker.removedVolumes).toEqual(["restow-share-exec-abcdef0123456789"]);
  });

  it("reports a refused test with the runner's code, and a mount failure classified", async () => {
    docker.nextExit = {
      code: 10,
      stdout: JSON.stringify({ ok: false, code: "wrong_filesystem", detail: "not mounted" }),
    };
    expect(await engine.exec({ op: "probe", share: SMB })).toMatchObject({
      ok: false,
      code: "wrong_filesystem",
      detail: "not mounted",
    });
    docker.nextExit = null;
    docker.startError = "mount error: no route to host";
    expect(await engine.exec({ op: "probe", share: SMB })).toMatchObject({
      ok: false,
      code: "mount.unreachable",
      output: null,
    });
    docker.startError = null;
    docker.nextExit = { code: 2, stdout: "", stderr: "crash" };
    expect(await engine.exec({ op: "list", share: SMB, path: "A" })).toMatchObject({
      ok: false,
      code: "runner.failed",
      detail: "crash",
    });
  });

  it("gives up a test that does not answer", async () => {
    docker.nextExit = null;
    const result = await engine.exec({ op: "probe", share: SMB });
    expect(result).toMatchObject({ ok: false, code: "runner.timeout" });
    expect(docker.containers.size).toBe(0);
  });

  it("removes a share's cache unless a run of it runs", async () => {
    await engine.start(request());
    await expect(engine.removeCache(SHARE_ID)).rejects.toMatchObject({ code: "busy" });
    await engine.stop(RUN_ID);
    await flush();
    await flush();
    await engine.removeCache(SHARE_ID);
    expect(docker.volumes.has(`restow-share-cache-${SHARE_ID}`)).toBe(false);
  });
});

describe("FileRunnerRunStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "runner-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips the records and starts empty on a broken file", async () => {
    const store = new FileRunnerRunStore(dir);
    expect(await store.load()).toEqual([]);
    const run = {
      runId: RUN_ID,
      kind: "backup" as const,
      shareId: SHARE_ID,
      containerId: "c1",
      volumes: ["v"],
      state: "exited" as const,
      startedAt: "2026-10-10T20:00:00.000Z",
      deadline: "2026-10-11T20:00:00.000Z",
      exitCode: 0,
      finishedAt: "2026-10-10T21:00:00.000Z",
      stopReason: null,
      stderrTail: "ok",
    };
    await store.save([run]);
    expect(await store.load()).toEqual([run]);
    expect(JSON.parse(await readFile(join(dir, RUNNER_STATE_FILE), "utf8")).schemaVersion).toBe(1);
  });
});

describe("parseLastJson", () => {
  it("takes the last JSON line", () => {
    expect(parseLastJson('{"a":1}\n{"b":2}\nnot json\n')).toEqual({ b: 2 });
    expect(parseLastJson("nothing")).toBeNull();
  });
});
