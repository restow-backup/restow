import { mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { LocalStorageBackend } from "./local.js";

describe("local storage backend", () => {
  it("round-trips objects, streams, listing and deletion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-core-"));
    try {
      const store = new LocalStorageBackend(dir);
      const key = "tenants/t1/packs/ab/pack-0001";
      const data = Buffer.from("sealed pack bytes");

      expect(await store.head(key)).toBeNull();

      await store.put(key, data);
      expect((await store.head(key))?.size).toBe(data.length);
      expect((await store.get(key)).equals(data)).toBe(true);

      await store.put("tenants/t1/manifests/snap.json.zst", Buffer.from("manifest"));
      const listed = await store.list("tenants/t1/");
      expect(listed).toContain(key);
      expect(listed).toContain("tenants/t1/manifests/snap.json.zst");

      await store.put(
        "tenants/t1/stream.bin",
        Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
      );
      expect((await store.get("tenants/t1/stream.bin")).toString()).toBe("abcd");

      await store.delete(key);
      expect(await store.head(key)).toBeNull();
      await store.delete(key); // deleting a missing key is a no-op
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes through a synced temporary file, so a failed write leaves the old object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-core-"));
    const probe = await open(join(dir, "probe"), "w");
    const fileHandle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
    await probe.close();
    await rm(join(dir, "probe"));
    const sync = vi.spyOn(fileHandle, "sync");
    try {
      const store = new LocalStorageBackend(dir);
      const key = "tenants/t1/snapshots/snap.partial";
      await store.put(key, Buffer.from("checkpoint one"));
      // The file, its directory and the directories the write created are synced.
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(3);

      // A stream that breaks off mid-write replaces nothing.
      const broken = new Readable({
        read() {
          this.push(Buffer.from("checkpoint t"));
          this.destroy(new Error("connection reset"));
        },
      });
      await expect(store.put(key, broken)).rejects.toThrow(/connection reset/);
      expect((await store.get(key)).toString()).toBe("checkpoint one");

      // Overwriting replaces the whole object.
      await store.put(key, Readable.from([Buffer.from("two")]));
      expect((await store.get(key)).toString()).toBe("two");

      // No temporary file is left behind, and none is ever listed as a key.
      expect(await readdir(join(dir, "tenants/t1/snapshots"))).toEqual(["snap.partial"]);
      await writeFile(join(dir, "tenants/t1/snapshots/.snap.partial.0badc0de.restow-tmp"), "x");
      expect(await store.list("tenants/")).toEqual([key]);
      await expect(store.put("tenants/t1/.x.restow-tmp", Buffer.from("x"))).rejects.toThrow(
        /reserved name/,
      );
    } finally {
      sync.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses keys that escape the storage root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-core-"));
    try {
      const store = new LocalStorageBackend(dir);
      await expect(store.get("../escape")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
