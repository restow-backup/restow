import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HARDWARE_RAID_DRIVERS, RECOVERY_RAM_MIN_BYTES, replacementHardware } from "./hardware.js";
import { type LinuxLayoutManifest, parseLayoutManifest } from "./manifest.js";

const MANIFESTS = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/manifests/", import.meta.url),
);

function manifest(name: string): LinuxLayoutManifest {
  const parsed = parseLayoutManifest(JSON.parse(readFileSync(`${MANIFESTS}${name}.json`, "utf8")));
  if (!parsed.ok || parsed.manifest.platform !== "linux") throw new Error(`${name} does not parse`);
  return parsed.manifest;
}

describe("replacementHardware", () => {
  it("names firmware, the CA of the first stage, disks with minimum sizes and the keymap", () => {
    const hardware = replacementHardware(manifest("debian12-uefi-luks-lvm"), {
      minimumSizes: { disks: [{ disk: "d0", minBytes: 115964116992 }] },
      planner: {
        otherController: {
          ok: true,
          storage: [
            { module: "ahci", found: true, builtin: false },
            { module: "virtio_blk", found: false, builtin: false },
            { module: "nvme", found: false, builtin: true },
          ],
        },
      },
    });
    expect(hardware.firmwareMode).toBe("uefi");
    expect(hardware.secureBoot).toBe(true);
    // shim and its fallback copy are signed by the 3rd party CA; GRUB's Debian CA is shim's.
    expect(hardware.requiredCAs).toEqual(["CN=Microsoft Corporation UEFI CA 2011,O=Restow Test"]);
    expect(hardware.disks).toEqual([
      expect.objectContaining({ id: "d0", minBytes: 115964116992, transport: "nvme" }),
    ]);
    expect(hardware.keymap).toEqual({
      layout: "de",
      variant: "nodeadkeys",
      inInitramfs: false,
      grubCryptodisk: false,
    });
    expect(hardware.luksVolumes).toBe(1);
    expect(hardware.tpm).toBe(false);
    expect(hardware.storageDriversOtherController).toEqual([
      { module: "ahci", ok: true },
      { module: "nvme", ok: true },
      { module: "virtio_blk", ok: false },
    ]);
    expect(hardware.biosNeedsCsm).toBe(false);
    expect(hardware.ramMinBytes).toBe(RECOVERY_RAM_MIN_BYTES);
  });

  it("asks for CSM on a BIOS machine and reads no drivers from a report before M4", () => {
    const hardware = replacementHardware(manifest("bios-mbr-mdadm-raid1"), {
      minimumSizes: null,
      planner: { otherController: { ok: true, problems: [], warnings: [] } },
    });
    expect(hardware.biosNeedsCsm).toBe(true);
    expect(hardware.requiredCAs).toEqual([]);
    expect(hardware.disks.map((disk) => [disk.id, disk.minBytes])).toEqual([
      ["d0", null],
      ["d1", null],
    ]);
    expect(hardware.storageDriversOtherController).toEqual([]);
    expect(replacementHardware(manifest("bios-mbr-mdadm-raid1"), null).disks).toHaveLength(2);
  });

  it("flags disks behind a hardware RAID controller and TPM tokens", () => {
    const base = manifest("debian12-uefi-luks-lvm");
    const raid: LinuxLayoutManifest = {
      ...base,
      disks: base.disks.map((disk) => ({ ...disk, driverChain: ["sd", "megaraid_sas"] })),
      luks: base.luks.map((volume) => ({ ...volume, tokenTypes: ["systemd-tpm2"] })),
    };
    const hardware = replacementHardware(raid, {
      minimumSizes: { disks: [{ disk: "d0", minBytes: 1000 }] },
      planner: null,
    });
    expect(HARDWARE_RAID_DRIVERS).toContain("megaraid_sas");
    expect(hardware.hardwareRaidHint).toEqual([{ disk: "d0", minBytes: 1000 }]);
    expect(hardware.tokenTypes).toEqual(["systemd-tpm2"]);
    expect(hardware.tpm).toBe(true);
  });
});
