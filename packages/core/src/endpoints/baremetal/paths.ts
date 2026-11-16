/**
 * Where a layout lies in a snapshot, and which files of a snapshot its manifest marks as secret
 * (docs/BAREMETAL.md 4.3, 5.4).
 */
import { posix } from "node:path";
import type { LayoutManifest } from "./manifest.js";

/** The manifest's path in a Linux snapshot (`Layout.BaremetalDir()` of the agent). */
export const LINUX_MANIFEST_PATH = "/var/lib/restow-agent/baremetal/layout.json";

/**
 * The manifest's path inside a snapshot of `platform`. macOS backs up from an APFS snapshot
 * mounted at `snapshotRoot` (M6), so its paths start there and the agent's data folder is the
 * Data volume's `/private/var/lib`.
 */
export function manifestPathInSnapshot(platform: string, snapshotRoot?: string): string {
  if (platform === "darwin") {
    const root = (snapshotRoot ?? "").replace(/\/+$/, "");
    return `${root}/private/var/lib/restow-agent/baremetal/layout.json`;
  }
  return LINUX_MANIFEST_PATH;
}

/** Key "files" of crypttab that are no files: none, `-` and the random devices. */
const NOT_A_FILE = new Set(["none", "-", "/dev/urandom", "/dev/random"]);

/**
 * The LUKS key files a manifest names (`luks[].keyFile`, from crypttab): absolute paths in plain
 * form. crypttab's `<path>:<device>` form (the key file on another device) counts by its path.
 */
export function keyFilesOf(manifest: LayoutManifest): string[] {
  if (manifest.platform !== "linux") {
    return [];
  }
  const files = new Set<string>();
  for (const luks of manifest.luks) {
    const raw = luks.keyFile?.split(":")[0]?.trim() ?? "";
    if (!raw.startsWith("/") || NOT_A_FILE.has(raw)) {
      continue;
    }
    const normalized = posix.normalize(raw).replace(/\/+$/, "");
    if (normalized && normalized !== "/" && !NOT_A_FILE.has(normalized)) {
      files.add(normalized);
    }
  }
  return [...files].sort();
}
