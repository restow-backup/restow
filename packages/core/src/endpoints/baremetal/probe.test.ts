import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LinuxLayoutManifest } from "./manifest.js";
import {
  bootProbeDue,
  classifyProbeSerial,
  judgeBootProbe,
  type LabResult,
  labPresent,
  labResultSchema,
  PROBE_INTERVAL_MS,
  PROBE_RETRY_MS,
  PROBE_VALID_MS,
  ProbeFolderCounter,
  type ProbeRecoveryFacts,
  type ProbeReportFacts,
  probeAnswers,
  probeEmptyAllowed,
  probeHardware,
  probeNotPossible,
  probeRating,
  probeSelection,
  probeSystemMounts,
} from "./probe.js";

const TESTDATA = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/manifests/", import.meta.url),
);
function manifest(name: string): LinuxLayoutManifest {
  return JSON.parse(readFileSync(join(TESTDATA, `${name}.json`), "utf8")) as LinuxLayoutManifest;
}
const GIB = 1024 ** 3;
const size = (gib: number) => ({ bytes: gib * GIB, files: 10, inodes: 20 });
const NOW = new Date("2026-11-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 3_600_000;

describe("what a boot probe restores (docs/BAREMETAL.md 12.3)", () => {
  const debian = manifest("debian12-uefi-luks-lvm");

  it("restores /, /boot, the ESP, /usr and /var in full and creates the other file systems empty", () => {
    expect(probeSystemMounts(debian)).toEqual(["/", "/boot", "/boot/efi", "/usr", "/var"]);
    const selection = probeSelection({
      manifest: debian,
      restoreSizes: {
        "/": size(9),
        "/boot": size(0.2),
        "/boot/efi": size(0.01),
        "/home": size(400),
      },
      folderSizes: {},
      maxBytes: 64 * GIB,
    });
    expect(selection).toMatchObject({
      possible: true,
      fullRestore: ["/", "/boot", "/boot/efi"],
      emptyFilesystems: ["/home"],
      emptyDirs: [],
    });
  });

  it("leaves the largest data folders empty above the limit, never the package or systemd databases", () => {
    const selection = probeSelection({
      manifest: debian,
      restoreSizes: { "/": size(90), "/boot": size(0.2), "/boot/efi": size(0.01) },
      folderSizes: {
        "/var/lib/postgresql": 50 * GIB,
        "/var/lib/dpkg": 30 * GIB,
        "/srv/www": 10 * GIB,
        "/var/lib/docker": 5 * GIB,
      },
      maxBytes: 64 * GIB,
    });
    expect(selection.possible).toBe(true);
    if (!selection.possible) return;
    expect(selection.emptyDirs).toEqual(["/var/lib/postgresql"]);
    expect(selection.restoreBytes).toBeLessThanOrEqual(64 * GIB);
    // Even when that is not enough: the package database is no candidate.
    const tooLarge = probeSelection({
      manifest: debian,
      restoreSizes: { "/": size(100), "/boot": size(0.2) },
      folderSizes: { "/var/lib/dpkg": 80 * GIB },
      maxBytes: 64 * GIB,
    });
    expect(tooLarge).toMatchObject({ possible: false, reason: "too_large" });
  });

  it("never leaves a system path, a protected folder or anything outside the roots empty", () => {
    const system = probeSystemMounts(debian);
    for (const path of [
      "/",
      "/boot",
      "/usr",
      "/var",
      "/var/lib",
      "/var/lib/systemd",
      "/var/lib/dpkg/info",
      "/boot/efi",
      "relative",
      "/home/../etc",
    ]) {
      expect(probeEmptyAllowed(path, system), path).toBe(false);
    }
    for (const path of ["/home", "/var/lib/postgresql", "/srv/data"]) {
      expect(probeEmptyAllowed(path, system), path).toBe(true);
    }
  });

  it("counts the folders of the roots from the snapshot walk, largest first", () => {
    const counter = new ProbeFolderCounter();
    counter.add({ path: "/var/lib/postgresql/16/main/base", type: "file", size: 3000 });
    counter.add({ path: "/var/lib/postgresql/16/x", type: "file", size: 1000 });
    counter.add({ path: "/srv/www/index.html", type: "file", size: 10 });
    counter.add({ path: "/srv/top-level-file", type: "file", size: 99 });
    counter.add({ path: "/home/anna", type: "dir", size: null });
    counter.add({ path: "/etc/hosts", type: "file", size: 5 });
    expect(counter.result()).toEqual({ "/var/lib/postgresql": 4000, "/srv/www": 10 });
  });
});

describe("the hardware of a boot probe (12.3)", () => {
  it("swaps the disk controller and the network card, keeps sizes, sectors and Secure Boot", () => {
    const debian = manifest("debian12-uefi-luks-lvm");
    expect(probeHardware(debian)).toEqual({
      firmware: "uefi-sb",
      disks: [
        {
          id: "d0",
          sizeBytes: 512110190592,
          logicalSectorSize: 512,
          controller: "sata",
          serial: "RESTOWPROBE0",
        },
      ],
      nic: "virtio-net",
      memoryMiB: 4096,
      cpus: 2,
    });
    const bios = manifest("bios-mbr-mdadm-raid1");
    const hw = probeHardware(bios);
    expect(hw.firmware).toBe("bios");
    expect(hw.disks.length).toBeGreaterThanOrEqual(2);
    for (const disk of hw.disks) {
      const source = bios.disks.find((d) => d.id === disk.id);
      expect(disk.controller).toBe(source?.transport === "nvme" ? "sata" : "nvme");
    }
  });

  it("probes no system without systemd", () => {
    const debian = manifest("debian12-uefi-luks-lvm");
    expect(probeNotPossible(debian)).toBeNull();
    expect(probeNotPossible({ ...debian, os: { ...debian.os, init: "other" } })).toBe(
      "not_systemd",
    );
  });

  it("writes the answers of an unattended recovery with the probe block", () => {
    const debian = manifest("debian12-uefi-luks-lvm");
    const hardware = probeHardware(debian);
    const answers = probeAnswers({
      origin: "https://restow.example.com",
      code: "ABCD-EFGH",
      spkiCheck: "AAAA-BBBB-CCCC-DDDD",
      snapshotId: "a".repeat(64),
      hardware,
      selection: {
        possible: true,
        fullRestore: ["/", "/boot"],
        emptyFilesystems: ["/home"],
        emptyDirs: [],
        restoreBytes: 1,
      },
      passphrase: "secret",
    });
    expect(answers).toMatchObject({
      format: "restow-answers-v1",
      diskMapping: { d0: "serial.RESTOWPROBE0" },
      confirmErase: ["serial.RESTOWPROBE0"],
      network: { mode: "dhcp", proxy: "http://10.0.2.100:3128" },
      afterSuccess: "poweroff",
      probe: { fullRestore: ["/", "/boot"], emptyFilesystems: ["/home"], emptyDirs: [] },
    });
    expect(answers).not.toHaveProperty("rebindToken");
  });
});

describe("the serial console of the restored system", () => {
  it("finds the line of restow-probe.service", () => {
    expect(
      classifyProbeSerial(
        "[  OK  ] Reached target multi-user.target\r\nRESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0-27-amd64\r\n",
      ),
    ).toEqual({
      outcome: "ok",
      bootId: "0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f",
      kernel: "6.1.0-27-amd64",
      line: "RESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0-27-amd64",
    });
  });

  it.each([
    ["[    2.1] Kernel panic - not syncing: VFS: Unable to mount root fs", "kernel_panic"],
    ["Gave up waiting for root file system device.  Common problems:", "root_not_found"],
    ["ALERT!  UUID=1234 does not exist.  Dropping to a shell!", "root_not_found"],
    ['You are in emergency mode. After logging in, type "journalctl -xb"', "emergency_mode"],
    ["Verification failed: (0x1A) Security Violation", "secure_boot_refused"],
    [
      'BdsDxe: failed to load Boot0001 "debian" from HD(1,GPT,...): Access Denied',
      "secure_boot_refused",
    ],
    ["BdsDxe: No bootable option or device was found.", "no_bootable_device"],
  ])("recognises %s", (line, pattern) => {
    expect(classifyProbeSerial(`noise\n${line}\nmore`)).toMatchObject({
      outcome: "failed",
      pattern,
    });
  });

  it("finds nothing in an ordinary boot without the marker", () => {
    expect(classifyProbeSerial("[  OK  ] Started systemd-journald.service\n")).toEqual({
      outcome: "none",
    });
  });
});

const lab = (change: Partial<LabResult> = {}): LabResult =>
  labResultSchema.parse({
    outcome: "booted",
    bootSerial: "RESTOW-PROBE-OK 0f6c1a1c-4c6f-4bd4-9d0d-1a2b3c4d5e6f 6.1.0-27-amd64\n",
    kvm: true,
    firmware: "uefi-sb",
    controllers: ["sata"],
    ...change,
  });
const recovery = (change: Partial<ProbeRecoveryFacts> = {}): ProbeRecoveryFacts => ({
  status: "succeeded",
  verification: {
    format: "restow-verify-v1",
    result: "ok",
    snapshotId: "a".repeat(64),
    planSha256: "b".repeat(64),
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    restoreErrors: 0,
    checks: [{ id: "fstab", result: "ok", findings: [], evidence: {} }],
    hints: [],
    fixups: [],
    notAdaptedKernels: [],
  },
  warnings: [],
  ...change,
});

describe("the rating of a boot probe [VERIFY-009]", () => {
  it("is green only with a successful, verified recovery and the marker of the restored system", () => {
    expect(judgeBootProbe(recovery(), lab()).readiness).toBe("green");
    // No marker: proves nothing.
    expect(judgeBootProbe(recovery(), lab({ bootSerial: "booting..." })).readiness).toBeNull();
    // A recovery that did not succeed: never green, whatever the console says.
    expect(judgeBootProbe(recovery({ status: "cancelled" }), lab()).readiness).toBeNull();
    expect(judgeBootProbe(null, lab()).readiness).toBeNull();
    // Without a verification report the success is not borne out.
    expect(judgeBootProbe(recovery({ verification: null }), lab()).readiness).toBeNull();
  });

  it("is red only with evidence: a failure pattern of the boot, a failed verification, a problem of the backup", () => {
    expect(
      judgeBootProbe(
        recovery(),
        lab({ outcome: "boot_timeout", bootSerial: "You are in emergency mode." }),
      ),
    ).toEqual({
      readiness: "red",
      cause: { kind: "boot_failed", pattern: "emergency_mode", line: "You are in emergency mode." },
    });
    const failedVerification = recovery({ status: "failed" });
    if (failedVerification.verification) {
      failedVerification.verification.result = "failed";
      failedVerification.verification.checks = [
        { id: "fstab", result: "failed", findings: [], evidence: {} },
      ];
    }
    expect(judgeBootProbe(failedVerification, lab({ outcome: "lab_error" }))).toEqual({
      readiness: "red",
      cause: { kind: "verification_failed", checks: ["fstab"] },
    });
    expect(
      judgeBootProbe(
        recovery({
          status: "failed",
          verification: null,
          warnings: [{ code: "secure_boot_revoked", message: "" }],
        }),
        lab({ outcome: "lab_error" }),
      ).readiness,
    ).toBe("red");
  });

  it("proves nothing on a lab error, a time limit without a pattern or a failure of the transport", () => {
    expect(
      judgeBootProbe(recovery(), lab({ outcome: "lab_error", bootSerial: "" })).readiness,
    ).toBeNull();
    expect(
      judgeBootProbe(recovery(), lab({ outcome: "boot_timeout", bootSerial: "..." })).readiness,
    ).toBeNull();
    expect(
      judgeBootProbe(
        recovery({
          status: "failed",
          verification: null,
          warnings: [{ code: "access_expired", message: "" }],
        }),
        lab(),
      ).readiness,
    ).toBeNull();
  });
});

const probe = (
  readiness: ProbeReportFacts["readiness"],
  age: number,
  fp = "L",
): ProbeReportFacts => ({
  readiness,
  layoutFingerprint: fp,
  bootChainFingerprint: fp === "L" ? "B" : `${fp}B`,
  checkedAt: ago(age),
});

describe("when a machine is probed (12.3)", () => {
  const due = (probes: ProbeReportFacts[], requested = false) =>
    bootProbeDue({
      layoutFingerprint: "L",
      bootChainFingerprint: "B",
      probes,
      requested,
      now: NOW,
    });

  it("at once for new fingerprints, weekly after that, six hours after a probe that proved nothing", () => {
    expect(due([])).toEqual({ due: true, reason: "fingerprint_changed" });
    expect(due([probe("green", DAY, "OLD")])).toEqual({ due: true, reason: "fingerprint_changed" });
    expect(due([probe("green", DAY)])).toEqual({ due: false });
    expect(due([probe("green", PROBE_INTERVAL_MS)])).toEqual({ due: true, reason: "weekly" });
    expect(due([probe("red", 2 * DAY)])).toEqual({ due: false });
    expect(due([probe(null, PROBE_RETRY_MS - 1)])).toEqual({ due: false });
    expect(due([probe(null, PROBE_RETRY_MS)])).toEqual({ due: true, reason: "retry" });
    expect(due([probe("green", DAY)], true)).toEqual({ due: true, reason: "requested" });
    // Not possible for these fingerprints: only new ones (or a request) bring a probe.
    expect(due([{ ...probe(null, 30 * DAY), notPossible: "too_large" }])).toEqual({ due: false });
    expect(
      probeRating(
        {
          probes: [{ ...probe(null, DAY), notPossible: "too_large" }],
          notPossible: null,
          lab: { present: true, kvm: true },
          pending: null,
        },
        NOW,
      ),
    ).toEqual({ state: "layout_checked", reason: "too_large" });
  });
});

describe("the bare metal rating with the boot probe [READY-014]", () => {
  const facts = (probes: ProbeReportFacts[]) => ({
    probes,
    notPossible: null,
    lab: { present: true, kvm: true },
    pending: null,
  });

  it("is green with a green probe of these fingerprints at most 8 days old, overdue after, red with a red one", () => {
    expect(probeRating(facts([probe("green", DAY)]), NOW)).toEqual({
      state: "green",
      checkedAt: ago(DAY),
    });
    expect(probeRating(facts([probe("green", PROBE_VALID_MS + 1)]), NOW).state).toBe("overdue");
    expect(probeRating(facts([probe("red", DAY), probe("green", 2 * DAY)]), NOW).state).toBe("red");
    // A probe that proved nothing does not hide the last rated one.
    expect(probeRating(facts([probe(null, 1), probe("green", DAY)]), NOW).state).toBe("green");
  });
});

describe("no green without the lab [READY-015]", () => {
  it("names why a machine with a green stage 1 is only layout checked", () => {
    const base = { probes: [], notPossible: null, pending: null };
    expect(probeRating({ ...base, lab: { present: false, kvm: false } }, NOW)).toEqual({
      state: "layout_checked",
      reason: "no_lab",
    });
    expect(probeRating({ ...base, lab: { present: true, kvm: false } }, NOW)).toEqual({
      state: "layout_checked",
      reason: "no_kvm",
    });
    expect(
      probeRating({ ...base, lab: { present: true, kvm: true }, pending: "running" }, NOW),
    ).toEqual({
      state: "layout_checked",
      reason: "running",
    });
    expect(
      probeRating({ ...base, lab: { present: true, kvm: true }, notPossible: "not_systemd" }, NOW),
    ).toEqual({ state: "layout_checked", reason: "not_systemd" });
  });

  it("counts a lab as present for ten minutes after it last asked for work", () => {
    expect(labPresent(null, NOW)).toEqual({ present: false, kvm: false });
    expect(labPresent({ seenAt: ago(60_000).toISOString(), kvm: true }, NOW)).toEqual({
      present: true,
      kvm: true,
    });
    expect(labPresent({ seenAt: ago(11 * 60_000).toISOString(), kvm: true }, NOW)).toEqual({
      present: false,
      kvm: false,
    });
  });
});
