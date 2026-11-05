/**
 * The worker's download of the recovery ISO against a fake release server (docs/BAREMETAL.md
 * 26.13): the ISO of the image's signed release, rebuilds `recovery-v<v>.<n>` with their own signed
 * checksums, redirects to another path like GitHub's asset host, Range requests after a cut-off
 * transfer, the size bound, a proxy tunnel, and every way a file must not be taken.
 */
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readRecoveryIsoFetchState,
  rebuildSumsText,
  recoveryIsoFileName,
  resetRecoveryIsoHashCache,
  selectRecoveryIso,
} from "./recovery-iso.js";
import {
  fetchRecoveryIso,
  proxyFor,
  proxySettingsFromEnv,
  type RecoveryIsoFetchOptions,
} from "./recovery-iso-fetch.js";
import { releaseKeyLineForTests, signReleaseForTests } from "./sshsig.js";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const ISO = Buffer.alloc(300_000, 7);
const REBUILD_1 = Buffer.alloc(300_000, 8);
const REBUILD_2 = Buffer.alloc(300_000, 9);

const { privateKey } = generateKeyPairSync("ed25519");
const KEY = releaseKeyLineForTests(privateKey);
const OTHER = generateKeyPairSync("ed25519").privateKey;

const temps: string[] = [];
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** The signed checksums of a release whose ISO is `iso` (if given). */
function releaseSums(iso: Buffer | null, version = "0.5.0"): string {
  const lines = [`${"a".repeat(64)}  linux-amd64/restow-agent`];
  if (iso) lines.push(`${sha(iso)}  recovery/${recoveryIsoFileName(version)}`);
  return `${lines.join("\n")}\n`;
}

/** The image's agent folder: a release (0.5.0) whose signed SHA256SUMS lists `iso` (if given). */
async function agentRoot(
  iso: Buffer | null,
  signer: KeyObject = privateKey,
  version = "0.5.0",
): Promise<string> {
  const root = await temp("restow-iso-agent-");
  await mkdir(join(root, version), { recursive: true });
  const sums = releaseSums(iso, version);
  await writeFile(join(root, version, "SHA256SUMS"), sums);
  await writeFile(join(root, version, "SHA256SUMS.sig"), signReleaseForTests(signer, sums));
  return root;
}

/** The checksums of a rebuild, bound to the release's checksums (by default 0.5.0 with ISO). */
function rebuildSums(
  version: string,
  rebuild: number,
  bytes: Buffer,
  release: string = releaseSums(ISO, version),
) {
  return rebuildSumsText(version, rebuild, sha(bytes), sha(release));
}

// ---------------------------------------------------------------------------
// The fake release server
// ---------------------------------------------------------------------------

interface Asset {
  bytes: Buffer;
  /** Cut the connection after this many bytes, once. */
  cutAfter?: number;
  /**
   * Resolves once the client has the bytes before the cut (on disk): without it the close can
   * reach the client in the same tick as the bytes, which are then never read.
   */
  beforeCut?: () => Promise<void>;
  /** Send this many bytes, then nothing more, without closing (a stalled line). */
  stallAfter?: number;
  /** Send without a length (chunked), so only the bytes themselves can hit the bound. */
  chunked?: boolean;
}

class FakeReleases {
  readonly assets = new Map<string, Asset>();
  readonly requests: { path: string; range: string | undefined }[] = [];
  private server = http.createServer((request, response) => this.handle(request, response));
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  base(repository = "restow-backup/restow"): string {
    return `http://127.0.0.1:${this.port}/${repository}`;
  }

  /** An attachment of a release of a repository. */
  put(
    tag: string,
    name: string,
    bytes: Buffer | string,
    repository = "restow-backup/restow",
    extra: Partial<Asset> = {},
  ) {
    this.assets.set(`/${repository}/releases/download/${tag}/${name}`, {
      bytes: Buffer.from(bytes),
      ...extra,
    });
  }

  countFor(fragment: string): number {
    return this.requests.filter((request) => request.path.includes(fragment)).length;
  }

  private handle(request: IncomingMessage, response: ServerResponse) {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    this.requests.push({ path, range: request.headers.range });
    if (!path.startsWith("/asset-host") && path.includes("/releases/download/")) {
      if (!this.assets.has(path)) {
        response.writeHead(404).end();
        return;
      }
      // Like GitHub: the attachment comes from another place.
      response.writeHead(302, { location: `/asset-host${path}?token=signed` }).end();
      return;
    }
    const asset = path.startsWith("/asset-host")
      ? this.assets.get(path.slice("/asset-host".length))
      : undefined;
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    const total = asset.bytes.length;
    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    if (range) {
      start = Number(range[1]);
      if (start >= total) {
        response.writeHead(416, { "content-range": `bytes */${total}` }).end();
        return;
      }
    }
    const body = asset.bytes.subarray(start);
    const headers: Record<string, string> = asset.chunked
      ? {}
      : { "content-length": String(body.length) };
    if (range) headers["content-range"] = `bytes ${start}-${total - 1}/${total}`;
    response.writeHead(range ? 206 : 200, headers);
    if (asset.cutAfter !== undefined && start === 0) {
      const cut = asset.cutAfter;
      const beforeCut = asset.beforeCut ?? (() => Promise.resolve());
      asset.cutAfter = undefined;
      response.write(body.subarray(0, cut), () => {
        void beforeCut().finally(() => response.socket?.destroy());
      });
      return;
    }
    if (asset.stallAfter !== undefined) {
      const stall = asset.stallAfter;
      asset.stallAfter = undefined;
      response.write(body.subarray(0, stall));
      return;
    }
    response.end(body);
  }
}

const server = new FakeReleases();
beforeAll(() => server.start());
afterAll(async () => {
  await server.stop();
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

let store = "";
beforeEach(async () => {
  resetRecoveryIsoHashCache();
  server.assets.clear();
  server.requests.length = 0;
  store = await temp("restow-iso-store-");
});

function options(
  root: string,
  extra: Partial<RecoveryIsoFetchOptions> = {},
): RecoveryIsoFetchOptions {
  return {
    root,
    key: KEY,
    storeDir: store,
    dropDirs: [join(store, "import")],
    bases: [server.base("restow-backup/restow"), server.base("restow-backup/restow-alpha")],
    http: {
      allowInsecureHttp: true,
      allowPrivateNetworks: true,
      proxy: { https: null, http: null, noProxy: [] },
    },
    ...extra,
  };
}

/** Publish release 0.5.0 with its ISO (and agent-SHA256SUMS, which says where it is). */
async function publishRelease(
  root: string,
  iso: Buffer = ISO,
  repository = "restow-backup/restow",
) {
  server.put(
    "v0.5.0",
    "agent-SHA256SUMS",
    await readFile(join(root, "0.5.0", "SHA256SUMS")),
    repository,
  );
  server.put("v0.5.0", recoveryIsoFileName("0.5.0"), iso, repository);
}

function publishRebuild(
  rebuild: number,
  bytes: Buffer,
  {
    sums,
    signer = privateKey,
    version = "0.5.0",
  }: { sums?: string; signer?: KeyObject | null; version?: string } = {},
) {
  const tag = `recovery-v${version}.${rebuild}`;
  const text = sums ?? rebuildSums(version, rebuild, bytes);
  server.put(tag, "recovery-SHA256SUMS", text);
  if (signer) server.put(tag, "recovery-SHA256SUMS.sig", signReleaseForTests(signer, text));
  server.put(tag, recoveryIsoFileName(version, rebuild), bytes);
}

const stored = (name: string) => join(store, "0.5.0", name);

/** Resolves once `path` has at least `bytes` bytes (polled; gives up after ten seconds). */
async function untilSize(path: string, bytes: number): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 10) {
    const size = await stat(path).then(
      (info) => info.size,
      () => 0,
    );
    if (size >= bytes) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("fetchRecoveryIso", () => {
  it("downloads the release's ISO once, checks its hash and serves it from the store after", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const first = await fetchRecoveryIso(options(root));
    expect(first.transient).toBe(false);
    expect(first.state).toMatchObject({
      status: "verified",
      version: "0.5.0",
      fileName: "restow-recovery_0.5.0_amd64.iso",
      rebuild: null,
      sha256: sha(ISO),
      bytesDone: ISO.length,
      bytesTotal: ISO.length,
      problem: null,
      githubBase: server.base(),
    });
    expect(await readFile(stored(recoveryIsoFileName("0.5.0")))).toEqual(ISO);
    expect(existsSync(`${stored(recoveryIsoFileName("0.5.0"))}.part`)).toBe(false);
    expect(await readRecoveryIsoFetchState(store)).toMatchObject({ status: "verified" });
    // It asked for the first rebuild, which does not exist.
    expect(server.countFor("recovery-v0.5.0.1/recovery-SHA256SUMS")).toBe(1);

    // Another pass: nothing is downloaded again (one download per installation and release).
    const isoRequests = server.countFor(
      `/asset-host/restow-backup/restow/releases/download/v0.5.0/${recoveryIsoFileName("0.5.0")}`,
    );
    const second = await fetchRecoveryIso(options(root));
    expect(second.state.status).toBe("verified");
    expect(
      server.countFor(
        `/asset-host/restow-backup/restow/releases/download/v0.5.0/${recoveryIsoFileName("0.5.0")}`,
      ),
    ).toBe(isoRequests);
    const selection = await selectRecoveryIso({ root, key: KEY, storeDir: store, dropDirs: [] });
    expect(selection.local).toMatchObject({ origin: "store", size: ISO.length });
  });

  it("refuses a download with the wrong hash and keeps nothing of it", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root, Buffer.alloc(ISO.length, 1));
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({ status: "failed", problem: "hash_mismatch" });
    expect(result.transient).toBe(false);
    expect(existsSync(stored(recoveryIsoFileName("0.5.0")))).toBe(false);
    expect(existsSync(`${stored(recoveryIsoFileName("0.5.0"))}.part`)).toBe(false);
  });

  it("continues a cut-off download with a Range request", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const part = `${stored(recoveryIsoFileName("0.5.0"))}.part`;
    server.put("v0.5.0", recoveryIsoFileName("0.5.0"), ISO, "restow-backup/restow", {
      cutAfter: 100_000,
      beforeCut: () => untilSize(part, 1),
    });
    const first = await fetchRecoveryIso(options(root));
    expect(first.state).toMatchObject({ status: "failed", problem: "truncated" });
    expect(first.transient).toBe(true);
    const kept = (await stat(part)).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(ISO.length);

    const second = await fetchRecoveryIso(options(root));
    expect(second.state).toMatchObject({ status: "verified", bytesDone: ISO.length });
    expect(await readFile(stored(recoveryIsoFileName("0.5.0")))).toEqual(ISO);
    const ranged = server.requests.filter((request) => request.range !== undefined);
    expect(ranged.map((request) => request.range)).toContain(`bytes=${kept}-`);
  });

  it("gives up an ISO above the size bound, declared or not", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const declared = await fetchRecoveryIso(options(root, { maxBytes: 1000 }));
    expect(declared.state).toMatchObject({ status: "failed", problem: "too_large" });
    // Without a declared length, the bytes themselves are cut off at the bound.
    server.put("v0.5.0", recoveryIsoFileName("0.5.0"), ISO, "restow-backup/restow", {
      chunked: true,
    });
    const undeclared = await fetchRecoveryIso(options(root, { maxBytes: 1000 }));
    expect(undeclared.state).toMatchObject({ status: "failed", problem: "too_large" });
    expect(existsSync(`${stored(recoveryIsoFileName("0.5.0"))}.part`)).toBe(false);
    expect(existsSync(stored(recoveryIsoFileName("0.5.0")))).toBe(false);
  });

  it("takes the newest signed rebuild of its own release and stops at the first missing number", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    publishRebuild(1, REBUILD_1);
    publishRebuild(2, REBUILD_2);
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({
      status: "verified",
      fileName: "restow-recovery_0.5.0.2_amd64.iso",
      rebuild: 2,
      sha256: sha(REBUILD_2),
      problem: null,
    });
    expect(await readFile(stored("restow-recovery_0.5.0.2_amd64.iso"))).toEqual(REBUILD_2);
    // Neither the release's ISO nor rebuild 1 was downloaded; number 3 was asked for once.
    expect(
      server.countFor(
        `/asset-host/restow-backup/restow/releases/download/v0.5.0/${recoveryIsoFileName("0.5.0")}`,
      ),
    ).toBe(0);
    expect(server.countFor("restow-recovery_0.5.0.1_amd64.iso")).toBe(0);
    expect(server.countFor("recovery-v0.5.0.3/recovery-SHA256SUMS")).toBe(1);
    // The verified checksums are kept; the next pass asks only for number 3.
    const before = server.countFor("recovery-v0.5.0.1/");
    await fetchRecoveryIso(options(root));
    expect(server.countFor("recovery-v0.5.0.1/")).toBe(before);
    expect(server.countFor("recovery-v0.5.0.3/recovery-SHA256SUMS")).toBe(2);

    // A newer rebuild replaces the older copy in the store.
    publishRebuild(3, Buffer.alloc(300_000, 3));
    const third = await fetchRecoveryIso(options(root));
    expect(third.state).toMatchObject({ status: "verified", rebuild: 3 });
    expect(existsSync(stored("restow-recovery_0.5.0.2_amd64.iso"))).toBe(false);
  });

  it("never takes a rebuild with a wrong or missing signature", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    publishRebuild(1, REBUILD_1, { signer: OTHER });
    publishRebuild(2, REBUILD_2, { signer: null });
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({
      status: "verified",
      rebuild: null,
      fileName: recoveryIsoFileName("0.5.0"),
      problem: "signature_invalid",
    });
    expect(server.countFor("restow-recovery_0.5.0.1_amd64.iso")).toBe(0);
    expect(server.countFor("restow-recovery_0.5.0.2_amd64.iso")).toBe(0);
  });

  it("never takes a rebuild that names another release or another number", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    // Signed checksums of 0.6.0's first rebuild, attached to 0.5.0's tag.
    publishRebuild(1, REBUILD_1, { sums: rebuildSums("0.6.0", 1, REBUILD_1) });
    // Signed checksums of rebuild 1 under the tag of rebuild 2.
    publishRebuild(2, REBUILD_2, { sums: rebuildSums("0.5.0", 1, REBUILD_2) });
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({
      status: "verified",
      rebuild: null,
      problem: "wrong_release",
    });
    const selection = await selectRecoveryIso({ root, key: KEY, storeDir: store, dropDirs: [] });
    expect(selection.newest?.rebuild).toBeNull();
  });

  it("never takes a rebuild bound to another release's checksums, or bound to none", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    // The right file name, but bound to the checksums of an ISO of other bytes.
    publishRebuild(1, REBUILD_1, {
      sums: rebuildSums("0.5.0", 1, REBUILD_1, releaseSums(REBUILD_2)),
    });
    // The right file name and no binding line at all.
    publishRebuild(2, REBUILD_2, {
      sums: `${sha(REBUILD_2)}  recovery/${recoveryIsoFileName("0.5.0", 2)}\n`,
    });
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({
      status: "verified",
      rebuild: null,
      problem: "wrong_release",
    });
    expect(server.countFor("restow-recovery_0.5.0.1_amd64.iso")).toBe(0);
    expect(server.countFor("restow-recovery_0.5.0.2_amd64.iso")).toBe(0);
  });

  it("does not read the ISO of release 0.5.0-alpha.3.1 as rebuild 1 of 0.5.0-alpha.3", async () => {
    const version = "0.5.0-alpha.3";
    const root = await agentRoot(ISO, privateKey, version);
    server.put(`v${version}`, "agent-SHA256SUMS", releaseSums(ISO, version));
    server.put(`v${version}`, recoveryIsoFileName(version), ISO);
    // The signed checksums of release 0.5.0-alpha.3.1, whose ISO has the name rebuild 1 of
    // 0.5.0-alpha.3 would have, put up under the tag of that rebuild.
    const other = releaseSums(REBUILD_1, "0.5.0-alpha.3.1");
    publishRebuild(1, REBUILD_1, { version, sums: other });
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({
      status: "verified",
      rebuild: null,
      fileName: recoveryIsoFileName(version),
      problem: "wrong_release",
    });
    expect(server.countFor("restow-recovery_0.5.0-alpha.3.1_amd64.iso")).toBe(0);
    // A real rebuild of 0.5.0-alpha.3 is taken.
    publishRebuild(2, REBUILD_2, { version });
    const rebuilt = await fetchRecoveryIso(options(root));
    expect(rebuilt.state).toMatchObject({ status: "verified", rebuild: 2 });
  });

  it("finds the release in the alpha repository, and reports a release that is not published", async () => {
    const root = await agentRoot(ISO);
    const none = await fetchRecoveryIso(options(root));
    expect(none.state).toMatchObject({ status: "failed", problem: "not_published" });
    expect(none.transient).toBe(false);
    await publishRelease(root, ISO, "restow-backup/restow-alpha");
    const alpha = await fetchRecoveryIso(options(root));
    expect(alpha.state).toMatchObject({
      status: "verified",
      githubBase: server.base("restow-backup/restow-alpha"),
    });
  });

  it("does not touch the network when the image's own signature does not verify", async () => {
    const root = await agentRoot(ISO, OTHER);
    await publishRelease(root);
    const result = await fetchRecoveryIso(options(root));
    expect(result.state).toMatchObject({ status: "failed", problem: "signature_invalid" });
    expect(server.requests).toHaveLength(0);
    const unsigned = await agentRoot(null);
    expect((await fetchRecoveryIso(options(unsigned))).state).toMatchObject({
      status: "failed",
      problem: "no_iso_line",
    });
  });

  it("uses the drop folder without downloading, and only with the verified hash", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    await mkdir(join(store, "import"), { recursive: true });
    await writeFile(join(store, "import", recoveryIsoFileName("0.5.0")), ISO);
    const offline = await fetchRecoveryIso(options(root, { enabled: false }));
    expect(offline.state).toMatchObject({ status: "verified" });
    expect(server.requests).toHaveLength(0);
    // A rebuild dropped with its signed checksums counts the same.
    await writeFile(
      join(store, "import", "recovery-SHA256SUMS"),
      rebuildSums("0.5.0", 4, REBUILD_1),
    );
    await writeFile(
      join(store, "import", "recovery-SHA256SUMS.sig"),
      signReleaseForTests(privateKey, rebuildSums("0.5.0", 4, REBUILD_1)),
    );
    await writeFile(join(store, "import", "restow-recovery_0.5.0.4_amd64.iso"), REBUILD_1);
    const selection = await selectRecoveryIso({
      root,
      key: KEY,
      storeDir: store,
      dropDirs: [join(store, "import")],
    });
    expect(selection.offered).toMatchObject({
      rebuild: 4,
      fileName: "restow-recovery_0.5.0.4_amd64.iso",
    });
    expect(selection.local).toMatchObject({ origin: "import" });
    // A dropped file with other bytes is not offered; the store's own copy is not either.
    await writeFile(join(store, "import", "restow-recovery_0.5.0.4_amd64.iso"), REBUILD_2);
    resetRecoveryIsoHashCache();
    const tampered = await selectRecoveryIso({
      root,
      key: KEY,
      storeDir: store,
      dropDirs: [join(store, "import")],
    });
    expect(tampered.offered).toMatchObject({ rebuild: null });
    // Without a store nothing is written and nothing is fetched.
    const noStore = await fetchRecoveryIso(options(root, { storeDir: null, dropDirs: [] }));
    expect(noStore.state.status).toBe("disabled");
  });
});

describe("fetchRecoveryIso: space, deadline, lock and an unreachable release page", () => {
  const part = () => `${stored(recoveryIsoFileName("0.5.0"))}.part`;

  it("refuses to start without room for the ISO and the reserve, and keeps no partial file", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const result = await fetchRecoveryIso(
      options(root, { minFreeBytes: 1000, freeBytes: async () => ISO.length }),
    );
    expect(result.state).toMatchObject({ status: "failed", problem: "store_full" });
    expect(result.transient).toBe(false);
    expect(existsSync(part())).toBe(false);
    expect(existsSync(`${part()}.json`)).toBe(false);
    expect(existsSync(stored(recoveryIsoFileName("0.5.0")))).toBe(false);
  });

  it("stops when the volume runs low during the download and removes the partial file", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    // Plenty before the start, then the backups take the room.
    const answers = [10 * ISO.length];
    const result = await fetchRecoveryIso(
      options(root, { minFreeBytes: 1000, freeBytes: async () => answers.shift() ?? 10 }),
    );
    expect(result.state).toMatchObject({ status: "failed", problem: "store_full" });
    expect(result.transient).toBe(false);
    expect(existsSync(part())).toBe(false);
    expect(existsSync(`${part()}.json`)).toBe(false);
  });

  it("ends itself at its deadline with a resumable partial file", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    server.put("v0.5.0", recoveryIsoFileName("0.5.0"), ISO, "restow-backup/restow", {
      stallAfter: 100_000,
    });
    const first = await fetchRecoveryIso(options(root, { timeLimitMs: 2000 }));
    expect(first.state).toMatchObject({
      status: "failed",
      problem: "truncated",
      detail: "deadline",
    });
    expect(first.transient).toBe(true);
    const kept = (await stat(part())).size;
    expect(kept).toBeGreaterThan(0);
    // The lock went with the pass; the next one continues the file.
    expect(existsSync(join(store, ".fetch.lock"))).toBe(false);
    const second = await fetchRecoveryIso(options(root));
    expect(second.state).toMatchObject({ status: "verified", bytesDone: ISO.length });
    expect(server.requests.map((request) => request.range)).toContain(`bytes=${kept}-`);
  });

  it("leaves the store alone while another pass holds its lock, and takes over a stale lock", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const lock = join(store, ".fetch.lock");
    await mkdir(store, { recursive: true });
    await writeFile(lock, JSON.stringify({ token: "other", pid: 1 }));
    const busy = await fetchRecoveryIso(options(root));
    expect(busy.busy).toBe(true);
    expect(busy.transient).toBe(false);
    expect(server.countFor(recoveryIsoFileName("0.5.0"))).toBe(0);
    expect(existsSync(lock)).toBe(true);
    // A lock nobody refreshed for an hour belongs to a pass that is gone.
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(lock, old, old);
    const taken = await fetchRecoveryIso(options(root));
    expect(taken.busy).toBeUndefined();
    expect(taken.state).toMatchObject({ status: "verified" });
    expect(existsSync(lock)).toBe(false);
  });

  it("lets exactly one of several concurrent passes take over a stale lock", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const isoPath = `/asset-host/restow-backup/restow/releases/download/v0.5.0/${recoveryIsoFileName("0.5.0")}`;
    for (let round = 0; round < 4; round++) {
      store = await temp("restow-iso-store-");
      resetRecoveryIsoHashCache();
      const lock = join(store, ".fetch.lock");
      await writeFile(lock, JSON.stringify({ token: "gone", pid: 1 }));
      const old = new Date(Date.now() - 60 * 60_000);
      await utimes(lock, old, old);
      const before = server.countFor(isoPath);
      const passes = round % 2 === 0 ? 2 : 4;
      const results = await Promise.all(
        Array.from({ length: passes }, () => fetchRecoveryIso(options(root))),
      );
      const winners = results.filter((result) => !result.busy);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.state).toMatchObject({ status: "verified" });
      expect(results.filter((result) => result.busy)).toHaveLength(passes - 1);
      // One download, one writer of the partial file, and nothing of the takeover left behind.
      expect(server.countFor(isoPath) - before).toBe(1);
      expect(await readFile(stored(recoveryIsoFileName("0.5.0")))).toEqual(ISO);
      expect((await readdir(store)).filter((name) => name.startsWith(".fetch.lock"))).toEqual([]);
    }
  }, 30_000);

  it("stops writing once another pass took its lock over", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    server.put("v0.5.0", recoveryIsoFileName("0.5.0"), ISO, "restow-backup/restow", {
      stallAfter: 100_000,
    });
    const lock = join(store, ".fetch.lock");
    const running = fetchRecoveryIso(options(root, { timeLimitMs: 1500 }));
    await untilSize(part(), 100_000);
    const fetching = await readRecoveryIsoFetchState(store);
    expect(fetching?.status).toBe("fetching");
    // The pass went silent; another one took the store over (a lock with its own token).
    await writeFile(lock, JSON.stringify({ token: "newer", pid: 2 }));
    const result = await running;
    expect(result.busy).toBe(true);
    // It neither recorded its cut-off transfer nor removed the other pass's lock or the part.
    expect(await readRecoveryIsoFetchState(store)).toMatchObject({ status: "fetching" });
    expect(JSON.parse(await readFile(lock, "utf8"))).toMatchObject({ token: "newer" });
    expect((await stat(part())).size).toBeGreaterThanOrEqual(100_000);
  });

  it("does not report a skipped rebuild or retry when only the release page cannot be reached", async () => {
    const root = await agentRoot(ISO);
    await mkdir(join(store, "import"), { recursive: true });
    await writeFile(join(store, "import", recoveryIsoFileName("0.5.0")), ISO);
    // Nothing listens on the bases: an installation without internet access.
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await fetchRecoveryIso(
      options(root, { bases: [`http://127.0.0.1:${port}/restow-backup/restow`] }),
    );
    expect(result.state).toMatchObject({ status: "verified", problem: null, detail: null });
    expect(result.transient).toBe(false);
    expect(result.lookupProblem).toMatchObject({ problem: "network" });
    // A rebuild that was found and refused still is a note.
    await publishRelease(root);
    publishRebuild(1, REBUILD_1, { signer: OTHER });
    const refused = await fetchRecoveryIso(options(root));
    expect(refused.state).toMatchObject({ status: "verified", problem: "signature_invalid" });
    expect(refused.transient).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The proxy variables
// ---------------------------------------------------------------------------

describe("proxies", () => {
  let proxy: net.Server;
  let proxyPort = 0;
  const tunnels: string[] = [];

  beforeAll(async () => {
    // A minimal CONNECT proxy.
    proxy = http.createServer((_request, response) => response.writeHead(405).end());
    proxy.on("connect", (request: IncomingMessage, client: net.Socket) => {
      tunnels.push(String(request.url));
      const [host, port] = String(request.url).split(":");
      const upstream = net.connect(Number(port), host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  afterEach(() => {
    tunnels.length = 0;
  });

  it("reads HTTPS_PROXY, HTTP_PROXY and NO_PROXY", () => {
    const settings = proxySettingsFromEnv({
      HTTPS_PROXY: "http://proxy.firma.de:3128",
      http_proxy: "proxy.firma.de:8080",
      NO_PROXY: "localhost, .intern.firma.de,example.org:443",
    });
    expect(proxyFor(new URL("https://github.com/x"), settings)?.host).toBe("proxy.firma.de:3128");
    expect(proxyFor(new URL("http://github.com/x"), settings)?.host).toBe("proxy.firma.de:8080");
    expect(proxyFor(new URL("https://a.intern.firma.de/x"), settings)).toBeNull();
    expect(proxyFor(new URL("https://example.org/x"), settings)).toBeNull();
    expect(proxyFor(new URL("https://sub.example.org/x"), settings)).toBeNull();
    expect(proxyFor(new URL("https://localhost/x"), settings)).toBeNull();
    expect(proxyFor(new URL("https://github.com/x"), { ...settings, noProxy: ["*"] })).toBeNull();
    // An https:// proxy URL is not supported and means no proxy.
    expect(proxySettingsFromEnv({ HTTPS_PROXY: "https://proxy:3128" }).https).toBeNull();
  });

  it("downloads through the proxy's tunnel", async () => {
    const root = await agentRoot(ISO);
    await publishRelease(root);
    const result = await fetchRecoveryIso(
      options(root, {
        http: {
          allowInsecureHttp: true,
          allowPrivateNetworks: true,
          proxy: { https: null, http: new URL(`http://127.0.0.1:${proxyPort}`), noProxy: [] },
        },
      }),
    );
    expect(result.state.status).toBe("verified");
    expect(tunnels.length).toBeGreaterThan(0);
    expect(tunnels.every((target) => target === `127.0.0.1:${server.port}`)).toBe(true);
  });
});
