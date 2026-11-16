/**
 * Which recovery ISO an installation offers (docs/BAREMETAL.md 8.5, 9.2, 26.13): only one the
 * newest signed agent release lists under `recovery/` in its checksums counts as verified, and the
 * server checks that signature itself with the release key the image ships. A release without
 * that line, or with a signature that does not verify, leaves the code dialog and the wizard
 * hidden and refuses to issue codes. The ISO comes from this instance when the worker's store or a
 * drop folder holds a file with exactly the verified hash, otherwise from the GitHub release,
 * which stays the fallback link; the download routes serve only that file.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REBUILD_SUMS_ASSET,
  rebuildSumsText,
  releaseKeyLineForTests,
  signReleaseForTests,
  storedRebuildDir,
  writeRecoveryIsoFetchState,
} from "@restow/core";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../config.js";
import { errorHandler } from "../../problem.js";
import { parseChecksums, readChecksums } from "./distribution.js";
import { installRoutes, recoveryIsoDownloadLimiter } from "./install-routes.js";
import { RECOVERY_ISO_DOWNLOAD_LIMIT } from "./rate-limits.js";
import {
  isoChecksum,
  recoveryFirmwareLicensesName,
  recoveryIsoFileName,
  recoveryIsoHashStats,
  recoveryIsoState,
  resetRecoveryIsoHashCache,
} from "./recovery-iso.js";

const roots: string[] = [];
const ISO_BYTES = Buffer.from("restow recovery iso, not really bootable\n");
const ISO_SHA = createHash("sha256").update(ISO_BYTES).digest("hex");
const GITHUB = "https://github.com/restow-backup/restow";
const { privateKey } = generateKeyPairSync("ed25519");
const KEY = releaseKeyLineForTests(privateKey);
const OTHER_KEY = generateKeyPairSync("ed25519").privateKey;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** The signed checksums of a release as the image ships them. */
function releaseSums(version: string, iso: boolean, isoSha = "C".repeat(64)): string {
  const lines = [`${"a".repeat(64)}  linux-amd64/restow-agent`];
  if (iso) {
    lines.push(`${isoSha.toUpperCase()}  recovery/${recoveryIsoFileName(version)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * An agent folder like the image's: releases with their SHA256SUMS, signed with the test key
 * (`signed: true`), with another key (`"other"`), with garbage (`"garbage"`) or not at all; the
 * test key's public half is `install/release-signing.pub`.
 */
async function root(
  releases: {
    version: string;
    iso: boolean;
    signed: boolean | "other" | "garbage";
    sha?: string;
  }[],
): Promise<string> {
  const dir = await temp("restow-recovery-iso-");
  await mkdir(join(dir, "install"), { recursive: true });
  await writeFile(join(dir, "install", "release-signing.pub"), `${KEY}\n`);
  for (const release of releases) {
    await mkdir(join(dir, release.version, "linux-amd64"), { recursive: true });
    const sums = releaseSums(release.version, release.iso, release.sha);
    await writeFile(join(dir, release.version, "SHA256SUMS"), sums);
    await writeFile(join(dir, release.version, "linux-amd64", "restow-agent"), "agent\n");
    if (release.signed !== false) {
      const signature =
        release.signed === "garbage"
          ? "sig\n"
          : signReleaseForTests(release.signed === "other" ? OTHER_KEY : privateKey, sums);
      await writeFile(join(dir, release.version, "SHA256SUMS.sig"), signature);
    }
  }
  return dir;
}

/** A store as the worker leaves it: a verified rebuild's checksums and, if given, its ISO. */
async function storeWithRebuild(
  version: string,
  rebuild: number,
  bytes: Buffer,
  { releaseIsoSha, withIso = true }: { releaseIsoSha: string; withIso?: boolean },
): Promise<string> {
  const store = await temp("restow-recovery-iso-store-");
  const dir = storedRebuildDir(store, version, rebuild);
  await mkdir(dir, { recursive: true });
  const text = rebuildSumsText(
    version,
    rebuild,
    sha(bytes),
    sha(releaseSums(version, true, releaseIsoSha)),
  );
  await writeFile(join(dir, REBUILD_SUMS_ASSET), text);
  await writeFile(join(dir, `${REBUILD_SUMS_ASSET}.sig`), signReleaseForTests(privateKey, text));
  if (withIso) {
    await writeFile(join(store, version, recoveryIsoFileName(version, rebuild)), bytes);
  }
  return store;
}

/** The options of every state test: the test key, no store unless given, GitHub as base. */
const base = (extra: Parameters<typeof recoveryIsoState>[2] = {}) => ({
  isoDir: null,
  storeDir: null,
  key: KEY,
  githubBase: GITHUB,
  fetchEnabled: true,
  ...extra,
});

async function isoDir(version: string, bytes: Buffer = ISO_BYTES): Promise<string> {
  const dir = await temp("restow-recovery-iso-dir-");
  await writeFile(join(dir, recoveryIsoFileName(version)), bytes);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe("recoveryIsoState", () => {
  beforeEach(() => resetRecoveryIsoHashCache());

  it("is verified when the newest signed release lists its ISO, with the GitHub release", async () => {
    const state = await recoveryIsoState(
      await root([{ version: "0.5.0", iso: true, signed: true }]),
      "https://restow.firma.de/",
      base(),
    );
    expect(state).toMatchObject({
      version: "0.5.0",
      rebuild: null,
      fileName: "restow-recovery_0.5.0_amd64.iso",
      url: `${GITHUB}/releases/download/v0.5.0/restow-recovery_0.5.0_amd64.iso`,
      githubUrl: `${GITHUB}/releases/download/v0.5.0/restow-recovery_0.5.0_amd64.iso`,
      sumsUrl: `${GITHUB}/releases/download/v0.5.0/agent-SHA256SUMS`,
      signatureUrl: `${GITHUB}/releases/download/v0.5.0/agent-SHA256SUMS.sig`,
      source: "github",
      sha256: "c".repeat(64),
      sizeBytes: null,
      verified: true,
      releaseUrl: `${GITHUB}/releases/tag/v0.5.0`,
      sourcesUrl: `${GITHUB}/releases/tag/v0.5.0`,
      firmwareLicensesUrl: `${GITHUB}/releases/download/v0.5.0/${recoveryFirmwareLicensesName("0.5.0")}`,
      local: { status: "disabled", importDir: null },
    });
    expect(state.commands.linux[0]).toBe(
      "./verify-agent-signature.sh agent-SHA256SUMS agent-SHA256SUMS.sig release-signing.pub",
    );
    expect(state.commands.linux.join("\n")).toContain("sha256sum -c");
    expect(state.commands.windows[0]).toContain("Get-FileHash");
  });

  it("links the alpha repository's release for an installation that follows it", async () => {
    const state = await recoveryIsoState(
      await root([{ version: "0.5.0-alpha.3", iso: true, signed: true }]),
      null,
      base({ githubBase: "https://github.com/restow-backup/restow-alpha" }),
    );
    expect(state.url).toBe(
      "https://github.com/restow-backup/restow-alpha/releases/download/v0.5.0-alpha.3/restow-recovery_0.5.0-alpha.3_amd64.iso",
    );
  });

  it("offers the copy in RESTOW_RECOVERY_ISO_DIR only with the signed hash, hashed once", async () => {
    const agents = await root([{ version: "0.5.0", iso: true, signed: true, sha: ISO_SHA }]);
    const dir = await isoDir("0.5.0");
    const state = await recoveryIsoState(agents, "https://restow.firma.de", base({ isoDir: dir }));
    expect(state).toMatchObject({
      source: "instance",
      url: "https://restow.firma.de/api/v1/recovery-iso/file/restow-recovery_0.5.0_amd64.iso",
      githubUrl: `${GITHUB}/releases/download/v0.5.0/restow-recovery_0.5.0_amd64.iso`,
      sizeBytes: ISO_BYTES.length,
      sha256: ISO_SHA,
      verified: true,
      local: { status: "verified", origin: "import", bytesDone: ISO_BYTES.length },
    });
    await recoveryIsoState(agents, "https://restow.firma.de", base({ isoDir: dir }));
    expect(recoveryIsoHashStats.computed).toBe(1);
    // A changed file (other size and time) is hashed again; with another hash it is not offered.
    await writeFile(join(dir, recoveryIsoFileName("0.5.0")), Buffer.from("tampered iso bytes"));
    await utimes(join(dir, recoveryIsoFileName("0.5.0")), new Date(), new Date(Date.now() + 5000));
    const tampered = await recoveryIsoState(
      agents,
      "https://restow.firma.de",
      base({ isoDir: dir }),
    );
    expect(recoveryIsoHashStats.computed).toBe(2);
    expect(tampered).toMatchObject({ source: "github", sizeBytes: null, verified: true });
    expect(tampered.url).toContain("github.com");
    // Without a known instance address the GitHub release stays the source.
    expect(
      (
        await recoveryIsoState(
          await root([{ version: "0.5.0", iso: true, signed: true, sha: ISO_SHA }]),
          null,
          base({ isoDir: await isoDir("0.5.0") }),
        )
      ).source,
    ).toBe("github");
  });

  it("is not verified for a release without the ISO, an unsigned one, or none", async () => {
    const plain = await recoveryIsoState(
      await root([{ version: "0.5.0", iso: false, signed: true }]),
      null,
      base(),
    );
    expect(plain).toMatchObject({
      version: null,
      url: null,
      source: null,
      sha256: null,
      verified: false,
    });
    expect(plain.commands).toEqual({ linux: [], macos: [], windows: [] });
    // An unsigned newer release is skipped; the newest signed one decides, and it has no ISO.
    expect(
      (
        await recoveryIsoState(
          await root([
            { version: "0.5.1", iso: true, signed: false },
            { version: "0.5.0", iso: false, signed: true },
            { version: "0.4.9", iso: true, signed: true },
          ]),
          null,
          base(),
        )
      ).verified,
    ).toBe(false);
    expect((await recoveryIsoState(await root([]), null, base())).verified).toBe(false);
  });

  it("checks the signature itself: another key, garbage or no release key is not verified", async () => {
    for (const signed of ["other", "garbage"] as const) {
      const state = await recoveryIsoState(
        await root([{ version: "0.5.0", iso: true, signed }]),
        null,
        base(),
      );
      expect(state, signed).toMatchObject({ verified: false, url: null, githubUrl: null });
    }
    const agents = await root([{ version: "0.5.0", iso: true, signed: true }]);
    // The placeholder of a development build: nothing to verify with.
    expect((await recoveryIsoState(agents, null, base({ key: "" }))).verified).toBe(false);
    // The key the image ships is the default.
    const before = process.env.RESTOW_AGENT_DIR;
    process.env.RESTOW_AGENT_DIR = agents;
    try {
      const state = await recoveryIsoState(agents, null, { ...base(), key: undefined });
      expect(state.verified).toBe(true);
      expect(state.releaseKeyFingerprint).toMatch(/^SHA256:/);
    } finally {
      if (before === undefined) delete process.env.RESTOW_AGENT_DIR;
      else process.env.RESTOW_AGENT_DIR = before;
    }
  });

  it("reports the worker's state: not fetched, fetching, stale, failed with its reason", async () => {
    const agents = await root([{ version: "0.5.0", iso: true, signed: true, sha: ISO_SHA }]);
    const store = await temp("restow-recovery-iso-store-");
    const at = Date.parse("2026-11-05T10:00:00Z");
    const now = () => at;
    expect(
      (await recoveryIsoState(agents, null, base({ storeDir: store, now }))).local,
    ).toMatchObject({
      status: "not_fetched",
      importDir: join(store, "import"),
    });
    const state = {
      status: "fetching" as const,
      version: "0.5.0",
      fileName: recoveryIsoFileName("0.5.0"),
      rebuild: null,
      sha256: ISO_SHA,
      bytesDone: 1000,
      bytesTotal: 4000,
      problem: null,
      detail: null,
      githubBase: GITHUB,
      updatedAt: new Date(at - 60_000).toISOString(),
      checkedAt: null,
    };
    await writeRecoveryIsoFetchState(store, state);
    expect(
      (await recoveryIsoState(agents, null, base({ storeDir: store, now }))).local,
    ).toMatchObject({
      status: "fetching",
      bytesDone: 1000,
      bytesTotal: 4000,
    });
    // A worker that stopped mid-download: no report for over 15 minutes.
    await writeRecoveryIsoFetchState(store, {
      ...state,
      updatedAt: new Date(at - 20 * 60_000).toISOString(),
    });
    expect(
      (await recoveryIsoState(agents, null, base({ storeDir: store, now }))).local,
    ).toMatchObject({
      status: "failed",
      problem: "truncated",
    });
    await writeRecoveryIsoFetchState(store, {
      ...state,
      status: "failed",
      problem: "hash_mismatch",
      detail: null,
    });
    const failed = await recoveryIsoState(
      agents,
      "https://restow.firma.de",
      base({ storeDir: store, now }),
    );
    expect(failed).toMatchObject({
      source: "github",
      verified: true,
      local: { status: "failed", problem: "hash_mismatch" },
    });
    // A state about another ISO (an older release) says nothing about this one.
    await writeRecoveryIsoFetchState(store, {
      ...state,
      status: "failed",
      fileName: recoveryIsoFileName("0.4.0"),
      problem: "network",
    });
    expect(
      (await recoveryIsoState(agents, null, base({ storeDir: store, now }))).local.status,
    ).toBe("not_fetched");
    // Downloading switched off: only the drop folders count.
    expect(
      (await recoveryIsoState(agents, null, base({ storeDir: store, fetchEnabled: false }))).local
        .status,
    ).toBe("disabled");
  });

  it("offers the worker's copy and the newest verified rebuild, with the rebuild's links", async () => {
    const releaseIso = Buffer.from("the release's own iso\n");
    const rebuilt = Buffer.from("rebuilt against a newer snapshot\n");
    const agents = await root([
      { version: "0.5.0", iso: true, signed: true, sha: sha(releaseIso) },
    ]);
    const store = await storeWithRebuild("0.5.0", 2, rebuilt, { releaseIsoSha: sha(releaseIso) });
    const state = await recoveryIsoState(
      agents,
      "https://restow.firma.de",
      base({ storeDir: store }),
    );
    expect(state).toMatchObject({
      version: "0.5.0",
      rebuild: 2,
      fileName: "restow-recovery_0.5.0.2_amd64.iso",
      sha256: sha(rebuilt),
      source: "instance",
      url: "https://restow.firma.de/api/v1/recovery-iso/file/restow-recovery_0.5.0.2_amd64.iso",
      githubUrl: `${GITHUB}/releases/download/recovery-v0.5.0.2/restow-recovery_0.5.0.2_amd64.iso`,
      sumsUrl: `${GITHUB}/releases/download/recovery-v0.5.0.2/recovery-SHA256SUMS`,
      releaseUrl: `${GITHUB}/releases/tag/recovery-v0.5.0.2`,
      firmwareLicensesUrl: `${GITHUB}/releases/download/recovery-v0.5.0.2/restow-recovery_0.5.0.2_FIRMWARE-LICENSES.txt`,
      local: { status: "verified", origin: "store" },
    });
    expect(state.commands.linux[0]).toBe(
      "./verify-agent-signature.sh recovery-SHA256SUMS recovery-SHA256SUMS.sig release-signing.pub",
    );
    expect(state.commands.linux[1]).toContain("restow-recovery_0.5.0.2_amd64.iso");
    // The rebuild's checksums without its ISO here: the rebuild is offered from GitHub, and the
    // state says it is not fetched yet.
    const pending = await storeWithRebuild("0.5.0", 3, rebuilt, {
      releaseIsoSha: sha(releaseIso),
      withIso: false,
    });
    const remote = await recoveryIsoState(
      agents,
      "https://restow.firma.de",
      base({ storeDir: pending }),
    );
    expect(remote).toMatchObject({
      rebuild: 3,
      source: "github",
      local: { status: "not_fetched" },
    });
    // A rebuild bound to another release's checksums is never offered.
    const foreign = await storeWithRebuild("0.5.0", 4, rebuilt, { releaseIsoSha: "d".repeat(64) });
    expect((await recoveryIsoState(agents, null, base({ storeDir: foreign }))).rebuild).toBeNull();
  });
});

describe("the recovery ISO line in SHA256SUMS (C-M4-3)", () => {
  const text = [
    `${"a".repeat(64)}  linux-amd64/restow-agent`,
    `${"b".repeat(64)}  linux-amd64/restic`,
    `${"c".repeat(64)}  recovery/restow-recovery_0.5.0_amd64.iso`,
  ].join("\n");

  it("is found by the ISO lookup and ignored for every agent target", async () => {
    expect(isoChecksum(text, "restow-recovery_0.5.0_amd64.iso")).toBe("c".repeat(64));
    expect(isoChecksum(text, "restow-recovery_0.4.0_amd64.iso")).toBeNull();
    expect(isoChecksum(text, "restow-agent")).toBeNull();
    for (const target of ["linux-amd64", "linux-arm64", "darwin-arm64", "windows-amd64"]) {
      expect([...parseChecksums(text, target).keys()]).not.toContain(
        "restow-recovery_0.5.0_amd64.iso",
      );
    }
    expect(parseChecksums(text, "linux-amd64")).toEqual(
      new Map([
        ["restow-agent", "a".repeat(64)],
        ["restic", "b".repeat(64)],
      ]),
    );
    const dir = await temp("restow-sums-");
    await mkdir(join(dir, "0.5.0", "linux-amd64"), { recursive: true });
    await writeFile(join(dir, "0.5.0", "SHA256SUMS"), `${text}\n`);
    expect([...(await readChecksums("0.5.0", "linux-amd64", dir)).keys()].sort()).toEqual([
      "restic",
      "restow-agent",
    ]);
  });
});

describe("GET /install/recovery/:version/:file", () => {
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/install", installRoutes);
  const before = {
    agentDir: process.env.RESTOW_AGENT_DIR,
    isoDir: config.recoveryIsoDir,
    storeDir: config.recoveryIsoStoreDir,
  };
  const file = recoveryIsoFileName("0.5.0");
  let address = 0;
  const get = (path: string, ip = `192.0.2.${(address++ % 200) + 1}`) =>
    app.request(path, { headers: { "x-real-ip": ip } });

  beforeEach(async () => {
    resetRecoveryIsoHashCache();
    recoveryIsoDownloadLimiter.reset();
    process.env.RESTOW_AGENT_DIR = await root([
      { version: "0.5.0", iso: true, signed: true, sha: ISO_SHA },
      { version: "0.4.0", iso: true, signed: false, sha: ISO_SHA },
    ]);
    config.recoveryIsoDir = await isoDir("0.5.0");
    config.recoveryIsoStoreDir = null;
    await writeFile(join(config.recoveryIsoDir, recoveryIsoFileName("0.4.0")), ISO_BYTES);
  });

  afterEach(() => {
    if (before.agentDir === undefined) delete process.env.RESTOW_AGENT_DIR;
    else process.env.RESTOW_AGENT_DIR = before.agentDir;
    config.recoveryIsoDir = before.isoDir;
    config.recoveryIsoStoreDir = before.storeDir;
  });

  it("streams the ISO the signed checksums name, with its length", async () => {
    const response = await get(`/install/recovery/0.5.0/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(ISO_BYTES.length));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ISO_BYTES);
  });

  it("answers 404 for a bad version or name, a file outside the sums, no signature, a mismatch", async () => {
    for (const path of [
      `/install/recovery/latest/${file}`,
      `/install/recovery/0.5.0/..%2F0.5.0%2FSHA256SUMS`,
      `/install/recovery/0.5.0/%2e%2e`,
      "/install/recovery/0.5.0/SHA256SUMS",
      "/install/recovery/0.5.0/restow-recovery_0.5.0_arm64.iso",
      // Listed and present, but the release has no signature.
      `/install/recovery/0.4.0/${recoveryIsoFileName("0.4.0")}`,
      "/install/recovery/0.6.0/restow-recovery_0.6.0_amd64.iso",
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
    await writeFile(join(config.recoveryIsoDir as string, file), Buffer.from("other bytes"));
    expect((await get(`/install/recovery/0.5.0/${file}`)).status).toBe(404);
    await writeFile(join(config.recoveryIsoDir as string, file), ISO_BYTES);
    resetRecoveryIsoHashCache();
    // The same file, but the release's signature does not verify (another key).
    process.env.RESTOW_AGENT_DIR = await root([
      { version: "0.5.0", iso: true, signed: "other", sha: ISO_SHA },
    ]);
    expect((await get(`/install/recovery/0.5.0/${file}`)).status).toBe(404);
    config.recoveryIsoDir = null;
    expect((await get(`/install/recovery/0.5.0/${file}`)).status).toBe(404);
  });

  it(`allows ${RECOVERY_ISO_DOWNLOAD_LIMIT} downloads per address and hour, then 429 with Retry-After`, async () => {
    for (let index = 0; index < RECOVERY_ISO_DOWNLOAD_LIMIT; index++) {
      const response = await get(`/install/recovery/0.5.0/${file}`, "198.51.100.7");
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const limited = await get(`/install/recovery/0.5.0/${file}`, "198.51.100.7");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get(`/install/recovery/0.5.0/${file}`, "198.51.100.8")).status).toBe(200);
  });
});
