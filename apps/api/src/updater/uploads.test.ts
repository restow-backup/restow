import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DumpStore, isDumpFileName } from "./dumps.js";
import { DumpUploads, STALE_UPLOAD_MS, UploadError } from "./uploads.js";

/**
 * Dumps uploaded in parts for a restore (uploads.ts): parts are appended at the offset the upload
 * stands at (a repeated part is not written twice), the SHA-256 is checked on completion, the
 * completed file becomes a dump of the store, parts never show up as dumps, stale ones are swept
 * and the disk must hold the dump about three times.
 */

let dir: string;
const now = new Date("2026-11-05T12:00:00Z");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-uploads-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function uploads(free = 10 * 1024 ** 3): DumpUploads {
  return new DumpUploads({
    directory: dir,
    version: "0.5.0",
    now: () => now,
    freeBytes: async () => free,
  });
}

const stream = (bytes: Buffer) => new Blob([bytes]).stream();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("dump uploads", () => {
  it("assembles the parts into a dump of the store", async () => {
    const content = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100, 7)]);
    const store = uploads();
    const started = await store.start({ bytes: content.length, sha256: sha(content) });
    expect(started.received).toBe(0);
    await store.append(started.id, 0, stream(content.subarray(0, 60)));
    // The same part again (a lost answer): nothing is written twice.
    expect((await store.append(started.id, 0, stream(content.subarray(0, 60)))).received).toBe(60);
    await expect(store.append(started.id, 70, stream(content.subarray(70)))).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect((await store.append(started.id, 60, stream(content.subarray(60)))).received).toBe(105);
    const dump = await store.complete(started.id);
    expect(dump.file).toBe("restow-20261105-120000-uploaded-to-0.5.0.dump");
    expect(isDumpFileName(dump.file)).toBe(true);
    expect(await fs.readFile(path.join(dir, dump.file))).toEqual(content);
    expect((await new DumpStore(dir).list()).map((entry) => entry.file)).toEqual([dump.file]);
  });

  it("refuses an incomplete upload, a wrong checksum and a part that is too large", async () => {
    const content = Buffer.from("PGDMP-content");
    const store = uploads();
    const started = await store.start({ bytes: content.length, sha256: sha(Buffer.from("other")) });
    await expect(store.complete(started.id)).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      store.append(started.id, 0, stream(Buffer.concat([content, content]))),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await store.append(started.id, 0, stream(content));
    await expect(store.complete(started.id)).rejects.toBeInstanceOf(UploadError);
    // A wrong checksum discards the upload.
    await expect(store.view(started.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await new DumpStore(dir).list()).toEqual([]);
    await expect(store.view("../../etc/passwd")).rejects.toMatchObject({ code: "not_found" });
  });

  it("needs room for the dump three times, and sweeps stale parts", async () => {
    await expect(uploads(100).start({ bytes: 50, sha256: "a".repeat(64) })).rejects.toMatchObject({
      code: "blocked",
    });
    const store = uploads();
    const started = await store.start({ bytes: 10, sha256: "a".repeat(64) });
    const old = new Date(now.getTime() - STALE_UPLOAD_MS - 1000);
    for (const name of await fs.readdir(dir)) {
      await fs.utimes(path.join(dir, name), old, old);
    }
    expect((await store.sweep()).sort()).toEqual(
      [`.upload-${started.id}.json`, `.upload-${started.id}.part`].sort(),
    );
  });
});
