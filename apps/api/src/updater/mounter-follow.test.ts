import { afterEach, describe, expect, it } from "vitest";
import { envValueOf } from "./env-file.js";
import { HttpMounterStatus } from "./mounter-status.js";
import { stateViewSchema } from "./protocol.js";
import { mounterUpdateDecision } from "./self-update.js";
import {
  DEFAULT_ENV,
  FakeLauncher,
  FakeMounterStatus,
  type Harness,
  type HarnessOptions,
  apiAt,
  createHarness,
  releaseDigests,
  scheduleRequest,
  settle,
} from "./testing.js";

/** The mounter follows the updater to a verified release image (self-update.ts, followMounter). */

const APP = "ghcr.io/restow-backup/restow";
const DIGEST = `sha256:${"d".repeat(64)}`;

describe("mounterUpdateDecision", () => {
  const image = `${APP}:0.2.1@${DIGEST}`;
  const update = { action: "update", image } as const;

  it("follows the updater's verified image when the mounter is in use", () => {
    expect(
      mounterUpdateDecision({
        selfUpdate: update,
        mounterImage: `${APP}:0.2.0@sha256:${"e".repeat(64)}`,
        mounterContainer: false,
      }),
    ).toEqual({ action: "update", image });
    // A container without a pinned line (a local build, or a line emptied by hand).
    expect(
      mounterUpdateDecision({ selfUpdate: update, mounterImage: "", mounterContainer: true }),
    ).toEqual({ action: "update", image });
  });

  it("leaves an installation without a mounter alone", () => {
    for (const mounterImage of [null, ""]) {
      expect(
        mounterUpdateDecision({ selfUpdate: update, mounterImage, mounterContainer: false }),
      ).toEqual({ action: "none" });
    }
  });

  it("never moves when the updater does not: switched off, source mode, unverified, by tag", () => {
    for (const selfUpdate of [
      { action: "none" } as const,
      { action: "skip", reason: "disabled" } as const,
      { action: "skip", reason: "source_mode" } as const,
      { action: "skip", reason: "signature_unverified" } as const,
      { action: "update", image: `${APP}:0.2.1` } as const,
    ]) {
      expect(
        mounterUpdateDecision({ selfUpdate, mounterImage: `${APP}:0.2.0`, mounterContainer: true }),
      ).toEqual({ action: "none" });
    }
  });
});

describe("HttpMounterStatus", () => {
  const answering = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;

  it("reads `busy` from the mounter's health check", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ status: "ok", busy: true }));
    }) as unknown as typeof fetch;
    expect(
      await new HttpMounterStatus({ url: "http://mounter:8091", fetch: fetchImpl }).busy(),
    ).toBe(true);
    expect(urls).toEqual(["http://mounter:8091/healthz"]);
    expect(
      await new HttpMounterStatus({
        url: "http://mounter:8091",
        fetch: answering(200, { status: "ok", busy: false }),
      }).busy(),
    ).toBe(false);
  });

  it("is unknown for an older mounter, an error or no answer", async () => {
    for (const fetchImpl of [
      answering(200, { status: "ok" }),
      answering(503, { busy: false }),
      (async () => {
        throw new Error("getaddrinfo ENOTFOUND mounter");
      }) as unknown as typeof fetch,
    ]) {
      expect(
        await new HttpMounterStatus({ url: "http://mounter:8091", fetch: fetchImpl }).busy(),
      ).toBeNull();
    }
  });
});

describe("the mounter follows the updater after an image-mode update", () => {
  let h: Harness;
  let launcher: FakeLauncher;
  let mounterLauncher: FakeLauncher;
  const OLD_MOUNTER = `${APP}:0.1.0@sha256:${"e".repeat(64)}`;
  const verified = `${APP}:0.2.0@${releaseDigests("0.2.0").app}`;

  afterEach(async () => {
    await h.cleanup();
  });

  interface SetupOptions extends HarnessOptions {
    /** The RESTOW_MOUNTER_IMAGE line (null: none). */
    mounterLine?: string | null;
    status?: FakeMounterStatus;
    selfUpdateEnabled?: boolean;
  }

  async function setup(options: SetupOptions = {}): Promise<void> {
    launcher = new FakeLauncher();
    mounterLauncher = new FakeLauncher();
    const { mounterLine = OLD_MOUNTER, status, selfUpdateEnabled = true, ...harness } = options;
    h = await createHarness({
      env: `${DEFAULT_ENV}RESTOW_UPDATER_IMAGE=${APP}:0.1.0@${DIGEST}\n${
        mounterLine === null ? "" : `RESTOW_MOUNTER_IMAGE=${mounterLine}\n`
      }`,
      ...harness,
      selfUpdate: {
        enabled: selfUpdateEnabled,
        launcher,
        mounter: {
          launcher: mounterLauncher,
          ...(status ? { status } : {}),
          idleWaitMs: 60_000,
          pollMs: 10_000,
        },
      },
    });
    h.ops.updaterImage = "fallback";
    // Compose stops the old updater while its helper runs.
    launcher.onWait = () => h.selfUpdater?.stop();
    apiAt(h, `${APP}:0.2.0`, { kind: "ready", migrates: 1, reportsVersion: "0.2.0" });
    apiAt(h, "restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
  }

  async function update(overrides: Parameters<typeof scheduleRequest>[1] = {}) {
    await h.engine.schedule(scheduleRequest("0.2.0", overrides));
    await settle(h.engine);
    return h.engine.view();
  }

  it("pins RESTOW_MOUNTER_IMAGE to the verified image and recreates the mounter before the updater", async () => {
    await setup();
    let mounterFirst = false;
    launcher.onWait = () => {
      mounterFirst = mounterLauncher.launches === 1;
      h.selfUpdater?.stop();
    };
    const view = await update();
    expect(view.run?.outcome).toBe("succeeded");
    expect(mounterLauncher.launches).toBe(1);
    expect(mounterFirst).toBe(true);
    const env = await h.readEnv();
    expect(envValueOf(env, "RESTOW_MOUNTER_IMAGE")).toBe(verified);
    expect(envValueOf(env, "RESTOW_UPDATER_IMAGE")).toBe(verified);
    // The compose file was asked what the mounter would run, with the new value.
    expect(h.ops.callsTo("configMounterImage")).toContain(
      `configMounterImage ${JSON.stringify({ RESTOW_MOUNTER_IMAGE: verified })}`,
    );
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "pending",
      mounter: { status: "succeeded", reason: null, image: verified },
    });
    // It survives the restart of the updater and parses as the api reads it.
    h = await h.restart({ selfUpdate: { launcher, updaterVersion: "0.2.0" } });
    const last = h.selfUpdater?.view().last;
    expect(last).toMatchObject({ status: "succeeded", mounter: { status: "succeeded" } });
    expect(stateViewSchema.shape.selfUpdate.parse(h.selfUpdater?.view())?.last?.mounter).toEqual(
      last?.mounter,
    );
  });

  it("recreates a mounter whose line is empty when its container exists", async () => {
    await setup({ mounterLine: "" });
    h.ops.mounterContainer = true;
    await update();
    expect(mounterLauncher.launches).toBe(1);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(verified);
  });

  it("does nothing for an installation without a mounter", async () => {
    await setup({ mounterLine: "" });
    await update();
    expect(launcher.launches).toBe(1);
    expect(mounterLauncher.launches).toBe(0);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe("");
    expect(h.selfUpdater?.view().last?.mounter).toBeNull();
    expect(h.ops.callsTo("configMounterImage")).toEqual([]);
  });

  it("waits while the mounter changes a share, then goes ahead", async () => {
    const status = new FakeMounterStatus([true, true, false]);
    await setup({ status });
    await update();
    expect(status.calls).toBe(3);
    expect(mounterLauncher.launches).toBe(1);
    expect(h.selfUpdater?.view().last?.mounter?.status).toBe("succeeded");
  });

  it("goes ahead when the mounter's status cannot be read", async () => {
    await setup({ status: new FakeMounterStatus([null]) });
    await update();
    expect(mounterLauncher.launches).toBe(1);
  });

  it("leaves a mounter that stays busy alone, and the updater still moves", async () => {
    await setup({ status: new FakeMounterStatus([true]) });
    const view = await update();
    expect(view.run?.outcome).toBe("succeeded");
    expect(mounterLauncher.launches).toBe(0);
    expect(launcher.launches).toBe(1);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(OLD_MOUNTER);
    expect(h.selfUpdater?.view().last).toMatchObject({
      status: "pending",
      image: verified,
      mounter: { status: "skipped", reason: "busy", image: null },
    });
  });

  it("records a failed mounter helper without failing the update or the updater's move", async () => {
    await setup();
    mounterLauncher.exitCode = 1;
    mounterLauncher.output = "Error response from daemon: conflict";
    const view = await update();
    expect(view.run?.outcome).toBe("succeeded");
    expect(launcher.launches).toBe(1);
    expect(h.selfUpdater?.view().last?.mounter).toMatchObject({
      status: "failed",
      reason: "helper_failed",
      image: verified,
    });
    expect(h.selfUpdater?.view().last?.mounter?.detail).toContain("conflict");
  });

  it("records a mounter helper that does not finish in time", async () => {
    await setup();
    mounterLauncher.exitCode = null;
    await update();
    expect(h.selfUpdater?.view().last?.mounter).toMatchObject({
      status: "failed",
      reason: "helper_failed",
    });
    expect(launcher.launches).toBe(1);
  });

  it("records a mounter helper that could not be started", async () => {
    await setup();
    mounterLauncher.launchError = new Error("Creating a container failed");
    await update();
    expect(h.selfUpdater?.view().last?.mounter).toMatchObject({
      status: "failed",
      reason: "launch_failed",
    });
    expect(launcher.launches).toBe(1);
  });

  it("writes nothing when the compose file does not take the mounter image from RESTOW_MOUNTER_IMAGE", async () => {
    await setup();
    h.ops.mounterImage = "pinned";
    await update();
    expect(h.selfUpdater?.view().last?.mounter).toMatchObject({
      status: "failed",
      reason: "compose_unsupported",
      image: null,
    });
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(OLD_MOUNTER);
    expect(mounterLauncher.launches).toBe(0);
    expect(launcher.launches).toBe(1);
  });

  it("closes a mounter move the stopped updater left pending as interrupted", async () => {
    await setup();
    mounterLauncher.onWait = () => h.selfUpdater?.stop();
    await update();
    expect(h.selfUpdater?.view().last?.mounter?.status).toBe("pending");
    h = await h.restart({ selfUpdate: { launcher, updaterVersion: "0.1.0" } });
    expect(h.selfUpdater?.view().last?.mounter).toMatchObject({
      status: "failed",
      reason: "interrupted",
    });
  });

  it("never moves the mounter in source mode", async () => {
    await setup();
    await update({
      mode: "source",
      source: {
        archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
        repository: "acme/restow",
        useToken: false,
      },
    });
    expect(mounterLauncher.launches).toBe(0);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(OLD_MOUNTER);
  });

  it("never moves the mounter without verified signatures", async () => {
    await setup({ verifySignatures: false });
    await update();
    expect(mounterLauncher.launches).toBe(0);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(OLD_MOUNTER);
  });

  it("never moves the mounter when the self-update is switched off", async () => {
    await setup({ selfUpdateEnabled: false });
    await update();
    expect(mounterLauncher.launches).toBe(0);
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(OLD_MOUNTER);
  });
});
