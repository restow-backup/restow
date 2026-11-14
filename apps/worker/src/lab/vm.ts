/**
 * The QEMU side of a probe (./runner.ts `VmDriver`): `qemu-img` and `qemu-system-x86_64` as the
 * lab's own unprivileged user. The key of the probe's disks reaches them through a named pipe in
 * a fresh folder only the lab may enter (`-object secret,file=<fifo>`, keyFifo): it is never
 * written to a file.
 */
import { execFile, spawn } from "node:child_process";
import { closeSync, constants, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
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

/** A key handed to one program through a named pipe (keyFifo). */
export interface KeyFifo {
  /** The path the program opens like a file. */
  path: string;
  /** Settles once the program has read the key (the pipe reached its end). */
  written: Promise<void>;
  /** Stop offering the key and remove the folder (also when nobody read it). */
  close: () => Promise<void>;
}

/**
 * Offer `key` once through a named pipe in a fresh folder (mkdtemp, 0700) and hand out its path.
 * The program reads the key like a file up to its end; nothing is written to a disk. The file
 * descriptor 3 of a child does not do: Node makes it a socket pair, and a program that opens
 * /dev/fd/3 gets ENXIO (qemu-img: "Unable to read /dev/fd/3 ... No such device or address").
 * The pipe is opened without blocking and tried again until the program opens its end, so a
 * program that never reads leaves no thread waiting.
 */
export async function keyFifo(key: string, pollMs = 20): Promise<KeyFifo> {
  const dir = await mkdtemp(join(tmpdir(), "restow-lab-key-"));
  const path = join(dir, "key");
  try {
    await promisify(execFile)("mkfifo", ["-m", "0600", path]);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let stopped = false;
  const written = (async () => {
    while (!stopped) {
      let fd: number;
      try {
        fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        // ENXIO: no reader yet.
        if ((error as NodeJS.ErrnoException).code !== "ENXIO") throw error;
        await sleep(pollMs);
        continue;
      }
      try {
        writeSync(fd, key);
      } finally {
        closeSync(fd);
      }
      return;
    }
  })();
  written.catch(() => {});
  return {
    path,
    written,
    close: async () => {
      stopped = true;
      await written.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Run a program with `key` behind KEY_FILE in its arguments; rejects with the end of its stderr. */
const KEY_FILE = "{key}";

async function runWithKey(command: string, args: string[], key: string | null): Promise<void> {
  const fifo = key ? await keyFifo(key) : null;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        command,
        args.map((arg) => (fifo ? arg.replaceAll(KEY_FILE, fifo.path) : arg)),
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${command} failed (${code}): ${stderr.trim().slice(-300)}`)),
      );
    });
  } finally {
    await fifo?.close();
  }
}

export function qemuDriver(options: { dbxFile: string | null; ovmf?: OvmfFiles }): VmDriver {
  const ovmf = options.ovmf ?? OVMF;
  return {
    async createDisks(disks, key) {
      for (const disk of disks) {
        await runWithKey("qemu-img", encryptedDiskArgs(disk.file, disk.sizeBytes, KEY_FILE), key);
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
    async start(machine: Machine, key: string, fwCfgData?: Record<string, string>): Promise<Vm> {
      const fifo = await keyFifo(key);
      const dataFifos: Record<string, KeyFifo> = {};
      for (const [name, content] of Object.entries(fwCfgData ?? {})) {
        dataFifos[name] = await keyFifo(content);
      }
      const fwCfg = { ...machine.fwCfg };
      for (const [name, data] of Object.entries(dataFifos)) fwCfg[name] = data.path;
      const pipes = [fifo, ...Object.values(dataFifos)];
      const args = machineArgs({
        ...machine,
        ...(Object.keys(fwCfg).length > 0 ? { fwCfg } : {}),
        ovmf,
        secrets: [{ id: "probekey", file: fifo.path }],
      });
      const child = spawn("qemu-system-x86_64", args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-2000);
      });
      const exited = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? -1));
        child.on("error", () => resolve(-1));
      });
      // QEMU reads its secret first and the fw_cfg files when it builds the machine, after it
      // opened the encrypted disks; the pipes go once it read them all, or QEMU ended.
      await Promise.race([Promise.all(pipes.map((pipe) => pipe.written)), exited, sleep(120_000)]);
      await Promise.all(pipes.map((pipe) => pipe.close()));
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
        stderr: () => stderr,
        kill: () => {
          serial?.destroy();
          if (child.exitCode === null) child.kill("SIGKILL");
        },
      };
    },
  };
}
