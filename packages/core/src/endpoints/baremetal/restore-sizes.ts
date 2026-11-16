/**
 * Restore sizes (docs/BAREMETAL.md 10.9, 12.1 L8): what a restore writes into each file system,
 * counted from the snapshot's tree (`restic ls --json <snapshot>`), not from the machine's
 * `usedBytes`, which also counts what the backup left out. The planner sizes the new file systems
 * from these, and the machine's page shows the minimum disk sizes that follow.
 */
import type { LinuxLayoutManifest } from "./manifest.js";
import type { RestoreSize } from "./plan.js";

/**
 * How many files {@link RestoreSizeCounter} remembers to recognise hard links (all targets
 * together). Each key takes about 80 bytes of heap.
 */
export const MAX_DEDUP_KEYS = 1_000_000;

/** One node of a snapshot's tree as `restic ls --json` prints it. */
export interface TreeNode {
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
  inode: number | null;
}

/** The mount targets a restore fills: every mount and local fstab entry, no swap, no automount. */
export function restoreSizeTargets(manifest: LinuxLayoutManifest): string[] {
  const targets = new Set<string>();
  for (const mount of manifest.mounts) {
    if (mount.autofs || mount.fs === null || !mount.target.startsWith("/")) continue;
    targets.add(normaliseTarget(mount.target));
  }
  for (const entry of manifest.fstab) {
    if (entry.type === "swap" || entry.type === "autofs" || !entry.target.startsWith("/")) continue;
    if (entry.resolved === null || !("fs" in entry.resolved)) continue;
    targets.add(normaliseTarget(entry.target));
  }
  return [...targets].sort();
}

function normaliseTarget(target: string): string {
  const collapsed = target.replace(/\/+/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

/**
 * Counts a snapshot's nodes into the mount target each belongs to: the longest target that is the
 * node's path or one of its parents. A file's bytes count once per target, also when hard links
 * give it several paths: files are told apart by `inode|size|mtime` (restic records no link count
 * and no device), and the key is per target, so two btrfs subvolumes that reuse inode numbers in
 * different file systems never merge. A node with inode 0 (unknown) is never merged. `files`
 * counts regular files, `inodes` every node (folders and links too: what the new file system
 * needs inodes for).
 *
 * The keys it remembers are bounded ({@link MAX_DEDUP_KEYS} over all targets, about 80 MB): a
 * snapshot with more files is still counted in full, but a file first seen after the bound is
 * counted every time, so its target's sizes are an upper bound ({@link upperBounds}). Counting
 * too much only raises the minimum sizes; it never makes a restore too small.
 */
export class RestoreSizeCounter {
  private readonly targets: string[];
  private readonly sizes = new Map<string, RestoreSize>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly overflowed = new Set<string>();
  private keys = 0;

  constructor(
    mountTargets: readonly string[],
    private readonly maxKeys: number = MAX_DEDUP_KEYS,
  ) {
    this.targets = [...new Set(mountTargets.map(normaliseTarget))].sort(
      (a, b) => b.length - a.length,
    );
    for (const target of this.targets) {
      this.sizes.set(target, { bytes: 0, files: 0, inodes: 0 });
      this.seen.set(target, new Set());
    }
  }

  /** The target a path belongs to, or null when none covers it. */
  targetOf(path: string): string | null {
    for (const target of this.targets) {
      if (target === "/" || path === target || path.startsWith(`${target}/`)) {
        return target;
      }
    }
    return null;
  }

  add(node: Pick<TreeNode, "path" | "type" | "size" | "mtime" | "inode">): void {
    const target = this.targetOf(node.path);
    if (target === null) return;
    const size = this.sizes.get(target) as RestoreSize;
    if (node.type === "file") {
      const inode = node.inode ?? 0;
      if (inode > 0) {
        const key = `${inode}|${node.size ?? 0}|${node.mtime ?? ""}`;
        const seen = this.seen.get(target) as Set<string>;
        if (seen.has(key)) return;
        if (this.keys < this.maxKeys) {
          seen.add(key);
          this.keys += 1;
        } else {
          this.overflowed.add(target);
        }
      }
      size.files += 1;
      size.bytes += Math.max(0, node.size ?? 0);
    }
    size.inodes += 1;
  }

  /** The targets whose sizes may count a hard-linked file more than once (sorted). */
  upperBounds(): string[] {
    return [...this.overflowed].sort();
  }

  /** The sizes per target, keys sorted. */
  result(): Record<string, RestoreSize> {
    const out: Record<string, RestoreSize> = {};
    for (const target of [...this.targets].sort()) {
      out[target] = { ...(this.sizes.get(target) as RestoreSize) };
    }
    return out;
  }
}
