/**
 * The QEMU layer of the recovery end-to-end tests (docs/BAREMETAL.md 21.2): disks with serial
 * numbers on a chosen controller, BIOS (SeaBIOS) or UEFI (OVMF, with Secure Boot and the
 * Microsoft keys and a current DBX in the variable store), the answers through fw_cfg, the
 * serial console into a file and QMP for keys (the LUKS passphrase GRUB asks for in E7) and a
 * hard stop (the power loss of E8).
 *
 * The argument builders are pure and tested (run.test.mjs). The boot probe of the lab (M5) is to
 * take this layer over into apps/worker/src/endpoints/lab/qemu.ts; until then it lives here.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

/** Where Debian and Ubuntu install OVMF (package ovmf) and the variable tools. */
export const OVMF = Object.freeze({
  code: "/usr/share/OVMF/OVMF_CODE_4M.fd",
  codeSecure: "/usr/share/OVMF/OVMF_CODE_4M.secboot.fd",
  // The variable store with the Microsoft KEK and db (UEFI CA 2011 and 2023) enrolled.
  varsMs: "/usr/share/OVMF/OVMF_VARS_4M.ms.fd",
  vars: "/usr/share/OVMF/OVMF_VARS_4M.fd",
});

/** KVM must be there and usable: without it a case takes hours (TCG), so the run stops. */
export function assertKvm(path = "/dev/kvm", access = accessSync) {
  try {
    access(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    const reason = error && typeof error === "object" && "code" in error ? error.code : "error";
    throw new Error(
      `KVM is not available (${path}: ${reason}). The recovery end-to-end tests need KVM; ` +
        "on a GitHub runner the job adds a udev rule for /dev/kvm, elsewhere add your user to the kvm group.",
    );
  }
}

const SERIAL = /^[A-Za-z0-9._-]{1,20}$/;
const EUI64 = /^[0-9a-f]{16}$/;

/**
 * The -drive and -device arguments of the disks, each on its controller, with its serial number.
 * An NVMe disk is a controller with one explicit namespace (nsid 1) that carries the disk's fixed
 * EUI-64, so its identity does not depend on QEMU's machine-type defaults.
 */
export function diskArgs(disks) {
  const args = [];
  const controllers = new Set();
  let ahciPort = 0;
  disks.forEach((disk, index) => {
    if (!SERIAL.test(disk.serial)) {
      throw new Error(`disk serial ${JSON.stringify(disk.serial)}: up to 20 of A-Z a-z 0-9 . _ -`);
    }
    if (!disk.file) throw new Error(`disk ${disk.serial} has no image file`);
    const id = `disk${index}`;
    args.push(
      "-drive",
      `file=${disk.file},if=none,id=${id},format=qcow2,cache=unsafe,discard=unmap`,
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
        throw new Error(`unknown disk bus ${disk.bus}`);
    }
  });
  return args;
}

/**
 * The firmware: `bios` (SeaBIOS), `uefi` (OVMF without Secure Boot) or `uefi-sb` (OVMF with
 * Secure Boot, SMM, the variable store `varsFile` of this machine, a copy of the Microsoft
 * one with a current DBX that the run made with virt-fw-vars).
 */
export function firmwareArgs(firmware, varsFile, ovmf = OVMF) {
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
      throw new Error(`unknown firmware ${firmware}`);
  }
}

/** A string or file under fw_cfg (`opt/restow/answers` is read by the ISO only when sys_vendor is QEMU). */
export function fwCfgArgs(entries) {
  return Object.entries(entries).flatMap(([name, file]) => {
    if (!/^opt\/restow\/[a-z]+$/.test(name))
      throw new Error(`fw_cfg name ${name} is not opt/restow/<name>`);
    return ["-fw_cfg", `name=${name},file=${file}`];
  });
}

/**
 * The whole command line of a machine. `network.mac` is the NIC's address (a new one on the
 * target in E2); the guest reaches the host's test instance at 10.0.2.2 (QEMU user network).
 */
export function machineArgs(machine) {
  const args = [
    "-name",
    machine.name,
    "-m",
    String(machine.memoryMiB ?? 4096),
    "-smp",
    String(machine.cpus ?? 2),
    "-cpu",
    "host",
    "-nographic",
    "-serial",
    `file:${machine.serialLog}`,
    "-qmp",
    `unix:${machine.qmpSocket},server=on,wait=off`,
    "-netdev",
    "user,id=net0",
    "-device",
    `virtio-net-pci,netdev=net0,mac=${machine.mac ?? "52:54:00:12:34:56"}`,
    ...firmwareArgs(machine.firmware, machine.varsFile),
    ...diskArgs(machine.disks),
  ];
  if (machine.cdrom) {
    args.push("-drive", `file=${machine.cdrom},media=cdrom,readonly=on,if=none,id=cd0`);
    args.push("-device", "ide-cd,drive=cd0,bootindex=0");
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

/** A disk image of `size` (qemu-img create). */
export async function createDisk(run, file, size) {
  await run("qemu-img", ["create", "-q", "-f", "qcow2", file, size]);
}

/** A variable store for one machine: the Microsoft store, with the current DBX for `uefi-sb`. */
export async function createVars(run, file, firmware, dbxFile, ovmf = OVMF) {
  if (firmware === "uefi-sb") {
    const args = ["--input", ovmf.varsMs, "--output", file, "--secure-boot"];
    if (dbxFile) args.push("--set-dbx", dbxFile);
    await run("virt-fw-vars", args);
  } else {
    await run("cp", [ovmf.vars, file]);
  }
}

/** Start QEMU; answers the child and a promise of its exit code. */
export function startMachine(machine, spawnFn = spawn) {
  const child = spawnFn("qemu-system-x86_64", machineArgs(machine), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
  return { child, exited };
}

/** Wait until the serial log has a line matching `pattern`; answers the match. */
export async function waitForSerial(serialLog, pattern, { timeoutMs, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + (timeoutMs ?? 20 * 60 * 1000);
  while (Date.now() < deadline) {
    if (existsSync(serialLog)) {
      const match = pattern.exec(readFileSync(serialLog, "utf8"));
      if (match) return match;
    }
    await sleep(intervalMs);
  }
  throw new Error(`no ${pattern} on the serial console of ${serialLog} in time`);
}

/** One QMP command (a fresh connection each time: capabilities, then the command). */
export function qmp(socket, command, args = {}) {
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
        const message = JSON.parse(line);
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
export function keysOf(text) {
  const named = { "-": "minus", " ": "spc", ".": "dot", _: "shift-minus", "\n": "ret" };
  return [...text].map((char) => {
    if (named[char]) return named[char];
    if (/[a-z0-9]/.test(char)) return char;
    if (/[A-Z]/.test(char)) return `shift-${char.toLowerCase()}`;
    throw new Error(`no QMP key for ${JSON.stringify(char)}`);
  });
}

/** Type a text into the guest (E7: the passphrase GRUB asks for). */
export async function sendKeys(socket, text, qmpFn = qmp) {
  for (const key of keysOf(text)) {
    const keys = key.split("-").map((part) => ({ type: "qcode", data: part }));
    await qmpFn(socket, "send-key", { keys });
    await sleep(80);
  }
}
