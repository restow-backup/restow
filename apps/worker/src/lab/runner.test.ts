/**
 * One boot probe in the lab (docs/BAREMETAL.md 12.3), with the VMs replaced by scripts of what
 * their serial consoles show: the network is cut once the ISO released its access, the
 * passphrase is typed where a prompt asks, the boot ends at `RESTOW-PROBE-OK`; time limits,
 * a full disk, a changed ISO and a probe the server ended become their outcomes; the probe's
 * folder is always removed and the answers (code, passphrase) never reach the disk.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LabClient, LeasedProbe, ProbePhase } from "./client.js";
import type { Machine } from "./qemu.js";
import { euiOf, probeDisks, runProbe, type Vm, type VmDriver, withoutKeymap } from "./runner.js";
import {
  firstFailure,
  MAX_FINISH_BYTES,
  passphrasePrompts,
  probeFinishOf,
  recoverFailures,
  withoutFinishBlocks,
} from "./serial.js";

const ID = "0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f";

/** A finish block as recover writes it (agent/internal/recovery/probe.go ProbeFinishBlock). */
function finishBlock(
  finish: unknown,
  change: { sha256?: string; length?: number; json?: string } = {},
): string {
  const payload = Buffer.from(change.json ?? JSON.stringify(finish), "utf8");
  const encoded = payload.toString("base64");
  const lines = [
    `RESTOW-PROBE-FINISH-BEGIN ${change.length ?? payload.length} ${change.sha256 ?? createHash("sha256").update(payload).digest("hex")}`,
  ];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  lines.push("RESTOW-PROBE-FINISH-END");
  return `${lines.join("\n")}\n`;
}

const FINISH = {
  status: "succeeded",
  verification: { format: "restow-verify-v1", result: "ok", note: "x".repeat(300) },
  warnings: [{ code: "restore_size_estimated", message: "estimated" }],
  durationSeconds: 42,
};
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
    seen: {
      machines: Machine[];
      disks: unknown[];
      vars: string[];
      answersAtStart: boolean[];
      data: (Record<string, string> | undefined)[];
    },
  ): VmDriver {
    return {
      createDisks: async (disks) => {
        seen.disks.push(...disks);
      },
      createVars: async (file, firmware) => {
        seen.vars.push(firmware);
        await writeFile(file, "vars");
      },
      start: async (machine, _key, fwCfgData) => {
        seen.machines.push(machine);
        seen.data.push(fwCfgData);
        // Whether an answers file (code, passphrase) is anywhere in the probe's folder.
        seen.answersAtStart.push(
          existsSync(join(dir, "probes")) &&
            (await readdir(join(dir, "probes"), { recursive: true })).some((name) =>
              String(name).endsWith("answers.json"),
            ),
        );
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
      data: [] as (Record<string, string> | undefined)[],
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
    // The answers reach QEMU as fw_cfg content through the driver, never as a file.
    expect(seen.answersAtStart).toEqual([false, false]);
    expect(JSON.parse(seen.data[0]?.["opt/restow/answers"] ?? "{}")).toMatchObject({
      code: "SECRET-CODE",
      passphrase: "pass-WORD_1",
    });
    expect(seen.data[1]).toBeUndefined();
    expect(first?.fwCfg).toBeUndefined();
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
      data: [] as (Record<string, string> | undefined)[],
    };
    const result = await runProbe(deps(driver([restore.vm, boot.vm], seen)), lease());
    expect(result.outcome).toBe("boot_timeout");
    expect(boot.record.keys).toEqual(["pass-WORD_1\n"]);
    expect(result.bootMs).toBeGreaterThanOrEqual(50_000);
  });

  it("keeps a picture of the boot screen of a start that did not finish, when asked to", async () => {
    const restore = scriptedVm(["RESTOW-PROBE phase=released"], { exitOnCut: true });
    const boot = scriptedVm([""]);
    const pictures: string[] = [];
    boot.vm.screendump = async (file) => {
      pictures.push(file);
    };
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
      data: [] as (Record<string, string> | undefined)[],
    };
    const screenDir = join(dir, "screens");
    const result = await runProbe(
      { ...deps(driver([restore.vm, boot.vm], seen)), screenDir },
      lease(),
    );
    expect(result.outcome).toBe("boot_timeout");
    expect(pictures).toEqual([join(screenDir, `${lease().id}-boot.ppm`)]);
    expect(existsSync(screenDir)).toBe(true);
  });

  it("ends as a stopped restore when the ISO does not release, or runs out of time", async () => {
    const quiet = scriptedVm(["plan refused"], { exitAfter: 2 });
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
      data: [] as (Record<string, string> | undefined)[],
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

  it("stops the restore after three failed attempts of recover and logs the first one", async () => {
    const attempt = (why: string) =>
      `Restow Recovery 0.5.0\n$ loadkeys -\nrecover: ${why}\nRESTOW-RECOVER-RESULT failed\n`;
    const first = attempt("instance(): TLS check failed");
    const spent = attempt("HTTP 409 Recovery code used");
    const failing = scriptedVm([first, first + spent, first + spent + spent]);
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
      data: [] as (Record<string, string> | undefined)[],
    };
    const result = await runProbe(
      {
        ...deps(driver([failing.vm], seen)),
        log: (message: string, fields?: Record<string, unknown>) => lines.push({ message, fields }),
      },
      lease({ timeouts: { totalMs: 10 * 60_000, bootMs: 1 } }),
    );
    expect(result).toMatchObject({ outcome: "restore_stopped", error: { code: "recover_failed" } });
    expect(failing.record.killed).toBeGreaterThanOrEqual(1);
    const logged = lines.find((line) => line.message === "recover failed in the restore VM");
    expect(String(logged?.fields?.serial)).toContain("TLS check failed");
    expect(String(logged?.fields?.serial)).not.toContain("Recovery code used");
    expect(firstFailure("a\nRESTOW-RECOVER-RESULT failed\nb")).toBe(
      "a\nRESTOW-RECOVER-RESULT failed",
    );
    expect(recoverFailures(first + spent)).toBe(2);
  });

  it("refuses the probe when QEMU of the restore VM runs without no_new_privs", async () => {
    const unsafe = scriptedVm(["restoring"]);
    unsafe.vm.noNewPrivs = () => false;
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
      data: [] as (Record<string, string> | undefined)[],
    };
    const result = await runProbe(deps(driver([unsafe.vm], seen)), lease());
    expect(result).toMatchObject({ outcome: "lab_error", error: { code: "sandbox_unsafe" } });
    expect(unsafe.record.killed).toBe(1);
  });

  it("stops when the server ended the probe", async () => {
    go = false;
    const endless = scriptedVm(["restoring"]);
    const seen = {
      machines: [] as Machine[],
      disks: [] as unknown[],
      vars: [] as string[],
      answersAtStart: [] as boolean[],
      data: [] as (Record<string, string> | undefined)[],
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
      data: [] as (Record<string, string> | undefined)[],
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

describe("the finish recover relays over the console", () => {
  it("takes the last complete block whose length and SHA-256 match, and nothing else", () => {
    const block = finishBlock(FINISH);
    expect(block.split("\n").every((line) => line.length <= 76 || line.startsWith("RESTOW"))).toBe(
      true,
    );
    expect(block.split("\n").length).toBeGreaterThan(5);
    const valid = probeFinishOf(`recover: step 9\r\n${block}The recovery is complete.\n`);
    expect(valid).toMatchObject({ ok: true, finish: FINISH });
    // The last block wins, also over an earlier valid one; one cut short after it does not count.
    const later = { ...FINISH, status: "failed", warnings: [] };
    expect(probeFinishOf(block + finishBlock(later))).toMatchObject({ ok: true, finish: later });
    const cut = finishBlock(later).split("\n").slice(0, 3).join("\n");
    expect(probeFinishOf(block + cut)).toMatchObject({ ok: true, finish: FINISH });

    expect(probeFinishOf("RESTOW-PROBE phase=released\n")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(probeFinishOf(cut)).toEqual({ ok: false, reason: "incomplete" });
    expect(probeFinishOf(finishBlock(FINISH, { sha256: "0".repeat(64) }))).toEqual({
      ok: false,
      reason: "mismatch",
    });
    // A wrong length: the base64 does not fit it.
    expect(probeFinishOf(finishBlock(FINISH, { length: 10 })).ok).toBe(false);
    const big = { ...FINISH, verification: { note: "y".repeat(MAX_FINISH_BYTES) } };
    expect(probeFinishOf(finishBlock(big))).toEqual({ ok: false, reason: "too_large" });
    expect(probeFinishOf(finishBlock(null, { json: "[1,2]" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(probeFinishOf(finishBlock(null, { json: "{not json" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    // A changed character in the body.
    const tampered = block.replace(
      /\n([A-Za-z0-9+/])/,
      (_m, c: string) => `\n${c === "A" ? "B" : "A"}`,
    );
    expect(probeFinishOf(tampered).ok).toBe(false);
  });

  it("leaves the base64 out of the console the worker keeps", () => {
    const text = `before\n${finishBlock(FINISH)}after\n`;
    const kept = withoutFinishBlocks(text);
    expect(kept).toContain("before");
    expect(kept).toContain("after");
    expect(kept).toMatch(/RESTOW-PROBE-FINISH-BEGIN \d+ [0-9a-f]{64} \(relayed/);
    expect(kept).not.toContain(Buffer.from(JSON.stringify(FINISH)).toString("base64").slice(0, 40));
    // A block cut short ends at the first line that is no base64.
    const cut = finishBlock(FINISH).split("\n").slice(0, 3).join("\n");
    expect(withoutFinishBlocks(`${cut}\nRESTOW-RECOVER-RESULT succeeded`)).toContain(
      "RESTOW-RECOVER-RESULT succeeded",
    );
  });

  it("hands the finish and the end of the restore console to the worker after the release", async () => {
    const dir = await mkdtemp(join(tmpdir(), "restow-lab-"));
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const run = async (restoreConsole: string) => {
      const restore = scriptedVm(["restoring", restoreConsole], { exitOnCut: true });
      const boot = scriptedVm(["RESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0\n"]);
      const vms = [restore.vm, boot.vm];
      const d: VmDriver = {
        createDisks: async () => {},
        createVars: async (file) => {
          await writeFile(file, "vars");
        },
        start: async () => vms.shift() as Vm,
      };
      return runProbe(
        {
          client: {
            next: async () => ({ probe: null, reason: "none" }),
            event: async () => ({ go: true }),
            result: async () => {},
            downloadIso: async (_sha, file) => {
              await writeFile(file, "ISO");
            },
          },
          driver: d,
          dir,
          labVersion: "0.5.0",
          kvm: true,
          tlsUpstream: "127.0.0.1:1",
          pollMs: 1,
          now: (() => {
            let clock = 0;
            return () => (clock += 1000);
          })(),
          freeBytes: async () => 100 * 1024 ** 3,
          sha256File: async () => SHA,
          log: (message: string, fields?: Record<string, unknown>) =>
            lines.push({ message, fields }),
        },
        lease(),
      );
    };
    try {
      const released = "RESTOW-PROBE phase=released\n";
      const keymap = "2026-11-14T22:31:50Z   keycode 71 = KP_7 KP_7 Hex_7 KP_7 Ascii_7\n";
      const good = await run(
        `${released}${keymap}grub-install: done\n${finishBlock(FINISH)}RESTOW-RECOVER-RESULT succeeded\n`,
      );
      expect(good.outcome).toBe("booted");
      expect(good.recoveryFinish).toEqual(FINISH);
      expect(good.restoreSerial).toContain("grub-install: done");
      expect(good.restoreSerial).toContain("RESTOW-RECOVER-RESULT succeeded");
      expect(good.restoreSerial).not.toContain("keycode 71");
      expect(good.restoreSerial).not.toContain(
        Buffer.from(JSON.stringify(FINISH)).toString("base64").slice(0, 40),
      );

      const broken = await run(
        `${released}${finishBlock(FINISH, { sha256: "0".repeat(64) })}RESTOW-RECOVER-RESULT succeeded\n`,
      );
      expect(broken.outcome).toBe("booted");
      expect(broken).not.toHaveProperty("recoveryFinish");
      expect(broken.restoreSerial).toContain("RESTOW-RECOVER-RESULT succeeded");
      expect(lines).toContainEqual({
        message: "the restore console holds no usable finish",
        fields: { probeId: ID, reason: "mismatch" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withoutKeymap", () => {
  it("drops the keymap recover logged at every start and keeps its messages", () => {
    const console = [
      "roll_Lock Scroll_Lock Show_Registers Scroll_Lock",
      "2026-11-14T22:31:50Z $ loadkeys -",
      "2026-11-14T22:31:50Z   keycode 71 = KP_7 KP_7 Hex_7 KP_7 Ascii_7",
      "2026-11-14T22:31:50Z   keycode 72 = KP_8 KP_8",
      "Scroll_Lock Scroll_Lock Show_Memory Show_State",
      "2026-11-14T22:31:51Z instance: TLS check failed: tls_untrusted",
    ].join("\n");
    expect(withoutKeymap(console)).toBe(
      [
        "2026-11-14T22:31:50Z $ loadkeys -",
        "2026-11-14T22:31:51Z instance: TLS check failed: tls_untrusted",
      ].join("\n"),
    );
  });
});
