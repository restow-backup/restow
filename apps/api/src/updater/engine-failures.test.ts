import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsError } from "./ops.js";
import {
  DEFAULT_ENV,
  type Harness,
  apiAt,
  createHarness,
  digestOf,
  scheduleRequest,
  settle,
} from "./testing.js";

const OLD_APP = "ghcr.io/restow-backup/restow:0.1.0";
const OLD_WEB = "ghcr.io/restow-backup/restow-web:0.1.0";
const NEW_APP = "ghcr.io/restow-backup/restow:0.2.0";
const NEW_WEB = "ghcr.io/restow-backup/restow-web:0.2.0";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function run(version = "0.2.0", overrides: Parameters<typeof scheduleRequest>[1] = {}) {
  await h.engine.schedule(scheduleRequest(version, overrides));
  await settle(h.engine);
  const view = h.engine.view();
  if (!view.run) {
    throw new Error("no run");
  }
  return view.run;
}

function serviceImages(): Record<string, string | undefined> {
  return Object.fromEntries([...h.ops.containers.entries()].map(([name, c]) => [name, c.image]));
}

describe("failures before anything is replaced: outcome unchanged", () => {
  it("a pull failure ends unchanged and leaves the services, .env and the disk alone", async () => {
    h.ops.failOn("pull", new OpsError("The image pull failed.", "manifest unknown"));
    const result = await run();
    expect(result.outcome).toBe("unchanged");
    expect(result.failure).toMatchObject({
      code: "fetch.pull_failed",
      step: "fetch",
      migrationsRan: false,
    });
    expect(result.failure?.detail).toContain("manifest unknown");
    expect(result.recovery).toBeNull();
    expect(h.engine.view().phase).toBe("failed");
    expect(result.message).toEqual({
      code: "run.unchanged",
      params: { code: "fetch.pull_failed" },
    });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(h.ops.callsTo("composeStop")).toEqual([]);
    expect(h.ops.callsTo("composeUp")).toEqual([]);
    expect(h.ops.callsTo("dumpDatabase")).toEqual([]);
    expect(serviceImages()).toMatchObject({
      api: OLD_APP,
      worker: OLD_APP,
      scheduler: OLD_APP,
      caddy: OLD_WEB,
    });
    expect(result.steps.map((step) => step.status)).toEqual([
      "done",
      "failed",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    // Progress is frozen where it stopped and never jumps because steps were skipped.
    expect(result.progress).toBeLessThan(30);
    const events = h.engine.view().events;
    expect(events.map((event) => event.action)).toEqual(["update.started", "update.failed"]);
    expect(events[1]?.details).toMatchObject({
      outcome: "unchanged",
      failureCode: "fetch.pull_failed",
    });
  });

  it("a digest mismatch ends unchanged and records that verification failed", async () => {
    h.ops.pulledDigests.set(NEW_APP, [digestOf("something-else")]);
    const result = await run("0.2.0", { digests: { app: digestOf("published") } });
    expect(result.outcome).toBe("unchanged");
    expect(result.failure?.code).toBe("fetch.digest_mismatch");
    expect(result.digestVerified).toBe(false);
    expect(h.ops.callsTo("dumpDatabase")).toEqual([]);
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("a digest of the web image is checked too", async () => {
    h.ops.pulledDigests.set(NEW_WEB, [digestOf("wrong")]);
    const result = await run("0.2.0", {
      digests: { app: digestOf(NEW_APP), web: digestOf("published-web") },
    });
    expect(result.failure?.code).toBe("fetch.digest_mismatch");
    expect(result.failure?.detail).toContain("web image");
  });

  it("a failing dump ends unchanged and leaves no dump file behind", async () => {
    h.ops.failOn(
      "dumpDatabase",
      new OpsError(
        "Dumping the database failed (exit code 1).",
        "pg_dump: error: connection refused",
      ),
    );
    const result = await run();
    expect(result.outcome).toBe("unchanged");
    expect(result.failure?.code).toBe("backup.failed");
    expect(await h.dumps.list()).toEqual([]);
    expect(h.ops.callsTo("composeStop")).toEqual([]);
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("an unverifiable dump is discarded", async () => {
    h.ops.failOn("verifyDump", new OpsError("The dump has no content."));
    const result = await run();
    expect(result.outcome).toBe("unchanged");
    expect(result.failure?.code).toBe("backup.failed");
    expect(await h.dumps.list()).toEqual([]);
  });

  it("an unreadable migration marker fails the backup before anything happens", async () => {
    h.ops.failOn(
      "migrationCount",
      new OpsError(
        "Reading the migration count failed (exit code 2).",
        'relation "drizzle.__drizzle_migrations" does not exist',
      ),
    );
    const result = await run();
    expect(result.outcome).toBe("unchanged");
    expect(result.failure?.code).toBe("backup.failed");
    expect(result.failure?.detail).toContain("migration marker");
    expect(h.ops.callsTo("dumpDatabase")).toEqual([]);
  });

  it("stops in prepare when the compose file does not use the image variables", async () => {
    h.ops.honoursVariables = false;
    const result = await run();
    expect(result.outcome).toBe("unchanged");
    expect(result.failure).toMatchObject({ code: "prepare.compose_unsupported", step: "prepare" });
    expect(h.ops.callsTo("pull")).toEqual([]);
  });

  it.each([
    [
      "docker unreachable",
      () => {
        h.ops.pingError = new Error("no daemon");
      },
      "prepare.docker_unreachable",
    ],
    [
      "disk space",
      () => {
        h.ops.freeBytesValue = 10 * 1024 * 1024;
      },
      "prepare.disk_space",
    ],
    [
      "compose file missing",
      () => {
        h.ops.composeFile = null;
      },
      "prepare.compose_missing",
    ],
    [
      "project directory mismatch",
      () => {
        h.ops.self = { id: "abc", projectName: "restow", workingDir: "/somewhere/else" };
      },
      "prepare.project_dir_mismatch",
    ],
    [
      "the helper runner is not ready",
      () => {
        h.ops.runnerReady = { ready: false, detail: "pulling" };
      },
      "prepare.docker_unreachable",
    ],
  ])("prepare fails with the matching code: %s", async (_name, arrange, code) => {
    // Schedule while everything is fine, break the world during the countdown.
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    arrange();
    h.clock.advance(60_000);
    await settle(h.engine);
    const result = h.engine.view().run;
    expect(result?.outcome).toBe("unchanged");
    expect(result?.failure?.code).toBe(code);
    expect(h.ops.callsTo("pull")).toEqual([]);
  });

  it("prepare fails when .env cannot be replaced", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    await fs.chmod(h.projectDir, 0o500);
    try {
      h.clock.advance(60_000);
      await settle(h.engine);
    } finally {
      await fs.chmod(h.projectDir, 0o700);
    }
    if (process.getuid?.() === 0) {
      return; // root ignores permissions
    }
    expect(h.engine.view().run?.failure?.code).toBe("prepare.env_unwritable");
  });

  it("prepare fails when the target is not newer than the version the api reports by then", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    h.api.override = { ready: true, version: "0.2.0", reason: null };
    h.clock.advance(60_000);
    await settle(h.engine);
    expect(h.engine.view().run?.failure?.code).toBe("prepare.not_newer");
    expect(h.engine.view().run?.outcome).toBe("unchanged");
  });
});

describe("failures after the workers were stopped, before migrations ran: rollback", () => {
  it("a failing stop restarts everything with the previous images", async () => {
    h.ops.failOn(
      "composeStop",
      new OpsError("Stopping services failed (exit code 1).", "timeout"),
      0,
    );
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "stop.failed",
      step: "stop",
      migrationsRan: false,
    });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(h.ops.callsTo("composeUp")).toEqual(["composeUp api,worker,scheduler,caddy"]);
    expect(h.ops.containers.get("worker")?.state).toBe("running");
    expect(result.message).toEqual({ code: "run.rolled_back", params: { code: "stop.failed" } });
    // The api was never touched, so nothing needed freezing or counting.
    expect(h.ops.callsTo("migrationCount")).toHaveLength(1);
  });

  it("a failing compose up of the api rolls back byte-exact", async () => {
    h.ops.failOn(
      "composeUp",
      new OpsError("Starting services failed (exit code 1).", "no such image"),
      0,
    );
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("start.failed");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(serviceImages()).toMatchObject({
      api: OLD_APP,
      worker: OLD_APP,
      scheduler: OLD_APP,
      caddy: OLD_WEB,
    });
    expect(h.ops.containers.get("api")?.state).toBe("running");
    // The new api was frozen before the migration count was read again.
    const calls = h.ops.calls;
    const frozen = calls.findIndex((call) => call.startsWith("composeStop api "));
    const counted = calls.lastIndexOf("migrationCount");
    expect(frozen).toBeGreaterThan(-1);
    expect(counted).toBeGreaterThan(frozen);
  });

  it("a health timeout rolls back: .env restored byte for byte, old images up, log tail in the detail", async () => {
    apiAt(h, NEW_APP, { kind: "never" });
    const started = h.clock.now().getTime();
    const result = await run();
    const elapsedSeconds = (h.clock.now().getTime() - started) / 1000;

    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "health.timeout",
      step: "health",
      migrationsRan: false,
    });
    expect(result.failure?.detail).toContain("migration 0042 failed");
    expect(result.recovery).toBeNull();
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(serviceImages()).toMatchObject({
      api: OLD_APP,
      worker: OLD_APP,
      scheduler: OLD_APP,
      caddy: OLD_WEB,
    });
    expect(h.ops.containers.get("api")?.state).toBe("running");
    expect(elapsedSeconds).toBeGreaterThanOrEqual(600);
    expect(elapsedSeconds).toBeLessThan(700);
    expect(result.steps.find((step) => step.id === "health")?.status).toBe("failed");
    expect(result.steps.find((step) => step.id === "finish")?.status).toBe("skipped");
    // Rollback order: freeze the api, restore .env, bring the previous images up, wait.
    const relevant = h.ops.calls.filter((call) =>
      /^(composeStop api|composeUp|migrationCount)/.test(call),
    );
    expect(relevant.slice(-3)).toEqual([
      expect.stringMatching(/^composeStop api /),
      "migrationCount",
      "composeUp api,worker,scheduler,caddy",
    ]);
    expect(h.engine.view().events.at(-1)?.details).toMatchObject({
      outcome: "rolled_back",
      failureCode: "health.timeout",
    });
  });

  it("restores a missing variable to missing and leaves comments, order and mode alone", async () => {
    await h.cleanup();
    const original =
      "# my settings\r\nPOSTGRES_PASSWORD=pw-pw-pw-pw\r\nRESTOW_APP_DOMAIN=example.com\r\n# no image variables here\r\nRESTOW_MASTER_KEY=zzzzzzzzzzzz";
    h = await createHarness({ env: original });
    await h.ops.installAt("restow:local", "restow-web:local", "0.1.0");
    await fs.chmod(`${h.projectDir}/.env`, 0o640);
    apiAt(h, NEW_APP, { kind: "never" });
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(await h.readEnv()).toBe(original);
    expect((await fs.stat(`${h.projectDir}/.env`)).mode & 0o777).toBe(0o640);
    expect(serviceImages()).toMatchObject({ api: "restow:local", caddy: "restow-web:local" });
    expect(result.recovery).toBeNull();
  });

  it("an api crash loop fails fast, without waiting for the health timeout", async () => {
    apiAt(h, NEW_APP, { kind: "crash" });
    const started = h.clock.now().getTime();
    const result = await run();
    const elapsedSeconds = (h.clock.now().getTime() - started) / 1000;
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("health.crashed");
    expect(result.failure?.detail).toContain("restarting");
    expect(elapsedSeconds).toBeLessThan(30);
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("an api that is ready with another version fails with health.version_mismatch", async () => {
    apiAt(h, NEW_APP, { kind: "ready", reportsVersion: "0.1.5" });
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("health.version_mismatch");
    expect(result.failure?.detail).toContain("0.1.5");
  });

  it("waits for a slow api instead of failing early", async () => {
    apiAt(h, NEW_APP, { kind: "ready", afterPolls: 40, reportsVersion: "0.2.0" });
    const result = await run();
    expect(result.outcome).toBe("succeeded");
  });

  it("a failing edge start without migrations rolls back too", async () => {
    apiAt(h, NEW_APP, { kind: "ready", reportsVersion: "0.2.0" });
    h.ops.failOn(
      "composeUp",
      new OpsError("Starting services failed (exit code 1).", "port 443 is already allocated"),
      2,
    );
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({ code: "start.failed", step: "health" });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(serviceImages()).toMatchObject({ api: OLD_APP, worker: OLD_APP, scheduler: OLD_APP });
  });

  it("a rollback that itself fails ends in needs_attention with both details", async () => {
    apiAt(h, NEW_APP, { kind: "never" });
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    // The previous version does not come up again either.
    apiAt(h, OLD_APP, { kind: "never" });
    h.clock.advance(60_000);
    await settle(h.engine);
    const result = h.engine.view().run;
    if (!result) {
      throw new Error("no run");
    }
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.code).toBe("health.timeout");
    expect(result.failure?.detail).toContain("Rollback failed");
    expect(result.failure?.detail.length).toBeLessThanOrEqual(2000);
    expect(result.failure?.migrationsRan).toBe(false);
    expect(result.recovery).toMatchObject({
      fromVersion: "0.1.0",
      previousImages: { app: OLD_APP, web: OLD_WEB },
    });
    expect(result.recovery?.dumpBytes).toBeGreaterThan(0);
    expect(result.message?.code).toBe("run.needs_attention");
  });

  it("a rollback that cannot restore .env ends in needs_attention", async () => {
    apiAt(h, NEW_APP, { kind: "never" });
    const restore = h.envFile.restore.bind(h.envFile);
    h.envFile.restore = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const result = await run();
    h.envFile.restore = restore;
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.detail).toContain("EROFS");
    expect(result.recovery?.dumpFile).toMatch(/\.dump$/);
  });
});

describe("failures after migrations ran or with an unknown migration state: needs_attention", () => {
  it("stops api, worker and scheduler, leaves the edge, keeps the dump and hands over recovery data", async () => {
    apiAt(h, NEW_APP, { kind: "never", migrates: 3 });
    const result = await run();

    expect(result.outcome).toBe("needs_attention");
    expect(result.failure).toMatchObject({
      code: "health.timeout",
      step: "health",
      migrationsRan: true,
    });
    expect(h.engine.view().phase).toBe("failed");
    expect(result.message).toEqual({
      code: "run.needs_attention",
      params: { code: "health.timeout" },
    });

    // Everything but the edge is stopped, and nothing was rolled back over migrated data.
    expect(h.ops.containers.get("api")?.state).toBe("exited");
    expect(h.ops.containers.get("worker")?.state).toBe("exited");
    expect(h.ops.containers.get("scheduler")?.state).toBe("exited");
    expect(h.ops.containers.get("caddy")).toMatchObject({ state: "running", image: OLD_WEB });
    expect(h.ops.containers.get("api")?.image).toBe(NEW_APP);
    expect(h.ops.callsTo("composeUp")).toEqual(["composeUp api"]);
    expect(h.ops.calls.at(-1)).toMatch(/^composeStop api,worker,scheduler /);
    // .env keeps the new references: restoring them is the operator's decision.
    expect(await h.readEnv()).toContain("RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.2.0");

    // The dump is kept and described.
    const dumps = await h.dumps.list();
    expect(dumps).toHaveLength(1);
    expect(result.recovery).toEqual({
      dumpFile: dumps[0]?.file,
      dumpBytes: dumps[0]?.bytes,
      fromVersion: "0.1.0",
      previousImages: { app: OLD_APP, web: OLD_WEB },
    });
    expect(result.recovery?.dumpBytes).toBeGreaterThan(0);
    const failed = h.engine.view().events.at(-1);
    expect(failed?.action).toBe("update.failed");
    expect(failed?.details).toMatchObject({ outcome: "needs_attention", dumpFile: dumps[0]?.file });
  });

  it("keeps the dump a needs_attention run needs until a later run has been made", async () => {
    apiAt(h, NEW_APP, { kind: "never", migrates: 1 });
    const attention = await run();
    const needed = attention.recovery?.dumpFile as string;
    expect(needed).toMatch(/\.dump$/);
    // Three newer dumps exist, so plain pruning would delete the one the operator needs.
    for (const day of ["01", "02", "03"]) {
      await fs.writeFile(
        `${h.dumps.directory}/restow-2027010${day.slice(1)}-120000-0.1.0-to-0.2.0.dump`,
        "PGDMP-newer",
      );
    }

    apiAt(h, "ghcr.io/restow-backup/restow:0.3.0", { kind: "ready", reportsVersion: "0.3.0" });
    h.clock.advance(10_000);
    await h.engine.schedule(scheduleRequest("0.3.0"));
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("succeeded");
    expect((await h.dumps.list()).map((dump) => dump.file)).toContain(needed);

    // With a later run made, the attention run is history: its dump is pruned like any other.
    apiAt(h, "ghcr.io/restow-backup/restow:0.4.0", { kind: "ready", reportsVersion: "0.4.0" });
    h.clock.advance(10_000);
    await h.engine.schedule(scheduleRequest("0.4.0"));
    await settle(h.engine);
    expect((await h.dumps.list()).map((dump) => dump.file)).not.toContain(needed);
    expect(await h.dumps.list()).toHaveLength(3);
  });

  it("a crash after migrations is not rolled back either", async () => {
    apiAt(h, NEW_APP, { kind: "crash", migrates: 1 });
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure).toMatchObject({ code: "health.crashed", migrationsRan: true });
  });

  it("a failing edge start after migrations keeps the migrated database untouched", async () => {
    apiAt(h, NEW_APP, { kind: "ready", migrates: 1, reportsVersion: "0.2.0" });
    h.ops.failOn("composeUp", new OpsError("Starting services failed (exit code 1).", "boom"), 2);
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure).toMatchObject({
      code: "start.failed",
      step: "health",
      migrationsRan: true,
    });
    expect(h.ops.containers.get("api")?.state).toBe("exited");
    expect(await h.readEnv()).toContain("restow:0.2.0");
  });

  it("does not guess when the migration count cannot be read", async () => {
    apiAt(h, NEW_APP, { kind: "never" });
    h.ops.failOn(
      "migrationCount",
      new OpsError("Reading the migration count failed (exit code 1)."),
      1,
    );
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.migrationsRan).toBeNull();
    expect(h.ops.containers.get("api")?.state).toBe("exited");
    expect(result.recovery?.dumpFile).toMatch(/\.dump$/);
  });

  it("does not trust an unchanged count when the new api could not be frozen", async () => {
    apiAt(h, NEW_APP, { kind: "never" });
    h.ops.failOn("composeStop", new OpsError("Stopping services failed (exit code 1)."), 1);
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.migrationsRan).toBeNull();
  });

  it("reports when the application could not be stopped completely", async () => {
    apiAt(h, NEW_APP, { kind: "never", migrates: 1 });
    // Calls: 0 stops workers, 1 freezes the api, 2 stops everything.
    h.ops.failOn(
      "composeStop",
      new OpsError("Stopping services failed (exit code 1).", "daemon busy"),
      2,
    );
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.detail).toContain("could not be stopped completely");
  });
});
