/**
 * The recovery lab apart from one probe (docs/BAREMETAL.md 12.3):
 *
 *   - its bundle imports only Node and its own files: nothing of the database, the server's
 *     configuration or its keys can reach the lab image;
 *   - QEMU runs sandboxed, without default devices, with encrypted disks and a network that
 *     forwards one address only (or none);
 *   - its configuration, the DBX of the image, the loop that asks the worker for work, the ISO
 *     download checked against its SHA-256.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { labClient, serialTail } from "./client.js";
import { guidBytes } from "./dbx.js";
import { labConfigFromEnv, noProbeNote, prepareDbx, runLab } from "./main.js";
import {
  connectSerial,
  encryptedDiskArgs,
  machineArgs,
  networkArgs,
  SANDBOX_ARGS,
  typeSerial,
} from "./qemu.js";
import { sendKey } from "./vm.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("the lab bundle [CRYPT-006]", () => {
  it("imports nothing but Node and the lab's own files, and reads no server secret", () => {
    const files = readdirSync(HERE).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files).toContain("main.ts");
    for (const name of files) {
      const text = readFileSync(join(HERE, name), "utf8");
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
        (m) => m[1] as string,
      );
      for (const specifier of imports) {
        expect(
          specifier.startsWith("node:") || /^\.\/[a-z-]+\.js$/.test(specifier),
          `${name} imports ${specifier}`,
        ).toBe(true);
      }
      expect(text, name).not.toMatch(
        /RESTOW_MASTER_KEY|DATABASE_URL|RESTOW_DB_|repositoryPassword/,
      );
    }
  });
});

describe("QEMU for a probe", () => {
  it("sandboxes the guest, encrypts its disks and forwards one address only", () => {
    const args = machineArgs({
      name: "probe",
      serialLog: "/p/s.log",
      serialSocket: "/p/s.sock",
      qmpSocket: "/p/q.sock",
      firmware: "uefi-sb",
      varsFile: "/p/vars.fd",
      sandbox: true,
      secrets: [{ id: "probekey", file: "/dev/fd/3" }],
      disks: [{ file: "/p/d.qcow2", serial: "RESTOWPROBE0", bus: "ahci", keySecret: "probekey" }],
      network: {
        mode: "restricted",
        guestAddress: "10.0.2.100",
        guestPort: 3128,
        target: "127.0.0.1:4100",
        model: "e1000e",
      },
    }).join(" ");
    expect(args).toContain(SANDBOX_ARGS.join(" "));
    expect(args).not.toContain("-nographic");
    expect(args).toContain("-object secret,id=probekey,file=/dev/fd/3");
    expect(args).toContain("encrypt.format=luks,encrypt.key-secret=probekey");
    expect(args).toContain(
      "user,id=net0,restrict=on,guestfwd=tcp:10.0.2.100:3128-tcp:127.0.0.1:4100",
    );
    expect(args).toContain("e1000e,netdev=net0,id=nic0");
    expect(args).toContain("socket,id=ser0,path=/p/s.sock,server=on,wait=off,logfile=/p/s.log");
    expect(networkArgs({ mode: "none" })).toEqual(["-nic", "none"]);
    expect(() =>
      networkArgs({
        mode: "restricted",
        guestAddress: "10.0.2.100",
        guestPort: 3128,
        target: "10.0.0.1:443",
      }),
    ).toThrow(/127\.0\.0\.1/);
    expect(encryptedDiskArgs("/p/d.qcow2", 1024, "/dev/fd/3").join(" ")).toBe(
      "create -q --object secret,id=sec0,file=/dev/fd/3 -f qcow2 -o encrypt.format=luks,encrypt.key-secret=sec0 /p/d.qcow2 1024",
    );
  });
});

describe("the serial console of a machine", () => {
  it("types a passphrase character by character, Enter as carriage return", async () => {
    const written: string[] = [];
    await typeSerial({ write: (chunk: string) => written.push(chunk) }, "ab\n", 0);
    expect(written).toEqual(["a", "b", "\r"]);
  });

  it("connects once QEMU has made the socket, and gives up after its time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-serial-"));
    const path = join(dir, "s.sock");
    const received: string[] = [];
    const server = createServer((socket) => socket.on("data", (d) => received.push(String(d))));
    try {
      const later = new Promise<void>((resolve) =>
        setTimeout(() => server.listen(path, () => resolve()), 300),
      );
      const socket = await connectSerial(path, 5_000);
      await later;
      await typeSerial(socket, "pw\n", 0);
      await new Promise<void>((resolve) => socket.end(() => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received.join("")).toBe("pw\r");
      await expect(connectSerial(join(dir, "missing.sock"), 300)).rejects.toThrow();
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the lab process", () => {
  it("needs a token of 32 characters and knows its defaults", () => {
    expect(() => labConfigFromEnv({ RESTOW_LAB_TOKEN: "short" })).toThrow(/32/);
    expect(labConfigFromEnv({ RESTOW_LAB_TOKEN: "t".repeat(32) })).toMatchObject({
      api: "http://worker:8095",
      dir: "/var/lib/restow-lab",
      concurrency: 1,
      tlsUpstream: "caddy:443",
    });
  });

  it("joins the DBX updates of the image once, and runs without them for other firmware", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-lab-dbx-"));
    try {
      expect(prepareDbx(join(dir, "none"), dir)).toBeNull();
      const cert = Buffer.alloc(24);
      cert.writeUInt32LE(24, 0);
      guidBytes("4aafd29d-68df-49ee-8aa9-347d375665a7").copy(cert, 8);
      const head = Buffer.alloc(28);
      guidBytes("c1c41626-504c-4092-aca9-41f936934328").copy(head, 0);
      head.writeUInt32LE(28 + 48, 16);
      head.writeUInt32LE(48, 24);
      await writeFile(
        join(dir, "a.bin"),
        Buffer.concat([Buffer.alloc(16), cert, head, Buffer.alloc(48, 1)]),
      );
      expect(prepareDbx(dir, dir)).toMatchObject({ count: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tells the worker whether it has KVM and leases nothing it cannot run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-lab-loop-"));
    const asked: { kvm: boolean }[] = [];
    const controller = new AbortController();
    try {
      await runLab(
        {
          token: "t".repeat(32),
          api: "http://x",
          dir,
          concurrency: 1,
          tlsUpstream: null,
          dbxDir: join(dir, "none"),
          version: "0.5.0",
        },
        {
          kvm: () => false,
          signal: controller.signal,
          client: {
            next: async (state) => {
              asked.push(state);
              controller.abort();
              return { probe: null, reason: "no_kvm" };
            },
            event: async () => ({ go: true }),
            result: async () => {},
            downloadIso: async () => {},
          },
        },
      );
      expect(asked).toEqual([{ labVersion: "0.5.0", kvm: false }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("survives a program that closes the key's fd 3 before reading it all", async () => {
    // The lab process ended on such an ECONNRESET (no 'error' listener) right after a lease.
    const child = spawn("sh", ["-c", "exec 3<&-; sleep 0.3"], {
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const errors: Error[] = [];
    sendKey(child.stdio[3] as NodeJS.WritableStream, "k".repeat(4 * 1024 * 1024), (error) =>
      errors.push(error),
    );
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(errors.every((error) => /EPIPE|ECONNRESET/.test(String(error)))).toBe(true);
  });

  it("logs why a planned probe waits, once per change, and never the normal answers", () => {
    expect(noProbeNote(null, "iso_missing")).toBe("iso_missing");
    expect(noProbeNote("iso_missing", "iso_missing")).toBeNull();
    expect(noProbeNote("iso_missing", "instance_unknown")).toBe("instance_unknown");
    expect(noProbeNote(null, "none")).toBeNull();
    expect(noProbeNote("iso_missing", "busy")).toBeNull();
  });

  it("keeps a downloaded ISO only with the expected SHA-256, and sends the token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-lab-iso-"));
    const auth: string[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      auth.push(String((init?.headers as Record<string, string>)?.authorization));
      return new Response("ISO-BYTES");
    }) as unknown as typeof fetch;
    try {
      const client = labClient("http://worker:8095/", "t".repeat(32), fake);
      const good = createHash("sha256").update("ISO-BYTES").digest("hex");
      await expect(client.downloadIso("a".repeat(64), join(dir, "x.iso"))).rejects.toThrow(
        /SHA-256/,
      );
      await expect(readFile(join(dir, "x.iso"))).rejects.toThrow();
      await expect(readFile(join(dir, "x.iso.part"))).rejects.toThrow();
      await client.downloadIso(good, join(dir, "x.iso"));
      expect(await readFile(join(dir, "x.iso"), "utf8")).toBe("ISO-BYTES");
      expect(auth[0]).toBe(`Bearer ${"t".repeat(32)}`);
      expect(serialTail("a\r\nb\x07c", 3)).toBe("\nbc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
