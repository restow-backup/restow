import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";
import { LocalRunner, findExecutable } from "./runner-local.js";

/**
 * A stand-in `docker` executable (a shell script in a temporary directory) that
 * echoes what it was given, so the tests can see exactly what reaches the process.
 */
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
  args) shift; for a in "$@"; do printf '%s\\n' "$a"; done ;;
  env) env | sort ;;
  cwd) pwd ;;
  cat) cat ;;
  fail) echo "boom Authorization: Bearer abcdefghijklmnop" >&2; echo "to stdout" ; exit 3 ;;
  sleep) sleep 30 ;;
  big) head -c 100000 /dev/zero | tr '\\0' 'x' ;;
  version) echo "27.0.0" ;;
  compose) if [ "$2" = "version" ]; then echo "2.29.0"; else echo "compose $*"; fi ;;
  *) echo "unknown" >&2; exit 64 ;;
esac
`;

let dir: string;
let bin: string;
let cwd: string;
const redactor = new Redactor();

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-local-"));
  bin = path.join(dir, "bin");
  cwd = path.join(dir, "project");
  await fs.mkdir(bin);
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function runner(env: Record<string, string | undefined> = {}): LocalRunner {
  return new LocalRunner({
    redactor,
    cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/updater", ...env },
  });
}

describe("LocalRunner", () => {
  it("finds docker in PATH and reports when it is missing", async () => {
    expect(runner().available).toBe(true);
    expect(findExecutable("docker", `${bin}`)).toBe(path.join(bin, "docker"));
    const missing = new LocalRunner({ redactor, cwd, env: { PATH: "/nonexistent" } });
    expect(missing.available).toBe(false);
    expect(await missing.readiness()).toMatchObject({ ready: false });
    const result = await missing.run({ argv: ["docker", "version"], timeoutMs: 1000 });
    expect(result.exitCode).toBe(127);
  });

  it("passes arguments exactly, without a shell", async () => {
    const hostile = [
      "a b",
      "x; touch pwned",
      "$(touch pwned)",
      "`touch pwned`",
      "'quoted'",
      '"dq"',
      "*",
      "line\nbreak",
      "--flag=value",
    ];
    const result = await runner().run({ argv: ["docker", "args", ...hostile], timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${hostile.join("\n")}\n`);
    await expect(fs.access(path.join(cwd, "pwned"))).rejects.toThrow();
  });

  it("runs in the project directory", async () => {
    const result = await runner().run({ argv: ["docker", "cwd"], timeoutMs: 5000 });
    expect(await fs.realpath(result.stdout.trim())).toBe(await fs.realpath(cwd));
  });

  it("filters the environment down to what Docker needs plus the explicit variables", async () => {
    const result = await runner({
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      DOCKER_CONFIG: "/etc/docker-config",
      RESTOW_MASTER_KEY: "must-not-leak",
      DATABASE_URL: "postgres://x:y@z/db",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    }).run({
      argv: ["docker", "env"],
      env: { RESTOW_IMAGE: "ghcr.io/x/restow:0.2.0" },
      timeoutMs: 5000,
    });
    const lines = result.stdout.split("\n");
    expect(lines).toContain("DOCKER_HOST=unix:///run/user/1000/docker.sock");
    expect(lines).toContain("DOCKER_CONFIG=/etc/docker-config");
    expect(lines).toContain("HOME=/home/updater");
    expect(lines).toContain("RESTOW_IMAGE=ghcr.io/x/restow:0.2.0");
    expect(lines).toContain("COMPOSE_ANSI=never");
    expect(result.stdout).not.toContain("must-not-leak");
    expect(result.stdout).not.toContain("DATABASE_URL");
    expect(result.stdout).not.toContain("postgres://");
  });

  it("writes stdout to a file with mode 0600 and feeds a file to stdin", async () => {
    const input = path.join(dir, "in.txt");
    const output = path.join(dir, "out.txt");
    await fs.writeFile(input, "from the file\n");
    const result = await runner().run({
      argv: ["docker", "cat"],
      stdinFile: input,
      stdoutFile: output,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    expect(await fs.readFile(output, "utf8")).toBe("from the file\n");
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
  });

  it("returns the exit code and a redacted tail (stderr first, stdout as fallback)", async () => {
    const result = await runner().run({ argv: ["docker", "fail"], timeoutMs: 5000 });
    expect(result.exitCode).toBe(3);
    expect(result.errorTail).toBe("boom Authorization: [redacted]");
    expect(result.errorTail).not.toContain("abcdefghijklmnop");
    const silent = await runner().run({ argv: ["docker", "unknown-subcommand"], timeoutMs: 5000 });
    expect(silent.exitCode).toBe(64);
    expect(silent.errorTail).toBe("unknown");
  });

  it("kills a command that runs too long", async () => {
    const started = Date.now();
    const result = await runner().run({ argv: ["docker", "sleep"], timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("caps captured output", async () => {
    const result = await runner().run({
      argv: ["docker", "big"],
      maxOutputBytes: 1000,
      timeoutMs: 5000,
    });
    expect(result.stdout).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    const whole = await runner().run({ argv: ["docker", "big"], timeoutMs: 5000 });
    expect(whole.stdout).toHaveLength(100_000);
    expect(whole.truncated).toBe(false);
  });

  it("refuses programs other than docker and relative file paths", async () => {
    const local = runner();
    await expect(local.run({ argv: ["sh", "-c", "id"], timeoutMs: 1000 })).rejects.toThrow(
      /docker/,
    );
    await expect(
      local.run({ argv: ["docker", "cat"], stdoutFile: "relative.txt", timeoutMs: 1000 }),
    ).rejects.toThrow(/absolute/);
  });

  it("reports an unopenable command file as an error result", async () => {
    const result = await runner().run({
      argv: ["docker", "cat"],
      stdinFile: path.join(dir, "does-not-exist"),
      timeoutMs: 1000,
    });
    expect(result.exitCode).toBe(126);
  });

  it("pings via the server version and checks the compose plugin for readiness", async () => {
    await expect(runner().ping()).resolves.toBeUndefined();
    expect(await runner().readiness()).toEqual({ ready: true, detail: null });
  });

  it("fails the ping with a redacted message", async () => {
    await fs.writeFile(
      path.join(bin, "docker"),
      '#!/bin/sh\necho "Cannot connect to the Docker daemon token=abc123secretvalue" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const error = await runner()
      .ping()
      .catch((caught: Error) => caught);
    expect((error as Error).message).toContain("Cannot connect");
    expect((error as Error).message).not.toContain("abc123secretvalue");
  });
});
