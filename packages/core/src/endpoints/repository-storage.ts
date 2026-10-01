/**
 * What the server reads from an endpoint's repository straight from the
 * storage, without restic: the objects of a type with the time the storage
 * received them, the bytes the repository takes, and the lock files
 * (docs/AGENT.md, "Sperren", "Aufbewahrung", "Speicherbudget").
 *
 * Lock files and maintenance:
 *
 * restic marks a repository it works on with a file under `locks/`; prune
 * needs an exclusive lock and stops while any other lock exists. A lock
 * counts as stale for restic when its own timestamp is 30 minutes old, and
 * that timestamp is written by whoever wrote the lock: an agent can plant a
 * lock dated far in the future, which `restic unlock` never removes, and so
 * stop retention for good.
 *
 * The server therefore decides by facts it controls, before every retention
 * and check run:
 *
 *   - a lock file stored more than 30 minutes ago is stale: restic writes a
 *     fresh lock file (with a new name) every five minutes while it works, so
 *     a live process never has an older one, whatever the file says inside;
 *   - a lock the agent wrote (the API records their names) goes as soon as
 *     the database shows no run of the agent in progress.
 *
 * Locks of the server's own restic runs are kept unless they are stale.
 */
import { type StorageBackend, listWithSizes } from "../storage/backend.js";
import { RESTIC_NAME } from "./restic-authz.js";

/** restic refreshes a live lock every five minutes and calls one 30 minutes old stale. */
export const STALE_LOCK_MS = 30 * 60 * 1000;

export interface StoredObject {
  readonly name: string;
  /** When the storage received the file; null when the backend does not say. */
  readonly storedAt: Date | null;
}

export type LockFile = StoredObject;

/**
 * The objects of one type (`locks`, `snapshots`) with the time each one was
 * stored. Names that are not a restic object name are skipped.
 */
export async function listRepositoryObjects(
  storage: StorageBackend,
  prefix: string,
  type: "locks" | "snapshots",
  concurrency = 8,
): Promise<StoredObject[]> {
  const base = `${prefix}${type}/`;
  const names = (await storage.list(base))
    .map((key) => key.slice(base.length))
    .filter((name) => RESTIC_NAME.test(name));
  const found: StoredObject[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (next < names.length) {
      const name = names[next++] as string;
      const head = await storage.head(`${base}${name}`);
      if (head) {
        found.push({ name, storedAt: head.lastModified ?? null });
      }
    }
  });
  await Promise.all(workers);
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The lock files of a repository, with the time each one was stored. */
export function listLockFiles(storage: StorageBackend, prefix: string): Promise<LockFile[]> {
  return listRepositoryObjects(storage, prefix, "locks");
}

/** The bytes everything under the repository's prefix takes in the storage. */
export async function measureRepositoryBytes(
  storage: StorageBackend,
  prefix: string,
): Promise<number> {
  const entries = await listWithSizes(storage, prefix);
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

/** The locks to remove before maintenance (see the module comment). */
export function locksToRemove(
  locks: readonly LockFile[],
  context: { agentLocks: ReadonlySet<string>; agentActive: boolean; now: Date },
): string[] {
  return locks
    .filter(
      (lock) =>
        (context.agentLocks.has(lock.name) && !context.agentActive) ||
        (lock.storedAt !== null && context.now.getTime() - lock.storedAt.getTime() > STALE_LOCK_MS),
    )
    .map((lock) => lock.name);
}

/** Remove lock files by name; one that is gone already is no error. */
export async function removeLockFiles(
  storage: StorageBackend,
  prefix: string,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    await storage.delete(`${prefix}locks/${name}`);
  }
}
