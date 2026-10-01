import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "./engine.js";
import { UPDATE_STEPS, journalEventSchema, runSchema, stateViewSchema } from "./protocol.js";
import { parseState } from "./store.js";
import {
  DEFAULT_ENV,
  type Harness,
  TEST_COSIGN_IMAGE,
  apiAt,
  createHarness,
  digestOf,
  releaseDigests,
  releaseSigner,
  scheduleRequest,
  settle,
} from "./testing.js";

const NEW_APP = "ghcr.io/restow-backup/restow:0.2.0";
const NEW_WEB = "ghcr.io/restow-backup/restow-web:0.2.0";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function runToEnd(version = "0.2.0", overrides: Parameters<typeof scheduleRequest>[1] = {}) {
  await h.engine.schedule(scheduleRequest(version, overrides));
  await settle(h.engine);
  return h.engine.view();
}

describe("image mode success", () => {
  beforeEach(() => {
    apiAt(h, NEW_APP, { kind: "ready", migrates: 2, reportsVersion: "0.2.0" });
    apiAt(h, "ghcr.io/restow-backup/restow:0.2.0", {
      kind: "ready",
      migrates: 2,
      reportsVersion: "0.2.0",
    });
  });

  it("runs every step, verifies the digests and rewrites only the two image variables", async () => {
    h.ops.pulledDigests.set(NEW_APP, [digestOf("app-0.2.0")]);
    h.ops.pulledDigests.set(NEW_WEB, [digestOf("web-0.2.0")]);
    const view = await runToEnd("0.2.0", {
      digests: { app: digestOf("app-0.2.0"), web: digestOf("web-0.2.0") },
    });

    expect(view.phase).toBe("succeeded");
    const run = view.run;
    expect(run).not.toBeNull();
    expect(run?.outcome).toBe("succeeded");
    expect(run?.digestVerified).toBe(true);
    expect(run?.fromVersion).toBe("0.1.0");
    expect(run?.targetVersion).toBe("0.2.0");
    expect(run?.images).toEqual({ app: NEW_APP, web: NEW_WEB });
    expect(run?.steps.map((step) => [step.id, step.status])).toEqual(
      UPDATE_STEPS.map((id) => [id, "done"]),
    );
    expect(run?.progress).toBe(100);
    expect(run?.message).toEqual({ code: "run.succeeded", params: { version: "0.2.0" } });

    // .env: two lines changed, every other byte identical.
    const env = await h.readEnv();
    expect(env).toBe(
      DEFAULT_ENV.replace("restow:0.1.0", "restow:0.2.0").replace(
        "restow-web:0.1.0",
        "restow-web:0.2.0",
      ),
    );

    // The order of side effects: pull, dump, stop workers, up api, up workers, up edge.
    const relevant = h.ops.calls.filter((call) =>
      /^(pull|dumpDatabase|composeStop|composeUp|migrationCount)/.test(call),
    );
    expect(
      relevant.map((call) => call.replace(/ -t \d+/, "").replace(/restow-[0-9-]+-/, "restow-")),
    ).toEqual([
      `pull ${NEW_APP}`,
      `pull ${NEW_WEB}`,
      "migrationCount",
      expect.stringMatching(/^dumpDatabase restow-.*\.dump$/),
      "composeStop worker,scheduler",
      "composeUp api",
      "composeUp worker,scheduler",
      "composeUp caddy",
    ]);
    // Neither the database nor the api was ever touched by name beyond that.
    expect(h.ops.callsTo("composeStart")).toEqual([]);
    expect(h.ops.containers.get("api")?.image).toBe(NEW_APP);
    expect(h.ops.containers.get("caddy")?.image).toBe(NEW_WEB);

    // A verified dump was left behind.
    expect(await h.dumps.list()).toHaveLength(1);
  });

  it("refuses to announce a release that publishes no application digest", async () => {
    for (const digests of [{}, { web: releaseDigests("0.2.0").web }]) {
      await expect(h.engine.schedule(scheduleRequest("0.2.0", { digests }))).rejects.toMatchObject({
        name: "EngineError",
        code: "invalid_request",
        message: expect.stringContaining("no image digest"),
      });
    }
    expect(h.engine.view().phase).toBe("idle");
    expect(h.ops.callsTo("pull")).toEqual([]);
  });

  it("fails with fetch.digest_missing, before any pull, when the run has no digest", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    // A state file written by an older updater (or edited by hand) carries none.
    if (h.store.state.runContext) {
      h.store.state.runContext.digests = {};
    }
    h.clock.advance(60_000);
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("unchanged");
    expect(run?.failure?.code).toBe("fetch.digest_missing");
    expect(h.ops.callsTo("verifySignature")).toEqual([]);
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("verifies both signatures by digest, for exactly this release's signer, before pulling", async () => {
    const digests = releaseDigests("0.2.0");
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.signatureVerified).toBe(true);
    expect(view.run?.digestVerified).toBe(true);
    expect(h.ops.signatureChecks).toEqual([
      {
        image: `ghcr.io/restow-backup/restow@${digests.app}`,
        certificateIdentity: releaseSigner("0.2.0"),
        certificateOidcIssuer: "https://token.actions.githubusercontent.com",
        verifierImage: TEST_COSIGN_IMAGE,
      },
      {
        image: `ghcr.io/restow-backup/restow-web@${digests.web}`,
        certificateIdentity: releaseSigner("0.2.0"),
        certificateOidcIssuer: "https://token.actions.githubusercontent.com",
        verifierImage: TEST_COSIGN_IMAGE,
      },
    ]);
    const order = h.ops.calls.filter((call) => /^(verifySignature|pull) /.test(call));
    expect(order.map((call) => call.split(" ")[0])).toEqual([
      "verifySignature",
      "verifySignature",
      "pull",
      "pull",
    ]);
    const fetchStep = view.run?.steps.find((step) => step.id === "fetch");
    expect(fetchStep?.detail).toMatchObject({ signatureVerified: true, digestVerified: true });
  });

  it("installs nothing whose signature is missing or from another signer, also for the web image", async () => {
    const digests = releaseDigests("0.2.0");
    const cases: [string, string | null][] = [
      [`ghcr.io/restow-backup/restow@${digests.app}`, null],
      [`ghcr.io/restow-backup/restow@${digests.app}`, releaseSigner("0.1.9")],
      [
        `ghcr.io/restow-backup/restow@${digests.app}`,
        "https://github.com/attacker/restow/.github/workflows/release.yml@refs/tags/v0.2.0",
      ],
      [`ghcr.io/restow-backup/restow-web@${digests.web}`, null],
    ];
    for (const [image, signer] of cases) {
      await h.cleanup();
      h = await createHarness();
      h.ops.signatures.set(image, signer);
      const view = await runToEnd();
      expect(view.run?.outcome, image).toBe("unchanged");
      expect(view.run?.failure?.code).toBe("fetch.signature_invalid");
      expect(view.run?.signatureVerified).toBe(false);
      expect(view.run?.failure?.detail).toContain(image);
      expect(view.run?.failure?.detail).toContain(releaseSigner("0.2.0"));
      expect(h.ops.callsTo("pull")).toEqual([]);
      expect(h.ops.callsTo("dumpDatabase")).toEqual([]);
      expect(await h.readEnv()).toBe(DEFAULT_ENV);
    }
  });

  it("refuses a release tag the release workflow does not sign for the version", async () => {
    for (const tag of ["0.2.0", "release-0.2.0", "v0.2.1", "v0.2.0+build"]) {
      const request = scheduleRequest("0.2.0");
      request.release.tag = tag;
      await expect(h.engine.schedule(request)).rejects.toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("release workflow signs"),
      });
    }
    expect(h.engine.view().phase).toBe("idle");
  });

  it("checks only the digests when the operator switched signature verification off", async () => {
    await h.cleanup();
    h = await createHarness({ verifySignatures: false });
    apiAt(h, NEW_APP, { kind: "ready", reportsVersion: "0.2.0" });
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.signatureVerified).toBe(false);
    expect(view.run?.digestVerified).toBe(true);
    expect(h.ops.callsTo("verifySignature")).toEqual([]);
    expect(view.run?.log.some((line) => line.includes("switched off"))).toBe(true);
    // A digest is still required.
    await expect(
      h.engine.schedule(scheduleRequest("0.3.0", { digests: {} })),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("keeps the current web image when the release publishes no web digest, and pulls none", async () => {
    const view = await runToEnd("0.2.0", { digests: { app: releaseDigests("0.2.0").app } });
    expect(view.run?.outcome).toBe("succeeded");
    const fetchStep = view.run?.steps.find((step) => step.id === "fetch");
    expect(fetchStep?.detail.web).toBe("not_published");
    expect(view.run?.images.web).toBe("ghcr.io/restow-backup/restow-web:0.1.0");
    expect(h.ops.callsTo("pull")).toEqual([`pull ${NEW_APP}`]);
    expect(h.ops.signatureChecks.map((check) => check.image)).toEqual([
      `ghcr.io/restow-backup/restow@${releaseDigests("0.2.0").app}`,
    ]);
    const env = await h.readEnv();
    expect(env).toContain("RESTOW_IMAGE=ghcr.io/restow-backup/restow:0.2.0");
    expect(env).toContain("RESTOW_WEB_IMAGE=ghcr.io/restow-backup/restow-web:0.1.0");
    expect(h.ops.containers.get("caddy")?.image).toBe("ghcr.io/restow-backup/restow-web:0.1.0");
    expect(view.run?.log.some((line) => line.includes("no web image digest"))).toBe(true);
  });

  it("fails a web image error that is not 'manifest not found'", async () => {
    h.ops.registry.set(NEW_WEB, "denied");
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("unchanged");
    expect(view.run?.failure?.code).toBe("fetch.pull_failed");
  });

  it("does not accept a missing web manifest when the release published a web digest", async () => {
    h.ops.registry.set(NEW_WEB, "not_found");
    const view = await runToEnd("0.2.0");
    expect(view.run?.outcome).toBe("unchanged");
    expect(view.run?.failure?.code).toBe("fetch.pull_failed");
  });

  it("keeps progress monotonic and every state document valid", async () => {
    const seen: number[] = [];
    const original = h.store.save.bind(h.store);
    h.store.save = () => {
      seen.push(h.store.state.run?.progress ?? 0);
      const parsed = parseState(JSON.stringify(h.store.state));
      expect(parsed.ok).toBe(true);
      return original();
    };
    await runToEnd();
    expect(seen.length).toBeGreaterThan(10);
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index] as number).toBeGreaterThanOrEqual(seen[index - 1] as number);
    }
    expect(seen.at(-1)).toBe(100);
  });

  it("writes the journal events with chronological ids and the promised details", async () => {
    await runToEnd();
    const events = h.engine.view().events;
    expect(events.map((event) => event.action)).toEqual(["update.started", "update.succeeded"]);
    for (const event of events) {
      expect(journalEventSchema.safeParse(event).success).toBe(true);
      expect(event.actor.label).toBe("admin@example.com");
      expect(event.target).toBe("0.2.0");
    }
    const [started, succeeded] = events;
    expect(started?.details).toMatchObject({
      mode: "image",
      fromVersion: "0.1.0",
      targetVersion: "0.2.0",
    });
    expect(succeeded?.details).toMatchObject({
      mode: "image",
      outcome: "succeeded",
      failureCode: null,
      fromVersion: "0.1.0",
      targetVersion: "0.2.0",
      digestVerified: true,
      signatureVerified: true,
    });
    const steps = (
      succeeded?.details as { steps: { id: string; status: string; durationMs: number | null }[] }
    ).steps;
    expect(steps.map((step) => step.id)).toEqual([...UPDATE_STEPS]);
    expect(
      steps.every((step) => step.status === "done" && typeof step.durationMs === "number"),
    ).toBe(true);
    expect((succeeded?.details as { dumpFile: string }).dumpFile).toMatch(
      /^restow-\d{8}-\d{6}-0\.1\.0-to-0\.2\.0\.dump$/,
    );
    expect([...events.map((event) => event.id)].sort()).toEqual(events.map((event) => event.id));
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
  });

  it("moves the finished run into the history and clears it on acknowledge", async () => {
    await runToEnd();
    expect(h.engine.view().history).toHaveLength(1);
    expect("log" in (h.engine.view().history[0] ?? {})).toBe(false);
    await h.engine.acknowledge();
    const view = h.engine.view();
    expect(view.phase).toBe("idle");
    expect(view.run).toBeNull();
    expect(view.history).toHaveLength(1);
    expect(view.history[0]?.outcome).toBe("succeeded");
  });

  it("produces a run that matches the protocol schemas", async () => {
    const view = await runToEnd();
    expect(runSchema.safeParse(view.run).success).toBe(true);
    expect(view.run?.log.length).toBeGreaterThan(5);
    void stateViewSchema;
  });

  it("keeps no more than three dumps", async () => {
    for (const [index, version] of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"].entries()) {
      const image = `ghcr.io/restow-backup/restow:${version}`;
      apiAt(h, image, { kind: "ready", reportsVersion: version });
      h.clock.advance((index + 1) * 5000);
      await h.engine.schedule(scheduleRequest(version));
      await settle(h.engine);
      expect(h.engine.view().run?.outcome).toBe("succeeded");
      await h.engine.acknowledge();
    }
    expect(await h.dumps.list()).toHaveLength(3);
  });
});

describe("source mode success", () => {
  it("fetches with the token, builds both targets and installs the local tags", async () => {
    apiAt(h, "restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
          repository: "acme/restow",
          useToken: true,
        },
      }),
    );
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("succeeded");
    expect(run?.images).toEqual({ app: "restow:0.2.0", web: "restow-web:0.2.0" });
    expect(run?.digestVerified).toBeNull();
    // A custom source is built, not signed: nothing to verify (docs/UPDATING.md).
    expect(run?.signatureVerified).toBeNull();
    expect(h.ops.callsTo("verifySignature")).toEqual([]);
    expect(h.source.fetches).toEqual([
      {
        version: "0.2.0",
        archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
        token: "ghp_0123456789abcdefghijTOKEN",
      },
    ]);
    expect(h.ops.builds.map((build) => [build.target, build.tag, build.buildArgs])).toEqual([
      ["runtime", "restow:0.2.0", { RESTOW_VERSION: "0.2.0" }],
      ["web", "restow-web:0.2.0", {}],
    ]);
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(h.source.cleanups).toBe(1);
    const env = await h.readEnv();
    expect(env).toContain("RESTOW_IMAGE=restow:0.2.0");
    expect(env).toContain("RESTOW_WEB_IMAGE=restow-web:0.2.0");
  });

  it("refuses a source the operator did not allow, before anything is announced", async () => {
    h.source.notAllowed = true;
    const request = scheduleRequest("0.2.0", {
      mode: "source",
      source: {
        archiveUrl: "https://attacker.example/api/v1/repos/x/y/archive/v0.2.0.tar.gz",
        repository: "x/y",
        useToken: false,
      },
    });
    await expect(h.engine.schedule(request)).rejects.toMatchObject({
      name: "EngineError",
      code: "source_not_allowed",
    });
    expect(h.engine.view().phase).toBe("idle");
    expect(h.engine.view().run).toBeNull();
    expect(h.source.fetches).toEqual([]);
    expect(h.ops.builds).toEqual([]);
  });

  it("does not ask the api for a token when the source needs none", async () => {
    apiAt(h, "restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/a.tar.gz",
          repository: "acme/restow",
          useToken: false,
        },
      }),
    );
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("succeeded");
    expect(h.api.calls).not.toContain("sourceToken");
    expect(h.source.fetches[0]?.token).toBeNull();
  });

  it("fails with fetch.token_unavailable when the api has no token, before anything else", async () => {
    h.api.token = null;
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/a.tar.gz",
          repository: "acme/restow",
          useToken: true,
        },
      }),
    );
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("unchanged");
    expect(run?.failure?.code).toBe("fetch.token_unavailable");
    expect(h.source.fetches).toEqual([]);
    expect(h.ops.callsTo("dumpDatabase")).toEqual([]);
  });

  it("maps a failed download and a failed build to their codes", async () => {
    h.source.failWith = new Error("The download failed with HTTP 404.");
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/a.tar.gz",
          repository: "acme/restow",
          useToken: false,
        },
      }),
    );
    await settle(h.engine);
    expect(h.engine.view().run?.failure?.code).toBe("fetch.download_failed");
    await h.engine.acknowledge();

    h.source.failWith = null;
    h.clock.advance(5000);
    h.ops.failOn("build", new Error("build exploded"));
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/a.tar.gz",
          repository: "acme/restow",
          useToken: false,
        },
      }),
    );
    await settle(h.engine);
    expect(h.engine.view().run?.failure?.code).toBe("fetch.build_failed");
    expect(h.engine.view().run?.outcome).toBe("unchanged");
    // The fetched sources are removed although the build failed.
    expect(h.source.cleanups).toBe(1);
  });
});

describe("scheduling", () => {
  it("counts down, starts at startsAt and can be cancelled before", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 300 }));
    let view = h.engine.view();
    expect(view.phase).toBe("scheduled");
    expect(view.run?.message?.code).toBe("run.scheduled");
    expect(Date.parse(view.run?.startsAt ?? "") - Date.parse(view.run?.scheduledAt ?? "")).toBe(
      300_000,
    );
    expect(h.ops.callsTo("pull")).toEqual([]);

    await h.engine.cancel();
    view = h.engine.view();
    expect(view.phase).toBe("idle");
    expect(view.run).toBeNull();
    expect(view.history[0]).toMatchObject({ cancelled: true, outcome: null });
    expect(view.history[0]?.cancelledAt).not.toBeNull();
    expect(h.clock.pendingTimers).toBe(0);

    h.clock.advance(600_000);
    await Promise.resolve();
    expect(h.engine.view().phase).toBe("idle");
    expect(h.ops.calls.filter((call) => call.startsWith("pull"))).toEqual([]);
    expect(h.engine.view().events).toEqual([]);
  });

  it("starts by itself when the lead time is over", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    h.clock.advance(59_000);
    expect(h.engine.view().phase).toBe("scheduled");
    h.clock.advance(1000);
    await settle(h.engine);
    expect(h.engine.view().phase).toBe("succeeded");
  });

  it("refuses to cancel once the run started and when nothing is scheduled", async () => {
    await expect(h.engine.cancel()).rejects.toMatchObject({ code: "not_scheduled" });
    apiAt(h, NEW_APP, { kind: "ready", afterPolls: 3, reportsVersion: "0.2.0" });
    let attempted: unknown = null;
    const original = h.ops.pull.bind(h.ops);
    h.ops.pull = async (image) => {
      // The run is executing now.
      attempted = await h.engine.cancel().catch((error: unknown) => error);
      return original(image);
    };
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    expect(attempted).toBeInstanceOf(EngineError);
    expect((attempted as EngineError).code).toBe("running");
    expect(h.engine.view().phase).toBe("succeeded");
  });

  it("allows only one run at a time and replaces a finished run", async () => {
    await h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 }));
    await expect(h.engine.schedule(scheduleRequest("0.3.0"))).rejects.toMatchObject({
      code: "busy",
    });
    h.clock.advance(60_000);
    // Now running or done: still busy while running.
    if (h.engine.view().phase === "running") {
      await expect(h.engine.schedule(scheduleRequest("0.3.0"))).rejects.toMatchObject({
        code: "busy",
      });
    }
    await settle(h.engine);
    expect(h.engine.view().phase).toBe("succeeded");

    // The finished run may be replaced without acknowledging it.
    apiAt(h, "ghcr.io/restow-backup/restow:0.3.0", { kind: "ready", reportsVersion: "0.3.0" });
    h.clock.advance(5000);
    await h.engine.schedule(scheduleRequest("0.3.0"));
    await settle(h.engine);
    const view = h.engine.view();
    expect(view.run?.targetVersion).toBe("0.3.0");
    expect(view.history.map((entry) => entry.targetVersion)).toEqual(["0.3.0", "0.2.0"]);
  });

  it("does not let two concurrent schedule calls both pass", async () => {
    const results = await Promise.allSettled([
      h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 })),
      h.engine.schedule(scheduleRequest("0.2.0", { leadSeconds: 60 })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect((rejected.reason as EngineError).code).toBe("busy");
  });

  it("rejects versions that are not newer, invalid versions and blocked installations", async () => {
    await expect(h.engine.schedule(scheduleRequest("0.1.0"))).rejects.toMatchObject({
      code: "not_newer",
    });
    await expect(h.engine.schedule(scheduleRequest("0.0.9"))).rejects.toMatchObject({
      code: "not_newer",
    });
    await expect(h.engine.schedule(scheduleRequest("latest"))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(h.engine.schedule(scheduleRequest("0.2.0+build5"))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      h.engine.schedule(scheduleRequest("0.2.0", { mode: "source", source: null })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      h.engine.schedule(
        scheduleRequest("0.2.0", {
          mode: "source",
          source: { archiveUrl: "http://example.com/a.tar.gz", repository: "a/b", useToken: false },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });

    h.ops.pingError = new Error("cannot connect to the docker daemon");
    const blocked = await h.engine
      .schedule(scheduleRequest("0.2.0"))
      .catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(EngineError);
    expect((blocked as EngineError).code).toBe("blocked");
    expect((blocked as EngineError).blockers.map((blocker) => blocker.code)).toContain(
      "docker_unreachable",
    );
    expect(h.engine.view().phase).toBe("idle");
  });

  it("accepts a pre-release newer than the running release and an upgrade from a pre-release", async () => {
    apiAt(h, "ghcr.io/restow-backup/restow:0.2.0-rc.1", {
      kind: "ready",
      reportsVersion: "0.2.0-rc.1",
    });
    await h.engine.schedule(scheduleRequest("v0.2.0-rc.1"));
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("succeeded");
    expect(h.engine.view().run?.targetVersion).toBe("0.2.0-rc.1");
  });
});

describe("what leaves the process", () => {
  it("never holds the shared secret, database password or token in state, log or journal", async () => {
    h.redactor.add("shared-secret-value-0123456789");
    h.ops.failOn(
      "pull",
      new Error(
        "pull failed for https://ci-user:hunter2hunter2@registry.example.com/x with Authorization: Bearer abcdefghijklmnop",
      ),
      0,
    );
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const raw = await fs.readFile(`${h.stateDir}/status.json`, "utf8");
    for (const secret of ["hunter2hunter2", "abcdefghijklmnop", "super-secret-db-password"]) {
      expect(raw).not.toContain(secret);
    }
    expect(h.engine.view().run?.failure?.code).toBe("fetch.pull_failed");
    expect(h.engine.view().run?.failure?.detail).toContain("[redacted]");
  });

  it("redacts a database password found in .env from a failing command's output", async () => {
    h.ops.failOn(
      "dumpDatabase",
      new Error("pg_dump: connection string password=super-secret-db-password rejected"),
    );
    await h.engine.schedule(scheduleRequest("0.2.0"));
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.failure?.code).toBe("backup.failed");
    expect(JSON.stringify(run)).not.toContain("super-secret-db-password");
    expect(await fs.readFile(`${h.stateDir}/status.json`, "utf8")).not.toContain(
      "super-secret-db-password",
    );
  });

  it("never lets the source token reach state, log, journal or the logger", async () => {
    const token = "ghp_0123456789abcdefghijTOKEN";
    h.source.failWith = new Error(
      `request failed: Authorization: token ${token} was rejected; token=${token}`,
    );
    await h.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/a.tar.gz",
          repository: "acme/restow",
          useToken: true,
        },
      }),
    );
    await settle(h.engine);
    expect(h.engine.view().run?.failure?.code).toBe("fetch.download_failed");
    const everything = [
      await fs.readFile(`${h.stateDir}/status.json`, "utf8"),
      JSON.stringify(h.engine.view()),
      h.logger.lines.join("\n"),
    ].join("\n");
    expect(everything).not.toContain(token);
    // The token is forgotten once the run is over.
    expect(h.redactor.size).toBeGreaterThan(0);
  });

  it("puts only versions and failure codes into messages, never images, files or paths", async () => {
    const messages: string[] = [];
    const original = h.store.save.bind(h.store);
    h.store.save = () => {
      const message = h.store.state.run?.message;
      if (message) {
        messages.push(JSON.stringify(message));
      }
      return original();
    };
    apiAt(h, "ghcr.io/restow-backup/restow:0.2.0", { kind: "never", migrates: 1 });
    await runToEnd();
    expect(h.engine.view().run?.outcome).toBe("needs_attention");
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(message).not.toMatch(
        /ghcr\.io|restow:|restow-web|\.dump\b|\/state|\/tmp|docker|worker|scheduler/,
      );
    }
    // The operator's log keeps the details.
    const log = (h.engine.view().run?.log ?? []).join("\n");
    expect(log).toContain("ghcr.io/restow-backup/restow:0.2.0");
    expect(log).toMatch(/restow-\d{8}-\d{6}-0\.1\.0-to-0\.2\.0\.dump/);
  });

  it("keeps at most 200 redacted log lines", async () => {
    await runToEnd();
    const run = h.engine.view().run;
    expect(run?.log.length).toBeLessThanOrEqual(200);
    expect(run?.log.every((line) => line.length < 600)).toBe(true);
  });
});

describe("a Community installation", () => {
  const COMMUNITY_APP = "ghcr.io/restow-backup/restow-community:0.2.0";
  const COMMUNITY_WEB = "ghcr.io/restow-backup/restow-web-community:0.2.0";
  let c: Harness;

  beforeEach(async () => {
    c = await createHarness({ imageVariant: "community" });
  });

  afterEach(async () => {
    await c.cleanup();
  });

  it("verifies and installs the Community images of the release in image mode", async () => {
    apiAt(c, COMMUNITY_APP, { kind: "ready", reportsVersion: "0.2.0" });
    await c.engine.schedule(
      scheduleRequest("0.2.0", {
        digests: { app: digestOf(COMMUNITY_APP), web: digestOf(COMMUNITY_WEB) },
      }),
    );
    await settle(c.engine);
    const run = c.engine.view().run;
    expect(run?.outcome).toBe("succeeded");
    expect(run?.images).toEqual({ app: COMMUNITY_APP, web: COMMUNITY_WEB });
    expect(c.ops.callsTo("pull")).toEqual([`pull ${COMMUNITY_APP}`, `pull ${COMMUNITY_WEB}`]);
    expect(c.ops.signatureChecks.map((check) => check.image)).toEqual([
      `ghcr.io/restow-backup/restow-community@${digestOf(COMMUNITY_APP)}`,
      `ghcr.io/restow-backup/restow-web-community@${digestOf(COMMUNITY_WEB)}`,
    ]);
    const env = await c.readEnv();
    expect(env).toContain(`RESTOW_IMAGE=${COMMUNITY_APP}`);
    expect(env).toContain(`RESTOW_WEB_IMAGE=${COMMUNITY_WEB}`);
  });

  it("builds the Community targets in source mode", async () => {
    apiAt(c, "restow-community:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
    await c.engine.schedule(
      scheduleRequest("0.2.0", {
        mode: "source",
        source: {
          archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
          repository: "acme/restow",
          useToken: false,
        },
      }),
    );
    await settle(c.engine);
    const run = c.engine.view().run;
    expect(run?.outcome).toBe("succeeded");
    expect(run?.images).toEqual({
      app: "restow-community:0.2.0",
      web: "restow-web-community:0.2.0",
    });
    expect(c.ops.builds.map((build) => [build.target, build.tag])).toEqual([
      ["runtime-community", "restow-community:0.2.0"],
      ["web-community", "restow-web-community:0.2.0"],
    ]);
  });
});
