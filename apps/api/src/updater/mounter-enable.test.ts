import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envValueOf } from "./env-file.js";
import {
  MOUNTER_COMPOSE_PROBE,
  MounterEnableRefusedError,
  MounterEnabler,
  verifiedUpdaterImage,
} from "./mounter-enable.js";
import { type SelfUpdateRecord, stateViewSchema } from "./protocol.js";
import { buildServer } from "./server.js";
import { DEFAULT_ENV, FakeLauncher, type Harness, createHarness } from "./testing.js";

/** "Enable network shares" (docs/FILESHARES.md 3.9): POST /v1/mounter/enable. */

const APP = "ghcr.io/restow-backup/restow";
const VERIFIED = `${APP}:0.3.4@sha256:${"a".repeat(64)}`;
const SECRET = "e".repeat(64);
const auth = { Authorization: `Bearer ${SECRET}` };

function selfUpdate(overrides: Partial<SelfUpdateRecord> = {}): SelfUpdateRecord {
  return {
    status: "succeeded",
    reason: null,
    fromVersion: "0.3.3",
    targetVersion: "0.3.4",
    image: VERIFIED,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:01:00.000Z",
    detail: "",
    mounter: null,
    ...overrides,
  };
}

describe("verifiedUpdaterImage", () => {
  it("is the image the last confirmed self-update pinned", () => {
    expect(verifiedUpdaterImage({ updaterImage: VERIFIED, selfUpdate: selfUpdate() })).toBe(
      VERIFIED,
    );
  });

  it("is null for a first-start pin, a local build, a tag or an unconfirmed self-update", () => {
    expect(verifiedUpdaterImage({ updaterImage: VERIFIED, selfUpdate: null })).toBeNull();
    expect(verifiedUpdaterImage({ updaterImage: "restow:local", selfUpdate: null })).toBeNull();
    expect(
      verifiedUpdaterImage({
        updaterImage: `${APP}:0.3.4`,
        selfUpdate: selfUpdate({ image: `${APP}:0.3.4` }),
      }),
    ).toBeNull();
    for (const status of ["pending", "failed", "skipped"] as const) {
      expect(
        verifiedUpdaterImage({ updaterImage: VERIFIED, selfUpdate: selfUpdate({ status }) }),
      ).toBeNull();
    }
    expect(
      verifiedUpdaterImage({
        updaterImage: VERIFIED,
        selfUpdate: selfUpdate({ image: `${APP}:0.3.3@sha256:${"b".repeat(64)}` }),
      }),
    ).toBeNull();
    expect(verifiedUpdaterImage({ updaterImage: null, selfUpdate: selfUpdate() })).toBeNull();
  });
});

describe("MounterEnabler", () => {
  let h: Harness;
  let launcher: FakeLauncher;

  beforeEach(async () => {
    h = await createHarness();
    launcher = new FakeLauncher();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function enabler(options: { launcher?: FakeLauncher | null; phase?: string } = {}) {
    return new MounterEnabler({
      envFile: h.envFile,
      ops: h.ops,
      launcher: options.launcher === undefined ? launcher : options.launcher,
      store: h.store,
      phase: () => (options.phase ?? h.engine.view().phase) as never,
      clock: h.clock,
      logger: h.logger,
      redactor: h.redactor,
    });
  }

  it("starts the mounter through the helper and leaves an empty line empty", async () => {
    const subject = enabler();
    const { done } = await subject.start();
    expect(subject.view().last?.status).toBe("running");
    await done;
    const last = subject.view().last;
    expect(last).toMatchObject({ status: "started", reason: null, image: null, detail: "" });
    expect(last?.finishedAt).not.toBeNull();
    expect(launcher.launches).toBe(1);
    // The compose file was checked with the probe value, and nothing was written.
    expect(h.ops.calls).toContain(
      `configMounterImage ${JSON.stringify({ RESTOW_MOUNTER_IMAGE: MOUNTER_COMPOSE_PROBE })}`,
    );
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBeNull();
    // Kept in the state document (it survives a restart).
    expect(h.store.state.mounterEnable?.status).toBe("started");
  });

  it("writes the verified image the updater runs into RESTOW_MOUNTER_IMAGE", async () => {
    await h.envFile.pinImage("RESTOW_UPDATER_IMAGE", VERIFIED);
    h.store.state.selfUpdate = selfUpdate();
    const subject = enabler();
    await (await subject.start()).done;
    expect(subject.view().last).toMatchObject({ status: "started", image: VERIFIED });
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBe(VERIFIED);
  });

  it("does not write an image the updater only pinned on its first start", async () => {
    await h.envFile.pinImage("RESTOW_UPDATER_IMAGE", VERIFIED);
    const subject = enabler();
    await (await subject.start()).done;
    expect(subject.view().last).toMatchObject({ status: "started", image: null });
    expect(envValueOf(await h.readEnv(), "RESTOW_MOUNTER_IMAGE")).toBeNull();
  });

  it("refuses a compose file without the mounter service", async () => {
    h.ops.mounterImage = "none";
    const subject = enabler();
    await (await subject.start()).done;
    expect(subject.view().last).toMatchObject({
      status: "failed",
      reason: "compose_unsupported",
    });
    expect(subject.view().last?.detail).toContain('profile "mounts"');
    expect(launcher.launches).toBe(0);
  });

  it("refuses a mounter service that does not take RESTOW_MOUNTER_IMAGE", async () => {
    h.ops.mounterImage = "pinned";
    const subject = enabler();
    await (await subject.start()).done;
    expect(subject.view().last?.reason).toBe("compose_unsupported");
    expect(launcher.launches).toBe(0);
  });

  it("refuses while an update is scheduled or running, or the updater replaces itself", async () => {
    for (const phase of ["scheduled", "running"]) {
      await expect(enabler({ phase }).start()).rejects.toBeInstanceOf(MounterEnableRefusedError);
    }
    h.store.state.selfUpdate = selfUpdate({ status: "pending", finishedAt: null });
    await expect(enabler().start()).rejects.toThrow(/replacing itself/);
    expect(launcher.launches).toBe(0);
    expect(h.store.state.mounterEnable).toBeNull();
  });

  it("refuses a second start while the first one runs", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new FakeLauncher();
    const original = slow.launch.bind(slow);
    slow.launch = async () => {
      await gate;
      return await original();
    };
    const subject = enabler({ launcher: slow });
    const first = await subject.start();
    await expect(subject.start()).rejects.toThrow(/already/);
    release();
    await first.done;
    expect(subject.view().last?.status).toBe("started");
    // Once finished, it may be started again.
    await (await subject.start()).done;
    expect(slow.launches).toBe(2);
  });

  it("records a helper failure, redacted", async () => {
    h.redactor.add("hunter2-secret-value");
    launcher.exitCode = 1;
    launcher.output = "Error response from daemon: hunter2-secret-value denied";
    const subject = enabler();
    await (await subject.start()).done;
    const last = subject.view().last;
    expect(last).toMatchObject({ status: "failed", reason: "helper_failed" });
    expect(last?.detail).toContain("exited with 1");
    expect(last?.detail).not.toContain("hunter2-secret-value");
  });

  it("records a helper that does not finish and one that cannot be launched", async () => {
    launcher.exitCode = null;
    const subject = enabler();
    await (await subject.start()).done;
    expect(subject.view().last).toMatchObject({ status: "failed", reason: "helper_failed" });
    expect(subject.view().last?.detail).toContain("did not finish in time");

    launcher.launchError = new Error("no such image");
    await (await subject.start()).done;
    expect(subject.view().last).toMatchObject({ status: "failed", reason: "launch_failed" });

    const without = enabler({ launcher: null });
    await (await without.start()).done;
    expect(without.view().last).toMatchObject({ status: "failed", reason: "launch_failed" });
  });

  it("marks a start the previous process left running as interrupted", async () => {
    h.store.state.mounterEnable = {
      status: "running",
      reason: null,
      image: null,
      requestedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: null,
      detail: "",
    };
    const subject = enabler();
    await subject.reconcile();
    expect(subject.view().last).toMatchObject({ status: "failed", reason: "interrupted" });
  });
});

describe("POST /v1/mounter/enable", () => {
  let h: Harness;
  let launcher: FakeLauncher;

  beforeEach(async () => {
    h = await createHarness({ env: DEFAULT_ENV });
    h.redactor.add(SECRET);
    launcher = new FakeLauncher();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function server(withEnabler = true, waitMs?: number) {
    return buildServer({
      engine: h.engine,
      preflight: h.preflight,
      secret: SECRET,
      clock: h.clock,
      updaterVersion: "0.1.0",
      logger: h.logger,
      redactor: h.redactor,
      ...(withEnabler
        ? {
            mounterEnable: new MounterEnabler({
              envFile: h.envFile,
              ops: h.ops,
              launcher,
              store: h.store,
              phase: () => h.engine.view().phase,
              clock: h.clock,
              logger: h.logger,
              redactor: h.redactor,
            }),
          }
        : {}),
      ...(waitMs !== undefined ? { mounterEnableWaitMs: waitMs } : {}),
    });
  }

  it("needs the secret", async () => {
    const response = await server().request("/v1/mounter/enable", { method: "POST" });
    expect(response.status).toBe(401);
    expect(launcher.launches).toBe(0);
  });

  it("starts the mounter and answers with the state, the outcome included", async () => {
    const response = await server().request("/v1/mounter/enable", {
      method: "POST",
      headers: auth,
    });
    expect(response.status).toBe(200);
    const view = stateViewSchema.parse(await response.json());
    expect(view.mounterEnable?.last).toMatchObject({ status: "started" });
    expect(launcher.launches).toBe(1);
  });

  it("answers 202 while the helper still runs", async () => {
    launcher.launch = () => new Promise(() => undefined);
    const response = await server(true, 10).request("/v1/mounter/enable", {
      method: "POST",
      headers: auth,
    });
    expect(response.status).toBe(202);
    const view = stateViewSchema.parse(await response.json());
    expect(view.mounterEnable?.last?.status).toBe("running");
  });

  it("refuses with 409 busy during an update", async () => {
    h.store.state.selfUpdate = selfUpdate({ status: "pending", finishedAt: null });
    const response = await server().request("/v1/mounter/enable", {
      method: "POST",
      headers: auth,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "busy" });
  });

  it("is 404 on an updater without the enabler, and the state says so", async () => {
    const app = server(false);
    const response = await app.request("/v1/mounter/enable", { method: "POST", headers: auth });
    expect(response.status).toBe(404);
    const state = stateViewSchema.parse(
      await (await app.request("/v1/state", { headers: auth })).json(),
    );
    expect(state.mounterEnable).toBeNull();
  });

  it("an older updater's state (no mounterEnable) parses as null", () => {
    expect(stateViewSchema.shape.mounterEnable.parse(undefined)).toBeNull();
  });
});
