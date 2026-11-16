import { afterEach, describe, expect, it } from "vitest";
import { envValueOf } from "./env-file.js";
import { OpsError } from "./ops.js";
import { scheduleRequestSchema } from "./protocol.js";
import {
  apiAt,
  COMMUNITY_ENV,
  createHarness,
  DEFAULT_ENV,
  digestOf,
  type Harness,
  releaseDigests,
  releaseSigner,
  scheduleRequest,
  settle,
} from "./testing.js";

/**
 * The recovery lab (profile recovery-lab, docs/BAREMETAL.md) follows an update where
 * .env names its image: verified like the other images, pulled before the switch,
 * recreated after it and taken back by a rollback (docs/UPDATING.md) [UPDATE-018].
 */

const NEW_APP = "ghcr.io/restow-backup/restow:0.2.0";
const NEW_WEB = "ghcr.io/restow-backup/restow-web:0.2.0";
const OLD_LAB = "ghcr.io/restow-backup/restow-lab:0.1.0";
const NEW_LAB = "ghcr.io/restow-backup/restow-lab:0.2.0";
const LAB_ENV = `${DEFAULT_ENV}RESTOW_LAB_IMAGE=${OLD_LAB}\n`;

let h: Harness;

afterEach(async () => {
  await h.cleanup();
});

async function withLab(env = LAB_ENV, options: Parameters<typeof createHarness>[0] = {}) {
  h = await createHarness({ env, ...options });
  h.ops.containers.set("recovery-lab", {
    image: envValueOf(env, "RESTOW_LAB_IMAGE") || "restow-lab:local",
    state: "running",
    exitCode: null,
    polls: 0,
  });
  apiAt(h, NEW_APP, { kind: "ready", reportsVersion: "0.2.0" });
}

async function run(version = "0.2.0", overrides: Parameters<typeof scheduleRequest>[1] = {}) {
  await h.engine.schedule(scheduleRequest(version, overrides));
  await settle(h.engine);
  const view = h.engine.view();
  if (!view.run) {
    throw new Error("no run");
  }
  return view.run;
}

function labImage(): string | undefined {
  return h.ops.containers.get("recovery-lab")?.image;
}

describe("an installation with the recovery lab [UPDATE-018]", () => {
  it("moves RESTOW_LAB_IMAGE to the verified lab image of the target and recreates the lab", async () => {
    await withLab();
    const result = await run();

    expect(result.outcome).toBe("succeeded");
    // Exactly the three image lines changed; every other byte is the operator's.
    expect(await h.readEnv()).toBe(
      LAB_ENV.replace("restow:0.1.0", "restow:0.2.0")
        .replace("restow-web:0.1.0", "restow-web:0.2.0")
        .replace("restow-lab:0.1.0", "restow-lab:0.2.0"),
    );
    // Its signature by the release identity of the tag, by digest, like the others.
    const labByDigest = `ghcr.io/restow-backup/restow-lab@${releaseDigests("0.2.0").lab}`;
    expect(h.ops.signatureChecks.map((check) => check.image)).toEqual([
      `ghcr.io/restow-backup/restow@${releaseDigests("0.2.0").app}`,
      `ghcr.io/restow-backup/restow-web@${releaseDigests("0.2.0").web}`,
      labByDigest,
    ]);
    expect(h.ops.signatureChecks[2]?.certificateIdentity).toBe(releaseSigner("0.2.0"));
    // Every signature before the first pull, every pull before .env changes.
    const calls = h.ops.calls;
    const labVerified = calls.indexOf(`verifySignature ${labByDigest} ${releaseSigner("0.2.0")}`);
    const firstPull = calls.findIndex((call) => call.startsWith("pull "));
    expect(labVerified).toBeGreaterThan(-1);
    expect(labVerified).toBeLessThan(firstPull);
    expect(h.ops.callsTo("pull")).toEqual([
      `pull ${NEW_APP}`,
      `pull ${NEW_WEB}`,
      `pull ${NEW_LAB}`,
    ]);
    expect(h.ops.callsTo("imageDigests")).toContain(`imageDigests ${NEW_LAB}`);
    // Recreated after the edge, on the new image.
    expect(h.ops.callsTo("composeUp")).toEqual([
      "composeUp api",
      "composeUp worker,scheduler",
      "composeUp caddy",
      "composeUp recovery-lab",
    ]);
    expect(labImage()).toBe(NEW_LAB);
    expect(result.steps.find((step) => step.id === "fetch")?.detail.lab).toBe(NEW_LAB);
    expect(result.signatureVerified).toBe(true);
    expect(result.digestVerified).toBe(true);
  });

  it("uses the one lab repository for a Community installation and for the build switch", async () => {
    const env = `${COMMUNITY_ENV}RESTOW_LAB_IMAGE=${OLD_LAB}\n`;
    await withLab(env, { imageVariant: "community" });
    apiAt(h, "ghcr.io/restow-backup/restow:0.1.0", { kind: "ready", reportsVersion: "0.1.0" });
    const result = await run("0.1.0", { switchTo: "full", digests: releaseDigests("0.1.0") });
    expect(result.outcome).toBe("succeeded");
    expect(h.ops.signatureChecks.map((check) => check.image)).toContain(
      `ghcr.io/restow-backup/restow-lab@${releaseDigests("0.1.0").lab}`,
    );
    expect(envValueOf(await h.readEnv(), "RESTOW_LAB_IMAGE")).toBe(OLD_LAB);
    expect(h.ops.callsTo("composeUp")).toContain("composeUp recovery-lab");
  });

  it("stops before anything changes when the lab image has no valid signature", async () => {
    await withLab();
    h.ops.signatures.set(`ghcr.io/restow-backup/restow-lab@${releaseDigests("0.2.0").lab}`, null);
    const result = await run();

    expect(result.outcome).toBe("unchanged");
    expect(result.failure).toMatchObject({ code: "fetch.signature_invalid", step: "fetch" });
    expect(result.failure?.detail).toContain("lab image");
    expect(result.signatureVerified).toBe(false);
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(h.ops.callsTo("composeStop")).toEqual([]);
    expect(h.ops.callsTo("composeUp")).toEqual([]);
    expect(await h.readEnv()).toBe(LAB_ENV);
    expect(labImage()).toBe(OLD_LAB);
  });

  it("stops before anything changes when the pulled lab image is not the published one", async () => {
    await withLab();
    h.ops.pulledDigests.set(NEW_LAB, [digestOf("someone-else")]);
    const result = await run();

    expect(result.outcome).toBe("unchanged");
    expect(result.failure).toMatchObject({ code: "fetch.digest_mismatch", step: "fetch" });
    expect(result.failure?.detail).toContain("lab image");
    expect(h.ops.callsTo("composeUp")).toEqual([]);
    expect(await h.readEnv()).toBe(LAB_ENV);
  });

  it("leaves the lab on its image when the release publishes no lab digest", async () => {
    await withLab();
    const { app, web } = releaseDigests("0.2.0");
    const result = await run("0.2.0", { digests: { app, web } });

    expect(result.outcome).toBe("succeeded");
    expect(result.steps.find((step) => step.id === "fetch")?.detail.lab).toBe("not_published");
    expect(result.log.some((line) => line.includes("no recovery lab image digest"))).toBe(true);
    const env = await h.readEnv();
    expect(envValueOf(env, "RESTOW_IMAGE")).toBe(NEW_APP);
    expect(envValueOf(env, "RESTOW_LAB_IMAGE")).toBe(OLD_LAB);
    expect(h.ops.calls.filter((call) => call.includes("restow-lab"))).toEqual([]);
    expect(h.ops.callsTo("composeUp")).not.toContain("composeUp recovery-lab");
    expect(labImage()).toBe(OLD_LAB);
  });

  it("restores the previous lab tag byte for byte and restarts the lab when the update rolls back", async () => {
    await withLab();
    // The worker dies once the lab was recreated: the check of all services fails after it.
    const composeUp = h.ops.composeUp.bind(h.ops);
    let crashed = false;
    h.ops.composeUp = async (services) => {
      await composeUp(services);
      if (services.includes("recovery-lab") && !crashed) {
        crashed = true;
        const worker = h.ops.containers.get("worker");
        if (worker) {
          worker.state = "exited";
          worker.exitCode = 1;
        }
      }
    };
    const result = await run();

    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({ code: "health.crashed", migrationsRan: false });
    expect(await h.readEnv()).toBe(LAB_ENV);
    expect(labImage()).toBe(OLD_LAB);
    const ups = h.ops.callsTo("composeUp");
    expect(ups.slice(-2)).toEqual([
      "composeUp api,worker,scheduler,caddy",
      "composeUp recovery-lab",
    ]);
  });

  it("restores the lab tag as well when the new api never gets ready", async () => {
    await withLab();
    apiAt(h, NEW_APP, { kind: "never" });
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(await h.readEnv()).toBe(LAB_ENV);
    expect(labImage()).toBe(OLD_LAB);
  });

  it("leaves the lab tag alone when migrations ran and the update needs attention", async () => {
    await withLab();
    apiAt(h, NEW_APP, { kind: "never", migrates: 1 });
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    // As for the other images: no rollback onto a migrated database, so .env keeps the new tags.
    expect(envValueOf(await h.readEnv(), "RESTOW_LAB_IMAGE")).toBe(NEW_LAB);
    expect(h.ops.callsTo("composeUp")).not.toContain("composeUp recovery-lab");
  });

  it("finishes the update when only the lab does not start, and says how to start it", async () => {
    await withLab();
    // composeUp: api, worker+scheduler, caddy, then the lab (index 3).
    h.ops.failOn("composeUp", new OpsError("Starting services failed.", "no kvm"), 3);
    const result = await run();
    expect(result.outcome).toBe("succeeded");
    expect(envValueOf(await h.readEnv(), "RESTOW_LAB_IMAGE")).toBe(NEW_LAB);
    expect(
      result.log.some(
        (line) =>
          line.includes("recovery lab did not start") &&
          line.includes("docker compose --profile recovery-lab up -d recovery-lab"),
      ),
    ).toBe(true);
  });

  it("keeps a lab on its image in a source update, which builds no lab image", async () => {
    await withLab();
    apiAt(h, "restow:0.2.0", { kind: "ready", reportsVersion: "0.2.0" });
    const result = await run("0.2.0", {
      mode: "source",
      source: {
        archiveUrl: "https://example.com/archive/v0.2.0.tar.gz",
        repository: "acme/restow",
        useToken: true,
      },
    });
    expect(result.outcome).toBe("succeeded");
    expect(envValueOf(await h.readEnv(), "RESTOW_LAB_IMAGE")).toBe(OLD_LAB);
    expect(h.ops.calls.filter((call) => call.includes("recovery-lab"))).toEqual([]);
    expect(result.log.some((line) => line.includes("builds no recovery lab image"))).toBe(true);
  });
});

describe("the lab digest on the way from the api to the updater [UPDATE-018]", () => {
  it("keeps a well-formed lab digest and refuses a malformed one", () => {
    const request = scheduleRequest("0.2.0");
    expect(scheduleRequestSchema.parse(request).release.digests.lab).toBe(
      releaseDigests("0.2.0").lab,
    );
    const malformed = {
      ...request,
      release: { ...request.release, digests: { ...request.release.digests, lab: "sha256:abc" } },
    };
    expect(scheduleRequestSchema.safeParse(malformed).success).toBe(false);
  });
});

describe("an installation without the recovery lab [UPDATE-018]", () => {
  for (const [name, env] of [
    ["no RESTOW_LAB_IMAGE line", DEFAULT_ENV],
    ["an empty RESTOW_LAB_IMAGE (a lab built locally)", `${DEFAULT_ENV}RESTOW_LAB_IMAGE=\n`],
  ] as const) {
    it(`is untouched: ${name}`, async () => {
      h = await createHarness({ env });
      apiAt(h, NEW_APP, { kind: "ready", reportsVersion: "0.2.0" });
      const result = await run();
      expect(result.outcome).toBe("succeeded");
      expect(h.ops.calls.filter((call) => /restow-lab|recovery-lab/.test(call))).toEqual([]);
      expect(await h.readEnv()).toBe(
        env.replace("restow:0.1.0", "restow:0.2.0").replace("restow-web:0.1.0", "restow-web:0.2.0"),
      );
      expect(result.steps.find((step) => step.id === "fetch")?.detail.lab).toBeUndefined();
    });
  }
});
