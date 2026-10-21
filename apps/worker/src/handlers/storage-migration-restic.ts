/**
 * The restic repositories a `move` storage migration copies along with the chunk store
 * (docs/STORAGE.md, "Replace the primary"): every container's (`pve-guests/<guest id>/`),
 * machine's (`endpoints/<endpoint id>/`) and file share's (`file-shares/<share id>/`) of the
 * tenant. They lie on the primary only (the chunk store's copies never receive them), so a
 * switch without them would leave every container, machine and share with an empty repository
 * on the new primary.
 *
 * Each repository is copied from the one target that holds it (its `config`): the current
 * primary first, then a retired primary left by an earlier "keep". Files of two different
 * repositories under one prefix (a new chain on the primary, the old one on a retired target)
 * are never mixed. restic names its data, index, snapshot and key files by the SHA-256 of their
 * content, so those are copied and verified against that hash, like packs against theirs;
 * `config` and the sealed password file are compared with the source. `locks/` is skipped: a
 * lock is transient and restic writes its own.
 */
import type { MirrorItem, StorageBackend } from "@restow/core";
import { fileShareRepositoryPrefix } from "@restow/core";
import { endpoints, fileShares, pveGuests } from "@restow/db";
import { and, eq, isNotNull, or } from "drizzle-orm";
import type { TenantTxRunner } from "../progress.js";

const TOP_PREFIXES = ["pve-guests/", "endpoints/", "file-shares/"] as const;

/**
 * Up to this many repositories of one kind are listed one prefix at a time (an object store
 * answers a prefix listing directly); more are listed under the kind's top-level prefix once
 * and sorted out by id (a directory target walks its whole tree for every listing).
 */
const PER_PREFIX_LISTING_LIMIT = 32;

/** A restic file whose name is the SHA-256 of its content. */
const CONTENT_ADDRESSED = /\/(?:data\/[0-9a-f]{2}|index|snapshots|keys)\/([0-9a-f]{64})$/;

/** Whether `key` lies in a restic repository (of any tenant). */
export function isResticRepositoryKey(key: string): boolean {
  return TOP_PREFIXES.some((top) => key.startsWith(top));
}

/** The storage prefixes of the tenant's restic repositories, sorted. */
export async function tenantRepositoryPrefixes(
  run: TenantTxRunner,
  tenantId: string,
): Promise<string[]> {
  const [guests, machines, shares] = await run(async (tx) =>
    Promise.all([
      tx
        .select({ id: pveGuests.id })
        .from(pveGuests)
        .where(
          and(
            eq(pveGuests.tenantId, tenantId),
            or(isNotNull(pveGuests.repositoryReadyAt), isNotNull(pveGuests.repositorySecretId)),
          ),
        ),
      tx
        .select({ id: endpoints.id })
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositorySecretId))),
      tx
        .select({ id: fileShares.id })
        .from(fileShares)
        .where(and(eq(fileShares.tenantId, tenantId), isNotNull(fileShares.repositorySecretId))),
    ]),
  );
  return [
    ...guests.map((row) => `pve-guests/${row.id}/`),
    ...machines.map((row) => `endpoints/${row.id}/`),
    ...shares.map((row) => fileShareRepositoryPrefix(row.id)),
  ].sort();
}

/** The keys under each prefix on `backend` (prefixes without any are absent). */
export async function listRepositories(
  backend: StorageBackend,
  prefixes: readonly string[],
): Promise<Map<string, string[]>> {
  const byPrefix = new Map<string, string[]>();
  for (const top of TOP_PREFIXES) {
    const mine = prefixes.filter((prefix) => prefix.startsWith(top));
    if (mine.length === 0) {
      continue;
    }
    if (mine.length <= PER_PREFIX_LISTING_LIMIT) {
      for (const prefix of mine) {
        const keys = await backend.list(prefix);
        if (keys.length > 0) {
          byPrefix.set(prefix, keys);
        }
      }
      continue;
    }
    const wanted = new Set(mine);
    for (const key of await backend.list(top)) {
      const end = key.indexOf("/", top.length);
      const prefix = end < 0 ? null : key.slice(0, end + 1);
      if (prefix && wanted.has(prefix)) {
        const list = byPrefix.get(prefix) ?? [];
        list.push(key);
        byPrefix.set(prefix, list);
      }
    }
  }
  return byPrefix;
}

function itemOf(key: string): MirrorItem {
  const match = CONTENT_ADDRESSED.exec(key);
  return { key, size: null, sha256: match?.[1] ?? null };
}

/**
 * The files of the tenant's restic repositories to mirror, each repository from the first of
 * `sources` (the primary, then retired primaries) that holds its `config`. A repository no
 * source holds (never created, or gone) contributes nothing.
 */
export async function resticMirrorItems(
  prefixes: readonly string[],
  sources: readonly StorageBackend[],
): Promise<MirrorItem[]> {
  if (prefixes.length === 0) {
    return [];
  }
  const remaining = new Set(prefixes);
  const items: MirrorItem[] = [];
  for (const source of sources) {
    if (remaining.size === 0) {
      break;
    }
    const listed = await listRepositories(source, [...remaining]);
    for (const [prefix, keys] of listed) {
      if (!keys.includes(`${prefix}config`)) {
        continue;
      }
      remaining.delete(prefix);
      for (const key of keys) {
        if (!key.startsWith(`${prefix}locks/`)) {
          items.push(itemOf(key));
        }
      }
    }
  }
  return items;
}

/** The restic files the destination already holds under the tenant's repository prefixes. */
export async function resticKeysOn(
  backend: StorageBackend,
  prefixes: readonly string[],
): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const list of (await listRepositories(backend, prefixes)).values()) {
    for (const key of list) {
      keys.add(key);
    }
  }
  return keys;
}
