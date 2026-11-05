/**
 * Where a restic repository of a container, a machine or a file share lies on its storage target
 * (docs/STORAGE.md, "Write-once storage"). Every repository begins under its owner's prefix
 * (`pve-guests/<guest id>/`, `endpoints/<endpoint id>/`, `file-shares/<share id>/`). A new chain
 * whose old prefix cannot be cleared (a write-once target, or a storage that refused to delete or
 * move what lies there) begins under a fresh prefix next to it, `<owner prefix>.chain-<n>/`,
 * recorded with its owner (`pve_guests.repository_prefix`, `file_shares.repository_prefix`), and
 * every reader opens the recorded one. The old chain stays where it was, readable, and nothing
 * on such a target is ever deleted.
 *
 * Folders of an owner below its top-level prefix are therefore: its own prefix, earlier chains
 * (`<id>/` or `<id>.chain-<n>/` that are not the recorded one) and what was moved aside
 * (`<id>.orphaned-<time>/`, or `<id>.chain-<n>.orphaned-<time>/` for a chain under a fresh
 * prefix). None of them is mistaken for another owner's: an id never contains
 * a dot.
 */
import type { StorageBackend } from "../storage/backend.js";

/** The owners of restic repositories. */
export type RepositoryOwnerKind = "container" | "machine" | "file_share";

/** The top-level prefix of each kind's repositories. */
export const REPOSITORY_TOP_PREFIXES: Readonly<Record<RepositoryOwnerKind, string>> = {
  container: "pve-guests/",
  machine: "endpoints/",
  file_share: "file-shares/",
};

const OWNER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CHAIN_SUFFIX = /^\.chain-([1-9][0-9]{0,5})$/;
/** What a reset or the repair moved aside: `.orphaned-<time>`, after the chain suffix if any. */
const MOVED_ASIDE_SUFFIX = /^(?:\.chain-[1-9][0-9]{0,5})?\.orphaned-/;
/** No owner gets more fresh prefixes than this (a guard against a storage that lists nothing). */
const MAX_CHAIN = 999;

function ownerId(id: string): string {
  if (!OWNER_ID.test(id)) {
    throw new Error(`not a repository owner id: ${id}`);
  }
  return id;
}

/** The prefix every repository of an owner begins under. */
export function defaultRepositoryPrefix(kind: RepositoryOwnerKind, id: string): string {
  return `${REPOSITORY_TOP_PREFIXES[kind]}${ownerId(id)}/`;
}

/** The fresh prefix of an owner's `n`-th chain (n >= 2; the first lies under the default prefix). */
export function chainRepositoryPrefix(kind: RepositoryOwnerKind, id: string, n: number): string {
  if (!Number.isInteger(n) || n < 2 || n > MAX_CHAIN) {
    throw new Error(`not a chain number: ${n}`);
  }
  return `${REPOSITORY_TOP_PREFIXES[kind]}${ownerId(id)}.chain-${n}/`;
}

/**
 * Which chain of the owner `prefix` is: 1 for the default prefix, n for `<id>.chain-<n>/`, null
 * for anything else (another owner's, a moved-aside folder, a malformed value).
 */
export function chainNumberOf(
  kind: RepositoryOwnerKind,
  id: string,
  prefix: string,
): number | null {
  const base = `${REPOSITORY_TOP_PREFIXES[kind]}${id}`;
  if (prefix === `${base}/`) {
    return 1;
  }
  if (!prefix.startsWith(base) || !prefix.endsWith("/")) {
    return null;
  }
  const match = CHAIN_SUFFIX.exec(prefix.slice(base.length, -1));
  return match ? Number(match[1]) : null;
}

/**
 * The prefix an owner's repository lies under: the recorded one (a chain begun under a fresh
 * prefix), else the default. A recorded value of any other shape is refused, so a damaged row
 * can never point a reader into another owner's repository.
 */
export function repositoryPrefixOf(
  kind: RepositoryOwnerKind,
  id: string,
  recorded: string | null | undefined,
): string {
  if (!recorded) {
    return defaultRepositoryPrefix(kind, id);
  }
  if (chainNumberOf(kind, id, recorded) === null) {
    throw new Error(`the recorded repository prefix of ${kind} ${id} is not one of its own`);
  }
  return recorded;
}

/** What a folder directly below a kind's top-level prefix is (its name without the slash). */
export interface RepositoryFolder {
  readonly ownerId: string;
  /** 1 for `<id>`, n for `<id>.chain-<n>`, null for a moved-aside folder. */
  readonly chain: number | null;
  /**
   * `<id>.orphaned-<time>` or `<id>.chain-<n>.orphaned-<time>`: what a reset or the repair moved
   * aside.
   */
  readonly movedAside: boolean;
}

/** Parse a folder name below a top-level prefix, or null when it is no repository folder. */
export function repositoryFolderOf(folder: string): RepositoryFolder | null {
  const dot = folder.indexOf(".");
  const id = dot < 0 ? folder : folder.slice(0, dot);
  if (!OWNER_ID.test(id)) {
    return null;
  }
  if (dot < 0) {
    return { ownerId: id, chain: 1, movedAside: false };
  }
  const rest = folder.slice(dot);
  const chain = CHAIN_SUFFIX.exec(rest);
  if (chain) {
    return { ownerId: id, chain: Number(chain[1]), movedAside: false };
  }
  if (MOVED_ASIDE_SUFFIX.test(rest)) {
    return { ownerId: id, chain: null, movedAside: true };
  }
  return null;
}

/**
 * A fresh prefix for an owner's new chain on `backend`: the first `<id>.chain-<n>/` after the
 * current one that holds nothing there. Lists, never writes.
 */
export async function freshRepositoryPrefix(
  backend: StorageBackend,
  kind: RepositoryOwnerKind,
  id: string,
  current: string,
): Promise<string> {
  const from = Math.max(2, (chainNumberOf(kind, id, current) ?? 1) + 1);
  for (let n = from; n <= MAX_CHAIN; n++) {
    const prefix = chainRepositoryPrefix(kind, id, n);
    if ((await backend.list(prefix)).length === 0) {
      return prefix;
    }
  }
  throw new Error(`no fresh repository prefix is left for ${kind} ${id}`);
}
