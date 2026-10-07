/**
 * End to end without Proxmox VE: the real restow-pve binary against the real
 * /agent/pve/v1 of this API (Postgres, local storage), with qemu-nbd standing
 * in for PVE's backup access (a qcow2 image with a persistent dirty bitmap)
 * and qemu-img convert standing in for PVE's restore. The provider verbs are
 * called in the order vzdump and the restore code call them.
 *
 *   1. full VM backup (bitmap mode new), 2. incremental (bitmap reuse: only
 *   the dirty 4 MiB blocks are read), 3. restore of both restore points as raw
 *   images through the NBD restore server, compared bit for bit with the
 *   image at backup time, 4. a container backup with restic over a
 *   directory and its restore into a temporary folder, compared file by file.
 *
 * Not part of CI (it needs Go, qemu-utils and restic):
 *
 *   go build -o /tmp/restow-pve ./agent/cmd/restow-pve
 *   RESTOW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
 *   RESTOW_PVE_BIN=/tmp/restow-pve pnpm --filter @restow/api exec tsx src/features/pve/testing/helper-e2e.ts
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { startFixture } from "../../endpoints/testing/fixture.js";

const BIN = process.env.RESTOW_PVE_BIN ?? "";
// The node and the server run the same restic (RESTIC_BINARY, else the PATH).
process.env.RESTOW_PVE_RESTIC ??= process.env.RESTIC_BINARY ?? "restic";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function check(ok: boolean, what: string): void {
  if (!ok) {
    throw new Error(`FAILED: ${what}`);
  }
  console.log(`ok   ${what}`);
}

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

/** For commands that talk to the API of this very process: the event loop must keep running. */
function shAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

async function provider(
  root: string,
  verb: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, ["provider", verb], {
      env: { ...process.env, RESTOW_PVE_ROOT: root },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => {
      let parsed: { ok?: boolean; result?: Record<string, unknown>; error?: string } = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        // reported below
      }
      if (code !== 0 || !parsed.ok) {
        reject(new Error(`provider ${verb} failed (${code}): ${parsed.error ?? out}\n${err}`));
        return;
      }
      if (process.env.VERBOSE) {
        process.stderr.write(err);
      }
      resolve(parsed.result ?? {});
    });
    child.stdin.end(JSON.stringify({ storeid: "restow", ...request }));
  });
}

async function waitForSocket(path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await readdir(join(path, ".."));
      sh("test", ["-S", path]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`socket ${path} did not appear`);
}

async function treeHashes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out[relative(root, full)] = sha(await readFile(full));
      }
    }
  }
  await walk(root);
  return out;
}

async function main(): Promise<void> {
  if (!BIN) {
    throw new Error("set RESTOW_PVE_BIN to a built restow-pve");
  }
  const fixture = await startFixture(`restow_pve_e2e_${process.pid}`);
  const shared = await import("../../../db.js");
  const service = await import("../service.js");
  const { pveNodeRoutes } = await import("../node-routes.js");
  const { pveResticRoutes } = await import("../restic-route.js");
  const { errorHandler } = await import("../../../problem.js");
  const app = new Hono();
  app.onError(errorHandler);
  app.route("/agent/pve/v1", pveNodeRoutes);
  app.route("/agent/pve/restic", pveResticRoutes);
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The node must reach this process: the public address is this server.
  const { config } = await import("../../../config.js");
  config.publicUrl = base;
  const work = await mkdtemp(join(tmpdir(), "pve-e2e-"));
  const root = join(work, "root");
  const children: ReturnType<typeof spawn>[] = [];
  try {
    // ---- enroll (what `restow-pve enroll` does after it checked the PVE API) ----
    const { token } = await service.createEnrollmentToken(
      shared.db,
      fixture.tenantId,
      { label: "e2e", userId: fixture.adminId, ip: null },
      { url: base },
    );
    const enrolled = (await (
      await fetch(`${base}/agent/pve/v1/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          clusterName: "e2e",
          clusterFingerprint: "e".repeat(64),
          nodeName: "pve1",
          pveVersion: "9.2.1",
          helperVersion: "0.0.0-dev",
          fleecingStorage: "local-lvm",
        }),
      })
    ).json()) as { nodeId: string; nodeSecret: string; clusterId: string; storageId: string };
    await mkdir(join(root, "etc/restow-pve"), { recursive: true });
    await writeFile(
      join(root, "etc/restow-pve/state.json"),
      JSON.stringify({
        url: base,
        nodeId: enrolled.nodeId,
        nodeSecret: enrolled.nodeSecret,
        clusterId: enrolled.clusterId,
        storageId: enrolled.storageId,
        nodeName: "pve1",
        pveTokenId: "restow@pve!restow",
        pveTokenSecret: "unused",
        fleecingStorage: "local-lvm",
        allowInsecureHttp: true,
      }),
      { mode: 0o600 },
    );
    check(Boolean(enrolled.nodeId), "node enrolled");

    // ---- a VM disk with a dirty bitmap, exported like PVE's backup access ----
    const img = join(work, "disk.qcow2");
    const sock = join(work, "nbd.sock");
    sh("qemu-img", ["create", "-q", "-f", "qcow2", img, "40M"]);
    sh("qemu-io", ["-f", "qcow2", "-c", "write -P 0x41 0 6M", "-c", "write -P 0x42 20M 3M", img]);
    sh("qemu-img", ["bitmap", "--add", "-g", "4194304", img, "snapshot-access:restow"]);
    const exportImage = async () => {
      const child = spawn("qemu-nbd", [
        "-k",
        sock,
        "-f",
        "qcow2",
        "-B",
        "snapshot-access:restow",
        "-x",
        "drive-scsi0",
        "--persistent",
        img,
      ]);
      children.push(child);
      await waitForSocket(sock);
      return child;
    };
    const reference = async (name: string) => {
      const out = join(work, name);
      sh("qemu-img", ["convert", "-f", "qcow2", "-O", "raw", img, out]);
      return readFile(out);
    };
    const size = 40 * 1024 * 1024;
    const backup = async (time: number, mode: string) => {
      await provider(root, "job-init", { startTime: time });
      const init = await provider(root, "backup-init", {
        vmid: 101,
        vmtype: "qemu",
        startTime: time,
      });
      const mech = await provider(root, "backup-get-mechanism", { vmid: 101, vmtype: "qemu" });
      check(mech.mechanism === "nbd", "VM mechanism is nbd");
      const inc = await provider(root, "backup-vm-query-incremental", {
        vmid: 101,
        volumes: { "drive-scsi0": { size } },
      });
      const devices = inc.devices as Record<string, string>;
      const bitmapMode = devices["drive-scsi0"] === "use" ? mode : "new";
      const nbd = await exportImage();
      await provider(root, "backup-vm", {
        vmid: 101,
        guestConfig: "scsi0: local-lvm:vm-101-disk-0,size=40M\n",
        volumes: {
          "drive-scsi0": { size, bitmapMode, nbdPath: sock, bitmapName: "snapshot-access:restow" },
        },
        info: { firewallConfig: "[OPTIONS]\nenable: 0\n" },
      });
      nbd.kill();
      await new Promise((r) => nbd.once("exit", r));
      await provider(root, "backup-cleanup", {
        vmid: 101,
        vmtype: "qemu",
        success: true,
        info: {},
      });
      await writeFile(join(work, "task.log"), "INFO: backup finished\n");
      await provider(root, "backup-handle-log-file", {
        vmid: 101,
        logFile: join(work, "task.log"),
      });
      await provider(root, "job-cleanup", {});
      return { archiveName: init.archiveName as string, bitmapMode };
    };

    const first = await backup(1_790_000_000, "reuse");
    check(first.bitmapMode === "new", "first backup reads the whole disk");
    const ref1 = await reference("ref1.raw");
    // PVE clears the bitmap after a good backup; the guest then writes.
    sh("qemu-img", ["bitmap", "--clear", img, "snapshot-access:restow"]);
    sh("qemu-io", ["-f", "qcow2", "-c", "write -P 0x43 8M 1M", "-c", "write -z 20M 4M", img]);
    const ref2 = await reference("ref2.raw");
    const second = await backup(1_790_086_400, "reuse");
    check(second.bitmapMode === "reuse", "second backup is incremental (bitmap reuse)");
    const runs = await fixture.db.execute<{ stats: Record<string, number> }>(
      // biome-ignore lint/suspicious/noExplicitAny: test script
      (await import("drizzle-orm")).sql`SELECT stats FROM pve_runs ORDER BY started_at` as any,
    );
    const stats2 = runs.rows[1]?.stats ?? {};
    check(
      stats2.readBytes === 8 * 1024 * 1024,
      `second backup read only the two dirty blocks (${stats2.readBytes} bytes)`,
    );
    check(
      stats2.uploadedBytes === 4 * 1024 * 1024,
      "second backup uploaded one changed block, the zeroed one as a marker",
    );

    // ---- restore both through the NBD restore server and qemu-img convert ----
    for (const [name, ref] of [
      [first.archiveName, ref1],
      [second.archiveName, ref2],
    ] as const) {
      const volname = `backup/${name}`;
      const mech = await provider(root, "restore-get-mechanism", { volname });
      check(mech.mechanism === "qemu-img" && mech.vmtype === "qemu", "restore mechanism qemu-img");
      const conf = await provider(root, "archive-get-guest-config", { volname });
      check(String(conf.config).startsWith("scsi0:"), "guest config comes back");
      const init = await provider(root, "restore-vm-init", { volname });
      check(
        JSON.stringify(init.devices) === JSON.stringify({ "drive-scsi0": { size } }),
        "restore devices and sizes",
      );
      const vol = await provider(root, "restore-vm-volume-init", {
        volname,
        device: "drive-scsi0",
        info: {},
      });
      const out = join(work, `restored-${randomUUID()}.raw`);
      await shAsync("qemu-img", [
        "convert",
        "-f",
        "raw",
        "-O",
        "raw",
        String(vol.qemuImgPath),
        out,
      ]);
      await provider(root, "restore-vm-volume-cleanup", { volname, device: "drive-scsi0" });
      await provider(root, "restore-vm-cleanup", { volname });
      check((await readFile(out)).equals(ref), `restored ${name} equals the disk at backup time`);
    }

    // ---- a container: restic over the directory mechanism ----
    const ctDir = join(work, "ct-root");
    await mkdir(join(ctDir, "etc"), { recursive: true });
    await writeFile(join(ctDir, "etc/hostname"), "ct200\n");
    await writeFile(join(ctDir, "data.bin"), Buffer.alloc(300_000, 7));
    await mkdir(join(ctDir, "var/cache"), { recursive: true });
    await writeFile(join(ctDir, "var/cache/skip.tmp"), "x");
    const ctTime = 1_790_100_000;
    await provider(root, "job-init", { startTime: ctTime });
    const ctInit = await provider(root, "backup-init", {
      vmid: 200,
      vmtype: "lxc",
      startTime: ctTime,
    });
    await provider(root, "backup-container-prepare", {
      vmid: 200,
      vmtype: "lxc",
      info: { directory: ctDir, sources: ["."], backupUserId: process.getuid?.() ?? 0 },
    });
    await provider(root, "backup-container", {
      vmid: 200,
      vmtype: "lxc",
      guestConfig: "arch: amd64\nunprivileged: 1\n",
      excludePatterns: ["/var/cache/*"],
      info: { directory: ctDir, sources: ["."], backupUserId: process.getuid?.() ?? 0 },
    });
    await provider(root, "backup-cleanup", { vmid: 200, vmtype: "lxc", success: true, info: {} });
    const ctVol = `backup/${ctInit.archiveName}`;
    const ctMech = await provider(root, "restore-get-mechanism", { volname: ctVol });
    check(
      ctMech.mechanism === "directory" && ctMech.vmtype === "lxc",
      "container restore mechanism directory",
    );
    const restored = await provider(root, "restore-container-init", { volname: ctVol, info: {} });
    const got = await treeHashes(String(restored.archiveDirectory));
    const want = Object.fromEntries(
      Object.entries(await treeHashes(ctDir)).filter(([path]) => path !== "var/cache/skip.tmp"),
    );
    check(
      JSON.stringify(got) === JSON.stringify(want),
      "container restore equals the source (excludes applied)",
    );
    await provider(root, "restore-container-cleanup", { volname: ctVol });

    const listing = await provider(root, "list-volumes", { vmid: 101 });
    check(
      (listing.volumes as unknown[]).length === 2,
      "list-volumes answers from the cache job-init refreshed",
    );
    console.log("\nALL CHECKS PASSED");
  } finally {
    for (const c of children) {
      c.kill();
    }
    server.close();
    await fixture.cleanup();
    await rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
