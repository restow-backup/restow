/**
 * The restic repositories of a tenant across its storage targets (docs/STORAGE.md, "Replace the
 * primary" and "Repository repair"): every container's (`pve-guests/<guest id>/`), machine's
 * (`endpoints/<endpoint id>/`) and file share's (`file-shares/<share id>/`). They lie on the
 * primary only (the chunk store's copies never receive them), so a `move` copies them along
 * with the chunk store, and the repository repair rebuilds them on the primary.
 *
 * A repository may be split across targets: a run that went on while the primary changed
 * wrote its first files to the old primary and the rest to the new one (the 2026-10-16 field
 * incident). So the files of a repository are collected from every target that holds any
 * (`planRepositories`): the primary, the copies, the retired targets and the installation
 * default. restic names its data, index, snapshot and key files by the SHA-256 of their
 * content, so the same name is the same file wherever it lies; such files are merged, and
 * copied and verified against that hash. `config` must be the same on every target that has
 * one of this chain; a target with another `config` holds another chain (a new chain on the
 * primary, the old one on a retired target) and is left out. `locks/` is skipped: a lock is
 * transient and restic writes its own.
 *
 * A repository that is not complete from all targets together (no `config` or no key
 * anywhere) or ambiguous (two different `config` files and none on the primary) cannot be
 * copied: a `move` refuses to switch while one exists and names it.
 */
import type { MirrorItem, StorageBackend } from "@restow/core";
import { fileShareRepositoryPrefix } from "@restow/core";
import {
  endpoints,
  fileShareSnapshots,
  fileShares,
  pveGuests,
  pveSnapshots,
  type StorageRepositoryClass,
  type StorageRepositoryHolding,
  type StorageRepositoryScanEntry,
} from "@restow/db";
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

/** The sealed password file next to every repository. */
export const REPOSITORY_PASSWORD_FILE = "restow-repository-password.json";

/** Whether `key` lies in a restic repository (of any tenant). */
export function isResticRepositoryKey(key: string): boolean {
  return TOP_PREFIXES.some((top) => key.startsWith(top));
}

/** A restic repository the database knows of. */
export interface RepositoryOwner {
  readonly prefix: string;
  readonly kind: StorageRepositoryScanEntry["kind"];
  readonly ownerId: string;
  readonly name: string | null;
  /** The secret holding the repository password, when one is recorded. */
  readonly secretId: string | null;
  /** The secret kind (`pve_ct_repository`, `endpoint_repository`, `file_share_repository`). */
  readonly secretKind: string;
  /** Whether the repository was created (`repository_ready_at`; a machine's always was). */
  readonly created: boolean;
}

/** The tenant's restic repositories, sorted by prefix. */
export async function tenantRepositoryOwners(
  run: TenantTxRunner,
  tenantId: string,
): Promise<RepositoryOwner[]> {
  const [guests, machines, shares] = await run(async (tx) =>
    Promise.all([
      tx
        .select({
          id: pveGuests.id,
          name: pveGuests.name,
          vmid: pveGuests.vmid,
          secretId: pveGuests.repositorySecretId,
          readyAt: pveGuests.repositoryReadyAt,
        })
        .from(pveGuests)
        .where(
          and(
            eq(pveGuests.tenantId, tenantId),
            or(isNotNull(pveGuests.repositoryReadyAt), isNotNull(pveGuests.repositorySecretId)),
          ),
        ),
      tx
        .select({
          id: endpoints.id,
          name: endpoints.hostname,
          secretId: endpoints.repositorySecretId,
        })
        .from(endpoints)
        .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositorySecretId))),
      tx
        .select({
          id: fileShares.id,
          name: fileShares.name,
          secretId: fileShares.repositorySecretId,
          readyAt: fileShares.repositoryReadyAt,
        })
        .from(fileShares)
        .where(
          and(
            eq(fileShares.tenantId, tenantId),
            or(isNotNull(fileShares.repositorySecretId), isNotNull(fileShares.repositoryReadyAt)),
          ),
        ),
    ]),
  );
  return [
    ...guests.map(
      (row): RepositoryOwner => ({
        prefix: `pve-guests/${row.id}/`,
        kind: "container",
        ownerId: row.id,
        name: row.name ?? String(row.vmid),
        secretId: row.secretId,
        secretKind: "pve_ct_repository",
        created: row.readyAt !== null,
      }),
    ),
    ...machines.map(
      (row): RepositoryOwner => ({
        prefix: `endpoints/${row.id}/`,
        kind: "machine",
        ownerId: row.id,
        name: row.name,
        secretId: row.secretId,
        secretKind: "endpoint_repository",
        created: true,
      }),
    ),
    ...shares.map(
      (row): RepositoryOwner => ({
        prefix: fileShareRepositoryPrefix(row.id),
        kind: "file_share",
        ownerId: row.id,
        name: row.name,
        secretId: row.secretId,
        secretKind: "file_share_repository",
        created: row.readyAt !== null,
      }),
    ),
  ].sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}

/** The storage prefixes of the tenant's restic repositories, sorted. */
export async function tenantRepositoryPrefixes(
  run: TenantTxRunner,
  tenantId: string,
): Promise<string[]> {
  return (await tenantRepositoryOwners(run, tenantId)).map((owner) => owner.prefix);
}

/** How many restore points (containers) or snapshots (file shares) still refer to a repository. */
export async function activePointsOf(
  run: TenantTxRunner,
  owner: Pick<RepositoryOwner, "kind" | "ownerId">,
): Promise<number> {
  if (owner.kind === "container") {
    const rows = await run((tx) =>
      tx
        .select({ id: pveSnapshots.id })
        .from(pveSnapshots)
        .where(
          and(
            eq(pveSnapshots.guestId, owner.ownerId),
            eq(pveSnapshots.kind, "ct"),
            eq(pveSnapshots.status, "active"),
          ),
        ),
    );
    return rows.length;
  }
  if (owner.kind === "file_share") {
    const rows = await run((tx) =>
      tx
        .select({ id: fileShareSnapshots.id })
        .from(fileShareSnapshots)
        .where(eq(fileShareSnapshots.fileShareId, owner.ownerId)),
    );
    return rows.length;
  }
  return 0;
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

/** One place the repositories may lie, in the order they are read from (primary first). */
export interface RepositorySource {
  /** A target id, `installation_default`, or the destination of a move. */
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly backend: StorageBackend;
  /**
   * A place that is no target of the tenant (the installation default after a promotion of
   * 0.4.1 dropped it): a listing that fails counts as empty instead of failing the plan.
   */
  readonly optional?: boolean;
}

/** What `planRepositories` found for one repository. */
export interface RepositoryPlan {
  readonly owner: RepositoryOwner;
  readonly class: StorageRepositoryClass;
  readonly holdings: readonly StorageRepositoryHolding[];
  /**
   * The files of the repository's chain from every source (merged), lock files aside: what a
   * copy onto one target must bring there. Empty unless the repository is complete together.
   */
  readonly items: readonly MirrorItem[];
  /** Which source to read each non-content-addressed file (`config`, password file) from. */
  readonly configSource: RepositorySource | null;
  /** Items the reference target (`planRepositories`' `reference`) lacks. */
  readonly missingOnReference: number;
}

function holding(source: RepositorySource, prefix: string, keys: readonly string[]) {
  let config = false;
  let keyCount = 0;
  let files = 0;
  let snapshots = 0;
  let password = false;
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    if (rest === "config") {
      config = true;
    } else if (rest === REPOSITORY_PASSWORD_FILE) {
      password = true;
    } else if (rest.startsWith("keys/")) {
      keyCount += 1;
    } else if (!rest.startsWith("locks/")) {
      files += 1;
      if (rest.startsWith("snapshots/")) {
        snapshots += 1;
      }
    }
  }
  return {
    target: source.id,
    targetName: source.name,
    role: source.role,
    config,
    keys: keyCount,
    files,
    snapshots,
    password,
  } satisfies StorageRepositoryHolding;
}

/**
 * Classify every repository of `owners` across `sources` and collect its files (see the module
 * comment). `reference` is the source the repository should be complete on (the primary for a
 * scan, the source primary for a move); `ok` means it is, and nothing from another source of
 * its chain is missing there. Sources that do not answer fail the whole plan: a repository
 * must never be judged on half the facts.
 */
export async function planRepositories(
  owners: readonly RepositoryOwner[],
  sources: readonly RepositorySource[],
  reference: RepositorySource | null = sources[0] ?? null,
): Promise<RepositoryPlan[]> {
  if (owners.length === 0) {
    return [];
  }
  const prefixes = owners.map((owner) => owner.prefix);
  const listings: { source: RepositorySource; byPrefix: Map<string, string[]> }[] = [];
  for (const source of sources) {
    const byPrefix = source.optional
      ? await listRepositories(source.backend, prefixes).catch(() => new Map<string, string[]>())
      : await listRepositories(source.backend, prefixes);
    listings.push({ source, byPrefix });
  }
  const plans: RepositoryPlan[] = [];
  for (const owner of owners) {
    const prefix = owner.prefix;
    const present = listings
      .map(({ source, byPrefix }) => ({
        source,
        keys: (byPrefix.get(prefix) ?? []).filter((key) => !key.startsWith(`${prefix}locks/`)),
      }))
      .filter((entry) => entry.keys.length > 0);
    const holdings = present.map((entry) => holding(entry.source, prefix, entry.keys));
    const configKey = `${prefix}config`;
    const configHolders = present.filter((entry) => entry.keys.includes(configKey));
    // The chain's config: the reference's own, else the first holder's.
    const chosen =
      configHolders.find((entry) => entry.source === reference) ?? configHolders[0] ?? null;
    let conflict = false;
    let chain = present;
    if (chosen) {
      const config = await chosen.source.backend.get(configKey);
      const sameChain: typeof present = [];
      for (const entry of present) {
        if (!entry.keys.includes(configKey)) {
          // No config here: data a split run left, of the same chain.
          sameChain.push(entry);
          continue;
        }
        const other = entry === chosen ? config : await entry.source.backend.get(configKey);
        if (other.equals(config)) {
          sameChain.push(entry);
        } else if (!configHolders.some((holder) => holder.source === reference)) {
          // Two chains and none of them on the reference: which one is meant is not clear.
          conflict = true;
        }
      }
      chain = sameChain;
    }
    const union = new Map<string, MirrorItem>();
    for (const entry of chain) {
      for (const key of entry.keys) {
        if (!union.has(key)) {
          union.set(key, itemOf(key));
        }
      }
    }
    const keys = [...union.keys()];
    const hasKey = keys.some((key) => key.startsWith(`${prefix}keys/`));
    const data = keys.filter(
      (key) => key !== configKey && !key.endsWith(`/${REPOSITORY_PASSWORD_FILE}`),
    );
    const onReference = new Set(
      present.find((entry) => entry.source === reference)?.keys.filter((key) => union.has(key)) ??
        [],
    );
    const missingOnReference = keys.filter((key) => !onReference.has(key)).length;
    let klass: StorageRepositoryClass;
    if (present.length === 0) {
      klass = "missing";
    } else if (conflict) {
      klass = "conflict";
    } else if (!chosen && data.length === 0) {
      klass = "password_only";
    } else if (!chosen || !hasKey) {
      klass = "data_only";
    } else if (missingOnReference === 0) {
      klass = "ok";
    } else if (onReference.size === 0 && chain.length === 1) {
      klass = "elsewhere";
    } else {
      klass = "split";
    }
    const complete = klass === "ok" || klass === "elsewhere" || klass === "split";
    plans.push({
      owner,
      class: klass,
      holdings,
      items: complete ? [...union.values()] : [],
      configSource: chosen?.source ?? null,
      missingOnReference: complete ? missingOnReference : 0,
    });
  }
  return plans;
}

/**
 * Whether a plan stands in the way of a switch: a created repository with data that cannot be
 * copied whole (no `config` or no key anywhere), or two chains and none on the primary. A
 * repository on no target, or of which only the sealed password file is left, has nothing a
 * switch could lose or copy.
 */
export function blocksSwitch(plan: RepositoryPlan): boolean {
  return plan.owner.created && (plan.class === "data_only" || plan.class === "conflict");
}

/**
 * The files of the tenant's restic repositories to mirror for a move: every repository's chain
 * merged from all `sources` (`planRepositories`). Repositories that cannot be copied contribute
 * nothing here; `blocksSwitch` tells the caller which of them stop the switch.
 */
export async function resticMirrorItems(
  prefixes: readonly string[],
  sources: readonly StorageBackend[],
): Promise<MirrorItem[]> {
  const owners = prefixes.map(
    (prefix): RepositoryOwner => ({
      prefix,
      kind: prefix.startsWith("pve-guests/")
        ? "container"
        : prefix.startsWith("endpoints/")
          ? "machine"
          : "file_share",
      ownerId: prefix.split("/")[1] ?? "",
      name: null,
      secretId: null,
      secretKind: "",
      created: true,
    }),
  );
  const plans = await planRepositories(
    owners,
    sources.map((backend, index) => ({
      id: String(index),
      name: String(index),
      role: index === 0 ? "primary" : "previous",
      backend,
    })),
  );
  return plans.flatMap((plan) => plan.items);
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
