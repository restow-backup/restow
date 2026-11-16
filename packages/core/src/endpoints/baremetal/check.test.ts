import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalLayoutJson, layoutSha256 } from "./canonical.js";
import {
  type CheckNode,
  type DumpedFile,
  judgeLayoutCheck,
  type LayoutCheckId,
  type LayoutCheckInput,
  type PlannerOutcome,
  parseCrypttab,
  parseFstab,
  planFactsOf,
  reportString,
  resolveFstabSource,
  StageOneCollector,
  stageOneDumps,
  stageOneWanted,
} from "./check.js";
import { type LinuxLayoutManifest, parseLayoutManifest } from "./manifest.js";
import { planFactsSchema } from "./plan.js";

const TESTDATA = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/", import.meta.url),
);
const fixture = (path: string) =>
  readFileSync(join(TESTDATA, "capture/debian12-uefi-luks-lvm/root", path));

function loadManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(TESTDATA, "manifests", `${name}.json`), "utf8"));
}

/** A manifest as plain JSON the tests change at will. */
// biome-ignore lint/suspicious/noExplicitAny: test fixtures edit deep fields of the JSON directly.
type Json = Record<string, any>;

/** The debian12 manifest as the agent writes it for a whole machine backup. */
function debian(change: (m: Json) => void = () => {}): Json {
  const m = loadManifest("debian12-uefi-luks-lvm") as Json;
  m.backup.sources = ["/", "/boot", "/boot/efi", "/home"];
  change(m);
  return JSON.parse(canonicalLayoutJson(m));
}

function linux(value: unknown): LinuxLayoutManifest {
  const parsed = parseLayoutManifest(value);
  if (!parsed.ok || parsed.manifest.platform !== "linux") throw new Error("not a Linux manifest");
  return parsed.manifest;
}

const fileNode = (size: number): CheckNode => ({
  type: "file",
  size,
  mtime: "2024-11-01T10:00:00Z",
});
const dirNode: CheckNode = { type: "dir", size: 0, mtime: "2024-11-01T10:00:00Z" };
const dumped = (text: string): DumpedFile => ({ bytes: Buffer.from(text), truncated: false });

const plan = (target: string, problems: unknown[] = [], warnings: unknown[] = []): PlannerOutcome =>
  ({
    kind: "plan",
    plan: {
      format: "restow-plan-v1",
      target,
      ok: problems.length === 0,
      problems,
      warnings,
      mapping: [],
      adopted: [],
      minimumSizes: { disks: [], filesystems: [], lvs: [], thinPools: [] },
      disks: [],
      steps: [],
      secureBoot: { checked: false, targetSecureBoot: null, loaders: [] },
      drivers: { kernel: null, fallback: null, storage: [], nics: [] },
    },
  }) as unknown as PlannerOutcome;

const finding = (code: string, severity: "problem" | "warning", params = {}) => ({
  code,
  severity,
  ref: "t0",
  message: code,
  params,
});

/** Everything a green stage 1 of the debian12 machine sees. */
function greenInput(manifest = debian()): LayoutCheckInput {
  const nodes = new Map<string, CheckNode>([
    ["/boot", dirNode],
    ["/boot/efi", dirNode],
    ["/home", dirNode],
    ["/boot/vmlinuz-6.1.0-27-amd64", fileNode(5616)],
    ["/boot/initrd.img-6.1.0-27-amd64", fileNode(384)],
    ["/boot/grub/grub.cfg", fileNode(40)],
    ["/boot/efi/EFI/BOOT/BOOTX64.EFI", fileNode(4112)],
    ["/boot/efi/EFI/BOOT/fbx64.efi", fileNode(2576)],
    ["/boot/efi/EFI/debian/grubx64.efi", fileNode(4080)],
    ["/boot/efi/EFI/debian/shimx64.efi", fileNode(4112)],
    ["/lib/modules/6.1.0-27-amd64/modules.alias", fileNode(100)],
    ["/lib/modules/6.1.0-27-amd64/modules.builtin", fileNode(100)],
    ["/usr/sbin/update-initramfs", fileNode(10)],
    ["/usr/sbin/grub-install", fileNode(10)],
    ["/etc/fstab", fileNode(300)],
    ["/etc/crypttab", fileNode(80)],
    ["/etc/default/keyboard", fileNode(60)],
  ]);
  return {
    manifest,
    layoutSha256: layoutSha256(manifest),
    manifestInSnapshot: { state: "found", sha256: layoutSha256(manifest), bytes: 1000 },
    snapshotPaths: ["/", "/boot", "/boot/efi", "/home"],
    nodes,
    childCounts: new Map([
      ["/", 12],
      ["/boot", 4],
      ["/boot/efi", 1],
      ["/home", 2],
    ]),
    files: new Map([
      ["/etc/fstab", { bytes: fixture("etc/fstab"), truncated: false }],
      ["/etc/crypttab", { bytes: fixture("etc/crypttab"), truncated: false }],
      ["/etc/default/keyboard", { bytes: fixture("etc/default/keyboard"), truncated: false }],
    ]),
    consistency: { method: "lvm", state: "used" },
    restoreSizes: { "/": { bytes: 100, files: 3, inodes: 5 } },
    planner: {
      same: plan("same"),
      minimal: plan("minimal"),
      otherController: plan("other-controller"),
    },
  };
}

function checkOf(result: ReturnType<typeof judgeLayoutCheck>, id: LayoutCheckId) {
  const check = result.checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`no ${id}`);
  return check;
}

const codes = (result: ReturnType<typeof judgeLayoutCheck>, id: LayoutCheckId) =>
  checkOf(result, id).findings.map((f) => `${f.severity}:${f.code}`);

describe("judgeLayoutCheck", () => {
  it("rates a complete snapshot green with every check", () => {
    const result = judgeLayoutCheck(greenInput());
    expect(result.checks.map((check) => `${check.id}:${check.status}`)).toEqual([
      "L1:ok",
      "L2:ok",
      "L3:ok",
      "L4:ok",
      "L5:ok",
      "L6:ok",
      "L7:ok",
      "L8:ok",
    ]);
    expect(result).toMatchObject({ readiness: "green", incomplete: null });
  });

  describe("L1 and L2", () => {
    it("an invalid manifest fails L1 and skips what needs it", () => {
      const input = greenInput();
      const result = judgeLayoutCheck({ ...input, manifest: { format: "restow-layout-v1" } });
      expect(checkOf(result, "L1").status).toBe("failed");
      expect(checkOf(result, "L5").status).toBe("skipped");
      expect(result.readiness).toBe("red");
    });

    it("an unsupported layout fails L2", () => {
      const manifest = debian((m) => {
        m.verdict = "unsupported";
        m.unsupported = [
          { code: "fs_type_unsupported", ref: "f2", message: "zfs", severity: "unsupported" },
        ];
      });
      const result = judgeLayoutCheck(greenInput(manifest));
      expect(codes(result, "L2")).toEqual(["failed:verdict_unsupported"]);
      expect(checkOf(result, "L2").findings[0]?.params).toEqual({ codes: ["fs_type_unsupported"] });
      expect(result.readiness).toBe("red");
    });

    it("a layout supported with warnings passes L2", () => {
      const result = judgeLayoutCheck(
        greenInput(debian((m) => (m.verdict = "supported_with_warnings"))),
      );
      expect(checkOf(result, "L2").status).toBe("ok");
    });
  });

  describe("L3", () => {
    it("a problem on the same or the minimal hardware fails, on another controller it warns", () => {
      const input = greenInput();
      const red = judgeLayoutCheck({
        ...input,
        planner: {
          ...(input.planner as NonNullable<LayoutCheckInput["planner"]>),
          minimal: plan("minimal", [
            finding("target_too_small", "problem", { needBytes: 2, haveBytes: 1 }),
          ]),
        },
      });
      expect(codes(red, "L3")).toEqual(["failed:target_too_small"]);
      expect(checkOf(red, "L3").findings[0]?.params).toEqual({
        target: "minimal",
        needBytes: 2,
        haveBytes: 1,
      });
      expect(red.readiness).toBe("red");

      const other = judgeLayoutCheck({
        ...input,
        planner: {
          ...(input.planner as NonNullable<LayoutCheckInput["planner"]>),
          otherController: plan(
            "other-controller",
            [finding("storage_driver_missing", "problem")],
            [finding("other_controller_driver_missing", "warning", { module: "ahci" })],
          ),
        },
      });
      expect(codes(other, "L3")).toEqual([
        "warning:storage_driver_missing",
        "warning:other_controller_driver_missing",
      ]);
      expect(other.readiness).toBe("green");
    });

    it("a planner that could not answer makes the report yellow", () => {
      const input = greenInput();
      const result = judgeLayoutCheck({
        ...input,
        planner: {
          ...(input.planner as NonNullable<LayoutCheckInput["planner"]>),
          same: { kind: "incomplete", reason: "planner_timeout" },
        },
      });
      expect(result).toMatchObject({ readiness: "yellow", incomplete: "planner_timeout" });
      expect(checkOf(result, "L3").evidence).toMatchObject({
        same: { ran: false, reason: "planner_timeout" },
      });
    });

    it("a planner that refuses a valid manifest fails L3", () => {
      const input = greenInput();
      const result = judgeLayoutCheck({
        ...input,
        planner: {
          ...(input.planner as NonNullable<LayoutCheckInput["planner"]>),
          same: { kind: "refused", error: { code: "manifest_invalid", message: "x" } },
        },
      });
      expect(codes(result, "L3")).toEqual(["failed:planner_refused_valid_manifest"]);
      expect(result).toMatchObject({
        readiness: "red",
        incomplete: "planner_refused_valid_manifest",
      });
    });

    it("an incomplete planner does not hide proof elsewhere", () => {
      const input = greenInput();
      const result = judgeLayoutCheck({
        ...input,
        manifestInSnapshot: { state: "missing" },
        planner: {
          same: { kind: "incomplete", reason: "planner_crashed" },
          minimal: { kind: "incomplete", reason: "planner_crashed" },
          otherController: { kind: "incomplete", reason: "planner_crashed" },
        },
      });
      expect(checkOf(result, "L3").status).toBe("skipped");
      expect(result.readiness).toBe("red");
    });
  });

  describe("L4", () => {
    it("fails when the snapshot's manifest differs or is missing", () => {
      const input = greenInput();
      const mismatch = judgeLayoutCheck({
        ...input,
        manifestInSnapshot: { state: "found", sha256: "f".repeat(64), bytes: 10 },
      });
      expect(codes(mismatch, "L4")).toEqual(["failed:manifest_mismatch"]);
      expect(checkOf(mismatch, "L4").findings[0]?.params).toEqual({
        expected: input.layoutSha256,
        actual: "f".repeat(64),
      });
      const missing = judgeLayoutCheck({ ...input, manifestInSnapshot: { state: "missing" } });
      expect(codes(missing, "L4")).toEqual(["failed:manifest_missing"]);
    });
  });

  describe("L5", () => {
    it("fails for a missing source", () => {
      const input = greenInput();
      const nodes = new Map(input.nodes);
      nodes.delete("/home");
      const childCounts = new Map(input.childCounts);
      childCounts.set("/home", 0);
      const result = judgeLayoutCheck({ ...input, nodes, childCounts });
      expect(codes(result, "L5")).toEqual(["failed:source_missing"]);
      expect(result.readiness).toBe("red");
    });

    it("fails for an empty system source, warns for an empty data source", () => {
      const input = greenInput();
      const empty = (dir: string) =>
        judgeLayoutCheck({ ...input, childCounts: new Map([...input.childCounts, [dir, 0]]) });
      expect(codes(empty("/boot"), "L5")).toEqual(["failed:source_empty"]);
      expect(codes(empty("/home"), "L5")).toEqual(["warning:source_empty"]);
    });

    it("warns when the snapshot's paths differ, an fstab entry is not covered or a system mount is excluded", () => {
      const manifest = debian((m) => {
        m.backup.sources = ["/", "/boot", "/boot/efi"];
        m.backup.excludes = ["/boot"];
      });
      const input = greenInput(manifest);
      const result = judgeLayoutCheck({ ...input, snapshotPaths: ["/tmp/restow-fake-root"] });
      expect(codes(result, "L5").sort()).toEqual([
        "warning:fstab_entry_not_covered",
        "warning:paths_differ",
        // /boot, and the ESP below it.
        "warning:system_mount_excluded",
        "warning:system_mount_excluded",
      ]);
      expect(result.readiness).toBe("green");
    });

    it("an excluded fstab entry is covered", () => {
      const manifest = debian((m) => {
        m.backup.sources = ["/", "/boot", "/boot/efi"];
        m.backup.excludes = ["/home"];
      });
      expect(codes(judgeLayoutCheck(greenInput(manifest)), "L5")).toEqual([]);
    });
  });

  describe("L6", () => {
    const withFile = (input: LayoutCheckInput, path: string, text: string | null) => {
      const files = new Map(input.files);
      const nodes = new Map(input.nodes);
      if (text === null) {
        files.delete(path);
        nodes.delete(path);
      } else {
        files.set(path, dumped(text));
        nodes.set(path, fileNode(text.length));
      }
      return { ...input, files, nodes };
    };
    const without = (input: LayoutCheckInput, ...paths: string[]) => {
      const nodes = new Map(input.nodes);
      for (const path of paths) nodes.delete(path);
      return { ...input, nodes };
    };

    it("fails for an fstab entry that resolves to nothing, warns for one with nofail", () => {
      const input = greenInput();
      const red = judgeLayoutCheck(
        withFile(
          input,
          "/etc/fstab",
          `${fixture("etc/fstab").toString()}UUID=dead-beef /srv ext4 defaults 0 2\n`,
        ),
      );
      expect(codes(red, "L6")).toEqual(["failed:fstab_unresolvable"]);
      expect(checkOf(red, "L6").findings[0]?.params).toMatchObject({
        source: "UUID=dead-beef",
        target: "/srv",
      });
      const nofail = judgeLayoutCheck(
        withFile(
          input,
          "/etc/fstab",
          `${fixture("etc/fstab").toString()}UUID=dead-beef /srv ext4 nofail 0 2\n`,
        ),
      );
      expect(codes(nofail, "L6")).toEqual(["warning:fstab_unresolvable"]);
      // Network and virtual file systems are none of the manifest's business.
      const nfs = judgeLayoutCheck(
        withFile(
          input,
          "/etc/fstab",
          `${fixture("etc/fstab").toString()}nas:/export /mnt nfs defaults 0 0\ntmpfs /tmp tmpfs defaults 0 0\n`,
        ),
      );
      expect(codes(nfs, "L6")).toEqual([]);
    });

    it("fails without the fstab", () => {
      expect(codes(judgeLayoutCheck(withFile(greenInput(), "/etc/fstab", null)), "L6")).toEqual([
        "failed:fstab_missing",
      ]);
    });

    it("fails without the default kernel, warns without its initramfs or with another size", () => {
      const input = greenInput();
      expect(codes(judgeLayoutCheck(without(input, "/boot/vmlinuz-6.1.0-27-amd64")), "L6")).toEqual(
        ["failed:kernel_missing"],
      );
      expect(
        codes(judgeLayoutCheck(without(input, "/boot/initrd.img-6.1.0-27-amd64")), "L6"),
      ).toEqual(["warning:initramfs_missing"]);
      const nodes = new Map(input.nodes);
      nodes.set("/boot/vmlinuz-6.1.0-27-amd64", fileNode(1));
      expect(codes(judgeLayoutCheck({ ...input, nodes }), "L6")).toEqual([
        "warning:kernel_size_mismatch",
      ]);
    });

    it("fails without the loader of an active boot entry; names on the ESP compare without case", () => {
      const input = greenInput();
      expect(
        codes(judgeLayoutCheck(without(input, "/boot/efi/EFI/debian/shimx64.efi")), "L6"),
      ).toEqual(["failed:loader_missing"]);
      const nodes = new Map(input.nodes);
      nodes.delete("/boot/efi/EFI/debian/shimx64.efi");
      nodes.set("/boot/efi/efi/Debian/SHIMX64.EFI", fileNode(4112));
      expect(codes(judgeLayoutCheck({ ...input, nodes }), "L6")).toEqual([]);
    });

    it("fails without the initramfs generator, warns without GRUB's configuration or the module lists", () => {
      const input = greenInput();
      expect(codes(judgeLayoutCheck(without(input, "/usr/sbin/update-initramfs")), "L6")).toEqual([
        "failed:generator_missing",
      ]);
      expect(codes(judgeLayoutCheck(without(input, "/boot/grub/grub.cfg")), "L6")).toEqual([
        "warning:grub_cfg_missing",
      ]);
      expect(
        codes(judgeLayoutCheck(without(input, "/lib/modules/6.1.0-27-amd64/modules.alias")), "L6"),
      ).toEqual(["warning:modules_alias_missing"]);
      // A merged /usr keeps the generator below /usr, the old folder may hold it as well.
      const moved = without(input, "/usr/sbin/update-initramfs");
      (moved.nodes as Map<string, CheckNode>).set("/sbin/update-initramfs", fileNode(10));
      expect(codes(judgeLayoutCheck(moved), "L6")).toEqual([]);
    });

    it("fails without grub-install on BIOS, warns on UEFI", () => {
      const uefi = greenInput();
      expect(codes(judgeLayoutCheck(without(uefi, "/usr/sbin/grub-install")), "L6")).toEqual([
        "warning:bootloader_tool_missing",
      ]);
      const bios = greenInput(
        debian((m) => {
          m.firmware.mode = "bios";
          m.firmware.entries = [];
        }),
      );
      expect(codes(judgeLayoutCheck(without(bios, "/usr/sbin/grub-install")), "L6")).toEqual([
        "failed:bootloader_tool_missing",
      ]);
    });

    it("fails for plain dm-crypt on a device name without PARTUUID, warns with one", () => {
      const manifest = debian((m) => {
        m.disks[0].table.partitions[1].uuid = null;
      });
      const input = greenInput(manifest);
      const crypttab = `${fixture("etc/crypttab").toString()}cswap /dev/nvme0n1p2 /dev/urandom swap,cipher=aes-xts-plain64\n`;
      expect(codes(judgeLayoutCheck(withFile(input, "/etc/crypttab", crypttab)), "L6")).toEqual([
        "failed:crypttab_plain_device_name",
      ]);
      expect(
        codes(judgeLayoutCheck(withFile(greenInput(), "/etc/crypttab", crypttab)), "L6"),
      ).toEqual(["warning:crypttab_plain_device_name"]);
      const stable = `${fixture("etc/crypttab").toString()}cswap PARTUUID=6f2d5e1b-2c3d-4e4f-9a01-b2c3d4e5f607 /dev/urandom swap\n`;
      expect(
        codes(judgeLayoutCheck(withFile(greenInput(), "/etc/crypttab", stable)), "L6"),
      ).toEqual([]);
    });

    it("warns when the keyboard layout in the snapshot is another one", () => {
      const input = withFile(greenInput(), "/etc/default/keyboard", 'XKBLAYOUT="us"\n');
      expect(codes(judgeLayoutCheck(input), "L6")).toEqual(["warning:keymap_mismatch"]);
    });

    it("checks the kernels of BLS entries", () => {
      const manifest = debian((m) => {
        m.bootloader.bls = true;
      });
      const input = withFile(
        greenInput(manifest),
        "/boot/loader/entries/abc-6.1.conf",
        "title Linux\nlinux /vmlinuz-6.1.0-27-amd64\ninitrd /initrd.img-6.1.0-28-amd64\noptions root=/dev/x\n",
      );
      const result = judgeLayoutCheck(input);
      expect(codes(result, "L6")).toEqual(["warning:bls_kernel_missing"]);
      expect(checkOf(result, "L6").findings[0]?.params).toEqual({
        entry: "/boot/loader/entries/abc-6.1.conf",
        path: "/initrd.img-6.1.0-28-amd64",
      });
      // The evidence never holds the entry's lines (its command line).
      expect(JSON.stringify(checkOf(result, "L6"))).not.toContain("root=/dev/x");
    });
  });

  describe("L7 and L8", () => {
    it("warns for a root read live or no consistency report, never fails", () => {
      const input = greenInput();
      const live = judgeLayoutCheck({
        ...input,
        consistency: { method: "lvm", state: "partial", liveFilesystems: ["/"] },
      });
      expect(codes(live, "L7")).toEqual(["warning:consistency_live_root"]);
      expect(live.readiness).toBe("green");
      expect(codes(judgeLayoutCheck({ ...input, consistency: null }), "L7")).toEqual([
        "warning:consistency_missing",
      ]);
    });

    it("L8 records the restore sizes and never fails", () => {
      const result = judgeLayoutCheck(greenInput());
      expect(checkOf(result, "L8")).toMatchObject({
        status: "ok",
        findings: [{ code: "restore_sizes", severity: "info", params: { mounts: 4, bytes: 100 } }],
      });
    });
  });

  it("keeps at most 50 findings per check, failures first, strings cut", () => {
    const input = greenInput();
    const warnings = Array.from({ length: 60 }, (_, i) =>
      finding("nic_driver_missing", "warning", { name: `n${i}${"x".repeat(400)}` }),
    );
    const result = judgeLayoutCheck({
      ...input,
      planner: {
        ...(input.planner as NonNullable<LayoutCheckInput["planner"]>),
        same: plan("same", [finding("target_missing", "problem")], warnings),
      },
    });
    const l3 = checkOf(result, "L3");
    expect(l3.findings).toHaveLength(50);
    expect(l3.findings[0]?.code).toBe("target_missing");
    expect(String(l3.findings[1]?.params.name).length).toBe(300);
  });
});

describe("parseFstab, parseCrypttab", () => {
  it("reads entries, leaves out comments and decodes escapes", () => {
    expect(
      parseFstab(
        "# comment\n\nUUID=1 /  ext4 defaults 0 1\nLABEL=My\\040Disk /mnt/my\\040disk ext4 noauto\n",
      ),
    ).toEqual([
      { source: "UUID=1", target: "/", type: "ext4", options: "defaults", line: 3 },
      { source: "LABEL=My Disk", target: "/mnt/my disk", type: "ext4", options: "noauto", line: 4 },
    ]);
    expect(parseCrypttab("cswap /dev/sda2 /dev/urandom swap\nroot UUID=x none luks\n")).toEqual([
      { name: "cswap", device: "/dev/sda2", keyFile: "/dev/urandom", options: "swap", line: 1 },
      { name: "root", device: "UUID=x", keyFile: "none", options: "luks", line: 2 },
    ]);
  });
});

describe("resolveFstabSource", () => {
  const m = linux(debian());
  it.each([
    ["UUID=8b9c0d1e-2f3a-4b5c-6d7e-8f9a0b1c2d3e", { fs: "f1" }],
    ["UUID=1a2b-3c4d", { fs: "f0" }],
    ["/dev/disk/by-uuid/1A2B-3C4D", { fs: "f0" }],
    ["PARTUUID=6F2D5E1B-2C3D-4E4F-9A01-B2C3D4E5F607", { fs: "f1" }],
    ["PARTLABEL=EFI System Partition", { fs: "f0" }],
    ["/dev/disk/by-partlabel/EFI\\x20System\\x20Partition", { fs: "f0" }],
    ["/dev/nvme0n1p2", { fs: "f1" }],
    ["/dev/mapper/srv01--vg-root", { fs: "f2" }],
    ["/dev/srv01-vg/home", { fs: "f3" }],
    ["/dev/mapper/srv01--vg-swap_1", { swap: 0 }],
    ["UUID=1e2f3a4b-5c6d-7e8f-9a0b-1c2d3e4f5061", { swap: 0 }],
    ["/dev/nvme0n1p3", { fs: null }],
    ["/dev/mapper/nvme0n1p3_crypt", { block: { kind: "luks", id: "c0" } }],
    ["/dev/disk/by-id/nvme-eui.002538b111b2c3d4-part2", { fs: "f1" }],
    ["UUID=nope", null],
    ["/dev/sdz9", null],
  ] as const)("%s", (source, expected) => {
    const resolved = resolveFstabSource(m, source);
    if (expected && "fs" in expected && expected.fs === null) {
      // The LUKS partition carries no file system itself.
      expect(resolved).toEqual({ block: { kind: "partition", disk: "d0", number: 3 } });
      return;
    }
    expect(resolved).toEqual(expected);
  });
});

describe("what stage 1 reads", () => {
  const manifest = debian();
  const m = linux(manifest);

  it("lists kernels, loaders, module lists, generators, tools and configuration", () => {
    const wanted = stageOneWanted(m);
    for (const path of [
      "/var/lib/restow-agent/baremetal/layout.json",
      "/boot/vmlinuz-6.1.0-27-amd64",
      "/boot/initrd.img-6.1.0-27-amd64",
      "/boot/efi/EFI/debian/shimx64.efi",
      "/boot/grub/grub.cfg",
      "/lib/modules/6.1.0-27-amd64/modules.alias",
      "/usr/lib/modules/6.1.0-27-amd64/modules.builtin.modinfo",
      "/usr/sbin/update-initramfs",
      "/sbin/grub-install",
      "/etc/fstab",
      "/etc/default/keyboard",
    ]) {
      expect(wanted.listPaths).toContain(path);
    }
    expect(wanted.countChildren).toEqual(["/", "/boot", "/boot/efi", "/home"]);
    expect(wanted.caseInsensitive).toEqual(["/boot/efi"]);
    expect(wanted.listPrefixes).toContain("/boot");
  });

  it("collects during one walk and plans the dumps", () => {
    const collector = new StageOneCollector(stageOneWanted(m));
    const walk: [string, CheckNode][] = [
      ["/", dirNode],
      ["/etc", dirNode],
      ["/etc/fstab", fileNode(300)],
      ["/etc/crypttab", fileNode(80)],
      ["/home", dirNode],
      ["/home/alice", dirNode],
      ["/boot", dirNode],
      ["/boot/efi", dirNode],
      ["/boot/efi/efi/debian/SHIMX64.EFI", fileNode(4112)],
      ["/boot/loader", dirNode],
      ["/boot/loader/entries", dirNode],
      ["/boot/loader/entries/a.conf", fileNode(10)],
      ["/lib/modules/6.1.0-27-amd64/modules.alias", fileNode(10)],
      ["/usr/share/doc/readme", fileNode(10)],
    ];
    for (const [path, node] of walk) collector.add(path, node);
    expect(collector.childCounts.get("/")).toBe(3);
    expect(collector.childCounts.get("/home")).toBe(1);
    expect(collector.childCounts.get("/boot")).toBe(2);
    expect(collector.nodes.has("/boot/efi/EFI/debian/shimx64.efi")).toBe(true);
    expect(collector.nodes.has("/usr/share/doc/readme")).toBe(false);
    expect(stageOneDumps(m, collector.nodes)).toEqual([
      { path: "/etc/fstab", maxBytes: 1024 * 1024 },
      { path: "/etc/crypttab", maxBytes: 1024 * 1024 },
      { path: "/lib/modules/6.1.0-27-amd64/modules.alias", maxBytes: 8 * 1024 * 1024 },
      { path: "/boot/loader/entries/a.conf", maxBytes: 1024 * 1024 },
    ]);
  });

  it("builds the planner's facts from the dumps", () => {
    const nodes = new Map<string, CheckNode>([
      ["/lib/modules/6.1.0-27-amd64/modules.alias", fileNode(10)],
      ["/usr/lib/modules/6.1.0-27-amd64/modules.builtin.modinfo", fileNode(10)],
    ]);
    const files = new Map<string, DumpedFile>([
      [
        "/lib/modules/6.1.0-27-amd64/modules.alias",
        dumped("alias pci:v*d*sv*sd*bc01sc08i02* nvme\n"),
      ],
      [
        "/usr/lib/modules/6.1.0-27-amd64/modules.builtin.modinfo",
        dumped("ahci.alias=pci:v*d*sv*sd*bc01sc06i01*\0libata.x=y\0"),
      ],
    ]);
    const facts = planFactsOf(m, nodes, files, { "/": { bytes: 1, files: 1, inodes: 1 } });
    expect(planFactsSchema.safeParse(facts).success).toBe(true);
    expect(facts).toEqual({
      format: "restow-plan-facts-v1",
      kernels: [
        {
          version: "6.1.0-27-amd64",
          default: true,
          modulesAlias: "alias pci:v*d*sv*sd*bc01sc08i02* nvme\n",
          modulesBuiltin: "",
          modulesBuiltinModinfo: "ahci.alias=pci:v*d*sv*sd*bc01sc06i01*\nlibata.x=y\n",
        },
      ],
      restoreSizes: { "/": { bytes: 1, files: 1, inodes: 1 } },
      mokFiles: [],
    });
  });
});

describe("reportString", () => {
  it("cuts to 300 characters and replaces control characters", () => {
    expect(reportString("a".repeat(400))).toHaveLength(300);
    expect(reportString("a\u0000b\nc")).toBe("a?b?c");
  });
});
