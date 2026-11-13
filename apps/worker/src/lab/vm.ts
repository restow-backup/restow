/**
 * The QEMU side of a probe (./runner.ts `VmDriver`): `qemu-img` and `qemu-system-x86_64` as the
 * lab's own unprivileged user. The key of the probe's disks reaches QEMU through a pipe on file
 * descriptor 3 (`-object secret,file=/dev/fd/3`): it is never written to a file.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  connectSerial,
  cutNetwork,
  encryptedDiskArgs,
  type Firmware,
  type Machine,
  machineArgs,
  OVMF,
  type OvmfFiles,
  sendKeys,
  typeSerial,
} from "./qemu.js";
import type { Vm, VmDriver } from "./runner.js";

const KEY_FD_FILE = "/dev/fd/3";

/** Run a program with `key` on fd 3; rejects with the end of its stderr. */
function runWithKey(command: string, args: string[], key: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe", key ? "pipe" : "ignore"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    if (key) {
      const pipe = child.stdio[3] as NodeJS.WritableStream;
      pipe.end(key);
    }
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed (${code}): ${stderr.trim().slice(-300)}`)),
    );
  });
}

export function qemuDriver(options: { dbxFile: string | null; ovmf?: OvmfFiles }): VmDriver {
  const ovmf = options.ovmf ?? OVMF;
  return {
    async createDisks(disks, key) {
      for (const disk of disks) {
        await runWithKey(
          "qemu-img",
          encryptedDiskArgs(disk.file, disk.sizeBytes, KEY_FD_FILE),
          key,
        );
      }
    },
    async createVars(file, firmware: Firmware) {
      if (firmware === "uefi-sb") {
        if (!options.dbxFile) throw new Error("the lab image has no DBX update");
        await runWithKey(
          "virt-fw-vars",
          ["--input", ovmf.varsMs, "--output", file, "--secure-boot", "--set-dbx", options.dbxFile],
          null,
        );
      } else {
        await copyFile(ovmf.vars, file);
      }
    },
    async start(machine: Machine, key: string): Promise<Vm> {
      const args = machineArgs({
        ...machine,
        ovmf,
        secrets: [{ id: "probekey", file: KEY_FD_FILE }],
      });
      const child = spawn("qemu-system-x86_64", args, {
        stdio: ["ignore", "ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      (child.stdio[3] as NodeJS.WritableStream).end(key);
      const exited = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });
      const early = await Promise.race([exited, sleep(1500).then(() => null)]);
      if (early !== null) {
        throw new Error(`QEMU did not start (${early}): ${stderr.trim().slice(-300)}`);
      }
      const serial = machine.serialSocket ? await connectSerial(machine.serialSocket) : null;
      serial?.on("data", () => {});
      serial?.on("error", () => {});
      return {
        serial: () =>
          existsSync(machine.serialLog) ? readFileSync(machine.serialLog, "utf8") : "",
        type: async (text) => {
          if (!serial) throw new Error("no serial socket");
          await typeSerial(serial, text);
        },
        keys: (text) => sendKeys(machine.qmpSocket, text),
        cutNetwork: () => cutNetwork(machine.qmpSocket),
        exited,
        kill: () => {
          serial?.destroy();
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    },
  };
}
