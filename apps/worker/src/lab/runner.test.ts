/**
 * One boot probe in the lab (docs/BAREMETAL.md 12.3), with the VMs replaced by scripts of what
 * their serial consoles show: the network is cut once the ISO released its access, the
 * passphrase is typed where a prompt asks, the boot ends at `RESTOW-PROBE-OK`; time limits,
 * a full disk, a changed ISO and a probe the server ended become their outcomes; the probe's
 * folder is always removed and the answers (code, passphrase) leave the disk once QEMU read them.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LabClient, LeasedProbe, ProbePhase } from "./client.js";
import type { Machine } from "./qemu.js";
import { euiOf, probeDisks, runProbe, type Vm, type VmDriver } from "./runner.js";
import { passphrasePrompts } from "./serial.js";

const ID = "0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f";
const SHA = "e".repeat(64);

function lease(change: Partial<LeasedProbe> = {}): LeasedProbe {
  return {
    id: ID,
    snapshotId: "a".repeat(64),
    origin: "https://restow.contoso.example",
    spkiCheck: null,
    iso: { sha256: SHA, version: "0.5.0", fileName: "x.iso", size: 1000 },
    hardware: {
      firmware: "uefi-sb",
      disks: [
        {
          id: "d0",
          sizeBytes: 10 * 1024 ** 3,
          logicalSectorSize: 512,
          controller: "sata",
          serial: "RESTOWPROBE0",
        },
      ],
      nic: "e1000e",
      memoryMiB: 4096,
      cpus: 2,
    },
    restoreBytes: 4 * 1024 ** 3,
    answers: { format: "restow-answers-v1", code: "SECRET-CODE", passphrase: "pass-WORD_1" },
    passphrase: "pass-WORD_1",
    timeouts: { totalMs: 60_000, bootMs: 50_000 },
    ...change,
  };
}

/** A VM whose console shows `script[i]` from the i-th look on; exits when told. */
function scriptedVm(script: string[], options: { exitAfter?: number; exitOnCut?: boolean } = {}) {
  let looks = 0;
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const record = { typed: [] as string[], keys: [] as string[], cut: 0, killed: 0 };
  const vm: Vm = {
    serial: () => {
      looks += 1;
      if (options.exitAfter !== undefined && looks >= options.exitAfter) resolveExit(0);
      return script[Math.min(looks, script.length) - 1] ?? "";
    },
    type: async (text) => {
      record.typed.push(text);
    },
    keys: async (text) => {
      record.keys.push(text);
    },
    cutNetwork: async () => {
      record.cut += 1;
      // The ISO powers off after its last steps, without the network.
      if (options.exitOnCut) resolveExit(0);
    },
    exited,
    kill: () => {
      record.killed += 1;
    },
  };
  return { vm, record };
}

describe("a boot probe in the lab", () => {
  let dir = "";
  let clock = 0;
  const events: ProbePhase[] = [];
  let go = true;
  const client: LabClient = {
    next: async () => ({ probe: null, reason: "none" }),
    event: async (_id, phase) => {
      events.push(phase);
      return { go };
    },
    result: async () => {},
    downloadIso: async (_sha, file) => {
      await writeFile(file, "ISO");
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-lab-"));
    clock = 0;
    events.length = 0;
    go = true;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function driver(
    vms: Vm[],
    seen: { machines: Machine[]; disks: unknown[]; vars: string[]; answersAtStart: boolean[] },
  ): VmDriver {
    return {
      createDisks: async (disks) => {
        seen.disks.push(...disks);
      },
      createVars: async (file, firmware) => {
        seen.vars.push(firmware);
        await writeFile(file, "vars");
      },
      start: async (machine) => {
        seen.machines.push(machine);
        // Whether the answers of the first machine (code, passphrase) are still on disk.
        const answers = (seen.machines[0] ?? machine).fwCfg?.["opt/restow/answers"];
        seen.answersAtStart.push(answers ? existsSync(answers) : false);
        const vm = vms.shift();
        if (!vm) throw new Error("no VM left");
        return vm;
      },
    };
  }

  const deps = (d: VmDriver, change: Record<string, unknown> = {}) => ({
    client,
    driver: d,
    dir,
    labVersion: "0.5.0",
    kvm: true,
    tlsUpstream: "127.0.0.1:1",
    pollMs: 1,
    now: () => (clock += 1000),
    freeBytes: async () => 100 * 1024 ** 3,
    sha256File: async () => SHA,
    ...change,
  });

  it("restores through the proxy, cuts the network at the release, types the passphrase and sees the boot", async () => {
    const restore = scriptedVm(["booting the ISO", "restoring", "RESTOW-PROBE phase=released\n"], {
      exitOnCut: true,
    });
    const boot = scriptedVm([
      "",
      "Please enter passphrase for disk root:",
      "Please enter passphrase for disk root:\n[  OK  ] Reached target\nRESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0-27-amd64\n",
    ]);
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
    };
    const result = await runProbe(deps(driver([restore.vm, boot.vm], seen)), lease());
    expect(result).toMatchObject({
      outcome: "booted",
      kvm: true,
      firmware: "uefi-sb",
      controllers: ["sata"],
      error: null,
    });
    expect(result.bootSerial).toContain("RESTOW-PROBE-OK");
    expect(restore.record.cut).toBe(1);
    expect(boot.record.typed).toEqual(["pass-WORD_1\n"]);
    expect(events).toEqual(["iso", "restore", "released", "boot"]);
    expect(seen.vars).toEqual(["uefi-sb"]);
    // The restore VM: ISO, answers, the proxy only, sandboxed; the boot VM: no network.
    const [first, second] = seen.machines;
    expect(first?.sandbox).toBe(true);
    expect(first?.network).toMatchObject({
      mode: "restricted",
      guestAddress: "10.0.2.100",
      guestPort: 3128,
      model: "e1000e",
    });
    expect(first?.cdrom).toContain(`${SHA}.iso`);
    expect(seen.answersAtStart).toEqual([true, false]);
    expect(second?.network).toEqual({ mode: "none" });
    expect(second?.cdrom).toBeUndefined();
    expect(second?.fwCfg).toBeUndefined();
    expect(first?.disks[0]).toMatchObject({
      bus: "ahci",
      serial: "RESTOWPROBE0",
      keySecret: "probekey",
    });
    // Both VMs stopped, the probe's folder gone, the ISO kept for the next probe.
    expect(restore.record.killed + boot.record.killed).toBe(2);
    expect(await readdir(join(dir, "probes"))).toEqual([]);
    expect(existsSync(join(dir, "iso", `${SHA}.iso`))).toBe(true);
  });

  it("types on the keyboard once when the console stays silent (GRUB asks on the screen) and ends at the time limit", async () => {
    const restore = scriptedVm(["RESTOW-PROBE phase=released"], { exitOnCut: true });
    const boot = scriptedVm([""]);
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
    };
    const result = await runProbe(deps(driver([restore.vm, boot.vm], seen)), lease());
    expect(result.outcome).toBe("boot_timeout");
    expect(boot.record.keys).toEqual(["pass-WORD_1\n"]);
    expect(result.bootMs).toBeGreaterThanOrEqual(50_000);
  });

  it("ends as a stopped restore when the ISO does not release, or runs out of time", async () => {
    const quiet = scriptedVm(["plan refused"], { exitAfter: 2 });
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
    };
    expect(await runProbe(deps(driver([quiet.vm], seen)), lease())).toMatchObject({
      outcome: "restore_stopped",
      error: { code: "not_released" },
    });
    expect(seen.machines).toHaveLength(1);
    const endless = scriptedVm(["restoring"]);
    const result = await runProbe(deps(driver([endless.vm], seen)), lease());
    expect(result).toMatchObject({
      outcome: "restore_stopped",
      error: { code: "restore_timeout" },
    });
    expect(endless.record.killed).toBeGreaterThanOrEqual(1);
  });

  it("stops when the server ended the probe", async () => {
    go = false;
    const endless = scriptedVm(["restoring"]);
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
    };
    const result = await runProbe(
      deps(driver([endless.vm], seen)),
      lease({ timeouts: { totalMs: 10 * 60_000, bootMs: 1 } }),
    );
    expect(result).toMatchObject({ outcome: "lab_error", error: { code: "probe_ended" } });
    expect(endless.record.killed).toBe(1);
  });

  it("reports the lab's own problems: no KVM, no room, a changed ISO", async () => {
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
    };
    const d = driver([], seen);
    expect((await runProbe(deps(d, { kvm: false }), lease())).error?.code).toBe("no_kvm");
    const full = await runProbe(deps(d, { freeBytes: async () => 5 * 1024 ** 3 }), lease());
    expect(full).toMatchObject({ outcome: "lab_error", error: { code: "lab_disk_full" } });
    const changed = await runProbe(deps(d, { sha256File: async () => "f".repeat(64) }), lease());
    expect(changed.error?.code).toBe("iso_mismatch");
    expect(existsSync(join(dir, "iso", `${SHA}.iso`))).toBe(false);
    expect(seen.machines).toHaveLength(0);
  });

  it("counts the passphrase prompts of systemd, dracut, cryptsetup and initramfs-tools", () => {
    expect(passphrasePrompts("Please enter passphrase for disk vda3 (luks-1):")).toBe(1);
    expect(
      passphrasePrompts("Enter passphrase for /dev/sda3:\nEnter passphrase for /dev/sda3:"),
    ).toBe(2);
    expect(passphrasePrompts("Please unlock disk cryptroot: ")).toBe(1);
    expect(passphrasePrompts("[  OK  ] Started")).toBe(0);
  });

  it("puts NVMe disks on their own controller with a stable EUI-64", () => {
    const probe = lease();
    const disk = probe.hardware.disks[0];
    if (disk) disk.controller = "nvme";
    const [nvme] = probeDisks(probe, "/x");
    expect(nvme).toMatchObject({ bus: "nvme", eui64: euiOf("RESTOWPROBE0") });
    expect(euiOf("RESTOWPROBE0")).toMatch(/^02[0-9a-f]{14}$/);
  });
});
