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
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { labClient, serialTail } from "./client.js";
import { guidBytes } from "./dbx.js";
import { labConfigFromEnv, prepareDbx, runLab } from "./main.js";
import { encryptedDiskArgs, machineArgs, networkArgs, SANDBOX_ARGS } from "./qemu.js";

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
