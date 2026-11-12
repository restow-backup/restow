/**
 * Self-test of the recovery end-to-end driver (run.mjs, cases.mjs, lib/qemu.mjs) without KVM:
 * `node --test scripts/recovery-e2e/run.test.mjs`. The answers file it writes, the case filter,
 * the QEMU command lines, the agent folder with the ISO's line, and the clear stop without KVM.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_CASES, CASES, PROBE_CASES, selectCases } from "./cases.mjs";
import {
  assertKvm,
  diskArgs,
  firmwareArgs,
  fwCfgArgs,
  keysOf,
  machineArgs,
  startMachine,
  waitForSerial,
} from "./lib/qemu.mjs";
import {
  parseArgs as autoactivationArgs,
  cmdline as autoactivationCmdline,
  resultOf as autoactivationResult,
  runScript as autoactivationScript,
  CARRIER_LABEL,
  DISK_SERIAL,
} from "./no-autoactivation.mjs";
import {
  bootPattern,
  buildAnswers,
  factoryCmdline,
  guestInstanceUrl,
  identityOf,
  isFinal,
  labEnv,
  parseArgs,
  probeOutcome,
  testAgentDir,
  versionOfIso,
  withIsoLine,
} from "./run.mjs";

/** The keys of restow-answers-v1 (C-M4-4); the ISO refuses any other. */
const ANSWER_KEYS = new Set([
  "format",
  "instanceUrl",
  "code",
  "caFile",
  "spkiCheck",
  "snapshotId",
  "keymap",
  "language",
  "network",
  "diskMapping",
  "adopt",
  "shrink",
  "passphrase",
  "keyFiles",
  "confirmErase",
  "renameNics",
  "rawLvs",
  "secureBootOff",
  "rebindToken",
  "afterSuccess",
]);

const byId = (id) => CASES.find((item) => item.id === id);

describe("cases", () => {
  it("runs E1, E2 and the boot probes P1 and P2 per pull request and the rest at night", () => {
    assert.deepEqual(
      selectCases("per-pr").map((item) => item.id),
      ["E1", "E2", "P1", "P2"],
    );
    assert.deepEqual(
      selectCases("nightly").map((item) => item.id),
      ["E1b", "E3", "E4", "E5", "E6", "E6b", "E7", "E8", "E9", "E10", "P3"],
    );
    assert.equal(selectCases("all").length, ALL_CASES.length);
    assert.deepEqual(
      selectCases("e7, E2").map((item) => item.id),
      ["E7", "E2"],
    );
    assert.throws(() => selectCases("E11"), /unknown case E11/);
    assert.throws(() => selectCases(","), /unknown case/);
  });

  it("puts the target on another controller than the source wherever the source was virtio", () => {
    for (const id of ["E1", "E2", "E3", "E6b"]) {
      const testCase = byId(id);
      assert.notEqual(testCase.target.disks[0].bus, testCase.source.disks[0].bus, id);
    }
    assert.equal(byId("E6").target.disks[0].sectorSize, 4096);
  });

  it("names a factory script for every factory case that exists", () => {
    const factory = new URL("../../integrations/recovery/test/machines/", import.meta.url);
    for (const testCase of CASES.filter((item) => item.source.kind === "factory")) {
      assert.ok(readFileSync(new URL(testCase.source.script, factory), "utf8").includes("set -eu"));
    }
  });
});

describe("the boot probe cases [VERIFY-009]", () => {
  const probe = (id) => PROBE_CASES.find((item) => item.id === id);
  const latest = (over = {}) => ({
    checkedAt: "2026-11-12T10:00:00.000Z",
    readiness: "green",
    cause: { kind: "booted" },
    notPossible: null,
    emptyDirs: [],
    ...over,
  });
  const at = Date.parse("2026-11-12T09:00:00.000Z");

  it("start from the factory's sources with the switches their scripts read", () => {
    const factory = new URL("../../integrations/recovery/test/machines/", import.meta.url);
    for (const testCase of PROBE_CASES) {
      const script = readFileSync(new URL(testCase.source.script, factory), "utf8");
      for (const name of Object.keys(testCase.source.env ?? {})) {
        assert.ok(script.includes(name), `${testCase.id}: ${testCase.source.script} reads ${name}`);
      }
    }
    assert.equal(probe("P2").source.firmware, "uefi-sb");
    assert.equal(probe("P3").source.disks[0].bus, "nvme");
  });

  it("give the instance the lab only when a probe case runs, with the smallest limit", () => {
    const settings = { token: "t".repeat(64), kvmGid: 993, image: "restow-lab:recovery-e2e" };
    assert.deepEqual(labEnv(selectCases("E1"), settings), {});
    assert.deepEqual(labEnv(selectCases("P1,P3"), settings), {
      RESTOW_LAB_TOKEN: "t".repeat(64),
      RESTOW_LAB_IMAGE: "restow-lab:recovery-e2e",
      RESTOW_LAB_KVM_GID: "993",
      RESTOW_LAB_MAX_RESTORE_GIB: "2.5",
    });
  });

  it("judge by the machine's state and the probe that ended after the request", () => {
    const green = { state: "green", probe: { pending: null, latest: latest() } };
    assert.equal(
      probeOutcome(
        probe("P1"),
        { state: "layout_checked", probe: { pending: "running", latest: null } },
        at,
      ),
      null,
    );
    assert.equal(
      probeOutcome(
        probe("P1"),
        {
          ...green,
          probe: { pending: null, latest: latest({ checkedAt: "2026-11-12T08:00:00.000Z" }) },
        },
        at,
      ),
      null,
    );
    assert.equal(probeOutcome(probe("P1"), green, at).ok, true);
    const incomplete = {
      state: "layout_checked",
      probe: {
        pending: null,
        latest: latest({ readiness: null, cause: { kind: "incomplete", reason: "boot_timeout" } }),
      },
    };
    assert.match(probeOutcome(probe("P1"), incomplete, at).reason, /expected green.*boot_timeout/);
    assert.match(
      probeOutcome(probe("P3"), green, at).reason,
      /not left empty: \/var\/lib\/e2e-bulk/,
    );
    const red = {
      state: "red",
      probe: {
        pending: null,
        latest: latest({
          readiness: "red",
          cause: { kind: "boot_failed", pattern: "emergency_mode" },
        }),
      },
    };
    assert.equal(probeOutcome(probe("P2"), red, at).ok, true);
    assert.equal(probeOutcome(probe("P2"), green, at).ok, false);
    const otherRed = {
      state: "red",
      probe: {
        pending: null,
        latest: latest({
          readiness: "red",
          cause: { kind: "boot_failed", pattern: "kernel_panic" },
        }),
      },
    };
    assert.match(
      probeOutcome(probe("P2"), otherRed, at).reason,
      /expected the pattern emergency_mode/,
    );
  });
});

describe("the answers file", () => {
  const context = {
    instanceUrl: guestInstanceUrl(39443),
    code: "RC-0A1B2-C3D4E-F5G6H-J7K8M-N9P0Q",
    spkiCheck: "ABCD-EFGH-JKMN-PQRS",
    snapshotId: "4f2a9c1d",
  };

  it("holds only the keys of restow-answers-v1 and erases exactly the target disks", () => {
    for (const testCase of CASES) {
      const answers = buildAnswers(testCase, {
        ...context,
        passphrase: "pw",
        rebindToken: "rset_x",
      });
      for (const key of Object.keys(answers))
        assert.ok(ANSWER_KEYS.has(key), `${testCase.id}: ${key}`);
      assert.equal(answers.format, "restow-answers-v1");
      assert.deepEqual(answers.network, { mode: "dhcp" });
      assert.deepEqual(
        answers.confirmErase,
        [
          ...testCase.target.disks.map((disk) =>
            disk.bus === "nvme" ? `eui.${disk.eui64}` : `serial.${disk.serial}`,
          ),
          ...(testCase.eraseAlso ?? []),
        ].sort(),
      );
      if (answers.diskMapping !== "auto") {
        for (const target of Object.values(answers.diskMapping)) {
          assert.ok(answers.confirmErase.includes(target), `${testCase.id}: ${target} is erased`);
        }
      }
    }
  });

  it("keeps the data RAID of E9, wipes its old system disk and leaves the optional keys out", () => {
    const answers = buildAnswers(byId("E9"), context);
    assert.deepEqual(answers.adopt, ["md0"]);
    assert.ok(answers.confirmErase.includes("serial.e2e-src0"));
    assert.equal("passphrase" in answers, false);
    assert.equal("rebindToken" in answers, false);
    assert.equal(answers.spkiCheck, "ABCD-EFGH-JKMN-PQRS");
    assert.equal(buildAnswers(byId("E3"), context).keymap, "de");
  });

  it("derives the disk identities the way the agent does (shared fixture qemu-e2e.json)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const fixture = JSON.parse(
      readFileSync(join(here, "../../agent/internal/recovery/testdata/hw/qemu-e2e.json"), "utf8"),
    );
    const busOf = { nvme: "nvme", sata: "ahci", virtio: "virtio", scsi: "scsi" };
    for (const block of fixture.blocks) {
      const disk = {
        serial: block.serial,
        bus: busOf[block.transport],
        eui64: block.eui64 || undefined,
      };
      assert.equal(identityOf(disk), fixture.expectIdentity[block.kname], block.kname);
    }
    // Every NVMe disk of the cases has an EUI-64 the fixture covers in form, and a mapping
    // names exactly the identity the agent reports.
    for (const testCase of CASES) {
      for (const disk of testCase.target.disks) {
        assert.doesNotThrow(() => identityOf(disk), `${testCase.id}: ${disk.serial}`);
      }
      const mapping = testCase.answers.diskMapping;
      if (mapping && mapping !== "auto") {
        const ids = new Set(testCase.target.disks.map(identityOf));
        for (const target of Object.values(mapping))
          assert.ok(ids.has(target), `${testCase.id}: ${target}`);
      }
    }
    assert.equal(identityOf(byId("E2").target.disks[0]), "eui.525400e2e0000002");
    assert.throws(() => identityOf({ serial: "x", bus: "nvme" }), /eui64/);
  });

  it("reaches the instance through QEMU's host address under a name of its own", () => {
    assert.equal(guestInstanceUrl(39443), "https://restow-e2e.10.0.2.2.nip.io:39443");
  });
});

describe("the QEMU command line", () => {
  it("gives every disk its serial number on its controller, 4Kn where asked", () => {
    const args = diskArgs([
      { serial: "e2e-src0", bus: "virtio", file: "/d/a.qcow2" },
      { serial: "t0", bus: "ahci", file: "/d/b.qcow2" },
      { serial: "t1", bus: "ahci", file: "/d/c.qcow2" },
      {
        serial: "t2",
        bus: "nvme",
        file: "/d/d.qcow2",
        sectorSize: 4096,
        eui64: "525400e2e0000003",
      },
      { serial: "t3", bus: "scsi", file: "/d/e.qcow2", sectorSize: 4096 },
    ]).join(" ");
    assert.match(args, /virtio-blk-pci,drive=disk0,serial=e2e-src0/);
    assert.equal(args.match(/-device ahci,id=ahci0/g)?.length, 1);
    assert.match(args, /ide-hd,drive=disk1,bus=ahci0\.0,serial=t0/);
    assert.match(args, /ide-hd,drive=disk2,bus=ahci0\.1,serial=t1/);
    assert.match(args, /-device nvme,id=nvme3,serial=t2 /);
    assert.match(
      args,
      /nvme-ns,drive=disk3,bus=nvme3,nsid=1,eui64=5932367583574491139,logical_block_size=4096,physical_block_size=4096/,
    );
    assert.throws(() => diskArgs([{ serial: "x", bus: "nvme", file: "x" }]), /eui64/);
    assert.match(args, /scsi-hd,drive=disk4,bus=scsi0\.0,serial=t3,logical_block_size=4096/);
    assert.throws(() => diskArgs([{ serial: "bad serial!", bus: "virtio", file: "x" }]), /serial/);
    assert.throws(
      () => diskArgs([{ serial: "x", bus: "ahci", file: "x", sectorSize: 4096 }]),
      /512-byte/,
    );
    assert.throws(() => diskArgs([{ serial: "x", bus: "floppy", file: "x" }]), /unknown disk bus/);
  });

  it("starts BIOS, UEFI and UEFI with Secure Boot", () => {
    assert.deepEqual(firmwareArgs("bios"), ["-machine", "q35,accel=kvm"]);
    const uefi = firmwareArgs("uefi", "/v.fd").join(" ");
    assert.match(uefi, /OVMF_CODE_4M\.fd/);
    assert.doesNotMatch(uefi, /secboot/);
    const secure = firmwareArgs("uefi-sb", "/v.fd").join(" ");
    assert.match(secure, /smm=on/);
    assert.match(secure, /cfi\.pflash01,property=secure,value=on/);
    assert.match(secure, /OVMF_CODE_4M\.secboot\.fd/);
    assert.match(secure, /file=\/v\.fd/);
    assert.throws(() => firmwareArgs("uefi"), /variable store/);
  });

  it("hands the answers over fw_cfg, the serial console to a file and QMP to a socket", () => {
    assert.deepEqual(fwCfgArgs({ "opt/restow/answers": "/a.json" }), [
      "-fw_cfg",
      "name=opt/restow/answers,file=/a.json",
    ]);
    assert.throws(() => fwCfgArgs({ "etc/restow": "/x" }), /opt\/restow/);
    const args = machineArgs({
      name: "E1-iso",
      firmware: "bios",
      disks: [{ serial: "t0", bus: "ahci", file: "/t0.qcow2" }],
      cdrom: "/iso",
      serialLog: "/serial.log",
      qmpSocket: "/qmp.sock",
      fwCfg: { "opt/restow/answers": "/answers.json" },
    }).join(" ");
    assert.match(args, /-serial file:\/serial\.log/);
    assert.match(args, /-qmp unix:\/qmp\.sock,server=on,wait=off/);
    assert.match(args, /-cpu host/);
    assert.match(args, /ide-cd,drive=cd0,bootindex=0/);
    assert.match(args, /name=opt\/restow\/answers,file=\/answers\.json/);
  });

  it("boots the factory from the ISO's kernel without the recovery program", () => {
    const line = factoryCmdline();
    assert.match(line, /systemd\.mask=restow-recover\.service/);
    assert.match(line, /RESTOWFACTORY/);
    assert.match(line, /systemd\.run_success_action=poweroff/);
    const args = machineArgs({
      name: "f",
      firmware: "bios",
      disks: [],
      serialLog: "/s",
      qmpSocket: "/q",
      kernel: { file: "/k", initrd: "/i", append: line },
    });
    assert.deepEqual(args.slice(args.indexOf("-kernel"), args.indexOf("-kernel") + 6), [
      "-kernel",
      "/k",
      "-initrd",
      "/i",
      "-append",
      line,
    ]);
  });

  it("gives the ISO no boot index when its kernel boots directly (QEMU refuses a second index 0)", () => {
    // QEMU's linuxboot option ROM takes boot index 0 for -kernel; a CD with bootindex=0 next
    // to it stopped QEMU before the first line on the serial console.
    const args = machineArgs({
      name: "na",
      firmware: "bios",
      disks: [{ serial: "restow-na-disk0", bus: "virtio", file: "/d.qcow2" }],
      cdrom: "/iso",
      extraDisks: ["/carrier.iso"],
      serialLog: "/s",
      qmpSocket: "/q",
      kernel: { file: "/k", initrd: "/i", append: "boot=live console=ttyS0,115200n8" },
    });
    assert.ok(args.includes("ide-cd,drive=cd0"), "the ISO stays attached as the live medium");
    assert.equal(
      args.some((arg) => arg.includes("bootindex")),
      false,
    );
    // Booted from the ISO itself, the CD is the first boot device.
    const fromIso = machineArgs({
      name: "iso",
      firmware: "bios",
      disks: [],
      cdrom: "/iso",
      serialLog: "/s",
      qmpSocket: "/q",
    });
    assert.ok(fromIso.includes("ide-cd,drive=cd0,bootindex=0"));
  });

  it("fails the wait at once with QEMU's own words when QEMU ends before the line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "restow-serial-"));
    try {
      const log = join(dir, "s.log");
      writeFileSync(log, "");
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      const machine = startMachine(
        { name: "x", firmware: "bios", disks: [], serialLog: log, qmpSocket: join(dir, "q") },
        () => child,
      );
      child.stderr.emit(
        "data",
        Buffer.from(
          "qemu-system-x86_64: -device ide-cd,drive=cd0,bootindex=0: The bootindex 0 has already been used\n",
        ),
      );
      child.emit("exit", 1);
      const started = Date.now();
      await assert.rejects(
        waitForSerial(log, /NO-AUTOACTIVATION-PREPARED/, {
          timeoutMs: 60_000,
          intervalMs: 10,
          machine,
        }),
        /QEMU ended \(exit code 1\) before .*The bootindex 0 has already been used/,
      );
      assert.ok(Date.now() - started < 5_000, "no wait for the whole timeout");
      // A machine that powers itself off right after the line still counts.
      writeFileSync(log, "...\nNO-AUTOACTIVATION-PREPARED\n");
      const [line] = await waitForSerial(log, /NO-AUTOACTIVATION-PREPARED/, {
        timeoutMs: 1_000,
        intervalMs: 10,
        machine,
      });
      assert.equal(line, "NO-AUTOACTIVATION-PREPARED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("types a passphrase with z, y and - as QMP keys", () => {
    assert.deepEqual(keysOf("zy-Ab\n"), ["z", "y", "minus", "shift-a", "b", "ret"]);
    assert.throws(() => keysOf("ä"), /no QMP key/);
  });

  it("stops with a clear message without KVM", () => {
    const denied = () => {
      const error = new Error("EACCES");
      error.code = "EACCES";
      throw error;
    };
    assert.throws(
      () => assertKvm("/dev/kvm", denied),
      /KVM is not available \(\/dev\/kvm: EACCES\)/,
    );
    assert.doesNotThrow(() => assertKvm("/dev/kvm", () => undefined));
  });
});

describe("the run", () => {
  it("reads its options and refuses what it cannot run", () => {
    const options = parseArgs([
      "--iso",
      "/out/restow-recovery_0.5.0_amd64.iso",
      "--agent-dist",
      "/dist",
      "--cases",
      "E1,E7",
    ]);
    assert.equal(options.version, "0.5.0");
    assert.deepEqual(
      options.selected.map((item) => item.id),
      ["E1", "E7"],
    );
    assert.throws(() => parseArgs(["--agent-dist", "/dist"]), /--iso/);
    assert.throws(() => parseArgs(["--iso", "/x.iso", "--agent-dist", "/d"]), /pass --version/);
    assert.throws(() => parseArgs(["--iso"]), /needs a value/);
    assert.throws(() => parseArgs(["--bogus"]), /unknown option/);
    assert.equal(versionOfIso("restow-recovery_0.5.0-alpha.2_amd64.iso"), "0.5.0-alpha.2");
    assert.equal(parseArgs(["--help"]).help, true);
  });

  it("judges by the API and the marker line", () => {
    assert.ok(isFinal("succeeded") && isFinal("cancelled") && !isFinal("finishing"));
    const pattern = bootPattern("e1-debian12", "a".repeat(64));
    assert.match(`noise\nE2E-BOOT e1-debian12 ${"a".repeat(64)}\n`, pattern);
    assert.doesNotMatch(`E2E-BOOT e1-debian12 ${"b".repeat(64)}`, pattern);
  });

  it("adds the ISO's line once and signs the test agent folder with a key of its own", (t) => {
    const sums = `${"a".repeat(64)}  linux-amd64/restow-agent\n`;
    const once = withIsoLine(sums, "restow-recovery_0.5.0_amd64.iso", "c".repeat(64));
    assert.equal(withIsoLine(once, "restow-recovery_0.5.0_amd64.iso", "c".repeat(64)), once);
    assert.match(once, /^c{64} {2}recovery\/restow-recovery_0\.5\.0_amd64\.iso$/m);
    try {
      execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    } catch (error) {
      if (error.code === "ENOENT") return t.skip("ssh-keygen is not installed");
    }
    const dir = mkdtempSync(join(tmpdir(), "restow-recovery-e2e-"));
    try {
      mkdirSync(join(dir, "dist", "linux-amd64"), { recursive: true });
      writeFileSync(join(dir, "dist", "SHA256SUMS"), sums);
      writeFileSync(join(dir, "restow-recovery_0.5.0_amd64.iso"), "iso");
      const agent = testAgentDir({
        agentDist: join(dir, "dist"),
        iso: join(dir, "restow-recovery_0.5.0_amd64.iso"),
        version: "0.5.0",
        dir: join(dir, "agent"),
      });
      const listed = readFileSync(join(agent, "0.5.0", "SHA256SUMS"), "utf8");
      assert.match(listed, /recovery\/restow-recovery_0\.5\.0_amd64\.iso$/m);
      assert.match(
        readFileSync(join(agent, "0.5.0", "SHA256SUMS.sig"), "utf8"),
        /BEGIN SSH SIGNATURE/,
      );
      assert.match(readFileSync(join(agent, "release-signing.pub"), "utf8"), /^ssh-ed25519 /);
      // The private half is gone: only the signature and the public key stay.
      assert.throws(() => readFileSync(join(agent, "ephemeral-signing-key")));
      assert.ok(readFileSync(join(agent, "install", "linux.sh"), "utf8").length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the factory VM (factoryCmdline)", () => {
  it("makes its mount point before it mounts the factory disk, without the recovery program", () => {
    const line = factoryCmdline();
    assert.match(line, /systemd\.mask=restow-recover\.service/);
    // /run is an empty tmpfs at start; without the mount point the VM powers off at once.
    const mkdir = line.indexOf("mkdir -p /run/restow-factory");
    const mount = line.indexOf("mount -o ro /dev/disk/by-label/RESTOWFACTORY /run/restow-factory");
    assert.ok(mkdir >= 0 && mount > mkdir);
    assert.match(line, /exec sh \/run\/restow-factory\/run\.sh/);
    assert.match(line, /systemd\.run_failure_action=poweroff/);
  });
});

describe("the no auto-activation test of the ISO (no-autoactivation.mjs)", () => {
  it("prepares without the recovery program and checks with a normal start", () => {
    const prepare = autoactivationCmdline("prepare");
    const check = autoactivationCmdline("check");
    assert.match(prepare, /systemd\.mask=restow-recover\.service/);
    assert.doesNotMatch(check, /systemd\.mask/);
    for (const line of [prepare, check]) {
      assert.match(line, /boot=live components noswap nopersistence console=ttyS0/);
      assert.ok(line.includes(`/dev/disk/by-label/${CARRIER_LABEL}`));
      assert.match(line, /systemd\.run_success_action=poweroff/);
    }
    assert.throws(() => autoactivationCmdline("other"), /unknown mode/);
  });

  it("builds an md RAID1 with a VG and swap, stops it again, and runs the check", () => {
    const script = autoactivationScript();
    assert.ok(script.includes(`/dev/disk/by-id/virtio-${DISK_SERIAL}`));
    for (const step of [
      "mdadm --create /dev/md/naauto --run --level=1 --raid-devices=2",
      "vgcreate --devices",
      "lvcreate --devices",
      "mkfs.ext4",
      "mkswap",
      'vgchange --devices "$md" -an naauto',
      'mdadm --stop "$md"',
      "sh /run/restow-check/no-autoactivation.sh",
      'echo "NO-AUTOACTIVATION-RESULT $?"',
    ]) {
      assert.ok(script.includes(step), step);
    }
    // The preparation ends before the check part.
    assert.ok(
      script.indexOf("NO-AUTOACTIVATION-PREPARED") < script.indexOf("no-autoactivation.sh"),
    );
  });

  it("reads the result from the serial console and needs an ISO", () => {
    assert.equal(autoactivationResult("...\nNO-AUTOACTIVATION-RESULT 0\n"), 0);
    assert.equal(autoactivationResult("FAIL: swap is on:\nNO-AUTOACTIVATION-RESULT 1\n"), 1);
    assert.equal(autoactivationResult("kernel panic"), null);
    assert.equal(autoactivationArgs(["--iso", "x.iso"]).iso, "x.iso");
    assert.throws(() => autoactivationArgs([]), /--iso/);
    assert.throws(() => autoactivationArgs(["--iso"]), /needs a value/);
  });
});
