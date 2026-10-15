import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuestFsError, GuestFsSandbox, type SandboxDisk } from "@restow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The sandbox of the VM file restore (@restow/core GuestFsSandbox, as built): the child process
 * runs under Node's permission model with an empty environment, and the limits end a reader
 * that reads too much or takes too long. A probe script in the child's place reports what it
 * may do; the real reader is exercised in vm-files.pg.test.ts.
 */

const memoryDisk = (data: Buffer): SandboxDisk => ({
  device: "drive-scsi0",
  size: data.length,
  read: async (offset, length) => data.subarray(offset, offset + length),
});

describe("the guest file system sandbox", () => {
  let dir: string;
  let probe: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-sandbox-"));
    probe = join(dir, "probe.mjs");
    // Answers every operation with what the child may do: read a file outside its folder,
    // start a process, see an environment, build code from a string.
    await writeFile(
      probe,
      `
process.on("message", async (m) => {
  if (m.t !== "op") return;
  const fs = await import("node:fs");
  const cp = await import("node:child_process");
  const tryIt = (f) => { try { f(); return "allowed"; } catch (e) { return e.code ?? e.name; } };
  const value = [
    { name: "read", type: "other", size: null, mtime: tryIt(() => fs.readFileSync("/etc/hostname")) },
    { name: "spawn", type: "other", size: null, mtime: tryIt(() => cp.execFileSync("true")) },
    { name: "env", type: "other", size: null, mtime: String(Object.keys(process.env).length) },
    { name: "eval", type: "other", size: null, mtime: tryIt(() => new Function("return 1")()) },
  ];
  process.send({ t: "result", id: m.id, ok: true, value });
});
process.on("disconnect", () => process.exit(0));
`,
    );
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the reader without file access, processes, environment or code from strings", async () => {
    const sandbox = await GuestFsSandbox.start([memoryDisk(Buffer.alloc(4096))], {
      childScript: probe,
    });
    try {
      const facts = Object.fromEntries(
        (await sandbox.list("/")).map((entry) => [entry.name, entry.mtime]),
      );
      expect(facts).toEqual({
        read: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        env: "0",
        eval: "EvalError",
      });
    } finally {
      sandbox.close();
    }
  });

  it("ends a reader that reads more of the disk than its budget", async () => {
    const sandbox = await GuestFsSandbox.start([memoryDisk(Buffer.alloc(4 << 20))], {
      maxReadBytes: 1024,
    });
    await expect(sandbox.volumes()).rejects.toMatchObject({ code: "limit" });
    expect(sandbox.failed).toBe(true);
  });

  it("ends a reader that takes too long", async () => {
    const stuck: SandboxDisk = {
      device: "drive-scsi0",
      size: 4 << 20,
      read: () => new Promise<Buffer>(() => undefined),
    };
    const sandbox = await GuestFsSandbox.start([stuck], { timeoutMs: 300 });
    const error = await sandbox.volumes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuestFsError);
    expect((error as GuestFsError).message).toBe("the reader took too long");
  });

  it("reports a disk that cannot be read as an unreadable volume, not a crash", async () => {
    const failing: SandboxDisk = {
      device: "drive-scsi0",
      size: 4 << 20,
      read: async () => {
        throw new Error("block 0 does not match its recorded SHA-256");
      },
    };
    const sandbox = await GuestFsSandbox.start([failing]);
    try {
      const found = await sandbox.volumes();
      expect(found.volumes).toEqual([]);
      expect(found.skipped).toHaveLength(1);
    } finally {
      sandbox.close();
    }
  });
});
