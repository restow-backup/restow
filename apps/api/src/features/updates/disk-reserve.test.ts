import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDiskReserveCommand, runDiskReserveCommand } from "../../cli/disk-reserve.js";
import { parseCommand, UsageError } from "../../cli/main.js";
import {
  DEFAULT_DISK_RESERVE_PATH,
  DiskReserve,
  databaseDiskPath,
  diskReserveConfig,
  RELEASE_MARKER_SUFFIX,
  RESERVE_MAGIC,
  type ReserveStatus,
  reserveCreateAt,
  validReservePath,
} from "./disk-reserve.js";
import { decideReserve, startReserveGuard } from "./disk-watch.js";

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;

describe("the emergency disk reserve (#98)", () => {
  let dir: string;
  let free: number;
  const total = 100 * GIB;
  const statfs = async () => ({ freeBytes: free, totalBytes: total });

  /** A reserve of 1 MiB with a floor of 1 GiB in a directory of the test. */
  function reserve(over: { bytes?: number; floorBytes?: number } = {}) {
    return new DiskReserve({
      config: {
        path: join(dir, "restow-disk-reserve"),
        bytes: over.bytes ?? MIB,
        floorBytes: over.floorBytes ?? GIB,
      },
      statfs,
      now: () => new Date("2026-11-11T10:00:00.000Z"),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-reserve-"));
    free = 50 * GIB;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads its size, floor and path from the environment; 0 switches it off", () => {
    expect(diskReserveConfig({})).toEqual({
      path: DEFAULT_DISK_RESERVE_PATH,
      bytes: 2048 * MIB,
      floorBytes: 1024 * MIB,
    });
    expect(
      diskReserveConfig({
        RESTOW_DISK_RESERVE_MB: "512",
        RESTOW_DISK_RESERVE_FLOOR_MB: "256",
        RESTOW_DISK_RESERVE_PATH: "/srv/restow-disk-reserve-b",
      }),
    ).toEqual({ path: "/srv/restow-disk-reserve-b", bytes: 512 * MIB, floorBytes: 256 * MIB });
    // Empty (the release .env lists it empty) or nonsense: the default.
    expect(
      diskReserveConfig({ RESTOW_DISK_RESERVE_MB: "", RESTOW_DISK_RESERVE_PATH: "x" }),
    ).toEqual(diskReserveConfig({}));
    expect(diskReserveConfig({ RESTOW_DISK_RESERVE_MB: "0" }).bytes).toBe(0);
  });

  it("never lives at a path that names another file", () => {
    for (const path of [
      "/var/lib/postgresql/data/PG_VERSION",
      "/data/chunks",
      "/data/../etc/restow-disk-reserve",
      "/data//restow-disk-reserve",
      "restow-disk-reserve",
      "/data/restow-disk-reserve/",
    ]) {
      expect(validReservePath(path), path).toBe(false);
      expect(diskReserveConfig({ RESTOW_DISK_RESERVE_PATH: path }).path).toBe(
        DEFAULT_DISK_RESERVE_PATH,
      );
    }
    expect(validReservePath("/mnt/data/restow-disk-reserve")).toBe(true);
  });

  it("writes real, random blocks behind its mark, under a name of its own", async () => {
    expect(await reserve().create()).toBe("created");
    const path = join(dir, "restow-disk-reserve");
    const info = await stat(path);
    expect(info.size).toBe(MIB + RESERVE_MAGIC.length);
    // Not sparse: every block is allocated.
    expect(info.blocks * 512).toBeGreaterThanOrEqual(MIB);
    const content = await readFile(path);
    expect(content.subarray(0, RESERVE_MAGIC.length).equals(RESERVE_MAGIC)).toBe(true);
    // Random, not zeros: a compressing file system must keep it.
    expect(content.subarray(RESERVE_MAGIC.length, 4096).some((byte) => byte !== 0)).toBe(true);
    // Nothing half-written and no lock is left behind.
    expect((await readdir(dir)).sort()).toEqual(["restow-disk-reserve"]);
    expect((await reserve().status()).state).toBe("present");
    // Present already: nothing to do.
    expect(await reserve().create()).toBe("none");
  });

  it("is written only when the disk keeps its threshold besides it, counting what is free now", async () => {
    // 100 GiB: the threshold is 10 GiB, so 10 GiB + 1 MiB must be free.
    expect(reserveCreateAt(total, MIB)).toBe(10 * GIB + MIB);
    free = 10 * GIB;
    expect(await reserve().create()).toBe("no_room");
    expect((await reserve().status()).state).toBe("missing");
    // A new server (the installer's --initial): room for the reserve and the floor is enough.
    free = GIB + MIB / 2;
    expect(await reserve().create({ initial: true })).toBe("no_room");
    free = GIB + MIB;
    expect(await reserve().create({ initial: true })).toBe("created");
  });

  it("does not count a reserve that is too small as room: it is still there while the new one is written", async () => {
    const path = join(dir, "restow-disk-reserve");
    await writeFile(path, Buffer.concat([RESERVE_MAGIC, Buffer.alloc(16)]));
    // Free space plus the old file would be enough; what is free now is not.
    free = 10 * GIB + MIB - 8;
    expect(await reserve().create()).toBe("no_room");
    free = 20 * GIB;
    expect(await reserve().create()).toBe("created");
    expect((await stat(path)).size).toBe(MIB + RESERVE_MAGIC.length);
  });

  it("never replaces or deletes what is not the reserve: another file, a link", async () => {
    const path = join(dir, "restow-disk-reserve");
    await writeFile(path, "an operator's notes");
    expect((await reserve().status()).state).toBe("foreign");
    expect(await reserve().create()).toBe("foreign");
    free = 100 * MIB;
    expect((await reserve().check({ create: true })).action).toBe("foreign");
    expect(await reserve().release("manual")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("an operator's notes");
    await rm(path);
    // A link to the reserve of someone else (or to anything) is not the reserve either.
    const elsewhere = join(dir, "elsewhere");
    await writeFile(elsewhere, Buffer.concat([RESERVE_MAGIC, Buffer.alloc(16)]));
    await symlink(elsewhere, path);
    expect(await reserve().release("manual")).toBe(false);
    expect((await stat(elsewhere)).isFile()).toBe(true);
    expect((await reserve().status()).state).toBe("foreign");
  });

  it("leaves a writer that runs alone, and takes over the lock of one that died", async () => {
    const lock = join(dir, "restow-disk-reserve.lock");
    // This process holds it (an api loop writing right now).
    await writeFile(lock, JSON.stringify({ pid: process.pid, at: "2026-11-11T09:59:00.000Z" }));
    expect(await reserve().create()).toBe("busy");
    expect(await readFile(lock, "utf8")).toContain(String(process.pid));
    // A writer that died left its lock and a half-written file.
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 7, at: "2026-11-11T09:59:00.000Z" }));
    await writeFile(join(dir, "restow-disk-reserve.writing-123-abc"), "half");
    expect(await reserve().create()).toBe("created");
    expect((await readdir(dir)).sort()).toEqual(["restow-disk-reserve"]);
  });

  it("is freed below the floor, leaves a marker, and is written again once there is room", async () => {
    await reserve().create();
    // Above the floor: kept.
    free = 2 * GIB;
    expect((await reserve().check({ create: true })).action).toBe("none");
    // Below it: freed, with the marker for the alert.
    free = 512 * MIB;
    const released = await reserve().check({ create: true });
    expect(released.action).toBe("released");
    expect(released.status.state).toBe("released");
    expect(released.status.marker).toMatchObject({
      releasedAt: "2026-11-11T10:00:00.000Z",
      reason: "automatic",
      freeBytes: 512 * MIB,
      restoredAt: null,
    });
    // Not back while the disk lacks room for the threshold and the reserve.
    free = 5 * GIB;
    expect((await reserve().check({ create: true })).action).toBe("no_room");
    // Back once it has room; the marker says when.
    free = 30 * GIB;
    const restored = await reserve().check({ create: true });
    expect(restored.action).toBe("created");
    expect(restored.status.state).toBe("present");
    expect(restored.status.marker?.restoredAt).toBe("2026-11-11T10:00:00.000Z");
  });

  it("does nothing when switched off or when its directory does not exist", async () => {
    const off = new DiskReserve({
      config: { path: join(dir, "r"), bytes: 0, floorBytes: GIB },
      statfs,
    });
    expect((await off.check({ create: true })).action).toBe("off");
    const elsewhere = new DiskReserve({
      config: { path: join(dir, "missing", "r"), bytes: MIB, floorBytes: GIB },
      statfs,
    });
    expect((await elsewhere.check({ create: true })).action).toBe("unavailable");
  });

  it("reads the database's disk next to its named volume, never for a moved database", async () => {
    const path = join(dir, "restow-disk-reserve");
    expect(await databaseDiskPath({ RESTOW_DISK_RESERVE_PATH: path })).toEqual({
      measure: dir,
      location: "pgdata",
    });
    expect(
      await databaseDiskPath({
        RESTOW_DISK_RESERVE_PATH: path,
        RESTOW_POSTGRES_DATA_TYPE: "volume",
        RESTOW_POSTGRES_DATA: "restow_pgdata",
      }),
    ).toEqual({ measure: dir, location: "restow_pgdata" });
    expect(
      await databaseDiskPath({
        RESTOW_DISK_RESERVE_PATH: path,
        RESTOW_POSTGRES_DATA_TYPE: "bind",
        RESTOW_POSTGRES_DATA: "/mnt/db",
      }),
    ).toBeNull();
    expect(
      await databaseDiskPath({ RESTOW_DISK_RESERVE_PATH: join(dir, "nowhere", "reserve") }),
    ).toBeNull();
  });

  describe("the restow command", () => {
    const io = () => {
      const out: string[] = [];
      const err: string[] = [];
      return {
        out,
        err,
        io: {
          out: (text: string) => out.push(text),
          err: (text: string) => err.push(text),
          env: {
            RESTOW_DISK_RESERVE_PATH: join(dir, "restow-disk-reserve"),
            RESTOW_DISK_RESERVE_MB: "1",
          },
          statfs,
        },
      };
    };

    it("parses its commands", () => {
      expect(parseCommand(["disk-reserve", "status", "--json"])).toEqual({
        kind: "disk-reserve-status",
        json: true,
      });
      expect(parseCommand(["disk-reserve", "release"])).toEqual({ kind: "disk-reserve-release" });
      expect(parseDiskReserveCommand("guard", [])).toEqual({ kind: "disk-reserve-guard" });
      expect(parseCommand(["disk-reserve", "create"])).toEqual({
        kind: "disk-reserve-create",
        initial: false,
      });
      expect(parseCommand(["disk-reserve", "create", "--initial"])).toEqual({
        kind: "disk-reserve-create",
        initial: true,
      });
      expect(() => parseCommand(["disk-reserve", "create", "--force"])).toThrow(UsageError);
      expect(() => parseCommand(["disk-reserve", "drop"])).toThrow(UsageError);
      expect(() => parseCommand(["disk-reserve", "release", "--now"])).toThrow(UsageError);
    });

    it("creates, shows and frees the reserve by hand", async () => {
      const created = io();
      expect(
        await runDiskReserveCommand({ kind: "disk-reserve-create", initial: false }, created.io),
      ).toBe(0);
      expect(created.out.join("")).toContain("Disk reserve: 0.0 GiB at");
      const shown = io();
      await runDiskReserveCommand({ kind: "disk-reserve-status", json: true }, shown.io);
      expect(JSON.parse(shown.out.join("")) as ReserveStatus).toMatchObject({
        state: "present",
        presentBytes: MIB + RESERVE_MAGIC.length,
      });
      const released = io();
      expect(await runDiskReserveCommand({ kind: "disk-reserve-release" }, released.io)).toBe(0);
      expect(released.out.join("")).toContain("was freed");
      const marker = JSON.parse(
        await readFile(join(dir, `restow-disk-reserve${RELEASE_MARKER_SUFFIX}`), "utf8"),
      );
      expect(marker.reason).toBe("manual");
      const again = io();
      await runDiskReserveCommand({ kind: "disk-reserve-release" }, again.io);
      expect(again.out.join("")).toContain("There is no disk reserve");
    });

    it("guard frees it at the start only below the floor, and never fails", async () => {
      await runDiskReserveCommand({ kind: "disk-reserve-create", initial: true }, io().io);
      const calm = io();
      expect(await runDiskReserveCommand({ kind: "disk-reserve-guard" }, calm.io)).toBe(0);
      expect(calm.err).toEqual([]);
      free = 100 * MIB;
      const full = io();
      expect(await runDiskReserveCommand({ kind: "disk-reserve-guard" }, full.io)).toBe(0);
      expect(full.err.join("")).toContain("was freed so the database can start");
      expect((await reserve().status()).marker?.reason).toBe("start");
      const broken = io();
      broken.io.statfs = async () => {
        throw new Error("EIO");
      };
      expect(await runDiskReserveCommand({ kind: "disk-reserve-guard" }, broken.io)).toBe(0);
    });

    it("create says when there is no room", async () => {
      free = 100 * MIB;
      const tight = io();
      expect(
        await runDiskReserveCommand({ kind: "disk-reserve-create", initial: true }, tight.io),
      ).toBe(2);
      expect(tight.err.join("")).toContain("Not enough room");
    });
  });

  describe("the guard loop", () => {
    it("frees at once, writes again only after the start delay, and announces both", async () => {
      await reserve().create();
      const checkOnce = vi.fn(async () => ({
        database: "unknown" as const,
        repository: "unknown" as const,
        system: "unknown" as const,
      }));
      let clock = 0;
      const guard = startReserveGuard({ checkOnce }, reserve(), {
        now: () => clock,
        firstMs: 60_000_000,
        createAfterMs: 120_000,
      });
      try {
        free = 100 * MIB;
        await guard.tick();
        expect(checkOnce).toHaveBeenCalledTimes(1);
        expect((await reserve().status()).state).toBe("released");
        free = 50 * GIB;
        clock = 60_000;
        await guard.tick();
        expect((await reserve().status()).state).toBe("released");
        clock = 120_000;
        await guard.tick();
        expect((await reserve().status()).state).toBe("present");
        expect(checkOnce).toHaveBeenCalledTimes(2);
      } finally {
        guard.close();
      }
    });
  });

  describe("what is announced", () => {
    const status = (over: Partial<ReserveStatus>): ReserveStatus => ({
      state: "present",
      path: "/data/restow-disk-reserve",
      bytes: 2 * GIB,
      floorBytes: GIB,
      presentBytes: 2 * GIB,
      freeBytes: 30 * GIB,
      totalBytes: 100 * GIB,
      createAtBytes: 12 * GIB,
      marker: null,
      ...over,
    });
    const released = {
      releasedAt: "2026-11-11T10:00:00.000Z",
      reason: "automatic" as const,
      freeBytes: 0.5 * GIB,
      totalBytes: 100 * GIB,
    };

    it("a release once, a recreation once, both when they happened between two checks", () => {
      expect(decideReserve(undefined, status({})).raise).toEqual([]);
      const first = decideReserve(undefined, status({ state: "released", marker: released }));
      expect(first.raise).toEqual(["released"]);
      expect(
        decideReserve(first.entry, status({ state: "released", marker: released })).raise,
      ).toEqual([]);
      const back = { ...released, restoredAt: "2026-11-11T12:00:00.000Z" };
      const second = decideReserve(first.entry, status({ marker: back }));
      expect(second.raise).toEqual(["restored"]);
      expect(decideReserve(second.entry, status({ marker: back })).raise).toEqual([]);
      // Freed while the database was down and written again before it came back: both.
      expect(decideReserve(undefined, status({ marker: back }))).toMatchObject({
        raise: ["released", "restored"],
        outcome: "released_restored",
      });
    });
  });
});
