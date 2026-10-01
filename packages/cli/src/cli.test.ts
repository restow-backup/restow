/**
 * `restow-restore` end to end, in-process: a store protected by a KEK, as an
 * operator would hand it over, restored and verified through `runCli`, the
 * code path of the binary. The manifest is sealed with the tenant key, as the
 * server stores it. A chunk filed under the wrong id, a chunk whose content
 * does not hash to its id, and an object whose bytes do not match the
 * manifest's SHA-256 must each make the run fail with a non-zero exit code,
 * without a file for that object on disk.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Dek,
  LocalStorageBackend,
  MANIFEST_VERSION,
  type ManifestObject,
  PackWriter,
  type SnapshotManifest,
  deriveChunkIdKey,
  encryptChunk,
  sealManifest,
  storedId,
  wrapDek,
} from "@restow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";
import { chunkIdKeyFor, loadKeyring } from "./keyring.js";

const TENANT_ID = "3c9e1a52-7b0d-4f6e-9a18-2d4c6e8f0a1b";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x21) };
const kek = Buffer.alloc(32, 0x42);
const chunkIdKey = deriveChunkIdKey(TENANT_ID, dek);

// alpha and bravo have the same length, so a swap passes every size check.
const alpha = Buffer.from("alpha ".repeat(100));
const bravo = Buffer.from("bravo ".repeat(100));
const charlie = [Buffer.from("charlie one ".repeat(50)), Buffer.from("charlie two ".repeat(30))];

const MANIFEST_KEY = `tenants/${TENANT_ID}/manifests/snap-1.json.zst`;

type Tamper = "swapped_chunk" | "resealed_chunk" | "object_hash";

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function idOf(plaintext: Buffer): Buffer {
  return storedId(chunkIdKey, plaintext);
}

function sealWith(key: Dek, plaintext: Buffer, id: Buffer = idOf(plaintext)): Buffer {
  return encryptChunk(key, plaintext, id);
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "restow-cli-run-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Store {
  storageDir: string;
  keyFile: string;
  outDir: string;
}

/**
 * A one-pack store with three objects, optionally tampered with in one way.
 * Chunks are sealed with `sealingKey` (the tenant's first key by default).
 */
async function buildStore(
  name: string,
  tamper: Tamper | null,
  sealingKey: Dek = dek,
): Promise<Store> {
  const seal = (plaintext: Buffer, id?: Buffer) => sealWith(sealingKey, plaintext, id);
  const dir = join(root, name);
  const storageDir = join(dir, "store");
  const backend = new LocalStorageBackend(storageDir);
  await backend.put(`tenants/${TENANT_ID}/keys/1`, wrapDek(kek, dek));
  const keyFile = join(dir, "kek.key");
  await writeFile(keyFile, kek.toString("hex"), "utf8");

  const writer = new PackWriter(TENANT_ID);
  if (tamper === "swapped_chunk") {
    // bravo's sealed chunk (its header names bravo's id) filed under alpha's id.
    writer.append(idOf(alpha), seal(bravo));
  } else if (tamper === "resealed_chunk") {
    // Other bytes sealed under alpha's id: only re-addressing the plaintext tells.
    writer.append(idOf(alpha), seal(bravo, idOf(alpha)));
  } else {
    writer.append(idOf(alpha), seal(alpha));
  }
  writer.append(idOf(bravo), seal(bravo));
  for (const part of charlie) {
    writer.append(idOf(part), seal(part));
  }
  await backend.put(`tenants/${TENANT_ID}/packs/00/pack-1`, writer.finalize());

  const charlieBytes = Buffer.concat(charlie);
  const objects: ManifestObject[] = [
    {
      path: "docs/alpha.txt",
      type: "file",
      size: alpha.length,
      mtime: 0,
      sha256: sha256Hex(tamper === "object_hash" ? bravo : alpha),
      chunks: [idOf(alpha).toString("hex")],
    },
    {
      path: "docs/bravo.txt",
      type: "file",
      size: bravo.length,
      mtime: 0,
      sha256: sha256Hex(bravo),
      chunks: [idOf(bravo).toString("hex")],
    },
    {
      path: "media/charlie.bin",
      type: "file",
      size: charlieBytes.length,
      mtime: 0,
      sha256: sha256Hex(charlieBytes),
      chunks: charlie.map((part) => idOf(part).toString("hex")),
    },
  ];
  const manifest: SnapshotManifest = {
    version: MANIFEST_VERSION,
    tenantId: TENANT_ID,
    snapshotId: "snap-1",
    createdAt: Date.UTC(2026, 8, 20),
    source: { type: "m365", id: "drive-1" },
    objects,
  };
  await backend.put(MANIFEST_KEY, await sealManifest(manifest, sealingKey, MANIFEST_KEY));
  return { storageDir, keyFile, outDir: join(dir, "out") };
}

function captureIo(): CliIo & { err: () => string } {
  const errors: string[] = [];
  return {
    stdout: () => {},
    stderr: (text) => {
      errors.push(text);
    },
    err: () => errors.join(""),
  };
}

async function restore(store: Store, io: CliIo): Promise<number> {
  return runCli(
    [
      "restore",
      "--manifest",
      MANIFEST_KEY,
      "--storage",
      store.storageDir,
      "--key",
      store.keyFile,
      "--out",
      store.outDir,
    ],
    io,
  );
}

async function verify(store: Store, io: CliIo): Promise<number> {
  return runCli(
    ["verify", "--manifest", MANIFEST_KEY, "--storage", store.storageDir, "--key", store.keyFile],
    io,
  );
}

async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

describe("restow-restore", () => {
  it("restores and verifies an intact store with exit code 0", async () => {
    const store = await buildStore("intact", null);
    const io = captureIo();
    expect(await restore(store, io)).toBe(0);
    expect(await filesBelow(store.outDir)).toEqual([
      "docs/alpha.txt",
      "docs/bravo.txt",
      "media/charlie.bin",
    ]);
    expect((await readFile(join(store.outDir, "docs/alpha.txt"))).equals(alpha)).toBe(true);
    expect(
      (await readFile(join(store.outDir, "media/charlie.bin"))).equals(Buffer.concat(charlie)),
    ).toBe(true);
    expect(io.err()).toMatch(/restored snapshot snap-1 .*3\/3 ok, 0 skipped, 0 failed/);
    // The KEK path derives the chunk-id key, so no downgrade note is printed.
    expect(io.err()).not.toMatch(/no chunk-id key/);

    expect(await verify(store, captureIo())).toBe(0);
  });

  it.each<[Tamper, RegExp]>([
    ["swapped_chunk", /stored under a mismatched id/],
    ["resealed_chunk", /failed the content hash check/],
    ["object_hash", /SHA-256 mismatch/],
  ])(
    "exits non-zero on a tampered store (%s) without writing the bad file",
    async (tamper, reason) => {
      const store = await buildStore(tamper, tamper);
      const io = captureIo();
      expect(await restore(store, io)).toBe(1);

      // The intact objects are restored; the tampered one leaves nothing
      // behind, not even a temporary file.
      expect(await filesBelow(store.outDir)).toEqual(["docs/bravo.txt", "media/charlie.bin"]);
      expect((await readFile(join(store.outDir, "docs/bravo.txt"))).equals(bravo)).toBe(true);
      await expect(stat(join(store.outDir, "docs/alpha.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const output = io.err();
      expect(output).toMatch(/2\/3 ok, 0 skipped, 1 failed/);
      expect(output).toMatch(
        /failed objects \(1, 1 with data that does not match the manifest\):\n {2}docs\/alpha\.txt: /,
      );
      expect(output).toMatch(reason);

      const verifyIo = captureIo();
      expect(await verify(store, verifyIo)).toBe(1);
      expect(verifyIo.err()).toMatch(reason);
    },
  );

  it("exits non-zero with the reason when the run cannot start", async () => {
    const store = await buildStore("no-manifest", null);
    const io = captureIo();
    const code = await runCli(
      [
        "restore",
        "--manifest",
        "tenants/nowhere/manifests/missing.json.zst",
        "--storage",
        store.storageDir,
        "--key",
        store.keyFile,
        "--out",
        store.outDir,
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.err()).toMatch(/^restow-restore: /m);
    await expect(stat(store.outDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the object list sealed in the store and opens it from a local copy too", async () => {
    const store = await buildStore("sealed", null);
    const stored = await readFile(join(store.storageDir, MANIFEST_KEY));
    for (const path of [
      "docs/alpha.txt",
      "docs/bravo.txt",
      "media/charlie.bin",
      sha256Hex(alpha),
    ]) {
      expect(stored.toString("latin1")).not.toContain(path);
    }

    // Handed over as a file: the header names the tenant whose keys open it.
    const local = join(root, "sealed", "snapshot.manifest");
    await copyFile(join(store.storageDir, MANIFEST_KEY), local);
    const io = captureIo();
    expect(
      await runCli(
        [
          "restore",
          "--manifest",
          local,
          "--storage",
          store.storageDir,
          "--key",
          store.keyFile,
          "--out",
          store.outDir,
        ],
        io,
      ),
    ).toBe(0);
    expect(io.err()).toMatch(/3\/3 ok, 0 skipped, 0 failed/);
  });

  it("refuses a sealed manifest found under another snapshot's key", async () => {
    const store = await buildStore("moved", null);
    const moved = `tenants/${TENANT_ID}/manifests/snap-2.json.zst`;
    await copyFile(join(store.storageDir, MANIFEST_KEY), join(store.storageDir, moved));
    const io = captureIo();
    expect(
      await runCli(
        ["verify", "--manifest", moved, "--storage", store.storageDir, "--key", store.keyFile],
        io,
      ),
    ).toBe(1);
    expect(io.err()).toMatch(/bound to .*snap-1\.json\.zst/);
  });

  it("reports usage errors through commander with its exit code", async () => {
    const io = captureIo();
    expect(await runCli(["restore", "--manifest", "x"], io)).toBe(1);
    expect(io.err()).toMatch(/required option/);
    expect(await runCli(["--version"], captureIo())).toBe(0);
  });

  it('restores a post-"keep"-switch snapshot from --storage repeated across both locations', async () => {
    // Models a "keep" storage-target replacement (docs/STORAGE.md, "Replace the
    // primary"): alpha's chunk was deduped against a pack that already existed
    // on the old primary before the switch and so was never copied to the new
    // one, while bravo is new content written only after the switch, so its
    // pack sits only on the new primary. The manifest itself, like every
    // post-switch manifest, lives only on the new primary. The wrapped tenant
    // key predates the switch and is unaffected either way, so it is written
    // to both locations here, isolating the scenario to the pack index gap the
    // finding is about rather than key lookup.
    const dir = join(root, "keep-switch");
    const oldPrimary = join(dir, "old-primary");
    const newPrimary = join(dir, "new-primary");
    const oldBackend = new LocalStorageBackend(oldPrimary);
    const newBackend = new LocalStorageBackend(newPrimary);
    const wrappedKey = wrapDek(kek, dek);
    await oldBackend.put(`tenants/${TENANT_ID}/keys/1`, wrappedKey);
    await newBackend.put(`tenants/${TENANT_ID}/keys/1`, wrappedKey);

    const oldWriter = new PackWriter(TENANT_ID);
    oldWriter.append(idOf(alpha), sealWith(dek, alpha));
    await oldBackend.put(`tenants/${TENANT_ID}/packs/00/pack-old`, oldWriter.finalize());

    const newWriter = new PackWriter(TENANT_ID);
    newWriter.append(idOf(bravo), sealWith(dek, bravo));
    await newBackend.put(`tenants/${TENANT_ID}/packs/00/pack-new`, newWriter.finalize());

    const manifestKey = `tenants/${TENANT_ID}/manifests/snap-keep.json.zst`;
    const objects: ManifestObject[] = [
      {
        path: "docs/alpha.txt",
        type: "file",
        size: alpha.length,
        mtime: 0,
        sha256: sha256Hex(alpha),
        chunks: [idOf(alpha).toString("hex")],
      },
      {
        path: "docs/bravo.txt",
        type: "file",
        size: bravo.length,
        mtime: 0,
        sha256: sha256Hex(bravo),
        chunks: [idOf(bravo).toString("hex")],
      },
    ];
    const manifest: SnapshotManifest = {
      version: MANIFEST_VERSION,
      tenantId: TENANT_ID,
      snapshotId: "snap-keep",
      createdAt: Date.UTC(2026, 8, 24),
      source: { type: "m365", id: "drive-1" },
      objects,
    };
    await newBackend.put(manifestKey, await sealManifest(manifest, dek, manifestKey));

    const keyFile = join(dir, "kek.key");
    await writeFile(keyFile, kek.toString("hex"), "utf8");

    // A single --storage (the new primary alone) cannot reach alpha's chunk.
    const singleOut = join(dir, "out-single");
    const singleIo = captureIo();
    const singleCode = await runCli(
      [
        "restore",
        "--manifest",
        manifestKey,
        "--storage",
        newPrimary,
        "--key",
        keyFile,
        "--out",
        singleOut,
      ],
      singleIo,
    );
    expect(singleCode).toBe(1);
    expect(singleIo.err()).toMatch(/1\/2 ok, 0 skipped, 1 failed/);
    expect(await filesBelow(singleOut)).toEqual(["docs/bravo.txt"]);

    // Repeating --storage, new primary first then the retired old one, finds
    // both packs and restores the whole snapshot.
    const bothOut = join(dir, "out-both");
    const bothIo = captureIo();
    const bothCode = await runCli(
      [
        "restore",
        "--manifest",
        manifestKey,
        "--storage",
        newPrimary,
        "--storage",
        oldPrimary,
        "--key",
        keyFile,
        "--out",
        bothOut,
      ],
      bothIo,
    );
    expect(bothCode).toBe(0);
    expect(bothIo.err()).toMatch(/2\/2 ok, 0 skipped, 0 failed/);
    expect(await filesBelow(bothOut)).toEqual(["docs/alpha.txt", "docs/bravo.txt"]);
    expect((await readFile(join(bothOut, "docs/alpha.txt"))).equals(alpha)).toBe(true);
    expect((await readFile(join(bothOut, "docs/bravo.txt"))).equals(bravo)).toBe(true);

    // Order does not affect the outcome: old primary first, then new, finds
    // the same two packs (and the manifest, which sits only on the new one).
    const reorderedOut = join(dir, "out-reordered");
    const reorderedCode = await runCli(
      [
        "restore",
        "--manifest",
        manifestKey,
        "--storage",
        oldPrimary,
        "--storage",
        newPrimary,
        "--key",
        keyFile,
        "--out",
        reorderedOut,
      ],
      captureIo(),
    );
    expect(reorderedCode).toBe(0);
    expect(await filesBelow(reorderedOut)).toEqual(["docs/alpha.txt", "docs/bravo.txt"]);
  });
});

describe("chunk-id key", () => {
  it("is derived from the version 1 data key exactly as the server derives it", async () => {
    expect(chunkIdKeyFor(TENANT_ID, [{ version: 2, material: Buffer.alloc(32, 1) }, dek])).toEqual(
      chunkIdKey,
    );
    expect(
      chunkIdKeyFor(TENANT_ID, [{ version: 2, material: Buffer.alloc(32, 1) }]),
    ).toBeUndefined();

    const store = await buildStore("keys", null);
    const backend = new LocalStorageBackend(store.storageDir);
    const fromKek = await loadKeyring({ keyRef: store.keyFile, backend, tenantId: TENANT_ID });
    expect(fromKek.hmacKey?.equals(chunkIdKey)).toBe(true);

    const exported = join(root, "keys", "keyring.json");
    await writeFile(
      exported,
      JSON.stringify({ keys: [{ version: 1, material: dek.material.toString("base64") }] }),
    );
    const fromExport = await loadKeyring({ keyRef: exported, backend, tenantId: TENANT_ID });
    expect(fromExport.hmacKey?.equals(chunkIdKey)).toBe(true);
  });

  it("says so when the chunk ids cannot be recomputed, and still checks objects", async () => {
    // A keyring exported without the tenant's first key: the chunks open, but
    // their ids cannot be recomputed.
    const second: Dek = { version: 2, material: Buffer.alloc(32, 0x37) };
    const exportKeyring = async (dir: string) => {
      const file = join(root, dir, "keyring.json");
      await writeFile(
        file,
        JSON.stringify({ keys: [{ version: 2, material: second.material.toString("hex") }] }),
      );
      return file;
    };
    const run = async (store: Store, keyFile: string) => {
      const io = captureIo();
      const code = await runCli(
        [
          "restore",
          "--manifest",
          MANIFEST_KEY,
          "--storage",
          store.storageDir,
          "--key",
          keyFile,
          "--out",
          store.outDir,
        ],
        io,
      );
      return { code, output: io.err() };
    };

    const intact = await buildStore("second-key", null, second);
    const clean = await run(intact, await exportKeyring("second-key"));
    expect(clean.code).toBe(0);
    expect(clean.output).toMatch(/note: no chunk-id key/);

    const tampered = await buildStore("second-key-tampered", "object_hash", second);
    const failed = await run(tampered, await exportKeyring("second-key-tampered"));
    expect(failed.code).toBe(1);
    expect(failed.output).toMatch(/SHA-256 mismatch/);
    expect(await filesBelow(tampered.outDir)).toEqual(["docs/bravo.txt", "media/charlie.bin"]);
  });
});
