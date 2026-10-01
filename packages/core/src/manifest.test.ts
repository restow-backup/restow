import * as zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MANIFEST_CODEC,
  MANIFEST_VERSION,
  type ManifestObject,
  type SnapshotManifest,
  deserializeManifest,
  isManifestHeaderLine,
  readManifestLines,
  serializeManifest,
} from "./manifest.js";

const manifest: SnapshotManifest = {
  version: MANIFEST_VERSION,
  tenantId: "tenant-abc",
  snapshotId: "snap-1",
  createdAt: 1_700_000_000_000,
  source: { type: "infrastructure", id: "host:/srv/data" },
  sequence: 4,
  packs: ["tenants/tenant-abc/packs/aa/pack-1"],
  state: { deltaLinks: { inbox: "https://graph.example.test/delta?token=abc" } },
  objects: [
    {
      path: "reports/q3.pdf",
      size: 1234,
      mtime: 1_699_999_000_000,
      metadata: { contentType: "application/pdf" },
      chunks: ["aa", "bb"],
    },
    { path: "empty.txt", size: 0, mtime: 1_699_999_500_000, chunks: [] },
  ],
};

/** A realistic mail object: Graph ids, folder, subject, Message-ID, hash, one chunk. */
function mailObject(i: number): ManifestObject {
  return {
    path: `mail/Posteingang/Grüße aus Köln ${i} 😀.eml`,
    size: 20_000 + i,
    mtime: 1_700_000_000_000 + i,
    id: `AAMkAGI2TG93AAA=${i}`,
    type: "message",
    sha256: i.toString(16).padStart(64, "0"),
    metadata: {
      folderId: "AAMkAGI2TG93AAAuAAAAAAAiQ8W967B7TKBjgx9rVEURAQAiIsqMbYjsT5e",
      subject: `Quartalsbericht ${i} — Übersicht`,
      messageId: `<${i}.message@example.test>`,
    },
    chunks: [i.toString(16).padStart(64, "c")],
  };
}

function withObjects(count: number): SnapshotManifest {
  return { ...manifest, objects: Array.from({ length: count }, (_, i) => mailObject(i)) };
}

const hasZstd = typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function";

/** The NDJSON text inside serialized bytes, decompressed if needed. */
function textOf(bytes: Buffer): Buffer {
  const body = bytes.subarray(1);
  if (bytes[0] === MANIFEST_CODEC.lines) {
    return body;
  }
  const decompress = (zlib as unknown as { zstdDecompressSync: (input: Buffer) => Buffer })
    .zstdDecompressSync;
  return decompress(body);
}

function tagged(codec: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([codec]), body]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapshot manifest", () => {
  it("round-trips a manifest", async () => {
    expect(await deserializeManifest(await serializeManifest(manifest))).toEqual(manifest);
  });

  it("round-trips a large manifest with multi-byte paths across stream chunks", async () => {
    const big = withObjects(5_000);
    expect(await deserializeManifest(await serializeManifest(big))).toEqual(big);
  });

  it("round-trips a manifest without objects", async () => {
    const empty: SnapshotManifest = { ...manifest, objects: [] };
    expect(await deserializeManifest(await serializeManifest(empty))).toEqual(empty);
  });

  it("writes format 2: a header line with the object count, then one line per object", async () => {
    const bytes = await serializeManifest(manifest);
    expect(bytes[0]).toBe(hasZstd ? MANIFEST_CODEC.linesZstd : MANIFEST_CODEC.lines);
    const lines = textOf(bytes).toString("utf8").split("\n");
    expect(lines.at(-1)).toBe(""); // every line ends in LF
    const [header, ...objects] = lines.slice(0, -1).map((line) => JSON.parse(line));
    expect(header).toEqual({
      version: 2,
      tenantId: "tenant-abc",
      snapshotId: "snap-1",
      createdAt: 1_700_000_000_000,
      source: manifest.source,
      sequence: 4,
      packs: manifest.packs,
      state: manifest.state,
      objectCount: 2,
    });
    expect(objects).toEqual(manifest.objects);
  });

  it("never builds one string of the whole manifest, writing or reading", async () => {
    const big = withObjects(20_000);
    const stringify = vi.spyOn(JSON, "stringify");
    const bytes = await serializeManifest(big);
    const longestWritten = Math.max(
      ...stringify.mock.results.map((result) => String(result.value).length),
    );
    stringify.mockRestore();

    const totalText = textOf(bytes).length;
    expect(totalText).toBeGreaterThan(5_000_000);
    expect(longestWritten).toBeLessThan(2_000);

    const parse = vi.spyOn(JSON, "parse");
    const decoded = await deserializeManifest(bytes);
    const longestRead = Math.max(...parse.mock.calls.map(([text]) => String(text).length));
    parse.mockRestore();
    expect(decoded.objects).toHaveLength(20_000);
    expect(longestRead).toBeLessThan(2_000);
  });

  it("reads lines split at any byte, including inside a multi-byte character", async () => {
    const text = textOf(await serializeManifest(withObjects(50)));
    const pieces: Buffer[] = [];
    for (let offset = 0; offset < text.length; offset += 7) {
      pieces.push(text.subarray(offset, offset + 7));
    }
    expect(await readManifestLines(pieces)).toEqual(withObjects(50));
  });

  it("reports a truncated manifest instead of reading a smaller snapshot", async () => {
    const text = textOf(await serializeManifest(withObjects(10))).toString("utf8");
    const lines = text.split("\n");
    const shortened = `${lines.slice(0, -2).join("\n")}\n`; // the last object line is gone
    await expect(
      deserializeManifest(tagged(MANIFEST_CODEC.lines, Buffer.from(shortened, "utf8"))),
    ).rejects.toThrow(/truncated or damaged: the header announces 10 objects, 9 were found/);

    const cut = Buffer.from(text, "utf8").subarray(0, Math.floor(text.length / 2));
    await expect(deserializeManifest(tagged(MANIFEST_CODEC.lines, cut))).rejects.toThrow(
      /not valid JSON|truncated/,
    );
  });

  it.skipIf(!hasZstd)("rejects a cut-off zstd payload", async () => {
    const bytes = await serializeManifest(withObjects(2_000));
    await expect(
      deserializeManifest(bytes.subarray(0, Math.floor(bytes.length / 2))),
    ).rejects.toThrow();
  });

  it("rejects a payload without a valid header", async () => {
    await expect(
      deserializeManifest(tagged(MANIFEST_CODEC.lines, Buffer.alloc(0))),
    ).rejects.toThrow(/no header line/);
    const noCount = Buffer.from(`${JSON.stringify({ tenantId: "t" })}\n`, "utf8");
    await expect(deserializeManifest(tagged(MANIFEST_CODEC.lines, noCount))).rejects.toThrow(
      /objectCount is missing/,
    );
    const notAnObject = Buffer.from(`${JSON.stringify({ objectCount: 1 })}\n[1,2]\n`, "utf8");
    await expect(deserializeManifest(tagged(MANIFEST_CODEC.lines, notAnObject))).rejects.toThrow(
      /object 1 is not an object/,
    );
  });

  it("still reads format 1 manifests (one JSON document)", async () => {
    const legacy = { ...manifest, version: 1 };
    const json = Buffer.from(JSON.stringify(legacy), "utf8");
    expect(await deserializeManifest(tagged(MANIFEST_CODEC.json, json))).toEqual(legacy);
    if (hasZstd) {
      const compress = (zlib as unknown as { zstdCompressSync: (input: Buffer) => Buffer })
        .zstdCompressSync;
      expect(await deserializeManifest(tagged(MANIFEST_CODEC.jsonZstd, compress(json)))).toEqual(
        legacy,
      );
    }
  });

  it("rejects an empty buffer and an unknown codec", async () => {
    await expect(deserializeManifest(Buffer.alloc(0))).rejects.toThrow(/empty/);
    await expect(deserializeManifest(Buffer.from([0x7f, 0x7b]))).rejects.toThrow(
      /unknown manifest codec 0x7f/,
    );
  });

  it("recognizes a header line", () => {
    const header = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
    expect(isManifestHeaderLine(header({ tenantId: "t", objectCount: 0 }))).toBe(true);
    expect(isManifestHeaderLine(header({ tenantId: "t", objectCount: 2, objects: [] }))).toBe(
      false,
    );
    expect(isManifestHeaderLine(header({ tenantId: "t" }))).toBe(false);
    expect(isManifestHeaderLine(header({ objectCount: -1 }))).toBe(false);
    expect(isManifestHeaderLine(Buffer.from("{", "utf8"))).toBe(false);
  });
});
