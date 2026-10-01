import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DumpStore,
  KEEP_DUMPS,
  dumpFileName,
  isDumpFileName,
  parseDumpFileName,
  versionForFileName,
} from "./dumps.js";

let dir: string;
let store: DumpStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "restow-updater-dumps-"));
  store = new DumpStore(path.join(dir, "dumps"));
  await store.ensureDirectory();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function touch(name: string, bytes = 10): Promise<void> {
  await fs.writeFile(path.join(store.directory, name), Buffer.alloc(bytes, 1));
}

describe("dump names", () => {
  it("encodes the UTC time and both versions", () => {
    const name = dumpFileName(new Date("2026-09-30T08:05:09.999Z"), "0.1.0", "0.2.0-rc.1");
    expect(name).toBe("restow-20260930-080509-0.1.0-to-0.2.0-rc.1.dump");
    expect(parseDumpFileName(name)).toEqual({
      createdAt: new Date("2026-09-30T08:05:09.000Z"),
      from: "0.1.0",
      to: "0.2.0-rc.1",
    });
  });

  it("uses 'unknown' for an unknown version and cleans odd characters", () => {
    expect(dumpFileName(new Date("2026-01-02T03:04:05Z"), null, "0.2.0")).toBe(
      "restow-20260102-030405-unknown-to-0.2.0.dump",
    );
    expect(versionForFileName("1.0/../x y")).toBe("1.0_.._x_y");
    expect(versionForFileName("")).toBe("unknown");
    expect(isDumpFileName(dumpFileName(new Date(), "1.0.0/../x", "2.0.0"))).toBe(true);
  });

  it("recognises only its own names", () => {
    expect(isDumpFileName("restow-20260930-080509-0.1.0-to-0.2.0.dump")).toBe(true);
    for (const name of [
      "restow.dump",
      "restow-20260930-080509-0.1.0-to-0.2.0.dump.tmp",
      "../restow-20260930-080509-0.1.0-to-0.2.0.dump",
      "restow-2026093-080509-0.1.0-to-0.2.0.dump",
      "backup.dump",
      "restow-20260930-080509-0.1.0-to-0.2.0.sql",
      "restow-20260930-080509--to-0.2.0.dump",
    ]) {
      expect(isDumpFileName(name)).toBe(false);
    }
    expect(() => store.pathOf("../../etc/passwd")).toThrow();
    expect(store.pathOf("restow-20260930-080509-0.1.0-to-0.2.0.dump")).toBe(
      path.join(store.directory, "restow-20260930-080509-0.1.0-to-0.2.0.dump"),
    );
  });
});

describe("DumpStore", () => {
  const names = [1, 2, 3, 4, 5].map((day) =>
    dumpFileName(new Date(Date.UTC(2026, 8, day, 12)), "0.1.0", "0.2.0"),
  );

  it("lists newest first with size and time, ignoring foreign files", async () => {
    for (const [index, name] of names.entries()) {
      await touch(name, 100 + index);
    }
    await touch("notes.txt");
    await touch("restow-manual.dump");
    await fs.mkdir(path.join(store.directory, "restow-20260901-000000-a-to-b.dump.d"));
    const list = await store.list();
    expect(list.map((entry) => entry.file)).toEqual([...names].reverse());
    expect(list[0]).toEqual({
      file: names[4],
      bytes: 104,
      createdAt: "2026-09-05T12:00:00.000Z",
    });
  });

  it("prunes to the newest three and touches nothing else", async () => {
    for (const name of names) {
      await touch(name);
    }
    await touch("keep-me.txt");
    await touch("restow-manual.dump");
    const deleted = await store.prune();
    expect(deleted.sort()).toEqual([names[0], names[1]].sort());
    expect((await fs.readdir(store.directory)).sort()).toEqual(
      [names[2], names[3], names[4], "keep-me.txt", "restow-manual.dump"].sort(),
    );
    expect(KEEP_DUMPS).toBe(3);
  });

  it("does not delete a protected dump and does not count it", async () => {
    for (const name of names) {
      await touch(name);
    }
    const deleted = await store.prune(3, new Set([names[0] as string]));
    // Protected: names[0]. Newest three of the rest: 4, 3, 2. Deleted: 1.
    expect(deleted).toEqual([names[1]]);
    expect(await fs.readdir(store.directory)).toContain(names[0]);
  });

  it("prunes nothing when there are three or fewer", async () => {
    await touch(names[0] as string);
    expect(await store.prune()).toEqual([]);
  });

  it("lists nothing when the directory does not exist", async () => {
    expect(await new DumpStore(path.join(dir, "missing")).list()).toEqual([]);
  });

  it("reports sizes and discards", async () => {
    await touch(names[0] as string, 77);
    expect(await store.sizeOf(names[0] as string)).toBe(77);
    expect(await store.sizeOf(names[1] as string)).toBeNull();
    await store.discard(names[0] as string);
    expect(await store.sizeOf(names[0] as string)).toBeNull();
  });
});
