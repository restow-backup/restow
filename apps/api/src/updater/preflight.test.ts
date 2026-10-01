import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREFLIGHT_TTL_MS, UPDATER_IMAGE_PROBE, updaterImageFollowsProbe } from "./preflight.js";
import { type Harness, createHarness, scheduleRequest, settle } from "./testing.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

describe("Preflight", () => {
  it("is ready for a healthy project", async () => {
    const capabilities = await h.preflight.get();
    expect(capabilities).toMatchObject({
      ready: true,
      blockers: [],
      runner: "cli",
      composeFile: "docker-compose.yml",
      imageRepository: "ghcr.io/restow-backup/restow",
      webImageRepository: "ghcr.io/restow-backup/restow-web",
      dumps: [],
      checkedAt: "2026-09-30T10:00:00.000Z",
    });
  });

  it("collects every blocker with a non-sensitive detail", async () => {
    h.ops.pingError = new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    );
    h.ops.composeFile = null;
    h.ops.freeBytesValue = 100 * 1024 * 1024;
    h.ops.self = { id: "x", projectName: "restow", workingDir: "/opt/other" };
    await fs.rm(`${h.projectDir}/.env`);
    const capabilities = await h.preflight.check();
    expect(capabilities.ready).toBe(false);
    expect(capabilities.blockers.map((blocker) => blocker.code)).toEqual([
      "docker_unreachable",
      "compose_missing",
      "env_unwritable",
      "disk_space",
    ]);
    const disk = capabilities.blockers.find((blocker) => blocker.code === "disk_space");
    expect(disk?.detail).toBe("100 MB free, 1024 MB required");
  });

  it("reports the project directory mismatch only when Docker answers", async () => {
    h.ops.self = { id: "x", projectName: "restow", workingDir: "/opt/other" };
    let capabilities = await h.preflight.check();
    expect(capabilities.blockers).toEqual([
      { code: "project_dir_mismatch", detail: expect.stringContaining("/opt/other") },
    ]);
    h.ops.pingError = new Error("down");
    capabilities = await h.preflight.check();
    expect(capabilities.blockers.map((blocker) => blocker.code)).toEqual(["docker_unreachable"]);
  });

  it("accepts a matching working directory and an unknown one", async () => {
    h.ops.self = { id: "x", projectName: "restow", workingDir: h.projectDir };
    expect((await h.preflight.check()).ready).toBe(true);
    h.ops.self = { id: "x", projectName: null, workingDir: null };
    expect((await h.preflight.check()).ready).toBe(true);
  });

  it("blocks while the docker command line is not usable and says why", async () => {
    h.ops.runnerReady = { ready: false, detail: "Preparing the Docker CLI image docker:27-cli." };
    const capabilities = await h.preflight.check();
    expect(capabilities.blockers).toEqual([
      { code: "docker_cli_missing", detail: "Preparing the Docker CLI image docker:27-cli." },
    ]);
  });

  it("caches for 30 seconds and refreshes on demand or when invalidated", async () => {
    const first = await h.preflight.get();
    h.ops.freeBytesValue = 1;
    expect(await h.preflight.get()).toBe(first);
    h.clock.advance(PREFLIGHT_TTL_MS - 1);
    expect(await h.preflight.get()).toBe(first);
    expect((await h.preflight.get(true)).ready).toBe(false);
    h.ops.freeBytesValue = 50 * 1024 ** 3;
    h.preflight.invalidate();
    expect((await h.preflight.get()).ready).toBe(true);
    h.ops.freeBytesValue = 1;
    h.clock.advance(PREFLIGHT_TTL_MS);
    expect((await h.preflight.get()).ready).toBe(false);
  });

  it("blocks while the updater's own image follows the variables the updater rewrites", async () => {
    h.ops.updaterImage = "follows";
    const capabilities = await h.preflight.get();
    expect(capabilities.ready).toBe(false);
    expect(capabilities.blockers).toEqual([
      { code: "updater_image_unpinned", detail: expect.stringContaining("RESTOW_UPDATER_IMAGE") },
    ]);
    // The probe stands in for both variables, never for a real image.
    expect(h.ops.callsTo("configUpdaterImage")).toEqual([
      `configUpdaterImage ${JSON.stringify(UPDATER_IMAGE_PROBE)}`,
    ]);
    // An announcement is refused with the reason.
    await expect(h.engine.schedule(scheduleRequest("0.2.0"))).rejects.toMatchObject({
      code: "blocked",
      blockers: [{ code: "updater_image_unpinned" }],
    });
    expect(h.engine.view().phase).toBe("idle");
  });

  it("is ready with a pinned updater image or without an updater service", async () => {
    h.ops.updaterImage = "pinned";
    expect((await h.preflight.check()).ready).toBe(true);
    h.ops.updaterImage = "none";
    expect((await h.preflight.check({ deep: true })).ready).toBe(true);
    expect(updaterImageFollowsProbe(null)).toBe(false);
    expect(updaterImageFollowsProbe(UPDATER_IMAGE_PROBE.RESTOW_WEB_IMAGE)).toBe(true);
  });

  it("reads the Compose configuration once, and again only for a deep check", async () => {
    await h.preflight.check();
    await h.preflight.check();
    h.clock.advance(PREFLIGHT_TTL_MS);
    await h.preflight.get();
    expect(h.ops.callsTo("configUpdaterImage")).toHaveLength(1);
    await h.preflight.get(true);
    await h.preflight.check({ deep: true });
    expect(h.ops.callsTo("configUpdaterImage")).toHaveLength(3);
  });

  it("does not block when the Compose configuration cannot be read, and asks again", async () => {
    h.ops.failOn("configUpdaterImage", new Error("compose failed"), 0);
    expect((await h.preflight.check()).ready).toBe(true);
    h.ops.updaterImage = "follows";
    expect((await h.preflight.check()).blockers.map((blocker) => blocker.code)).toEqual([
      "updater_image_unpinned",
    ]);
  });

  it("fails a run in its first step when the updater image follows the variables by then", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    h.ops.updaterImage = "follows";
    h.clock.advance(60_000);
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("unchanged");
    expect(run?.failure?.code).toBe("prepare.updater_image_unpinned");
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(await h.readEnv()).toContain("RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.1.0");
  });

  it("lists the dumps, newest first", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const capabilities = await h.preflight.check();
    expect(capabilities.dumps).toHaveLength(1);
    expect(capabilities.dumps[0]?.file).toMatch(/^restow-\d{8}-\d{6}-0\.1\.0-to-0\.2\.0\.dump$/);
  });
});
