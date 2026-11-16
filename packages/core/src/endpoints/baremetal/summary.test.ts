import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type LinuxLayoutManifest, parseLayoutManifest } from "./manifest.js";
import { keyFilesOf, manifestPathInSnapshot } from "./paths.js";
import { type LayoutStackNode, summarizeLayout } from "./summary.js";

function load(name: string): LinuxLayoutManifest {
  const file = fileURLToPath(
    new URL(
      `../../../../../agent/internal/baremetal/testdata/manifests/${name}.json`,
      import.meta.url,
    ),
  );
  const parsed = parseLayoutManifest(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.ok || parsed.manifest.platform !== "linux")
    throw new Error(`${name} is no Linux layout`);
  return parsed.manifest;
}

function find(nodes: LayoutStackNode[], id: string): LayoutStackNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const below = find(node.children, id);
    if (below) return below;
  }
  return undefined;
}

describe("summarizeLayout", () => {
  const summary = summarizeLayout(load("example-debian12-uefi-luks-lvm"));

  it("shows the disk with what lies on each partition", () => {
    expect(summary.disks).toHaveLength(1);
    expect(summary.disks[0]).toMatchObject({ id: "d0", kname: "nvme0n1", tableType: "gpt" });
    expect(summary.disks[0]?.partitions.map((p) => [p.number, p.content])).toEqual([
      [1, "esp"],
      [2, "filesystem"],
      [3, "luks"],
    ]);
    expect(summary.disks[0]?.partitions[0]?.label).toBe("EFI System Partition");
  });

  it("builds the stack from the disk down to the file systems", () => {
    const luks = find(summary.stack, "luks:c0");
    expect(luks?.kind).toBe("luks");
    expect(find(summary.stack, "partition:d0:3")?.children.map((c) => c.id)).toContain("luks:c0");
    const vg = luks?.children.find((child) => child.kind === "vg");
    expect(vg?.label).toBe("vg0");
    const root = vg?.children.find((child) => child.id === "lv:vg0/root");
    expect(root?.children[0]?.kind).toBe("fs");
    expect(root?.children[0]?.label).toContain("/");
    expect(find(summary.stack, "lv:vg0/swap")?.children[0]?.kind).toBe("swap");
  });

  it("counts encryption, volume groups and mounts", () => {
    expect(summary.encryption).toEqual({ luks: 1, plainCrypt: 0, tokenTypes: [] });
    expect(summary.vgs).toEqual([{ name: "vg0", sizeBytes: 510526783488, freeBytes: 48318382080 }]);
    expect(summary.counts.lvs).toBe(3);
    expect(summary.mounts.map((m) => m.target)).toEqual(["/", "/boot", "/boot/efi", "/home"]);
    expect(summary.firmware.mode).toBe("uefi");
    expect(summary.bootloader.kind).toBe("grub");
  });

  it("writes the keymap as layout:variant", () => {
    const m = load("example-debian12-uefi-luks-lvm");
    m.initramfs.keymap.layout = "de";
    m.initramfs.keymap.variant = "nodeadkeys";
    expect(summarizeLayout(m).initramfs.keymap).toBe("de:nodeadkeys");
    m.initramfs.keymap.variant = null;
    expect(summarizeLayout(m).initramfs.keymap).toBe("de");
    m.initramfs.keymap.layout = null;
    expect(summarizeLayout(m).initramfs.keymap).toBeNull();
  });

  it("summarizes RAID and btrfs subvolumes", () => {
    const raid = summarizeLayout(load("example-bios-mdadm-btrfs"));
    expect(raid.firmware.mode).toBe("bios");
    expect(raid.disks.flatMap((d) => d.partitions.map((p) => p.content))).toContain("md");
    expect(raid.counts.subvolumes).toBeGreaterThan(0);
    expect(JSON.stringify(raid.stack)).toContain('"kind":"subvolume"');
  });
});

describe("paths of a layout", () => {
  it("knows where the manifest lies in a snapshot", () => {
    expect(manifestPathInSnapshot("linux")).toBe("/var/lib/restow-agent/baremetal/layout.json");
    expect(manifestPathInSnapshot("darwin", "/private/var/run/restow-agent/apfs/")).toBe(
      "/private/var/run/restow-agent/apfs/private/var/lib/restow-agent/baremetal/layout.json",
    );
  });

  it("lists the LUKS key files of crypttab, without the random devices and none", () => {
    const m = load("example-debian12-uefi-luks-lvm");
    const base = m.luks[0];
    if (!base) throw new Error("no LUKS volume");
    m.luks = [
      { ...base, id: "c0", keyFile: "/etc/luks-keys/data.key" },
      { ...base, id: "c1", keyFile: "/root//disk.key:UUID=1234" },
      { ...base, id: "c2", keyFile: "none" },
      { ...base, id: "c3", keyFile: "-" },
      { ...base, id: "c4", keyFile: "/dev/urandom" },
      { ...base, id: "c5", keyFile: null },
      { ...base, id: "c6", keyFile: "relative.key" },
      { ...base, id: "c7", keyFile: "/etc/luks-keys/data.key" },
    ];
    expect(keyFilesOf(m)).toEqual(["/etc/luks-keys/data.key", "/root/disk.key"]);
  });
});
