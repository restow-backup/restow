import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { layoutFingerprint, layoutFingerprintInput } from "./fingerprint.js";
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
