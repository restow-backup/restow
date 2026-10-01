/**
 * Server-less restore proof: build a real chunk store with @restow/core, then
 * reconstruct and verify it through the standalone code paths only. This is the
 * "restore is the product" guarantee for packages/cli (docs/TESTING.md).
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Dek,
  LocalStorageBackend,
  MANIFEST_VERSION,
  type ManifestObject,
  PackWriter,
  type SnapshotManifest,
  encryptChunk,
  serializeManifest,
  storedId,
  wrapDek,
} from "@restow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keyring, loadKeyring } from "./keyring.js";
import { restoreSnapshot, verifySnapshot } from "./restore.js";
import { ChunkStore, readManifest } from "./store.js";

const TENANT_ID = "tenant-test";
const tenantKey = Buffer.alloc(32, 0x05); // HMAC key for stored ids
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x08) };
const kek = Buffer.alloc(32, 0x11);

// Two objects; the second spans multiple chunks to exercise ordered reassembly.
const objectA = { path: "docs/report.txt", data: Buffer.from("the quarterly report, in full") };
const objectB = {
  path: "media/photo.bin",
  data: Buffer.concat([Buffer.alloc(5000, 0xa1), Buffer.alloc(3000, 0xb2)]),
};
const objectBChunks = [objectB.data.subarray(0, 5000), objectB.data.subarray(5000)];

let root: string;
let storageDir: string;
let backend: LocalStorageBackend;
let manifest: SnapshotManifest;
/** Stored chunk ids (hex) of object A and of object B's two chunks. */
let chunksA: string[];
let chunksB: string[];

function seal(plaintext: Buffer): { id: Buffer; sealed: Buffer } {
  const id = storedId(tenantKey, plaintext);
  return { id, sealed: encryptChunk(dek, plaintext, id) };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "restow-cli-"));
  storageDir = join(root, "store");
  backend = new LocalStorageBackend(storageDir);

  const writer = new PackWriter(TENANT_ID);
  const a = seal(objectA.data);
  const b0 = seal(objectBChunks[0]);
  const b1 = seal(objectBChunks[1]);
  for (const { id, sealed } of [a, b0, b1]) {
    writer.append(id, sealed);
  }
  await backend.put(`tenants/${TENANT_ID}/packs/00/pack-1`, writer.finalize());
  chunksA = [a.id.toString("hex")];
  chunksB = [b0.id.toString("hex"), b1.id.toString("hex")];

  // A wrapped DEK in the store, so the KEK path of loadKeyring has something to open.
  await backend.put(`tenants/${TENANT_ID}/keys/1`, wrapDek(kek, dek));

  manifest = {
    version: MANIFEST_VERSION,
    tenantId: TENANT_ID,
    snapshotId: "snap-1",
    createdAt: Date.now(),
    source: { type: "m365", id: "drive-1" },
    objects: [
      {
        path: objectA.path,
        size: objectA.data.length,
        mtime: Date.now(),
        chunks: [a.id.toString("hex")],
      },
      {
        path: objectB.path,
        size: objectB.data.length,
        mtime: Date.now(),
        chunks: [b0.id.toString("hex"), b1.id.toString("hex")],
      },
    ],
  };
  await backend.put(
    `tenants/${TENANT_ID}/manifests/snap-1.json.zst`,
    await serializeManifest(manifest),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("standalone restore", () => {
  it("reassembles every object byte-for-byte", async () => {
    const store = await ChunkStore.build(backend, TENANT_ID);
    expect(store.chunkCount).toBe(3);
    const keyring = new Keyring([dek], tenantKey);
    const outDir = join(root, "out");

    const report = await restoreSnapshot({ manifest, store, keyring, outDir });
    expect(report.failed).toBe(0);
    expect(report.restored).toBe(2);

    expect((await readFile(join(outDir, objectA.path))).equals(objectA.data)).toBe(true);
    expect((await readFile(join(outDir, objectB.path))).equals(objectB.data)).toBe(true);
  });

  it("verifies end to end with the tenant hmac key", async () => {
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const report = await verifySnapshot({ manifest, store, keyring });
    expect(report.failed).toBe(0);
    expect(report.total).toBe(2);
  });

  it("reports a failure for a missing chunk instead of throwing", async () => {
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const broken: SnapshotManifest = {
      ...manifest,
      objects: [{ path: "ghost.txt", size: 4, mtime: Date.now(), chunks: ["00".repeat(32)] }],
    };
    const report = await verifySnapshot({ manifest: broken, store, keyring });
    expect(report.failed).toBe(1);
    expect(report.results[0].ok).toBe(false);
  });
});

describe("key material", () => {
  it("unwraps stored DEKs with a KEK from a keyfile", async () => {
    const keyfile = join(root, "kek.key");
    await writeFile(keyfile, kek.toString("hex"), "utf8");
    const keyring = await loadKeyring({ keyRef: keyfile, backend, tenantId: TENANT_ID });
    expect(keyring.size).toBe(1);

    const { sealed } = seal(objectA.data);
    expect(keyring.decrypt(sealed).equals(objectA.data)).toBe(true);
  });

  it("accepts an exported keyring document", async () => {
    const keyfile = join(root, "keyring.json");
    await writeFile(
      keyfile,
      JSON.stringify({
        tenantId: TENANT_ID,
        keys: [{ version: dek.version, material: dek.material.toString("base64") }],
        hmacKey: tenantKey.toString("base64"),
      }),
      "utf8",
    );
    const keyring = await loadKeyring({ keyRef: keyfile, backend, tenantId: TENANT_ID });
    expect(keyring.size).toBe(1);
    expect(keyring.hmacKey?.equals(tenantKey)).toBe(true);
  });
});

describe("damaged packs", () => {
  const DAMAGED_TENANT = "tenant-damaged";

  it("skips an unreadable pack and still restores objects from intact packs", async () => {
    const keptData = Buffer.from("survives in an intact pack");
    const lostData = Buffer.from("only in the truncated pack");
    const intact = seal(keptData);
    const lost = seal(lostData);

    const intactWriter = new PackWriter(DAMAGED_TENANT);
    intactWriter.append(intact.id, intact.sealed);
    await backend.put(`tenants/${DAMAGED_TENANT}/packs/00/pack-intact`, intactWriter.finalize());

    // An orphan a worker left half-written: the trailer never made it to disk.
    const lostWriter = new PackWriter(DAMAGED_TENANT);
    lostWriter.append(lost.id, lost.sealed);
    const complete = lostWriter.finalize();
    await backend.put(
      `tenants/${DAMAGED_TENANT}/packs/01/pack-truncated`,
      complete.subarray(0, complete.length - 7),
    );

    const store = await ChunkStore.build(backend, DAMAGED_TENANT);
    expect(store.chunkCount).toBe(1);
    expect(store.unreadablePacks).toEqual([
      { key: `tenants/${DAMAGED_TENANT}/packs/01/pack-truncated`, reason: expect.any(String) },
    ]);

    const damagedManifest: SnapshotManifest = {
      ...manifest,
      tenantId: DAMAGED_TENANT,
      objects: [
        {
          path: "kept.txt",
          size: keptData.length,
          mtime: Date.now(),
          chunks: [intact.id.toString("hex")],
        },
        {
          path: "lost.txt",
          size: lostData.length,
          mtime: Date.now(),
          chunks: [lost.id.toString("hex")],
        },
      ],
    };
    const outDir = join(root, "out-damaged");
    const report = await restoreSnapshot({
      manifest: damagedManifest,
      store,
      keyring: new Keyring([dek], tenantKey),
      outDir,
    });

    expect(report.restored).toBe(1);
    expect(report.failed).toBe(1);
    expect((await readFile(join(outDir, "kept.txt"))).equals(keptData)).toBe(true);
    const lostResult = report.results.find((result) => result.path === "lost.txt");
    expect(lostResult?.error).toMatch(/not present in any readable pack .*1 unreadable pack/);
    expect(lostResult?.integrity).toBeUndefined();
    expect(report.failures).toEqual([lostResult]);
    await expect(stat(join(outDir, "lost.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves no partial file when a later chunk of an object is missing", async () => {
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const outDir = join(root, "out-partial");
    const halfThere: SnapshotManifest = {
      ...manifest,
      objects: [
        {
          path: "media/half.bin",
          size: objectB.data.length,
          mtime: Date.now(),
          // The first chunk streams to disk before the missing second one fails.
          chunks: [chunksB[0] as string, "ab".repeat(32)],
        },
      ],
    };
    const report = await restoreSnapshot({ manifest: halfThere, store, keyring, outDir });
    expect(report.failed).toBe(1);
    expect(report.failures[0]?.error).toMatch(/not present in any pack/);
    expect(await readdir(join(outDir, "media"))).toEqual([]);
  });

  it("rejects a manifest chunk id that is not hex", async () => {
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const report = await verifySnapshot({
      manifest: {
        ...manifest,
        objects: [{ path: "odd.txt", size: 1, mtime: Date.now(), chunks: ["not-hex"] }],
      },
      store,
      keyring,
    });
    expect(report.failures[0]).toMatchObject({
      integrity: true,
      error: expect.stringMatching(/invalid chunk id/),
    });
  });
});

describe("manifest reading", () => {
  const manifestKey = (name: string) => `tenants/${TENANT_ID}/manifests/${name}`;

  it("reads a serialized manifest back from the store", async () => {
    const loaded = await readManifest(manifestKey("snap-1.json.zst"), backend);
    expect(loaded.snapshotId).toBe("snap-1");
    expect(loaded.objects).toHaveLength(2);
  });

  it("accepts plain JSON, including a byte order mark and leading whitespace", async () => {
    const json = Buffer.from(`\n  ${JSON.stringify(manifest)}`, "utf8");
    await backend.put(
      manifestKey("plain.json"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]),
    );
    const loaded = await readManifest(manifestKey("plain.json"), backend);
    expect(loaded.snapshotId).toBe("snap-1");
  });

  it("accepts the plain line form: a header line, then one object per line", async () => {
    const { objects, ...fields } = manifest;
    const lines = [
      JSON.stringify({ ...fields, objectCount: objects.length }),
      ...objects.map((object) => JSON.stringify(object)),
    ];
    await backend.put(manifestKey("plain.ndjson"), Buffer.from(`${lines.join("\n")}\n`, "utf8"));
    const loaded = await readManifest(manifestKey("plain.ndjson"), backend);
    expect(loaded).toEqual(manifest);

    // A line form that lost its last object is reported, not restored short.
    await backend.put(
      manifestKey("short.ndjson"),
      Buffer.from(`${lines.slice(0, -1).join("\n")}\n`, "utf8"),
    );
    await expect(readManifest(manifestKey("short.ndjson"), backend)).rejects.toThrow(
      /could not be decoded: manifest is truncated or damaged/,
    );
  });

  it("surfaces a codec error instead of masking it as a JSON error", async () => {
    // zstd codec tag followed by a payload that is not a zstd frame.
    await backend.put(manifestKey("corrupt.zst"), Buffer.from([0x01, 0xde, 0xad, 0xbe, 0xef]));
    const error = await readManifest(manifestKey("corrupt.zst"), backend).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not be decoded/);
    expect((error as Error).message).not.toMatch(/JSON/);
  });

  it("names an unknown codec tag", async () => {
    await backend.put(manifestKey("future.bin"), Buffer.from([0x07, 0x00]));
    await expect(readManifest(manifestKey("future.bin"), backend)).rejects.toThrow(
      /unknown manifest codec 0x7/,
    );
  });

  it("rejects JSON that is not a snapshot manifest", async () => {
    await backend.put(manifestKey("other.json"), Buffer.from('{"hello":"world"}'));
    await expect(readManifest(manifestKey("other.json"), backend)).rejects.toThrow(
      /not a snapshot manifest/,
    );
  });
});

// ---------------------------------------------------------------------------
// Folder objects: every engine records its folders at the parent paths of its
// items, and manifests list objects sorted by path, so a folder always comes
// before its children.

const byPath = (left: ManifestObject, right: ManifestObject) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

function folder(path: string, metadata: Record<string, string> = {}): ManifestObject {
  return { path, type: "folder", size: 0, mtime: Date.now(), metadata, chunks: [] };
}

function item(path: string, type: string, content: "a" | "b"): ManifestObject {
  const data = content === "a" ? objectA.data : objectB.data;
  const chunks = content === "a" ? chunksA : chunksB;
  return { path, type, size: data.length, mtime: Date.now(), chunks };
}

function layoutManifest(
  snapshotId: string,
  source: SnapshotManifest["source"],
  objects: ManifestObject[],
): SnapshotManifest {
  return {
    version: MANIFEST_VERSION,
    tenantId: TENANT_ID,
    snapshotId,
    createdAt: Date.now(),
    source,
    objects: [...objects].sort(byPath),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory();
}

describe("standalone restore of folder objects", () => {
  it("restores an Exchange mailbox: area roots and folders become directories", async () => {
    const mailbox = layoutManifest(
      "snap-exchange",
      { type: "m365", id: "mbx-1", kind: "mailbox" },
      [
        folder("mail", { folderKind: "root" }),
        folder("mail/Inbox", { folderKind: "mail", folderPath: "Inbox" }),
        folder("mail/Inbox/Projects", { folderKind: "mail", folderPath: "Inbox/Projects" }),
        item("mail/Inbox/Hello.AAMk1.eml", "mail", "a"),
        folder("calendar", { folderKind: "root" }),
        folder("calendar/Calendar", { folderKind: "calendar", calendarName: "Calendar" }),
        item("calendar/Calendar/Standup.AAMk2.json", "event", "b"),
        folder("contacts", { folderKind: "root" }),
        item("contacts/Anna Berg.AAMk3.json", "contact", "a"),
      ],
    );
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const outDir = join(root, "out-exchange");

    const report = await restoreSnapshot({ manifest: mailbox, store, keyring, outDir });
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report).toMatchObject({ total: 9, restored: 9, skipped: 0, failed: 0 });

    expect((await readFile(join(outDir, "mail/Inbox/Hello.AAMk1.eml"))).equals(objectA.data)).toBe(
      true,
    );
    expect(
      (await readFile(join(outDir, "calendar/Calendar/Standup.AAMk2.json"))).equals(objectB.data),
    ).toBe(true);
    expect(
      (await readFile(join(outDir, "contacts/Anna Berg.AAMk3.json"))).equals(objectA.data),
    ).toBe(true);
    expect(await isDirectory(join(outDir, "mail/Inbox/Projects"))).toBe(true);

    expect((await verifySnapshot({ manifest: mailbox, store, keyring })).failed).toBe(0);
  });

  it("restores an IMAP account: mailboxes, nested ones included, become directories", async () => {
    const account = layoutManifest("snap-imap", { type: "imap", id: "imap-1", kind: "imap" }, [
      folder("mail/INBOX", { mailbox: "INBOX", delimiter: "." }),
      item("mail/INBOX/1.eml", "message", "a"),
      folder("mail/INBOX/Archive", { mailbox: "INBOX.Archive", delimiter: "." }),
      item("mail/INBOX/Archive/7.eml", "message", "b"),
      folder("mail/Sent", { mailbox: "Sent", delimiter: ".", specialUse: "\\Sent" }),
    ]);
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const outDir = join(root, "out-imap");

    const report = await restoreSnapshot({ manifest: account, store, keyring, outDir });
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report).toMatchObject({ total: 5, restored: 5, skipped: 0, failed: 0 });

    expect((await readFile(join(outDir, "mail/INBOX/1.eml"))).equals(objectA.data)).toBe(true);
    expect((await readFile(join(outDir, "mail/INBOX/Archive/7.eml"))).equals(objectB.data)).toBe(
      true,
    );
    expect(await isDirectory(join(outDir, "mail/Sent"))).toBe(true);
  });

  it("restores a OneDrive: folders and notebooks become directories, shortcuts are skipped", async () => {
    const drive = layoutManifest(
      "snap-onedrive",
      { type: "m365", id: "drive-1", kind: "onedrive" },
      [
        folder("Documents"),
        item("Documents/report.txt", "file", "a"),
        folder("Documents/Old"),
        folder("Notebooks"),
        folder("Notebooks/Team", { packageType: "oneNote" }),
        item("Notebooks/Team/Section.one", "file", "b"),
        {
          path: "Shared budget",
          type: "shortcut",
          size: 0,
          mtime: Date.now(),
          metadata: { remoteKind: "folder" },
          chunks: [],
        },
      ],
    );
    const store = await ChunkStore.build(backend, TENANT_ID);
    const keyring = new Keyring([dek], tenantKey);
    const outDir = join(root, "out-onedrive");

    const report = await restoreSnapshot({ manifest: drive, store, keyring, outDir });
    expect(report.results.filter((result) => !result.ok)).toEqual([]);
    expect(report).toMatchObject({ total: 7, restored: 6, skipped: 1, failed: 0 });
    expect(report.results.find((result) => result.path === "Shared budget")?.skipped).toContain(
      "shortcut",
    );

    expect((await readFile(join(outDir, "Documents/report.txt"))).equals(objectA.data)).toBe(true);
    expect((await readFile(join(outDir, "Notebooks/Team/Section.one"))).equals(objectB.data)).toBe(
      true,
    );
    expect(await isDirectory(join(outDir, "Documents/Old"))).toBe(true);
    await expect(stat(join(outDir, "Shared budget"))).rejects.toMatchObject({ code: "ENOENT" });

    const verified = await verifySnapshot({ manifest: drive, store, keyring });
    expect(verified).toMatchObject({ restored: 6, skipped: 1, failed: 0 });
  });
});
