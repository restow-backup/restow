import { afterEach, describe, expect, it } from "vitest";
import { envValueOf } from "./env-file.js";
import { scheduleRequestSchema } from "./protocol.js";
import {
  COMMUNITY_ENV,
  FakeLauncher,
  type Harness,
  apiAt,
  createHarness,
  releaseDigests,
  releaseSigner,
  scheduleRequest,
  settle,
} from "./testing.js";

/**
 * The build switch (docs/UPDATING.md, "Switching to the full build"): a Community
 * installation moves to the full images of its own version, through the normal
 * pipeline, and never the other way.
 */

const FULL_APP = "ghcr.io/restow-backup/restow:0.1.0";
const FULL_WEB = "ghcr.io/restow-backup/restow-web:0.1.0";

let h: Harness;

afterEach(async () => {
  await h.cleanup();
});

function switchRequest(version = "0.1.0") {
  return scheduleRequest(version, { switchTo: "full", digests: releaseDigests(version) });
}

describe("switching a Community installation to the full build", () => {
  it("installs the verified full images of the same version through the normal pipeline", async () => {
    h = await createHarness({ imageVariant: "community" });
    apiAt(h, FULL_APP, { kind: "ready", reportsVersion: "0.1.0" });
    await h.engine.schedule(switchRequest());
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run).toMatchObject({
      outcome: "succeeded",
      switchTo: "full",
      fromVersion: "0.1.0",
      targetVersion: "0.1.0",
      signatureVerified: true,
      digestVerified: true,
      images: { app: FULL_APP, web: FULL_WEB },
    });
    // The signatures of the full images, by the release identity of the tag.
    expect(h.ops.signatureChecks.map((check) => check.image)).toEqual([
      `ghcr.io/restow-backup/restow@${releaseDigests("0.1.0").app}`,
      `ghcr.io/restow-backup/restow-web@${releaseDigests("0.1.0").web}`,
    ]);
    expect(h.ops.signatureChecks[0]?.certificateIdentity).toBe(releaseSigner("0.1.0"));
    // A dump first, as for every update.
    expect(await h.dumps.list()).toHaveLength(1);
    const env = await h.readEnv();
    expect(envValueOf(env, "RESTOW_IMAGE")).toBe(FULL_APP);
    expect(envValueOf(env, "RESTOW_WEB_IMAGE")).toBe(FULL_WEB);
  });

  it("moves the updater to the full image as well, by the verified digest", async () => {
    const launcher = new FakeLauncher();
    h = await createHarness({
      imageVariant: "community",
      env: `${COMMUNITY_ENV}RESTOW_UPDATER_IMAGE=ghcr.io/restow-backup/restow-community:0.1.0@sha256:${"c".repeat(64)}\n`,
      selfUpdate: { launcher, updaterVersion: "0.1.0" },
    });
    h.ops.updaterImage = "fallback";
    launcher.onWait = () => h.selfUpdater?.stop();
    apiAt(h, FULL_APP, { kind: "ready", reportsVersion: "0.1.0" });
    await h.engine.schedule(switchRequest());
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("succeeded");
    expect(launcher.launches).toBe(1);
    expect(envValueOf(await h.readEnv(), "RESTOW_UPDATER_IMAGE")).toBe(
      `${FULL_APP}@${releaseDigests("0.1.0").app}`,
    );
  });

  it("rolls back to the Community images when the full build does not start", async () => {
    h = await createHarness({ imageVariant: "community" });
    apiAt(h, FULL_APP, { kind: "never" });
    await h.engine.schedule(switchRequest());
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("rolled_back");
    expect(await h.readEnv()).toBe(COMMUNITY_ENV);
  });

  it("refuses to switch a full installation (no way back to Community)", async () => {
    h = await createHarness();
    await expect(h.engine.schedule(switchRequest())).rejects.toMatchObject({
      name: "EngineError",
      code: "invalid_request",
    });
    expect(h.engine.view().phase).toBe("idle");
  });

  it("refuses a switch to another version, and a switch built from source", async () => {
    h = await createHarness({ imageVariant: "community" });
    await expect(
      h.engine.schedule(scheduleRequest("0.2.0", { switchTo: "full" })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      h.engine.schedule(
        scheduleRequest("0.1.0", {
          switchTo: "full",
          mode: "source",
          source: {
            archiveUrl: "https://example.com/archive/v0.1.0.tar.gz",
            repository: "acme/restow",
            useToken: false,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("does not even accept a switch to the Community build on the wire", () => {
    const request = { ...scheduleRequest("0.1.0"), switchTo: "community" };
    expect(scheduleRequestSchema.safeParse(request).success).toBe(false);
    // An older api that sends no switchTo asks for a normal update.
    const { switchTo: _ignored, ...plain } = scheduleRequest("0.2.0");
    expect(scheduleRequestSchema.parse(plain).switchTo).toBeNull();
  });
});
