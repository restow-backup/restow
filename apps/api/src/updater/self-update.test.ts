import { afterEach, describe, expect, it } from "vitest";
import { envValueOf } from "./env-file.js";
import { memoryLogger } from "./logger.js";
import { UPDATER_IMAGE_PROBE } from "./preflight.js";
import { stateViewSchema } from "./protocol.js";
import { Redactor } from "./redact.js";
import {
  type SelfUpdateDecisionInput,
  pinOwnImage,
  pinnedReferenceOf,
  selfUpdateDecision,
} from "./self-update.js";
import {
  DEFAULT_ENV,
  FakeLauncher,
  type Harness,
  type HarnessOptions,
  apiAt,
  createHarness,
  releaseDigests,
  scheduleRequest,
  settle,
} from "./testing.js";

const APP = "ghcr.io/restow-backup/restow";
const DIGEST = `sha256:${"d".repeat(64)}`;

describe("selfUpdateDecision", () => {
  const base: SelfUpdateDecisionInput = {
    enabled: true,
    verifySignatures: true,
    updaterVersion: "0.2.0",
    run: {
      mode: "image",
      switchTo: null,
      outcome: "succeeded",
      signatureVerified: true,
      digestVerified: true,
      targetVersion: "0.2.1",
    },
    appDigest: DIGEST,
    imageRepository: APP,
  };
  const withRun = (run: Partial<SelfUpdateDecisionInput["run"]>) => ({
    ...base,
    run: { ...base.run, ...run },
  });

  it("moves to the verified application image of the release, by digest", () => {
    expect(selfUpdateDecision(base)).toEqual({
      action: "update",
      image: `${APP}:0.2.1@${DIGEST}`,
    });
    // An unversioned local build moves as well.
    expect(selfUpdateDecision({ ...base, updaterVersion: null })).toMatchObject({
      action: "update",
    });
  });

  it("does nothing after a failed run, or when the updater is already there", () => {
    expect(selfUpdateDecision(withRun({ outcome: "rolled_back" }))).toEqual({ action: "none" });
    expect(selfUpdateDecision({ ...base, updaterVersion: "0.2.1" })).toEqual({ action: "none" });
    expect(selfUpdateDecision({ ...base, updaterVersion: "0.3.0" })).toEqual({ action: "none" });
  });

  it("never moves without a verified signature, in source mode or when switched off", () => {
    expect(selfUpdateDecision({ ...base, enabled: false })).toEqual({
      action: "skip",
      reason: "disabled",
    });
    expect(selfUpdateDecision(withRun({ mode: "source", signatureVerified: null }))).toEqual({
      action: "skip",
      reason: "source_mode",
    });
    for (const input of [
      { ...base, verifySignatures: false },
      withRun({ signatureVerified: false }),
      withRun({ signatureVerified: null }),
      withRun({ digestVerified: false }),
      { ...base, appDigest: undefined },
    ]) {
      expect(selfUpdateDecision(input)).toEqual({
        action: "skip",
        reason: "signature_unverified",
      });
    }
  });
});

describe("pinnedReferenceOf", () => {
  it("adds the registry digest of the image's own repository to the reference", () => {
    expect(
      pinnedReferenceOf({
        configured: `${APP}:0.2.0`,
        repoDigests: [
          `registry.example.com/mirror/restow@sha256:${"a".repeat(64)}`,
          `${APP}@${DIGEST}`,
        ],
      }),
    ).toBe(`${APP}:0.2.0@${DIGEST}`);
    expect(pinnedReferenceOf({ configured: `${APP}@${DIGEST}`, repoDigests: [] })).toBe(
      `${APP}@${DIGEST}`,
    );
  });

  it("gives up on a local build or a digest of another repository", () => {
    expect(pinnedReferenceOf({ configured: "restow:local", repoDigests: [] })).toBeNull();
    expect(
      pinnedReferenceOf({ configured: `${APP}:0.2.0`, repoDigests: [`other/restow@${DIGEST}`] }),
    ).toBeNull();
  });
});

describe("pinOwnImage (first start)", () => {
  let h: Harness;
  afterEach(async () => {
    await h.cleanup();
  });

  it("pins the image the updater runs when RESTOW_UPDATER_IMAGE is empty, and then the preflight passes", async () => {
    h = await createHarness({ env: `${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=\n` });
    h.ops.updaterImage = "fallback";
    // Before: the updater follows RESTOW_IMAGE.
    expect(await h.ops.configUpdaterImage(UPDATER_IMAGE_PROBE)).toContain("probe");
    const before = await h.preflight.check({ deep: true });
    expect(before.blockers.map((blocker) => blocker.code)).toContain("updater_image_unpinned");

    const result = await pinOwnImage({
      envFile: h.envFile,
      ownImage: async () => ({ configured: `${APP}:0.1.0`, repoDigests: [`${APP}@${DIGEST}`] }),
      logger: h.logger,
    });
    expect(result).toBe("pinned");
    const env = await h.readEnv();
    expect(envValueOf(env, "RESTOW_UPDATER_IMAGE")).toBe(`${APP}:0.1.0@${DIGEST}`);
    // Everything else stays as the operator wrote it.
    expect(
      env.replace(`RESTOW_UPDATER_IMAGE=${APP}:0.1.0@${DIGEST}`, "RESTOW_UPDATER_IMAGE="),
    ).toBe(`${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=\n`);
    const after = await h.preflight.check({ deep: true });
    expect(after.blockers.map((blocker) => blocker.code)).not.toContain("updater_image_unpinned");
  });

  it("appends the line when .env has none", async () => {
    h = await createHarness();
    await pinOwnImage({
      envFile: h.envFile,
      ownImage: async () => ({ configured: `${APP}:0.1.0`, repoDigests: [`${APP}@${DIGEST}`] }),
      logger: h.logger,
    });
    expect(await h.readEnv()).toBe(`${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=${APP}:0.1.0@${DIGEST}\n`);
  });

  it("leaves a value the operator set, and pins nothing for a local build", async () => {
    h = await createHarness({ env: `${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=${APP}:0.1.0\n` });
    const own = async () => ({ configured: `${APP}:0.1.0`, repoDigests: [`${APP}@${DIGEST}`] });
    expect(await pinOwnImage({ envFile: h.envFile, ownImage: own, logger: h.logger })).toBe(
      "already_set",
    );
    expect(envValueOf(await h.readEnv(), "RESTOW_UPDATER_IMAGE")).toBe(`${APP}:0.1.0`);

    const local = memoryLogger(new Redactor());
    await h.envFile.replace(DEFAULT_ENV);
    expect(
      await pinOwnImage({
        envFile: h.envFile,
        ownImage: async () => ({ configured: "restow:local", repoDigests: [] }),
        logger: local,
      }),
    ).toBe("local_image");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });
});

describe("self-update after an image-mode update", () => {
  let h: Harness;
  let launcher: FakeLauncher;

  afterEach(async () => {
    await h.cleanup();
  });

  async function setup(options: HarnessOptions = {}, selfUpdate = {}): Promise<void> {
    launcher = new FakeLauncher();
    h = await createHarness({
      env: `${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=${APP}:0.1.0@${DIGEST}\n`,
      ...options,
      selfUpdate: { launcher, ...selfUpdate },
    });
    h.ops.updaterImage = "fallback";
    apiAt(h, `${APP}:0.2.0`, { kind: "ready", migrates: 1, reportsVersion: "0.2.0" });
    apiAt(h, "restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
  }

  async function update(overrides: Parameters<typeof scheduleRequest>[1] = {}) {
    await h.engine.schedule(scheduleRequest("0.2.0", overrides));
    await settle(h.engine);
    return h.engine.view();
  }

  const verified = `${APP}:0.2.0@${releaseDigests("0.2.0").app}`;

  it("pins the verified image by digest, recreates itself, and the new updater confirms it", async () => {
    await setup();
    // Compose stops the old updater while the helper runs.
    launcher.onWait = () => h.selfUpdater?.stop();
    const view = await update();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.signatureVerified).toBe(true);
    expect(launcher.launches).toBe(1);
    const env = await h.readEnv();
    expect(envValueOf(env, "RESTOW_UPDATER_IMAGE")).toBe(verified);
    expect(envValueOf(env, "RESTOW_IMAGE")).toBe(`${APP}:0.2.0`);
    // The compose file was asked what the updater would run, with the new value.
    expect(h.ops.callsTo("configUpdaterImage")).toContain(
      `configUpdaterImage ${JSON.stringify({ RESTOW_UPDATER_IMAGE: verified })}`,
    );
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "pending",
      fromVersion: "0.1.0",
      targetVersion: "0.2.0",
      image: verified,
    });

    const next = await h.restart({ selfUpdate: { launcher, updaterVersion: "0.2.0" } });
    h = next;
    expect(h.selfUpdater?.view().last).toMatchObject({ status: "succeeded", reason: null });
    // The run itself stays exactly as it was.
    expect(h.engine.view().run?.outcome).toBe("succeeded");
  });

  it("reports a self-update in the state view the api reads", async () => {
    await setup();
    launcher.onWait = () => h.selfUpdater?.stop();
    await update();
    const view = h.selfUpdater?.view();
    const parsed = stateViewSchema.shape.selfUpdate.parse(view);
    expect(parsed).toMatchObject({ enabled: true, verifiesSignatures: true });
  });

  it("records a failed helper without touching the successful update", async () => {
    await setup();
    launcher.exitCode = 1;
    launcher.output = "Error response from daemon: no such image";
    const view = await update();
    expect(view.phase).toBe("succeeded");
    expect(view.run?.outcome).toBe("succeeded");
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "failed",
      reason: "helper_failed",
      image: verified,
    });
    expect(h.selfUpdater?.view().last?.detail).toContain("no such image");
  });

  it("records when the helper succeeded but the updater was not replaced", async () => {
    await setup();
    await update();
    expect(h.selfUpdater?.view().last).toMatchObject({ status: "failed", reason: "not_replaced" });
  });

  it("records a helper that could not be started", async () => {
    await setup();
    launcher.launchError = new Error("Creating a container failed");
    await update();
    expect(h.selfUpdater?.view().last).toMatchObject({ status: "failed", reason: "launch_failed" });
    expect(h.engine.view().run?.outcome).toBe("succeeded");
  });

  it("writes nothing when the compose file does not take the updater image from RESTOW_UPDATER_IMAGE", async () => {
    await setup();
    h.ops.updaterImage = "pinned";
    await update();
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "failed",
      reason: "compose_unsupported",
    });
    expect(envValueOf(await h.readEnv(), "RESTOW_UPDATER_IMAGE")).toBe(`${APP}:0.1.0@${DIGEST}`);
    expect(launcher.launches).toBe(0);
  });

  it("is a failure on the next start when the old updater came back", async () => {
    await setup();
    launcher.onWait = () => h.selfUpdater?.stop();
    await update();
    h = await h.restart({ selfUpdate: { launcher, updaterVersion: "0.1.0" } });
    expect(h.selfUpdater?.view().last).toMatchObject({ status: "failed", reason: "not_replaced" });
  });

  it("never moves in source mode: the updater does not run what it built", async () => {
    await setup();
    const view = await update({
      mode: "source",
      source: {
        archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
        repository: "acme/restow",
        useToken: false,
      },
    });
    expect(view.run?.outcome).toBe("succeeded");
    expect(h.selfUpdater?.view().last).toMatchObject({ status: "skipped", reason: "source_mode" });
    expect(envValueOf(await h.readEnv(), "RESTOW_UPDATER_IMAGE")).toBe(`${APP}:0.1.0@${DIGEST}`);
    expect(launcher.launches).toBe(0);
  });

  it("never moves when signatures are not verified", async () => {
    await setup({ verifySignatures: false });
    const view = await update();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.signatureVerified).toBe(false);
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "skipped",
      reason: "signature_unverified",
    });
    expect(launcher.launches).toBe(0);
  });

  it("stays where it is when switched off", async () => {
    await setup({}, { enabled: false });
    await update();
    expect(h.selfUpdater?.view()).toMatchObject({
      enabled: false,
      last: { status: "skipped", reason: "disabled" },
    });
    expect(launcher.launches).toBe(0);
  });

  it("does nothing after a failed update", async () => {
    await setup();
    h.ops.signAll = false;
    const view = await update();
    expect(view.run?.outcome).toBe("unchanged");
    expect(h.selfUpdater?.view().last).toBeNull();
    expect(launcher.launches).toBe(0);
  });
});
