/**
 * The worker's job around the recovery ISO download (docs/BAREMETAL.md 26.13): where it looks and
 * writes, and that only a pass worth another try soon (the network, a cut-off transfer) makes the
 * queue retry it. The download itself is tested in @restow/core (recovery-iso-fetch.test.ts).
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopLogger,
  type RecoveryIsoFetchOptions,
  releaseKeyLineForTests,
  signReleaseForTests,
} from "@restow/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  endpointRecoveryIso,
  RecoveryIsoRetryError,
  recoveryIsoOptionsFromEnv,
} from "./recovery-iso.js";

const { privateKey } = generateKeyPairSync("ed25519");
const KEY = releaseKeyLineForTests(privateKey);
const temps: string[] = [];
const deps = { runtime: { logger: noopLogger } } as unknown as Parameters<
  typeof endpointRecoveryIso
>[0];

async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The options of a pass; with `dropped`, that ISO lies in the drop folder already. */
async function options(signed: boolean, dropped?: Buffer): Promise<RecoveryIsoFetchOptions> {
  const root = await temp("restow-worker-iso-agent-");
  await mkdir(join(root, "0.5.0"), { recursive: true });
  const hash = dropped ? createHash("sha256").update(dropped).digest("hex") : "c".repeat(64);
  const sums = `${hash}  recovery/restow-recovery_0.5.0_amd64.iso\n`;
  await writeFile(join(root, "0.5.0", "SHA256SUMS"), sums);
  if (signed) {
    await writeFile(join(root, "0.5.0", "SHA256SUMS.sig"), signReleaseForTests(privateKey, sums));
  }
  const store = await temp("restow-worker-iso-store-");
  if (dropped) {
    await mkdir(join(store, "import"), { recursive: true });
    await writeFile(join(store, "import", "restow-recovery_0.5.0_amd64.iso"), dropped);
  }
  return {
    root,
    key: KEY,
    storeDir: store,
    dropDirs: [join(store, "import")],
    bases: [`http://127.0.0.1:${await closedPort()}/restow-backup/restow`],
    http: {
      allowInsecureHttp: true,
      allowPrivateNetworks: true,
      proxy: { https: null, http: null, noProxy: [] },
      idleTimeoutMs: 5000,
    },
  };
}

describe("endpointRecoveryIso", () => {
  it("throws for the queue to retry when the release cannot be reached", async () => {
    const error = await endpointRecoveryIso(deps, await options(true)).catch((caught) => caught);
    expect(error).toBeInstanceOf(RecoveryIsoRetryError);
    expect((error as RecoveryIsoRetryError).result.state).toMatchObject({
      status: "failed",
      problem: "network",
    });
  });

  it("returns without a retry when the release cannot be reached but the ISO is here", async () => {
    const result = await endpointRecoveryIso(deps, await options(true, Buffer.alloc(4096, 5)));
    expect(result.transient).toBe(false);
    expect(result.state).toMatchObject({ status: "verified", problem: null });
    expect(result.lookupProblem).toMatchObject({ problem: "network" });
  });

  it("returns without a retry when there is nothing to fetch (no signed release)", async () => {
    const result = await endpointRecoveryIso(deps, await options(false));
    expect(result.transient).toBe(false);
    expect(result.state.status).toBe("not_fetched");
  });

  it("reads the store, the drop folders and the switch from the environment", () => {
    expect(
      recoveryIsoOptionsFromEnv({
        RESTOW_RECOVERY_ISO_STORE_DIR: "/srv/iso-store",
        RESTOW_RECOVERY_ISO_DIR: "/mnt/iso",
        RESTOW_RECOVERY_ISO_FETCH: "false",
      }),
    ).toEqual({
      storeDir: "/srv/iso-store",
      dropDirs: ["/srv/iso-store/import", "/mnt/iso"],
      enabled: false,
    });
    expect(recoveryIsoOptionsFromEnv({ RESTOW_RECOVERY_ISO_STORE_DIR: "/s" }).enabled).toBe(true);
  });
});
