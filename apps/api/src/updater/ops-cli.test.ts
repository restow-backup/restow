import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CliDockerOps,
  MIGRATION_COUNT_SQL,
  isManifestNotFound,
  parseComposePs,
} from "./ops-cli.js";
import {
  type BuildSpec,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
  OpsError,
  PullError,
  SignatureError,
} from "./ops.js";
import { Redactor } from "./redact.js";

class ScriptedRunner implements CommandRunner {
  readonly kind = "cli" as const;
  readonly specs: CommandSpec[] = [];
  private readonly answers: ((spec: CommandSpec) => Partial<CommandResult> | undefined)[] = [];
  pinged = false;

  answer(fn: (spec: CommandSpec) => Partial<CommandResult> | undefined): void {
    this.answers.push(fn);
  }

  async ping(): Promise<void> {
    this.pinged = true;
  }

  async readiness() {
    return { ready: true, detail: null };
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.specs.push(spec);
    for (const fn of [...this.answers].reverse()) {
      const answer = fn(spec);
      if (answer) {
        return {
          exitCode: 0,
          stdout: "",
          errorTail: "",
          timedOut: false,
          truncated: false,
          ...answer,
        };
      }
    }
    return { exitCode: 0, stdout: "", errorTail: "", timedOut: false, truncated: false };
  }

  get argvs(): string[][] {
    return this.specs.map((spec) => [...spec.argv]);
  }
}

let dir: string;
let dumpsDir: string;
let runner: ScriptedRunner;
let ops: CliDockerOps;

function make(composeFile: string | null = null): CliDockerOps {
  return new CliDockerOps({
    runner,
    redactor: new Redactor(),
    projectDir: dir,
    projectName: "restow",
    composeFile,
    dumpsDir,
    postgres: async () => ({ user: "restow", db: "restow" }),
    selfInspect: async () => null,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-ops-"));
  dumpsDir = path.join(dir, "state", "dumps");
  await fs.mkdir(dumpsDir, { recursive: true });
  runner = new ScriptedRunner();
  ops = make();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("signature verification", () => {
  const DIGEST = `sha256:${"e".repeat(64)}`;
  const COSIGN = `ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:${"c".repeat(64)}`;
  const SIGNER =
    "https://github.com/restow-backup/restow/.github/workflows/release.yml@refs/tags/v0.2.0";
  const check = {
    image: `ghcr.io/restow-backup/restow@${DIGEST}`,
    certificateIdentity: SIGNER,
    certificateOidcIssuer: "https://token.actions.githubusercontent.com",
    verifierImage: COSIGN,
  };

  it("runs the pinned cosign image locked down, with the exact signer, against the digest", async () => {
    await ops.verifySignature(check);
    expect(runner.argvs).toEqual([
      [
        "docker",
        "run",
        "--rm",
        "--label",
        "com.restow.updater.helper=1",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "--env",
        "HOME=/tmp",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        COSIGN,
        "verify",
        "--certificate-identity",
        SIGNER,
        "--certificate-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        `ghcr.io/restow-backup/restow@${DIGEST}`,
      ],
    ]);
  });

  it("fails closed when cosign finds no valid signature, or times out", async () => {
    runner.answer(() => ({
      exitCode: 12,
      errorTail: "Error: no matching signatures: none of the expected identities matched",
    }));
    const error = await ops.verifySignature(check).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(SignatureError);
    expect((error as SignatureError).message).toContain("exit code 12");
    expect((error as SignatureError).detail).toContain("none of the expected identities");
    runner.answer(() => ({ exitCode: 124, timedOut: true }));
    await expect(ops.verifySignature(check)).rejects.toThrow(/timed out/);
  });

  it("refuses a check that is not by digest, a loose signer or an unpinned verifier, without running anything", async () => {
    for (const bad of [
      { ...check, image: "ghcr.io/restow-backup/restow:0.2.0" },
      { ...check, image: `ghcr.io/x/y@${DIGEST} --insecure-ignore-tlog` },
      { ...check, certificateIdentity: ".*" },
      {
        ...check,
        certificateIdentity: "https://github.com/a/b/.github/workflows/r.yml@refs/heads/main",
      },
      { ...check, certificateOidcIssuer: "http://issuer.example" },
      { ...check, verifierImage: "ghcr.io/sigstore/cosign/cosign:v3.1.3" },
    ]) {
      await expect(ops.verifySignature(bad), JSON.stringify(bad)).rejects.toBeInstanceOf(
        SignatureError,
      );
    }
    expect(runner.specs).toEqual([]);
  });
});

describe("command lines", () => {
  it("pings through the runner", async () => {
    await ops.ping();
    expect(runner.pinged).toBe(true);
    runner.ping = async () => {
      throw new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    };
    await expect(ops.ping()).rejects.toBeInstanceOf(OpsError);
  });

  it("reads the images Compose resolves, with the given process environment", async () => {
    runner.answer(() => ({
      stdout: JSON.stringify({
        name: "restow",
        services: {
          api: {
            image: "ghcr.io/x/restow:0.2.0",
            environment: { POSTGRES_PASSWORD: "top-secret-password" },
          },
          worker: { image: "ghcr.io/x/restow:0.2.0" },
          scheduler: { image: "ghcr.io/x/restow:0.2.0" },
          caddy: { image: "ghcr.io/x/restow-web:0.2.0" },
          postgres: { image: "postgres:16-alpine" },
        },
      }),
    }));
    const images = await ops.configImages({ RESTOW_IMAGE: "ghcr.io/x/restow:0.2.0" });
    expect(images).toEqual({
      api: "ghcr.io/x/restow:0.2.0",
      worker: "ghcr.io/x/restow:0.2.0",
      scheduler: "ghcr.io/x/restow:0.2.0",
      caddy: "ghcr.io/x/restow-web:0.2.0",
    });
    expect(runner.argvs).toEqual([
      ["docker", "compose", "-p", "restow", "config", "--format", "json"],
    ]);
    expect(runner.specs[0]?.env).toEqual({ RESTOW_IMAGE: "ghcr.io/x/restow:0.2.0" });
  });

  it("reads the updater service's image with its profile active", async () => {
    runner.answer(() => ({
      stdout: JSON.stringify({ services: { updater: { image: "ghcr.io/x/restow:0.1.0" } } }),
    }));
    expect(await ops.configUpdaterImage({ RESTOW_IMAGE: "probe/app:1" })).toBe(
      "ghcr.io/x/restow:0.1.0",
    );
    expect(runner.argvs).toEqual([
      ["docker", "compose", "-p", "restow", "--profile", "updater", "config", "--format", "json"],
    ]);
    expect(runner.specs[0]?.env).toEqual({ RESTOW_IMAGE: "probe/app:1" });
    runner.answer(() => ({ stdout: JSON.stringify({ services: { api: { image: "a:1" } } }) }));
    expect(await ops.configUpdaterImage({})).toBeNull();
  });

  it("passes -f only for an explicitly named compose file", async () => {
    runner.answer(() => ({ stdout: "{}" }));
    await make("compose.prod.yml").configImages({});
    await ops.configImages({});
    expect(runner.argvs[0]).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "-f",
      "compose.prod.yml",
      "config",
      "--format",
      "json",
    ]);
    expect(runner.argvs[1]).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "config",
      "--format",
      "json",
    ]);
  });

  it("never quotes the config output in an error (it holds the resolved environment)", async () => {
    runner.answer(() => ({ stdout: "POSTGRES_PASSWORD=top-secret-password this is not json" }));
    const error = await ops.configImages({}).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(OpsError);
    expect(JSON.stringify(error)).not.toContain("top-secret-password");
    expect((error as Error).message).not.toContain("top-secret-password");
    expect((error as OpsError).detail).not.toContain("top-secret-password");
  });

  it("reads the api's RESTOW_VERSION through ps and inspect", async () => {
    runner.answer((spec) =>
      spec.argv.includes("ps") ? { stdout: `${"a".repeat(64)}\n` } : undefined,
    );
    runner.answer((spec) =>
      spec.argv.includes("inspect")
        ? { stdout: JSON.stringify(["PATH=/usr/bin", "RESTOW_VERSION=0.1.0", "ROLE=api"]) }
        : undefined,
    );
    expect(await ops.apiRunningVersion()).toBe("0.1.0");
    expect(runner.argvs).toEqual([
      ["docker", "compose", "-p", "restow", "ps", "-q", "api"],
      ["docker", "inspect", "--format", "{{json .Config.Env}}", "a".repeat(64)],
    ]);
  });

  it("apiRunningVersion is null when there is no container or no variable", async () => {
    expect(await ops.apiRunningVersion()).toBeNull();
    runner.answer((spec) =>
      spec.argv.includes("ps") ? { stdout: "abcdef123456\n" } : { stdout: '["A=1"]' },
    );
    expect(await ops.apiRunningVersion()).toBeNull();
  });

  it("pulls, inspects digests and builds with exact arguments", async () => {
    await ops.pull("ghcr.io/restow-backup/restow:0.2.0");
    runner.answer((spec) =>
      spec.argv.includes("inspect")
        ? {
            stdout: JSON.stringify([
              `ghcr.io/restow-backup/restow@sha256:${"1".repeat(64)}`,
              "junk",
            ]),
          }
        : undefined,
    );
    expect(await ops.imageDigests("ghcr.io/restow-backup/restow:0.2.0")).toEqual([
      `sha256:${"1".repeat(64)}`,
    ]);
    await ops.build({
      contextDir: "/state/src/0.2.0",
      target: "runtime",
      tag: "restow:0.2.0",
      buildArgs: { RESTOW_VERSION: "0.2.0" },
    });
    await ops.build({
      contextDir: "/state/src/0.2.0",
      target: "web",
      tag: "restow-web:0.2.0",
      buildArgs: {},
    });
    expect(runner.argvs).toEqual([
      ["docker", "pull", "ghcr.io/restow-backup/restow:0.2.0"],
      [
        "docker",
        "image",
        "inspect",
        "--format",
        "{{json .RepoDigests}}",
        "ghcr.io/restow-backup/restow:0.2.0",
      ],
      [
        "docker",
        "build",
        "--target",
        "runtime",
        "--tag",
        "restow:0.2.0",
        "--build-arg",
        "RESTOW_VERSION=0.2.0",
        "/state/src/0.2.0",
      ],
      ["docker", "build", "--target", "web", "--tag", "restow-web:0.2.0", "/state/src/0.2.0"],
    ]);
    expect(runner.specs[2]?.env).toEqual({ DOCKER_BUILDKIT: "1" });
  });

  it("counts the applied migrations with the documented statement", async () => {
    runner.answer(() => ({ stdout: "17\n" }));
    expect(await ops.migrationCount()).toBe(17);
    expect(runner.argvs).toEqual([
      [
        "docker",
        "compose",
        "-p",
        "restow",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "restow",
        "-d",
        "restow",
        "-v",
        "ON_ERROR_STOP=1",
        "-Atc",
        MIGRATION_COUNT_SQL,
      ],
    ]);
    expect(MIGRATION_COUNT_SQL).toBe("SELECT count(*) FROM drizzle.__drizzle_migrations");
  });

  it("rejects an unexpected migration count answer and a failing query", async () => {
    runner.answer(() => ({ stdout: "not a number" }));
    await expect(ops.migrationCount()).rejects.toThrow(/failed/);
    runner.answer(() => ({
      exitCode: 1,
      errorTail: 'ERROR: relation "drizzle.__drizzle_migrations" does not exist',
    }));
    await expect(ops.migrationCount()).rejects.toMatchObject({
      detail: expect.stringContaining("does not exist"),
    });
  });

  it("uses the database settings of the project", async () => {
    const custom = new CliDockerOps({
      runner,
      redactor: new Redactor(),
      projectDir: dir,
      projectName: "restow",
      composeFile: null,
      dumpsDir,
      postgres: async () => ({ user: "backup_admin", db: "app-db" }),
      selfInspect: async () => null,
    });
    runner.answer(() => ({ stdout: "3" }));
    await custom.migrationCount();
    const file = path.join(dumpsDir, "restow-20260930-100000-0.1.0-to-0.2.0.dump");
    await custom.dumpDatabase(file);
    expect(runner.argvs[0]).toContain("backup_admin");
    expect(runner.argvs[0]).toContain("app-db");
    expect(runner.argvs[1]).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "exec",
      "-T",
      "postgres",
      "pg_dump",
      "-U",
      "backup_admin",
      "-Fc",
      "-d",
      "app-db",
    ]);
  });

  it("streams the dump to a file and verifies it through stdin", async () => {
    const file = path.join(dumpsDir, "restow-20260930-100000-0.1.0-to-0.2.0.dump");
    await ops.dumpDatabase(file);
    expect(runner.specs[0]?.stdoutFile).toBe(file);
    expect(runner.specs[0]?.argv.join(" ")).not.toContain(file);

    await fs.writeFile(file, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100, 1)]));
    runner.answer((spec) =>
      spec.argv.includes("pg_restore")
        ? {
            stdout:
              ";\n; Archive created at ...\n;\n123; 1259 16384 TABLE public a restow\n124; 1259 16390 TABLE public b restow\n",
          }
        : undefined,
    );
    expect(await ops.verifyDump(file)).toEqual({ bytes: 105, entries: 2 });
    const verify = runner.specs.at(-1);
    expect(verify?.argv).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "exec",
      "-T",
      "postgres",
      "pg_restore",
      "--list",
    ]);
    expect(verify?.stdinFile).toBe(file);
  });

  it("refuses to verify an empty, foreign or content-less dump", async () => {
    const file = path.join(dumpsDir, "restow-20260930-100000-0.1.0-to-0.2.0.dump");
    await fs.writeFile(file, "");
    await expect(ops.verifyDump(file)).rejects.toThrow(/empty/);
    await fs.writeFile(file, "-- PostgreSQL database dump (plain text)\n");
    await expect(ops.verifyDump(file)).rejects.toThrow(/custom-format/);
    await fs.writeFile(file, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(10)]));
    runner.answer(() => ({ stdout: ";\n; only comments\n" }));
    await expect(ops.verifyDump(file)).rejects.toThrow(/no content/);
    runner.answer(() => ({
      exitCode: 1,
      errorTail: "pg_restore: error: could not read from input file",
    }));
    await expect(ops.verifyDump(file)).rejects.toMatchObject({
      detail: expect.stringContaining("could not read"),
    });
  });

  it("only writes and reads dump files of this updater", async () => {
    for (const bad of [
      path.join(dir, "elsewhere", "restow-20260930-100000-0.1.0-to-0.2.0.dump"),
      path.join(dumpsDir, "..", "restow-20260930-100000-0.1.0-to-0.2.0.dump"),
      path.join(dumpsDir, "backup.dump"),
      "relative.dump",
    ]) {
      await expect(ops.dumpDatabase(bad)).rejects.toThrow(/not a dump file/);
      await expect(ops.verifyDump(bad)).rejects.toThrow(/not a dump file/);
    }
    expect(runner.specs).toEqual([]);
  });

  it("stops, starts and brings services up without dependencies, builds or pulls", async () => {
    await ops.composeStop(["worker", "scheduler"], 60);
    await ops.composeUp(["api"]);
    await ops.composeUp(["api", "worker", "scheduler", "caddy"]);
    await ops.composeStart(["worker", "scheduler"]);
    expect(runner.argvs).toEqual([
      ["docker", "compose", "-p", "restow", "stop", "-t", "60", "worker", "scheduler"],
      [
        "docker",
        "compose",
        "-p",
        "restow",
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
        "api",
      ],
      [
        "docker",
        "compose",
        "-p",
        "restow",
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
        "api",
        "worker",
        "scheduler",
        "caddy",
      ],
      ["docker", "compose", "-p", "restow", "start", "worker", "scheduler"],
    ]);
    // Never `--remove-orphans`, never a service that was not named.
    expect(runner.argvs.flat()).not.toContain("--remove-orphans");
  });

  it("reads the service states from either JSON format Compose prints", async () => {
    const entries = [
      { Service: "api", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "worker", State: "restarting", Health: "", ExitCode: 1 },
    ];
    runner.answer(() => ({ stdout: JSON.stringify(entries) }));
    expect(await ops.servicesState()).toEqual([
      { service: "api", state: "running", health: "healthy", exitCode: 0 },
      { service: "worker", state: "restarting", health: null, exitCode: 1 },
    ]);
    runner.answer(() => ({ stdout: entries.map((entry) => JSON.stringify(entry)).join("\n") }));
    expect(await ops.servicesState()).toHaveLength(2);
    expect(runner.argvs[0]).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "ps",
      "-a",
      "--format",
      "json",
    ]);
    expect(parseComposePs("")).toEqual([]);
    expect(() => parseComposePs("{oops\n{bad")).toThrow(OpsError);
  });

  it("reads a redacted tail of the api log", async () => {
    runner.answer(() => ({
      stdout:
        "starting\nAuthorization: Bearer abcdefghijklmnop\nDATABASE_PASSWORD=hunter2\nfailed\n",
    }));
    const tail = await ops.apiLogsTail(40);
    expect(runner.argvs[0]).toEqual([
      "docker",
      "compose",
      "-p",
      "restow",
      "logs",
      "--no-color",
      "--no-log-prefix",
      "--tail",
      "40",
      "api",
    ]);
    expect(tail).toContain("failed");
    expect(tail).not.toContain("abcdefghijklmnop");
    expect(tail).not.toContain("hunter2");
    runner.answer(() => ({ exitCode: 1 }));
    expect(await ops.apiLogsTail(40)).toBe("");
  });

  it("reports the free bytes of a directory", async () => {
    expect(await ops.freeBytes(dir)).toBeGreaterThan(0);
  });

  it("finds the compose file", async () => {
    expect(await ops.composeFilePresent()).toBeNull();
    await fs.writeFile(path.join(dir, "compose.yml"), "name: x\n");
    expect(await ops.composeFilePresent()).toBe("compose.yml");
  });
});

describe("error handling", () => {
  it("turns a failing command into an OpsError carrying the redacted tail", async () => {
    runner.answer(() => ({ exitCode: 1, errorTail: "Error response from daemon: boom" }));
    const error = await ops.composeUp(["api"]).catch((caught: OpsError) => caught);
    expect(error).toBeInstanceOf(OpsError);
    expect((error as OpsError).message).toBe("Starting services failed (exit code 1).");
    expect((error as OpsError).detail).toBe("Error response from daemon: boom");
  });

  it("names a timeout", async () => {
    runner.answer(() => ({ exitCode: 143, timedOut: true }));
    await expect(ops.composeStop(["worker"], 5)).rejects.toThrow(/timed out/);
  });

  it("classifies pull failures", async () => {
    runner.answer(() => ({
      exitCode: 1,
      errorTail:
        "Error response from daemon: manifest for ghcr.io/x/restow-web:0.2.0 not found: manifest unknown: manifest unknown",
    }));
    const notFound = await ops
      .pull("ghcr.io/x/restow-web:0.2.0")
      .catch((caught: PullError) => caught);
    expect(notFound).toBeInstanceOf(PullError);
    expect((notFound as PullError).notFound).toBe(true);
    runner.answer(() => ({ exitCode: 1, errorTail: "Error response from daemon: denied" }));
    expect(
      ((await ops.pull("x/y:1").catch((caught: PullError) => caught)) as PullError).notFound,
    ).toBe(false);
    runner.answer(() => ({ exitCode: 1, timedOut: true, errorTail: "manifest unknown" }));
    expect(
      ((await ops.pull("x/y:1").catch((caught: PullError) => caught)) as PullError).notFound,
    ).toBe(false);
  });

  it.each([
    ["Error response from daemon: manifest unknown", true],
    ["manifest for ghcr.io/x/y:1 not found: manifest unknown", true],
    ["Error: No such manifest: ghcr.io/x/y:1", true],
    [
      'Error response from daemon: failed to resolve reference "localhost:55501/e2e-web:2.1.0": localhost:55501/e2e-web:2.1.0: not found',
      true,
    ],
    ['failed to resolve reference "ghcr.io/x/y:9": ghcr.io/x/y:9: not found\n', true],
    ['failed to resolve reference "ghcr.io/x/y:9": failed to authorize: 401 Unauthorized', false],
    ['failed to resolve reference "ghcr.io/x/y:9": dial tcp: lookup ghcr.io: no such host', false],
    ["pull access denied for x/y, repository does not exist or may require 'docker login'", false],
    ["denied: manifest unknown", false],
    ["unauthorized: authentication required", false],
    ["Get https://ghcr.io/v2/: dial tcp: lookup ghcr.io: no such host", false],
    ["toomanyrequests: You have reached your pull rate limit (manifest unknown)", false],
    ["", false],
  ])("isManifestNotFound(%j) = %s", (text, expected) => {
    expect(isManifestNotFound(text)).toBe(expected);
  });
});

describe("no shell, no injection", () => {
  const hostile = [
    "x; rm -rf /",
    "$(reboot)",
    "`id`",
    "a b",
    "-rf",
    "x\nnewline",
    "../../etc/passwd",
    "a|b",
    "",
  ];

  it("refuses image references and service names that are not plain, before any command runs", async () => {
    for (const value of hostile) {
      await expect(ops.pull(value)).rejects.toBeInstanceOf(OpsError);
      await expect(ops.imageDigests(value)).rejects.toBeInstanceOf(OpsError);
      await expect(ops.composeUp([value])).rejects.toBeInstanceOf(OpsError);
      await expect(ops.composeStop([value], 1)).rejects.toBeInstanceOf(OpsError);
      await expect(ops.composeStart([value])).rejects.toBeInstanceOf(OpsError);
    }
    await expect(ops.composeUp([])).rejects.toBeInstanceOf(OpsError);
    expect(runner.specs).toEqual([]);
  });

  it("refuses build parameters that are not plain", async () => {
    const good = {
      contextDir: "/state/src/1",
      target: "runtime" as const,
      tag: "restow:1",
      buildArgs: {},
    };
    const specs: BuildSpec[] = [
      { ...good, contextDir: "relative" },
      { ...good, tag: "restow:1; id" },
      { ...good, tag: "Bad Tag" },
      { ...good, buildArgs: { "BAD NAME": "1" } },
      { ...good, buildArgs: { RESTOW_VERSION: "1; id" } },
      { ...good, buildArgs: { RESTOW_VERSION: "$(id)" } },
    ];
    for (const spec of specs) {
      await expect(ops.build(spec)).rejects.toBeInstanceOf(OpsError);
    }
    expect(runner.specs).toEqual([]);
  });

  it("every command is an argument vector for docker and never a shell invocation", async () => {
    runner.answer(() => ({ stdout: "{}" }));
    const file = path.join(dumpsDir, "restow-20260930-100000-0.1.0-to-0.2.0.dump");
    await fs.writeFile(file, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(10)]));
    runner.answer((spec) => (spec.argv.includes("pg_restore") ? { stdout: "1; a\n" } : undefined));
    await ops.ping();
    await ops.configImages({});
    await ops.apiRunningVersion();
    await ops.pull("ghcr.io/x/y:1");
    await ops.build({ contextDir: "/s", target: "web", tag: "a:1", buildArgs: {} });
    await ops.composeStop(["worker"], 1);
    await ops.composeUp(["api"]);
    await ops.composeStart(["worker"]);
    await ops.dumpDatabase(file);
    await ops.verifyDump(file);
    await ops.servicesState().catch(() => undefined);
    await ops.apiLogsTail(5);
    for (const spec of runner.specs) {
      expect(spec.argv[0]).toBe("docker");
      expect(spec.argv.every((part) => typeof part === "string")).toBe(true);
      expect(spec.argv).not.toContain("sh");
      expect(spec.argv).not.toContain("-c");
      expect(spec.argv).not.toContain("bash");
    }
  });

  it("puts no value from the schedule request on a command line", async () => {
    // The engine passes only the validated version to image tags and build args; the
    // archive URL, the token and the operator's label never reach the ops layer.
    const source = await fs.readFile(new URL("./ops-cli.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/archiveUrl|useToken|requestedBy|token/i);
  });
});
