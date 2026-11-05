/**
 * The planner's sandbox (docs/BAREMETAL.md 12.2) with stand-in binaries: shell scripts at
 * `RESTOW_PLANNER_BIN`'s place that print their environment and working folder, run too long,
 * print too much, crash, or refuse the input. The real planner is exercised by
 * baremetal-check.pg.test.ts.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNER_BIN,
  PLANNER_ENV,
  plannerBinary,
  plannerVersion,
  runPlanner,
  runSandboxed,
} from "./planner.js";

const MANIFEST = Buffer.from('{"format":"restow-layout-v1"}');
const FACTS = { format: "restow-plan-facts-v1", kernels: [], restoreSizes: {}, mokFiles: [] };

const PLAN = {
  format: "restow-plan-v1",
  target: "same",
  ok: true,
  problems: [],
  warnings: [],
  mapping: [],
  adopted: [],
  minimumSizes: { disks: [], filesystems: [], lvs: [], thinPools: [] },
  disks: [],
  steps: [],
  secureBoot: { checked: false, targetSecureBoot: null, loaders: [] },
  drivers: { kernel: null, fallback: null, storage: [], nics: [] },
};

describe("the planner sandbox", () => {
  let dir: string;
  const script = async (name: string, body: string) => {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-planner-test-"));
    // Something the planner must never see.
    process.env.RESTOW_SECRET_FOR_TEST = "do-not-leak";
    process.env.DATABASE_URL ??= "postgres://user:secret@db/restow";
  });

  afterAll(async () => {
    delete process.env.RESTOW_SECRET_FOR_TEST;
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the binary at RESTOW_PLANNER_BIN, else in the image", () => {
    expect(plannerBinary({})).toBe(DEFAULT_PLANNER_BIN);
    expect(plannerBinary({ RESTOW_PLANNER_BIN: " /opt/planner " })).toBe("/opt/planner");
  });

  it.each([
    ["without prlimit", null],
    ["under prlimit when util-linux has it", undefined],
  ] as const)(
    "runs %s with PATH and LC_ALL only, in an empty folder, with stdin as its input",
    async (_label, prlimit) => {
      const bin = await script(
        "env.sh",
        'echo "ENV:$(env | sort | tr "\\n" " ")"; echo "CWD:$(ls -A | wc -l)"; echo "STDIN:$(cat | wc -c)"; echo "ARGS:$*"',
      );
      const result = await runSandboxed(bin, ["baremetal", "plan"], MANIFEST, { prlimit });
      expect(result.exitCode).toBe(0);
      const env = /ENV:(.*)/.exec(result.stdout)?.[1] ?? "";
      expect(env).not.toMatch(/RESTOW_/);
      expect(env).not.toMatch(/DATABASE_URL/);
      const names = env
        .trim()
        .split(" ")
        .map((pair) => pair.split("=")[0])
        // The shell itself adds PWD, SHLVL and `_`.
        .filter((name) => name && !["PWD", "OLDPWD", "SHLVL", "_"].includes(name as string));
      expect(names.sort()).toEqual(Object.keys(PLANNER_ENV).sort());
      expect(result.stdout).toContain("CWD:0");
      expect(result.stdout).toContain(`STDIN:${MANIFEST.length}`);
      expect(result.stdout).toContain("ARGS:baremetal plan");
    },
  );

  it("passes the manifest, a line break and the facts on stdin and reads the plan", async () => {
    const bin = await script("plan.sh", `cat > /dev/null; echo '${JSON.stringify(PLAN)}'`);
    const run = await runPlanner({
      bin,
      manifest: MANIFEST,
      facts: FACTS,
      target: "same",
      sandbox: { prlimit: null },
    });
    expect(run.outcome).toMatchObject({ kind: "plan", plan: { ok: true, target: "same" } });
    const echo = await script("echo.sh", "cat");
    const raw = await runSandboxed(
      echo,
      [],
      Buffer.concat([MANIFEST, Buffer.from("\n"), Buffer.from(JSON.stringify(FACTS))]),
      { prlimit: null },
    );
    expect(raw.stdout).toBe(`${MANIFEST.toString()}\n${JSON.stringify(FACTS)}`);
  });

  it("answers an input the planner refused (exit 1 with its error object) as refused", async () => {
    const bin = await script(
      "refuse.sh",
      `cat > /dev/null; echo '{"format":"restow-plan-v1","ok":false,"error":{"code":"manifest_invalid","message":"disks[0].id"}}'; exit 1`,
    );
    const run = await runPlanner({
      bin,
      manifest: MANIFEST,
      facts: FACTS,
      target: "minimal",
      sandbox: { prlimit: null },
    });
    expect(run.outcome).toEqual({
      kind: "refused",
      error: { code: "manifest_invalid", message: "disks[0].id" },
    });
  });

  it.each([
    ["a timeout", "sleep 5", { timeoutMs: 300 }, "planner_timeout"],
    ["too much output", "head -c 5000000 /dev/zero | tr '\\0' 'x'", {}, "planner_output_too_large"],
    ["a crash", "kill -SEGV $$", {}, "planner_crashed"],
    ["an exit code of its own", "exit 3", {}, "planner_crashed"],
    ["output that is no plan", 'echo \'{"format":"restow-plan-v1"}\'', {}, "planner_crashed"],
    ["garbage", "echo hello", {}, "planner_crashed"],
  ] as const)("answers %s as incomplete", async (_label, body, limits, reason) => {
    const bin = await script(
      `case-${reason}-${Math.random().toString(36).slice(2)}.sh`,
      `cat > /dev/null; ${body}`,
    );
    const run = await runPlanner({
      bin,
      manifest: MANIFEST,
      facts: FACTS,
      target: "other-controller",
      sandbox: { prlimit: null, ...limits },
    });
    expect(run.outcome).toEqual({ kind: "incomplete", reason });
  });

  it("answers a missing binary as unavailable", async () => {
    const run = await runPlanner({
      bin: join(dir, "missing"),
      manifest: MANIFEST,
      facts: FACTS,
      target: "same",
    });
    expect(run.outcome).toEqual({ kind: "incomplete", reason: "planner_unavailable" });
  });

  it("removes its working folder", async () => {
    const bin = await script("pwd.sh", "pwd");
    const result = await runSandboxed(bin, [], Buffer.alloc(0), { prlimit: null });
    const folder = result.stdout.trim();
    expect(folder).toContain("restow-planner-");
    const { existsSync } = await import("node:fs");
    expect(existsSync(folder)).toBe(false);
  });

  it("reads the planner's version", async () => {
    const bin = await script("version.sh", 'test "$1 $2" = "version --short" && echo 0.5.0');
    expect(await plannerVersion(bin, { prlimit: null })).toBe("0.5.0");
    const silent = await script("silent.sh", "exit 0");
    expect(await plannerVersion(silent, { prlimit: null })).toBeNull();
  });
});
