import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import {
  STALE_LOCK_MS,
  listLockFiles,
  listRepositoryObjects,
  locksToRemove,
  measureRepositoryBytes,
  removeLockFiles,
} from "./repository-storage.js";

const PREFIX = "endpoints/22222222-2222-4222-8222-222222222222/";
const name = (digit: string) => digit.repeat(64);
const MINUTE = 60 * 1000;

describe("reading a repository from the storage", () => {
  it("lists the objects of a type with the time they were stored, skipping foreign names", async () => {
    let clock = new Date("2026-10-01T10:00:00Z");
    const storage = new MemoryStorage(() => clock);
    await storage.put(`${PREFIX}snapshots/${name("a")}`, Buffer.from("s1"));
    clock = new Date("2026-10-01T11:00:00Z");
    await storage.put(`${PREFIX}snapshots/${name("b")}`, Buffer.from("s2"));
    await storage.put(`${PREFIX}snapshots/README`, Buffer.from("not restic"));
    await storage.put(`${PREFIX}locks/${name("c")}`, Buffer.from("lock"));
    expect(await listRepositoryObjects(storage, PREFIX, "snapshots")).toEqual([
      { name: name("a"), storedAt: new Date("2026-10-01T10:00:00Z") },
      { name: name("b"), storedAt: new Date("2026-10-01T11:00:00Z") },
    ]);
    expect((await listLockFiles(storage, PREFIX)).map((lock) => lock.name)).toEqual([name("c")]);
  });

  it("measures every byte under the repository's prefix", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${PREFIX}config`, Buffer.alloc(10));
    await storage.put(`${PREFIX}data/ab/${name("a")}`, Buffer.alloc(1000));
    await storage.put("endpoints/other/data/x", Buffer.alloc(5000));
    expect(await measureRepositoryBytes(storage, PREFIX)).toBe(1010);
  });
});

describe("locks before maintenance", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);

  it("removes a lock stored more than 30 minutes ago, whatever it says inside", () => {
    // A planted lock dated in the future is still a file stored long ago.
    const locks = [
      { name: name("1"), storedAt: at(31) },
      { name: name("2"), storedAt: at(29) },
      { name: name("3"), storedAt: null },
    ];
    expect(STALE_LOCK_MS).toBe(30 * MINUTE);
    expect(locksToRemove(locks, { agentLocks: new Set(), agentActive: true, now })).toEqual([
      name("1"),
    ]);
  });

  it("removes the agent's fresh locks only when no run of the agent is active", () => {
    const locks = [
      { name: name("4"), storedAt: at(1) },
      { name: name("5"), storedAt: at(1) },
    ];
    const agentLocks = new Set([name("4")]);
    expect(locksToRemove(locks, { agentLocks, agentActive: false, now })).toEqual([name("4")]);
    expect(locksToRemove(locks, { agentLocks, agentActive: true, now })).toEqual([]);
  });

  it("deletes lock files by name", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${PREFIX}locks/${name("6")}`, Buffer.from("x"));
    await storage.put(`${PREFIX}locks/${name("7")}`, Buffer.from("y"));
    await removeLockFiles(storage, PREFIX, [name("6"), name("8")]);
    expect([...storage.files.keys()]).toEqual([`${PREFIX}locks/${name("7")}`]);
  });
});
