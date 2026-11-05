/**
 * Which recovery ISO an installation offers (docs/BAREMETAL.md 8.5, 9.2): only one the newest
 * signed agent release lists under `recovery/` in its checksums counts as verified. A release
 * without that line leaves the code dialog and the wizard hidden and refuses to issue codes. The
 * ISO comes from the GitHub release, or from this instance when RESTOW_RECOVERY_ISO_DIR holds a
 * file with exactly the signed hash; the download route serves only that file.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function temp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

async function root(
  releases: { version: string; iso: boolean; signed: boolean; sha?: string }[],
): Promise<string> {
  const dir = await temp("restow-recovery-iso-");
  for (const release of releases) {
    await mkdir(join(dir, release.version, "linux-amd64"), { recursive: true });
    const lines = [`${"a".repeat(64)}  linux-amd64/restow-agent`];
    if (release.iso) {
      lines.push(
        `${(release.sha ?? "C".repeat(64)).toUpperCase()}  recovery/${recoveryIsoFileName(release.version)}`,
      );
    }
    await writeFile(join(dir, release.version, "SHA256SUMS"), `${lines.join("\n")}\n`);
    await writeFile(join(dir, release.version, "linux-amd64", "restow-agent"), "agent\n");
    if (release.signed) {
      await writeFile(join(dir, release.version, "SHA256SUMS.sig"), "sig\n");
    }
  }
  return dir;
}

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
      { isoDir: null, githubBase: GITHUB },
    );
    expect(state).toMatchObject({
      version: "0.5.0",
      fileName: "restow-recovery_0.5.0_amd64.iso",
      url: `${GITHUB}/releases/download/v0.5.0/restow-recovery_0.5.0_amd64.iso`,
      source: "github",
      sha256: "c".repeat(64),
      sizeBytes: null,
      verified: true,
      releaseUrl: `${GITHUB}/releases/tag/v0.5.0`,
      sourcesUrl: `${GITHUB}/releases/tag/v0.5.0`,
      firmwareLicensesUrl: `${GITHUB}/releases/download/v0.5.0/${recoveryFirmwareLicensesName("0.5.0")}`,
    });
    expect(state.commands.linux[0]).toBe(
      "./verify-agent-signature.sh SHA256SUMS SHA256SUMS.sig release-signing.pub",
    );
    expect(state.commands.linux.join("\n")).toContain("sha256sum -c");
    expect(state.commands.windows[0]).toContain("Get-FileHash");
  });

  it("links the alpha repository's release for an installation that follows it", async () => {
    const state = await recoveryIsoState(
      await root([{ version: "0.5.0-alpha.3", iso: true, signed: true }]),
      null,
      { isoDir: null, githubBase: "https://github.com/restow-backup/restow-alpha" },
    );
    expect(state.url).toBe(
      "https://github.com/restow-backup/restow-alpha/releases/download/v0.5.0-alpha.3/restow-recovery_0.5.0-alpha.3_amd64.iso",
    );
  });

  it("offers the copy in RESTOW_RECOVERY_ISO_DIR only with the signed hash, hashed once", async () => {
    const agents = await root([{ version: "0.5.0", iso: true, signed: true, sha: ISO_SHA }]);
    const dir = await isoDir("0.5.0");
    const state = await recoveryIsoState(agents, "https://restow.firma.de", {
      isoDir: dir,
      githubBase: GITHUB,
    });
    expect(state).toMatchObject({
      source: "instance",
      url: "https://restow.firma.de/install/recovery/0.5.0/restow-recovery_0.5.0_amd64.iso",
      sizeBytes: ISO_BYTES.length,
      sha256: ISO_SHA,
      verified: true,
    });
    await recoveryIsoState(agents, "https://restow.firma.de", { isoDir: dir, githubBase: GITHUB });
    expect(recoveryIsoHashStats.computed).toBe(1);
    // A changed file (other size and time) is hashed again; with another hash it is not offered.
    await writeFile(join(dir, recoveryIsoFileName("0.5.0")), Buffer.from("tampered iso bytes"));
    await utimes(join(dir, recoveryIsoFileName("0.5.0")), new Date(), new Date(Date.now() + 5000));
    const tampered = await recoveryIsoState(agents, "https://restow.firma.de", {
      isoDir: dir,
      githubBase: GITHUB,
    });
    expect(recoveryIsoHashStats.computed).toBe(2);
    expect(tampered).toMatchObject({ source: "github", sizeBytes: null, verified: true });
    expect(tampered.url).toContain("github.com");
    // Without a known instance address the GitHub release stays the source.
    expect(
      (
        await recoveryIsoState(
          await root([{ version: "0.5.0", iso: true, signed: true, sha: ISO_SHA }]),
          null,
          { isoDir: await isoDir("0.5.0"), githubBase: GITHUB },
        )
      ).source,
    ).toBe("github");
  });

  it("is not verified for a release without the ISO, an unsigned one, or none", async () => {
    const plain = await recoveryIsoState(
      await root([{ version: "0.5.0", iso: false, signed: true }]),
      null,
      { isoDir: null, githubBase: GITHUB },
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
          { isoDir: null, githubBase: GITHUB },
        )
      ).verified,
    ).toBe(false);
    expect((await recoveryIsoState(await root([]), null, { isoDir: null })).verified).toBe(false);
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
  const before = { agentDir: process.env.RESTOW_AGENT_DIR, isoDir: config.recoveryIsoDir };
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
    await writeFile(join(config.recoveryIsoDir, recoveryIsoFileName("0.4.0")), ISO_BYTES);
  });

  afterEach(() => {
    if (before.agentDir === undefined) delete process.env.RESTOW_AGENT_DIR;
    else process.env.RESTOW_AGENT_DIR = before.agentDir;
    config.recoveryIsoDir = before.isoDir;
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
