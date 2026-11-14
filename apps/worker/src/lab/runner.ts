/**
 * One boot probe in the lab (docs/BAREMETAL.md 12.3):
 *
 *   1. room: the restore and the ISO must fit into `RESTOW_LAB_DIR` with a margin, else the probe
 *      ends as a lab error (`lab_disk_full`) before anything is written;
 *   2. the ISO: from the cache, else downloaded from the worker; its SHA-256 is checked before
 *      every start;
 *   3. the firmware's variable store (with the union of the DBX updates for Secure Boot) and the
 *      probe's disks: qcow2 encrypted with LUKS, with a random key only this process holds;
 *   4. the restore: the ISO with the answers through fw_cfg (the file is removed once QEMU read
 *      it), the network through the CONNECT proxy only; on `RESTOW-PROBE phase=released` the lab
 *      takes the network away; the VM powers itself off;
 *   5. the boot of the restored disks: same firmware and variable store, no network; the lab
 *      types the probe's passphrase where a prompt asks for it; `RESTOW-PROBE-OK` ends it;
 *   6. always: both VMs stopped, the proxy closed, the probe's folder (disks, store, logs)
 *      removed.
 *
 * The VMs are behind {@link VmDriver} so the state machine is tested without QEMU (runner.test.ts);
 * ./vm.ts is the QEMU one.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { LabClient, LabController, LeasedProbe, ProbeResult } from "./client.js";
import { serialTail } from "./client.js";
import { proxyTarget, startProbeProxy } from "./proxy.js";
import type { Disk, Firmware, Machine, NicModel } from "./qemu.js";
import {
  GRUB_SILENCE_MS,
  MAX_PASSPHRASE_TRIES,
  OK_LINE,
  passphrasePrompts,
  RELEASED_LINE,
} from "./serial.js";

/** The guest address of the proxy, as the answers name it (`network.proxy`). */
export const PROXY_GUEST_ADDRESS = "10.0.2.100";
export const PROXY_GUEST_PORT = 3128;
/** Room kept free beside a probe's disks and the ISO. */
export const LAB_DISK_MARGIN_BYTES = 2 * 1024 ** 3;

export interface Vm {
  /** The serial console so far. */
  serial(): string;
  /** Type at the serial console. */
  type(text: string): Promise<void>;
  /** Type on the keyboard (QMP send-key). */
  keys(text: string): Promise<void>;
  /** Take the network away (QMP set_link and netdev_del). */
  cutNetwork(): Promise<void>;
  /** Resolves with the exit code once the VM ended. */
  exited: Promise<number>;
  /** The end of QEMU's own error output (why a VM ended early). */
  stderr?(): string;
  kill(): void;
}

export interface VmDriver {
  /** Create the probe's encrypted disks. */
  createDisks(disks: readonly { file: string; sizeBytes: number }[], key: string): Promise<void>;
  /** The variable store of the firmware (with the DBX for Secure Boot). */
  createVars(file: string, firmware: Firmware): Promise<void>;
  /**
   * Start a machine; `key` opens its disks (secret `probekey`). `fwCfgData` are fw_cfg entries
   * by content (the answers with the code and the passphrase): the driver hands them to QEMU
   * without a file on disk and returns once QEMU read them.
   */
  start(machine: Machine, key: string, fwCfgData?: Record<string, string>): Promise<Vm>;
}

export interface RunnerDeps {
  client: LabClient;
  driver: VmDriver;
  dir: string;
  labVersion: string;
  kvm: boolean;
  /** Where the proxy connects the tunnel (the TLS edge on the compose network). */
  tlsUpstream: string | null;
  now?: () => number;
  pollMs?: number;
  /** Free bytes of the lab's folder (tests replace it). */
  freeBytes?: (dir: string) => Promise<number>;
  /** SHA-256 of a file (tests replace it). */
  sha256File?: (file: string) => Promise<string>;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class ProbeLabError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProbeLabError";
  }
}

async function defaultFreeBytes(dir: string): Promise<number> {
  const stats = await statfs(dir);
  return stats.bavail * stats.bsize;
}

function defaultSha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

/** A stable EUI-64 for an NVMe disk of the probe, from its serial number. */
export function euiOf(serial: string): string {
  const hex = createHash("sha256").update(serial).digest("hex").slice(0, 16);
  // Locally administered, never a vendor's prefix.
  return `02${hex.slice(2)}`;
}

/** The bytes a probe needs in the lab's folder: what it restores, the ISO if not cached, a margin. */
export function probeRoomNeeded(probe: LeasedProbe, isoCached: boolean): number {
  const restore = Math.ceil((probe.restoreBytes ?? 0) * 1.1);
  return restore + (isoCached ? 0 : probe.iso.size) + LAB_DISK_MARGIN_BYTES;
}

/** The disks of a probe as QEMU gets them: on the probe's controller, encrypted. */
export function probeDisks(probe: LeasedProbe, dir: string): Disk[] {
  return probe.hardware.disks.map((disk) => ({
    file: join(dir, `${disk.serial}.qcow2`),
    serial: disk.serial,
    bus: disk.controller === "nvme" ? "nvme" : "ahci",
    sectorSize: disk.logicalSectorSize,
    ...(disk.controller === "nvme" ? { eui64: euiOf(disk.serial) } : {}),
    keySecret: "probekey",
  }));
}

/** Run one leased probe; answers the result for the worker (never throws). */
export async function runProbe(deps: RunnerDeps, probe: LeasedProbe): Promise<ProbeResult> {
  const now = deps.now ?? Date.now;
  const poll = deps.pollMs ?? 2000;
  const log = deps.log ?? (() => {});
  const controllers = [
    ...new Set(probe.hardware.disks.map((disk) => disk.controller)),
  ] as LabController[];
  const base: Omit<ProbeResult, "outcome"> = {
    bootSerial: "",
    error: null,
    kvm: deps.kvm,
    firmware: probe.hardware.firmware,
    controllers,
    restoreMs: null,
    bootMs: null,
    labVersion: deps.labVersion,
  };
  if (!/^[0-9a-f-]{36}$/.test(probe.id)) {
    return {
      ...base,
      outcome: "lab_error",
      error: { code: "probe_invalid", message: "not a probe id" },
    };
  }
  const dir = join(deps.dir, "probes", probe.id);
  const vms: Vm[] = [];
  let closeProxy: (() => Promise<void>) | null = null;
  try {
    if (!deps.kvm) throw new ProbeLabError("no_kvm", "The lab has no KVM.");
    const isoFile = join(deps.dir, "iso", `${probe.iso.sha256}.iso`);
    const cached = existsSync(isoFile);
    const free = await (deps.freeBytes ?? defaultFreeBytes)(deps.dir);
    const needed = probeRoomNeeded(probe, cached);
    if (free < needed) {
      throw new ProbeLabError(
        "lab_disk_full",
        `The lab's folder has ${Math.floor(free / 1024 ** 2)} MiB free, the probe needs ${Math.ceil(needed / 1024 ** 2)} MiB.`,
      );
    }
    await mkdir(join(deps.dir, "iso"), { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!cached) {
      await deps.client.event(probe.id, "iso");
      await deps.client.downloadIso(probe.iso.sha256, isoFile);
    }
    const actual = await (deps.sha256File ?? defaultSha256File)(isoFile);
    if (actual !== probe.iso.sha256) {
      await rm(isoFile, { force: true });
      throw new ProbeLabError("iso_mismatch", "The cached ISO does not have the expected SHA-256.");
    }

    const varsFile = probe.hardware.firmware === "bios" ? undefined : join(dir, "vars.fd");
    if (varsFile) await deps.driver.createVars(varsFile, probe.hardware.firmware);
    const disks = probeDisks(probe, dir);
    const key = randomBytes(32).toString("hex");
    await deps.driver.createDisks(
      disks.map((disk, index) => ({
        file: disk.file,
        sizeBytes: probe.hardware.disks[index]?.sizeBytes ?? 0,
      })),
      key,
    );

    const proxy = await startProbeProxy({
      allow: proxyTarget(probe.origin),
      upstream: deps.tlsUpstream,
    });
    closeProxy = proxy.close;
    const common = {
      memoryMiB: probe.hardware.memoryMiB,
      cpus: probe.hardware.cpus,
      firmware: probe.hardware.firmware,
      varsFile,
      disks,
      sandbox: true,
    };

    // The restore.
    await deps.client.event(probe.id, "restore");
    const restoreStart = now();
    const restore = await deps.driver.start(
      {
        ...common,
        name: `restow-probe-restore`,
        serialLog: join(dir, "restore-serial.log"),
        serialSocket: join(dir, "restore-serial.sock"),
        qmpSocket: join(dir, "restore-qmp.sock"),
        cdrom: isoFile,
        network: {
          mode: "restricted",
          guestAddress: PROXY_GUEST_ADDRESS,
          guestPort: PROXY_GUEST_PORT,
          target: `127.0.0.1:${proxy.port}`,
          model: probe.hardware.nic as NicModel,
        },
      },
      key,
      // The code and the passphrase never touch the disk: QEMU reads them from a pipe while it
      // builds the machine (after the encrypted disks are open, seconds after its start).
      { "opt/restow/answers": JSON.stringify(probe.answers) },
    );
    vms.push(restore);
    const deadline = restoreStart + probe.timeouts.totalMs;
    let released = false;
    let exitCode: number | null = null;
    let lastEvent = now();
    restore.exited.then((code) => {
      exitCode = code;
    });
    while (exitCode === null && now() < deadline) {
      if (!released && RELEASED_LINE.test(restore.serial())) {
        released = true;
        await restore.cutNetwork();
        await deps.client.event(probe.id, "released").catch(() => ({ go: true }));
        log("probe released its access, network cut", { probeId: probe.id });
      }
      if (now() - lastEvent >= 60_000) {
        lastEvent = now();
        const answer = await deps.client.event(probe.id, "restore").catch(() => ({ go: true }));
        if (!answer.go) {
          throw new ProbeLabError("probe_ended", "The server ended the probe.");
        }
      }
      await sleep(poll);
    }
    base.restoreMs = Math.max(0, now() - restoreStart);
    if (exitCode === null) {
      log("restore VM did not end in time", {
        probeId: probe.id,
        released,
        serial: serialTail(restore.serial(), 1500),
      });
      restore.kill();
      return {
        ...base,
        outcome: "restore_stopped",
        error: {
          code: "restore_timeout",
          message: "The restore did not end within the time limit.",
        },
      };
    }
    if (!released) {
      // QEMU's error output and the end of the console say why: the lab log keeps both, the
      // report the exit code and the end of the error output.
      const qemuError = (restore.stderr?.() ?? "").trim().slice(-200);
      log("restore VM ended without releasing", {
        probeId: probe.id,
        exitCode,
        stderr: qemuError,
        serial: serialTail(restore.serial(), 1500),
      });
      return {
        ...base,
        outcome: "restore_stopped",
        error: {
          code: "not_released",
          message:
            `The ISO ended without releasing its access (QEMU exit ${exitCode}${qemuError ? `: ${qemuError}` : ""}).`.slice(
              0,
              300,
            ),
        },
      };
    }

    // The boot of the restored disks.
    await deps.client.event(probe.id, "boot").catch(() => ({ go: true }));
    const bootStart = now();
    const boot = await deps.driver.start(
      {
        ...common,
        name: `restow-probe-boot`,
        serialLog: join(dir, "boot-serial.log"),
        serialSocket: join(dir, "boot-serial.sock"),
        qmpSocket: join(dir, "boot-qmp.sock"),
        network: { mode: "none" },
      },
      key,
    );
    vms.push(boot);
    let bootExit: number | null = null;
    boot.exited.then((code) => {
      bootExit = code;
    });
    let typed = 0;
    let grubTyped = false;
    let booted = false;
    const bootDeadline = bootStart + probe.timeouts.bootMs;
    while (now() < bootDeadline) {
      const text = boot.serial();
      if (OK_LINE.test(text)) {
        booted = true;
        break;
      }
      const prompts = passphrasePrompts(text);
      if (prompts > typed && typed < MAX_PASSPHRASE_TRIES) {
        typed += 1;
        await boot.type(`${probe.passphrase}\n`);
      } else if (!grubTyped && text.trim() === "" && now() - bootStart >= GRUB_SILENCE_MS) {
        grubTyped = true;
        await boot.keys(`${probe.passphrase}\n`);
      }
      if (bootExit !== null) break;
      await sleep(poll);
    }
    base.bootMs = Math.max(0, now() - bootStart);
    base.bootSerial = serialTail(boot.serial());
    return { ...base, outcome: booted ? "booted" : "boot_timeout" };
  } catch (error) {
    const code = error instanceof ProbeLabError ? error.code : "lab_error";
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/[^\x20-\x7e]/g, " ")
      .slice(0, 500);
    log("probe failed in the lab", { probeId: probe.id, code, message });
    return { ...base, outcome: "lab_error", error: { code, message } };
  } finally {
    for (const vm of vms) vm.kill();
    await closeProxy?.().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** After a crash: the folders of probes that no process runs any more go. */
export async function removeLeftovers(dir: string): Promise<void> {
  await rm(join(dir, "probes"), { recursive: true, force: true });
  await mkdir(join(dir, "probes"), { recursive: true, mode: 0o700 });
}
