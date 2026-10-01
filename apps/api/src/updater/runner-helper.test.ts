import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient } from "./engine-api.js";
import { FakeEngineApi, selfContainer } from "./fake-engine-api.js";
import { memoryLogger } from "./logger.js";
import { Redactor } from "./redact.js";
import { HELPER_LABEL, HelperRunner, wrapCommand } from "./runner-helper.js";

let api: FakeEngineApi;
let redactor: Redactor;
let logger: ReturnType<typeof memoryLogger>;

beforeEach(async () => {
  api = new FakeEngineApi();
  await api.start();
  api.self = selfContainer();
  api.images.add("docker:27-cli");
  redactor = new Redactor();
  logger = memoryLogger(redactor);
});

afterEach(async () => {
  await api.stop();
});

function makeRunner(
  overrides: Partial<ConstructorParameters<typeof HelperRunner>[0]> = {},
): HelperRunner {
  return new HelperRunner({
    engine: new EngineClient({ socketPath: api.socketPath, redactor, requestTimeoutMs: 2000 }),
    redactor,
    logger,
    cliImage: "docker:27-cli",
    projectDir: "/srv/restow",
    stateDir: "/state",
    dockerSocket: "/var/run/docker.sock",
    selfId: "self-host",
    ...overrides,
  });
}

describe("HelperRunner", () => {
  it("creates the helper with Entrypoint [], the command, the working directory and the three binds", async () => {
    api.nextContainer = { exitCode: 0, stdout: [Buffer.from('{"services":{}}')] };
    const runner = makeRunner();
    const result = await runner.run({
      argv: ["docker", "compose", "-p", "restow", "config", "--format", "json"],
      env: { RESTOW_IMAGE: "ghcr.io/x/restow:0.2.0" },
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '{"services":{}}',
      timedOut: false,
      truncated: false,
    });

    const body = [...api.created.values()][0] as Record<string, unknown>;
    expect(body).toMatchObject({
      Image: "docker:27-cli",
      Entrypoint: [],
      Cmd: ["docker", "compose", "-p", "restow", "config", "--format", "json"],
      WorkingDir: "/srv/restow",
      NetworkDisabled: true,
      Labels: { [HELPER_LABEL]: "1" },
      HostConfig: {
        Binds: [
          "/var/run/docker.sock:/var/run/docker.sock",
          "/srv/restow:/srv/restow",
          "restow_restow-updater:/state",
        ],
        NetworkMode: "none",
        AutoRemove: false,
        Privileged: false,
        SecurityOpt: ["no-new-privileges:true"],
      },
    });
    expect(body.Env).toEqual(
      expect.arrayContaining(["RESTOW_IMAGE=ghcr.io/x/restow:0.2.0", "HOME=/tmp"]),
    );
    // The name is generated, unique and recognisable.
    expect(api.callsTo("POST", "/containers/create")[0]?.query.get("name")).toMatch(
      /^restow-updater-helper-[0-9a-f]{12}$/,
    );
  });

  it("removes the helper after success and after a failing command", async () => {
    const runner = makeRunner();
    await runner.run({ argv: ["docker", "version"], timeoutMs: 5000 });
    api.nextContainer = { exitCode: 2, stderr: [Buffer.from("boom: nope\n")] };
    const failed = await runner.run({ argv: ["docker", "compose", "up"], timeoutMs: 5000 });
    expect(failed.exitCode).toBe(2);
    expect(failed.errorTail).toBe("boom: nope");
    expect(api.removed).toHaveLength(2);
    expect(api.removed).toEqual([...api.created.keys()]);
  });

  it("removes the helper when starting it fails, and reports it without throwing", async () => {
    api.startStatus = 500;
    const result = await makeRunner().run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(125);
    expect(result.errorTail).toContain("start refused");
    expect(api.removed).toHaveLength(1);
  });

  it("reports a refused create without a container to remove", async () => {
    api.createStatus = 500;
    const result = await makeRunner().run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(125);
    expect(api.removed).toEqual([]);
  });

  it("kills and removes a helper that runs too long", async () => {
    api.nextContainer = { exitCode: 0, hang: true };
    const result = await makeRunner().run({ argv: ["docker", "compose", "up"], timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(api.killed).toHaveLength(1);
    expect(api.removed).toHaveLength(1);
  });

  it("demultiplexes stdout and stderr and redacts the tail", async () => {
    api.nextContainer = {
      exitCode: 1,
      stdout: [Buffer.from("out line\n")],
      stderr: [Buffer.from("error: Authorization: Bearer abcdefghijklmnop rejected\n")],
    };
    const result = await makeRunner().run({ argv: ["docker", "pull", "x"], timeoutMs: 5000 });
    expect(result.stdout).toBe("out line\n");
    expect(result.errorTail).toBe("error: Authorization: [redacted] rejected");
  });

  it("falls back to the stdout tail for the error text when stderr is empty", async () => {
    api.nextContainer = { exitCode: 1, stdout: [Buffer.from("something went wrong\n")] };
    const result = await makeRunner().run({ argv: ["docker", "x"], timeoutMs: 5000 });
    expect(result.errorTail).toBe("something went wrong");
  });

  it("pulls the CLI image once when it is missing, never when it is there", async () => {
    api.images.clear();
    const runner = makeRunner();
    await runner.run({ argv: ["docker", "version"], timeoutMs: 5000 });
    await runner.run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(api.callsTo("POST", "/images/create")).toHaveLength(1);
    expect(api.callsTo("POST", "/images/create")[0]?.query.get("fromImage")).toBe("docker");

    const other = makeRunner();
    api.images.add("docker:27-cli");
    await other.run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(api.callsTo("POST", "/images/create")).toHaveLength(1);
  });

  it("runs commands with output files through a constant script and positional parameters", async () => {
    const hostile = "restow; $(reboot) `id` 'quote'";
    await makeRunner().run({
      argv: [
        "docker",
        "compose",
        "exec",
        "-T",
        "postgres",
        "pg_dump",
        "-U",
        hostile,
        "-Fc",
        "-d",
        "restow",
      ],
      stdoutFile: "/state/dumps/restow-20260930-100000-0.1.0-to-0.2.0.dump",
      timeoutMs: 5000,
    });
    const body = [...api.created.values()][0] as { Cmd: string[] };
    expect(body.Cmd.slice(0, 4)).toEqual([
      "sh",
      "-c",
      'umask 077; out="$1"; shift; exec "$@" > "$out"',
      "sh",
    ]);
    expect(body.Cmd[4]).toBe("/state/dumps/restow-20260930-100000-0.1.0-to-0.2.0.dump");
    expect(body.Cmd.slice(5)).toEqual([
      "docker",
      "compose",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      hostile,
      "-Fc",
      "-d",
      "restow",
    ]);
    // The script is a constant: nothing but the four fixed words precedes the positional parameters.
    expect(body.Cmd[2]).not.toContain(hostile);
    expect(body.Cmd[2]).not.toContain("dumps");
  });

  it("wraps stdin and both redirections", () => {
    expect(wrapCommand({ argv: ["docker", "a"] })).toEqual(["docker", "a"]);
    expect(wrapCommand({ argv: ["docker", "a"], stdinFile: "/state/x" })).toEqual([
      "sh",
      "-c",
      'in="$1"; shift; exec "$@" < "$in"',
      "sh",
      "/state/x",
      "docker",
      "a",
    ]);
    const both = wrapCommand({
      argv: ["docker", "a"],
      stdinFile: "/state/i",
      stdoutFile: "/state/o",
    });
    expect(both.slice(3)).toEqual(["sh", "/state/i", "/state/o", "docker", "a"]);
    expect(both[2]).toBe('umask 077; in="$1"; out="$2"; shift 2; exec "$@" < "$in" > "$out"');
  });

  it("refuses files outside the state directory and programs other than docker", async () => {
    const runner = makeRunner();
    await expect(
      runner.run({ argv: ["docker", "x"], stdoutFile: "/etc/passwd", timeoutMs: 1000 }),
    ).rejects.toThrow(/state directory/);
    await expect(
      runner.run({ argv: ["docker", "x"], stdinFile: "/state/../etc/passwd\0", timeoutMs: 1000 }),
    ).rejects.toThrow();
    await expect(runner.run({ argv: ["sh", "-c", "id"], timeoutMs: 1000 })).rejects.toThrow(
      /docker/,
    );
    expect(api.created.size).toBe(0);
  });

  it("uses a bind mount source when the state directory is a bind", async () => {
    api.self = selfContainer({
      stateMount: { Type: "bind", Source: "/srv/restow-data/updater", Destination: "/state" },
    });
    await makeRunner().run({ argv: ["docker", "version"], timeoutMs: 5000 });
    const body = [...api.created.values()][0] as { HostConfig: { Binds: string[] } };
    expect(body.HostConfig.Binds[2]).toBe("/srv/restow-data/updater:/state");
  });

  it("does not run when the state mount cannot be found", async () => {
    api.self = { Id: "selfselfselfself", Mounts: [] };
    const runner = makeRunner();
    const result = await runner.run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(125);
    expect(result.errorTail).toContain("/state");
    expect(api.created.size).toBe(0);
    expect((await runner.readiness()).ready).toBe(false);
  });

  it("does not run when the updater's own container cannot be inspected", async () => {
    api.self = null;
    const result = await makeRunner().run({ argv: ["docker", "version"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(125);
  });

  it("reports readiness without waiting for the image pull", async () => {
    api.images.clear();
    const runner = makeRunner();
    const first = await runner.readiness();
    expect(first.ready).toBe(false);
    expect(first.detail).toContain("docker:27-cli");
    await runner.prepare();
    expect(await runner.readiness()).toEqual({ ready: true, detail: null });
  });

  it("reports a failing preparation with its reason and prepares again later", async () => {
    api.images.clear();
    api.pullError = "network is unreachable";
    const runner = makeRunner();
    await expect(runner.prepare()).rejects.toThrow(/network is unreachable/);
    const readiness = await runner.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.detail).toContain("network is unreachable");
    expect(logger.lines.some((line) => line.startsWith("WARN") && line.includes("not ready"))).toBe(
      true,
    );
  });

  it("removes stale helper containers of a crashed updater", async () => {
    api.labelled = ["stale1", "stale2"];
    expect(await makeRunner().removeStaleHelpers()).toBe(2);
    expect(api.removed).toEqual(["stale1", "stale2"]);
    const request = api.callsTo("GET", "/containers/json")[0];
    expect(JSON.parse(request?.query.get("filters") ?? "{}")).toEqual({
      label: [`${HELPER_LABEL}=1`],
    });
  });

  it("pings through the Engine API", async () => {
    await expect(makeRunner().ping()).resolves.toBeUndefined();
    api.pingStatus = 500;
    await expect(makeRunner().ping()).rejects.toThrow();
  });
});
