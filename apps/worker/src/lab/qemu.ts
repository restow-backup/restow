/**
 * The QEMU layer of the recovery lab (docs/BAREMETAL.md 12.3) and of the recovery end-to-end
 * tests (21.2, scripts/recovery-e2e re-exports it): disks with serial numbers on a chosen
 * controller, BIOS (SeaBIOS) or UEFI (OVMF, with Secure Boot, the Microsoft keys and a current
 * DBX in the variable store), the answers through fw_cfg, the serial console into a file (or a
 * socket the lab types into, with the same log) and QMP for keys and the network link.
 *
 * The lab adds what a probe of a tenant's system needs: QEMU's sandbox and no default devices,
 * disks encrypted with a key that only the lab's memory holds, a user network that reaches
 * nothing but one forwarded address (the lab's CONNECT proxy), no network at all for the boot of
 * the restored disks.
 *
 * Plain erasable TypeScript with only `node:` imports: Node runs it as it is from the .mjs
 * driver of the end-to-end tests (type stripping), tsc builds it into the lab image.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** Where Debian and Ubuntu install OVMF (package ovmf). */
export const OVMF = Object.freeze({
  code: "/usr/share/OVMF/OVMF_CODE_4M.fd",
  codeSecure: "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd",
  // The variable store with the Microsoft KEK and db (UEFI CA 2011 and 2023) enrolled.
  varsMs: "/usr/share/OVMF/OVMF_VARS_4M.ms.fd",
  vars: "/usr/share/OVMF/OVMF_VARS_4M.fd",
});
export type OvmfFiles = { code: string; codeSecure: string; varsMs: string; vars: string };

export type Firmware = "bios" | "uefi" | "uefi-sb";
export type DiskBus = "virtio" | "ahci" | "nvme" | "scsi";

export interface Disk {
  file: string;
  serial: string;
  bus: DiskBus;
  sectorSize?: 512 | 4096;
  /** NVMe only: the namespace's EUI-64, 16 lower-case hex digits. */
  eui64?: string;
  /** The id of a `-object secret` that opens the LUKS encryption of the qcow2 file. */
  keySecret?: string;
}

/** KVM must be there and usable: without it a probe or a case takes hours (TCG). */
export function assertKvm(path = "/dev/kvm", access = accessSync): void {
  try {
    access(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    const reason =
      error && typeof error === "object" && "code" in error ? String(error.code) : "error";
    throw new Error(
      `KVM is not available (${path}: ${reason}). The recovery end-to-end tests need KVM; ` +
        "on a GitHub runner the job adds a udev rule for /dev/kvm, elsewhere add your user to the kvm group.",
    );
  }
}

/** Whether KVM is usable (the lab reports it instead of failing). */
export function kvmUsable(path = "/dev/kvm", access = accessSync): boolean {
  try {
    assertKvm(path, access);
    return true;
  } catch {
    return false;
  }
}

const SERIAL = /^[A-Za-z0-9._-]{1,20}$/;
const EUI64 = /^[0-9a-f]{16}$/;
const ID = /^[a-z][a-z0-9]{0,15}$/;

/**
 * The -drive and -device arguments of the disks, each on its controller, with its serial number.
 * An NVMe disk is a controller with one explicit namespace (nsid 1) that carries the disk's fixed
 * EUI-64, so its identity does not depend on QEMU's machine-type defaults.
 */
export function diskArgs(disks: readonly Disk[]): string[] {
  const args: string[] = [];
  const controllers = new Set<string>();
  let ahciPort = 0;
  disks.forEach((disk, index) => {
    if (!SERIAL.test(disk.serial)) {
      throw new Error(`disk serial ${JSON.stringify(disk.serial)}: up to 20 of A-Z a-z 0-9 . _ -`);
    }
    if (!disk.file) throw new Error(`disk ${disk.serial} has no image file`);
    if (disk.keySecret !== undefined && !ID.test(disk.keySecret)) {
      throw new Error(`disk ${disk.serial}: key secret id ${disk.keySecret}`);
    }
    const id = `disk${index}`;
    const encryption = disk.keySecret
      ? `,encrypt.format=luks,encrypt.key-secret=${disk.keySecret}`
      : "";
    args.push(
      "-drive",
      `file=${disk.file},if=none,id=${id},format=qcow2,cache=unsafe,discard=unmap${encryption}`,
    );
    const sectors =
      disk.sectorSize === 4096 ? ",logical_block_size=4096,physical_block_size=4096" : "";
    switch (disk.bus) {
      case "virtio":
        args.push("-device", `virtio-blk-pci,drive=${id},serial=${disk.serial}${sectors}`);
        break;
      case "ahci":
        if (!controllers.has("ahci")) {
          args.push("-device", "ahci,id=ahci0");
          controllers.add("ahci");
        }
        if (disk.sectorSize === 4096)
          throw new Error("QEMU's SATA disks have 512-byte sectors only");
        if (ahciPort > 5) throw new Error("the AHCI controller has six ports");
        args.push("-device", `ide-hd,drive=${id},bus=ahci0.${ahciPort},serial=${disk.serial}`);
        ahciPort += 1;
        break;
      case "nvme":
        if (!EUI64.test(disk.eui64 ?? ""))
          throw new Error(`NVMe disk ${disk.serial} needs eui64 (16 lower-case hex digits)`);
        args.push(
          "-device",
          `nvme,id=nvme${index},serial=${disk.serial}`,
          "-device",
          `nvme-ns,drive=${id},bus=nvme${index},nsid=1,eui64=${BigInt(`0x${disk.eui64}`)}${sectors}`,
        );
        break;
      case "scsi":
        if (!controllers.has("scsi")) {
          args.push("-device", "virtio-scsi-pci,id=scsi0");
          controllers.add("scsi");
        }
        args.push("-device", `scsi-hd,drive=${id},bus=scsi0.0,serial=${disk.serial}${sectors}`);
        break;
      default:
        throw new Error(`unknown disk bus ${String(disk.bus)}`);
    }
  });
  return args;
}

/**
 * The firmware: `bios` (SeaBIOS), `uefi` (OVMF without Secure Boot) or `uefi-sb` (OVMF with
 * Secure Boot, SMM, the variable store `varsFile` of this machine, a copy of the Microsoft
 * one with a current DBX).
 */
export function firmwareArgs(
  firmware: Firmware,
  varsFile: string | undefined,
  ovmf: OvmfFiles = OVMF,
): string[] {
  switch (firmware) {
    case "bios":
      return ["-machine", "q35,accel=kvm"];
    case "uefi":
      if (!varsFile) throw new Error("UEFI needs a variable store file");
      return [
        "-machine",
        "q35,accel=kvm",
        "-drive",
        `if=pflash,format=raw,unit=0,readonly=on,file=${ovmf.code}`,
        "-drive",
        `if=pflash,format=raw,unit=1,file=${varsFile}`,
      ];
    case "uefi-sb":
      if (!varsFile) throw new Error("Secure Boot needs a variable store file");
      return [
        "-machine",
        "q35,accel=kvm,smm=on",
        "-global",
        "driver=cfi.pflash01,property=secure,value=on",
        "-drive",
        `if=pflash,format=raw,unit=0,readonly=on,file=${ovmf.codeSecure}`,
        "-drive",
        `if=pflash,format=raw,unit=1,file=${varsFile}`,
      ];
    default:
      throw new Error(`unknown firmware ${String(firmware)}`);
  }
}

/** A string or file under fw_cfg (`opt/restow/answers` is read by the ISO only when sys_vendor is QEMU). */
export function fwCfgArgs(entries: Record<string, string>): string[] {
  return Object.entries(entries).flatMap(([name, file]) => {
    if (!/^opt\/restow\/[a-z]+$/.test(name))
      throw new Error(`fw_cfg name ${name} is not opt/restow/<name>`);
    return ["-fw_cfg", `name=${name},file=${file}`];
  });
}

/**
 * The network of a machine:
 *   - `user` (default, the end-to-end tests): QEMU's user network, the host at 10.0.2.2;
 *   - `restricted`: the user network with `restrict=on` (nothing outside is reachable) and one
 *     `guestfwd` rule: `address:port` in the guest goes to `target` (`127.0.0.1:<port>` of the
 *     lab's CONNECT proxy). No DNS is needed, the guest names the proxy by its address;
 *   - `none`: no network card at all.
 */
export type Network =
  | { mode: "user"; mac?: string; model?: NicModel }
  | {
      mode: "restricted";
      guestAddress: string;
      guestPort: number;
      target: string;
      mac?: string;
      model?: NicModel;
    }
  | { mode: "none" };
export type NicModel = "virtio-net" | "e1000e";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOST_PORT = /^127\.0\.0\.1:\d{1,5}$/;

export function networkArgs(network: Network): string[] {
  if (network.mode === "none") return ["-nic", "none"];
  const mac = network.mac ?? "52:54:00:12:34:56";
  const device = network.model === "e1000e" ? "e1000e" : "virtio-net-pci";
  if (network.mode === "user") {
    return ["-netdev", "user,id=net0", "-device", `${device},netdev=net0,id=nic0,mac=${mac}`];
  }
  if (!IPV4.test(network.guestAddress) || !HOST_PORT.test(network.target)) {
    throw new Error("a restricted network forwards one guest address to 127.0.0.1:<port>");
  }
  if (!Number.isInteger(network.guestPort) || network.guestPort < 1 || network.guestPort > 65535) {
    throw new Error(`guest port ${network.guestPort}`);
  }
  return [
    "-netdev",
    `user,id=net0,restrict=on,guestfwd=tcp:${network.guestAddress}:${network.guestPort}-tcp:${network.target}`,
    "-device",
    `${device},netdev=net0,id=nic0,mac=${mac}`,
  ];
}

/** QEMU's own sandbox for a guest that may be hostile (12.3): no new privileges, no spawning. */
export const SANDBOX_ARGS = Object.freeze([
  "-sandbox",
  "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
  "-nodefaults",
]);

export interface Machine {
  name: string;
  memoryMiB?: number;
  cpus?: number;
  /** The serial console: written into this file (and typed into through `serialSocket`). */
  serialLog: string;
  /** A Unix socket the serial console is also on (the lab types the passphrase there). */
  serialSocket?: string;
  qmpSocket: string;
  firmware: Firmware;
  varsFile?: string;
  disks: readonly Disk[];
  /** The legacy form of the end-to-end tests: a user network with this MAC. */
  mac?: string;
  network?: Network;
  cdrom?: string;
  extraDisks?: readonly string[];
  kernel?: { file: string; initrd: string; append: string };
  fwCfg?: Record<string, string>;
  /** `-object secret` definitions: id and the file QEMU reads the key from (`/dev/fd/<n>`). */
  secrets?: readonly { id: string; file: string }[];
  /** The lab's options: QEMU's sandbox and no default devices, a VGA for GRUB's prompt. */
  sandbox?: boolean;
  ovmf?: OvmfFiles;
}

/** The whole command line of a machine. */
export function machineArgs(machine: Machine): string[] {
  const serial = machine.serialSocket
    ? [
        "-chardev",
        `socket,id=ser0,path=${machine.serialSocket},server=on,wait=off,logfile=${machine.serialLog},logappend=on`,
        "-serial",
        "chardev:ser0",
      ]
    : ["-serial", `file:${machine.serialLog}`];
  const args = [
    "-name",
    machine.name,
    "-m",
    String(machine.memoryMiB ?? 4096),
    "-smp",
    String(machine.cpus ?? 2),
    "-cpu",
    "host",
    ...(machine.sandbox ? [...SANDBOX_ARGS, "-device", "VGA", "-display", "none"] : ["-nographic"]),
    ...serial,
    "-qmp",
    `unix:${machine.qmpSocket},server=on,wait=off`,
    ...networkArgs(machine.network ?? { mode: "user", mac: machine.mac }),
    ...firmwareArgs(machine.firmware, machine.varsFile, machine.ovmf),
  ];
  for (const secret of machine.secrets ?? []) {
    if (!ID.test(secret.id)) throw new Error(`secret id ${secret.id}`);
    args.push("-object", `secret,id=${secret.id},file=${secret.file}`);
  }
  args.push(...diskArgs(machine.disks));
  if (machine.cdrom) {
    args.push("-drive", `file=${machine.cdrom},media=cdrom,readonly=on,if=none,id=cd0`);
    // With a kernel booted directly, QEMU's linuxboot option ROM holds boot index 0 and a
    // second device with it stops QEMU at once ("The bootindex 0 has already been used");
    // the medium is then only the live system's carrier, found by its content.
    args.push("-device", machine.kernel ? "ide-cd,drive=cd0" : "ide-cd,drive=cd0,bootindex=0");
  }
  if (machine.extraDisks) {
    for (const [index, file] of machine.extraDisks.entries()) {
      args.push("-drive", `file=${file},format=raw,readonly=on,if=virtio,index=${10 + index}`);
    }
  }
  if (machine.kernel) {
    // Direct kernel boot (the factory VM: the ISO's live system with its own command line).
    args.push("-kernel", machine.kernel.file, "-initrd", machine.kernel.initrd);
    args.push("-append", machine.kernel.append);
  }
  if (machine.fwCfg) args.push(...fwCfgArgs(machine.fwCfg));
  return args;
}

export type Run = (command: string, args: string[]) => Promise<void>;

/** A disk image of `size` (qemu-img create). */
export async function createDisk(run: Run, file: string, size: string): Promise<void> {
  await run("qemu-img", ["create", "-q", "-f", "qcow2", file, size]);
}

/**
 * The arguments of `qemu-img create` for a disk encrypted with LUKS (12.3): the key comes from
 * `keyFile` (`/dev/fd/<n>`, a pipe the lab writes the key into), so no file holds it.
 */
export function encryptedDiskArgs(file: string, sizeBytes: number, keyFile: string): string[] {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error(`disk size ${sizeBytes}`);
  return [
    "create",
    "-q",
    "--object",
    `secret,id=sec0,file=${keyFile}`,
    "-f",
    "qcow2",
    "-o",
    "encrypt.format=luks,encrypt.key-secret=sec0",
    file,
    String(sizeBytes),
  ];
}

/** A variable store for one machine: the Microsoft store, with the current DBX for `uefi-sb`. */
export async function createVars(
  run: Run,
  file: string,
  firmware: Firmware,
  dbxFile: string | undefined,
  ovmf: OvmfFiles = OVMF,
): Promise<void> {
  if (firmware === "uefi-sb") {
    const args = ["--input", ovmf.varsMs, "--output", file, "--secure-boot"];
    if (dbxFile) args.push("--set-dbx", dbxFile);
    await run("virt-fw-vars", args);
  } else {
    await run("cp", [ovmf.vars, file]);
  }
}

/** A started QEMU: the child, its exit code once it ended, and the end of what it wrote to stderr. */
export interface StartedMachine {
  child: ChildProcess;
  exited: Promise<number>;
  /** The last few KiB QEMU wrote to stderr (why it refused to start, for example). */
  stderrTail: () => string;
}

const STDERR_TAIL_CHARS = 4000;

/**
 * Start QEMU; answers the child, a promise of its exit code and the end of its stderr. stderr is
 * read all the time, so a talkative QEMU never blocks on a full pipe, and a QEMU that refuses its
 * command line says why.
 */
export function startMachine(
  machine: Machine,
  spawnFn: typeof spawn = spawn,
  options: { stdio?: ("ignore" | "pipe")[] } = {},
): StartedMachine {
  const child = spawnFn("qemu-system-x86_64", machineArgs(machine), {
    stdio: options.stdio ?? ["ignore", "ignore", "pipe"],
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
  });
  const exited = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  return { child, exited, stderrTail: () => tail.trim() };
}

/**
 * Wait until the serial log has a line matching `pattern`; answers the match. With `machine`,
 * a QEMU that ends before the line appears fails the wait at once, with its exit code and the
 * end of its stderr, instead of after the whole timeout.
 */
export async function waitForSerial(
  serialLog: string,
  pattern: RegExp,
  {
    timeoutMs,
    intervalMs = 2000,
    machine,
  }: {
    timeoutMs?: number;
    intervalMs?: number;
    machine?: Pick<StartedMachine, "exited"> & Partial<Pick<StartedMachine, "stderrTail">>;
  } = {},
): Promise<RegExpExecArray> {
  const deadline = Date.now() + (timeoutMs ?? 20 * 60 * 1000);
  let exitCode: number | null = null;
  void machine?.exited.then((code) => {
    exitCode = code;
  });
  const match = (): RegExpExecArray | null =>
    existsSync(serialLog) ? pattern.exec(readFileSync(serialLog, "utf8")) : null;
  while (Date.now() < deadline) {
    const found = match();
    if (found) return found;
    if (exitCode !== null) {
      // The last lines may have arrived together with the end.
      const last = match();
      if (last) return last;
      const stderr = machine?.stderrTail?.() ?? "";
      throw new Error(
        `QEMU ended (exit code ${exitCode}) before ${pattern} appeared on the serial console of ${serialLog}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(`no ${pattern} on the serial console of ${serialLog} in time`);
}

/** One QMP command (a fresh connection each time: capabilities, then the command). */
export function qmp(
  socket: string,
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket);
    let buffer = "";
    let stage = 0;
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        const message = JSON.parse(line) as {
          event?: string;
          error?: { desc: string };
          return?: unknown;
        };
        if (message.event) continue;
        if (stage === 0) {
          stage = 1;
          connection.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
        } else if (stage === 1) {
          stage = 2;
          connection.write(`${JSON.stringify({ execute: command, arguments: args })}\n`);
        } else {
          connection.end();
          if (message.error) reject(new Error(`QMP ${command}: ${message.error.desc}`));
          else resolve(message.return);
        }
      }
    });
    connection.on("error", reject);
  });
}

/** The QMP key names of a text (US layout; the guest's keymap decides what arrives). */
export function keysOf(text: string): string[] {
  const named: Record<string, string> = {
    "-": "minus",
    " ": "spc",
    ".": "dot",
    _: "shift-minus",
    "\n": "ret",
  };
  return [...text].map((char) => {
    if (named[char]) return named[char] as string;
    if (/[a-z0-9]/.test(char)) return char;
    if (/[A-Z]/.test(char)) return `shift-${char.toLowerCase()}`;
    throw new Error(`no QMP key for ${JSON.stringify(char)}`);
  });
}

type QmpFn = (socket: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Type a text into the guest's keyboard (GRUB asks for the passphrase of an encrypted /boot). */
export async function sendKeys(socket: string, text: string, qmpFn: QmpFn = qmp): Promise<void> {
  for (const key of keysOf(text)) {
    const keys = key.split("-").map((part) => ({ type: "qcode", data: part }));
    await qmpFn(socket, "send-key", { keys });
    await sleep(80);
  }
}

/** Take the guest's network away (12.3, after `RESTOW-PROBE phase=released`): link down, netdev gone. */
export async function cutNetwork(socket: string, qmpFn: QmpFn = qmp): Promise<void> {
  await qmpFn(socket, "set_link", { name: "nic0", up: false });
  await qmpFn(socket, "netdev_del", { id: "net0" });
}

/**
 * Connect to the Unix socket of a machine's serial console (`serialSocket`); QEMU creates it a
 * moment after its start. What the guest prints still goes to the log; the caller drains it.
 */
export async function connectSerial(
  path: string,
  timeoutMs = 10_000,
): Promise<ReturnType<typeof createConnection>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
        const socket = createConnection(path);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(200);
    }
  }
}

/**
 * Type a text on the serial console, one character at a time, a line end as the Enter key
 * (carriage return): an encrypted root asks there for its passphrase when the kernel's console
 * is ttyS0, and the keyboard of `sendKeys` does not reach it.
 */
export async function typeSerial(
  serial: { write: (chunk: string) => unknown },
  text: string,
  delayMs = 20,
): Promise<void> {
  for (const char of text) {
    serial.write(char === "\n" ? "\r" : char);
    await sleep(delayMs);
  }
}
