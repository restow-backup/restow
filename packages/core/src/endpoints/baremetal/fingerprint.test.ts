import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bootChainFingerprint, layoutFingerprint, layoutFingerprintInput } from "./fingerprint.js";
import { type LinuxLayoutManifest, parseLayoutManifest } from "./manifest.js";

/** The manifests the Go agent writes and owns, with their fingerprints. */
const SHARED_MANIFESTS = fileURLToPath(
  new URL("../../../../../agent/internal/baremetal/testdata/manifests/", import.meta.url),
);

const withFingerprint = readdirSync(SHARED_MANIFESTS)
  .filter((name) => name.endsWith(".fingerprint"))
  .map((name) => name.replace(/\.fingerprint$/, ""));

function load(name: string): LinuxLayoutManifest {
  const parsed = parseLayoutManifest(
    JSON.parse(readFileSync(join(SHARED_MANIFESTS, `${name}.json`), "utf8")),
  );
  if (!parsed.ok || parsed.manifest.platform !== "linux")
    throw new Error(`${name} is no Linux layout`);
  return parsed.manifest;
}

describe("layoutFingerprint", () => {
  it("has Linux manifests to compare with", () => {
    expect(withFingerprint.length).toBeGreaterThanOrEqual(2);
  });

  it.each(withFingerprint)("%s fingerprints like the agent", (name) => {
    const expected = readFileSync(join(SHARED_MANIFESTS, `${name}.fingerprint`), "utf8").trim();
    expect(layoutFingerprint(load(name))).toBe(expected);
  });

  it("ignores what changes between backups and sees what a restore depends on", () => {
    const base = load(withFingerprint[0] as string);
    const fingerprint = layoutFingerprint(base);
    const volatile = structuredClone(base);
    volatile.capturedAt = "2030-01-01T00:00:00Z";
    for (const fs of volatile.filesystems) fs.usedBytes += 4096;
    for (const vg of volatile.lvm.vgs) vg.freeBytes = 0;
    expect(layoutFingerprint(volatile)).toBe(fingerprint);

    const changed = structuredClone(base);
    changed.initramfs.keymap.layout = "fr";
    expect(layoutFingerprint(changed)).not.toBe(fingerprint);
  });

  it("projects disks without a table with empty partitions and a null table", () => {
    const base = load(withFingerprint[0] as string);
    const copy = structuredClone(base);
    if (copy.disks[0]) copy.disks[0].table = null;
    const input = layoutFingerprintInput(copy) as { disks: { table: unknown; parts: unknown[] }[] };
    expect(input.disks.find((d) => d.table === null)?.parts).toEqual([]);
  });
});

describe("bootChainFingerprint", () => {
  const files = [
    { path: "/boot/vmlinuz-6.1.0-27-amd64", size: 5616, mtime: "2024-11-01T10:00:00Z" },
    { path: "/boot/initrd.img-6.1.0-27-amd64", size: 384, mtime: "2024-11-01T10:01:00Z" },
    {
      path: "/boot/efi/EFI/debian/shimx64.efi",
      size: 4112,
      mtime: "2024-10-01T08:00:00Z",
      authenticodeSha256: "a".repeat(64),
      sbat: ["sbat,1,SBAT Version", "shim,4,UEFI shim"],
    },
  ];
  const configs = [
    { path: "/etc/fstab", sha256: "b".repeat(64) },
    { path: "/etc/crypttab", sha256: null },
  ];

  it("does not depend on the order the snapshot was read in", () => {
    const first = bootChainFingerprint({ files, configs });
    const second = bootChainFingerprint({
      files: [...files].reverse(),
      configs: [...configs].reverse(),
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("changes with a kernel update and with a changed configuration", () => {
    const base = bootChainFingerprint({ files, configs });
    const kernel = files.map((file, index) =>
      index === 0 ? { ...file, size: 5620, mtime: "2024-12-01T10:00:00Z" } : file,
    );
    expect(bootChainFingerprint({ files: kernel, configs })).not.toBe(base);
    const fstab = configs.map((config) =>
      config.path === "/etc/fstab" ? { ...config, sha256: "c".repeat(64) } : config,
    );
    expect(bootChainFingerprint({ files, configs: fstab })).not.toBe(base);
    const sbat = files.map((file, index) => (index === 2 ? { ...file, sbat: ["shim,5"] } : file));
    expect(bootChainFingerprint({ files: sbat, configs })).not.toBe(base);
  });
});
