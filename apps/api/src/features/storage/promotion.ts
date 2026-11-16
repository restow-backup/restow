import {
  endpointPrefix,
  fileShareRepositoryKey,
  type RepositoryOwnerKind,
  repositoryPrefixOf,
  resticBinary,
  resticCacheBase,
  resticSnapshots,
  type StorageBackend,
  withRepository,
} from "@restow/core";
import {
  endpoints,
  fileShares,
  pveGuests,
  RECORDED_SNAPSHOT_COLUMNS,
  type RepositoryCopy,
  recordedColumnValuesSql,
  recordedColumnWhere,
  recordedSnapshotIds,
  repositoryCopies,
  resticSnapshotOrigins,
} from "@restow/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import {
  type CopiedSnapshot,
  matchOnCopy,
  type RepositoryCopyFacts,
  type RepositoryCopyReadiness,
  repositoryCopyReadiness,
} from "./rules.js";
import { loadSnapshotOrigins, persistentIdOf, persistentOfRecorded } from "./snapshot-origins.js";

/**
 * Promoting a copy target while the tenant has restic repositories (docs/STORAGE.md, "Promoting a
 * copy"): what a promotion reads about each repository and its copy on the target, and how the
 * restore points the database records are carried over to the copy.
 *
 * A repository copy (apps/worker repository-copies) is a repository of its own at the same
 * prefix, filled with `restic copy`: it holds each restore point under a new snapshot id and keeps
 * the primary's id as `original`. Once the copy is the primary, the database must name the
 * copy's ids, or every restore, check and retention would ask restic for a snapshot the new
 * primary does not have. The promotion lists the snapshots of every repository copy, maps each
 * recorded id onto its copy (`idOnCopy`), refuses when a restore point the server keeps is not
 * there, and rewrites the recorded ids in the same transaction that switches the primary.
 */

/** A restic repository of the tenant (a container's, a machine's, a file share's). */
export interface PromotionRepository {
  readonly prefix: string;
  readonly kind: RepositoryOwnerKind;
  readonly ownerId: string;
  readonly name: string | null;
  readonly secretId: string | null;
  /** The repository was created (`repository_ready_at`; a machine's always was). */
  readonly created: boolean;
}

/** The tenant's restic repositories, the same set the worker copies and a "move" moves. */
export async function promotionRepositories(
  tx: DbExecutor,
  tenantId: string,
): Promise<PromotionRepository[]> {
  // One statement after the other: they share the transaction's connection.
  const guests = await tx
    .select({
      id: pveGuests.id,
      name: pveGuests.name,
      vmid: pveGuests.vmid,
      secretId: pveGuests.repositorySecretId,
      readyAt: pveGuests.repositoryReadyAt,
      prefix: pveGuests.repositoryPrefix,
    })
    .from(pveGuests)
    .where(
      and(
        eq(pveGuests.tenantId, tenantId),
        or(isNotNull(pveGuests.repositoryReadyAt), isNotNull(pveGuests.repositorySecretId)),
      ),
    );
  const machines = await tx
    .select({ id: endpoints.id, name: endpoints.hostname, secretId: endpoints.repositorySecretId })
    .from(endpoints)
    .where(and(eq(endpoints.tenantId, tenantId), isNotNull(endpoints.repositorySecretId)));
  const shares = await tx
    .select({
      id: fileShares.id,
      name: fileShares.name,
      secretId: fileShares.repositorySecretId,
      readyAt: fileShares.repositoryReadyAt,
      prefix: fileShares.repositoryPrefix,
    })
    .from(fileShares)
    .where(
      and(
        eq(fileShares.tenantId, tenantId),
        or(isNotNull(fileShares.repositorySecretId), isNotNull(fileShares.repositoryReadyAt)),
      ),
    );
  return [
    ...guests.map((row) => ({
      prefix: repositoryPrefixOf("container", row.id, row.prefix),
      kind: "container" as const,
      ownerId: row.id,
      name: row.name ?? String(row.vmid),
      secretId: row.secretId,
      created: row.readyAt !== null,
    })),
    ...machines.map((row) => ({
      prefix: endpointPrefix(row.id),
      kind: "machine" as const,
      ownerId: row.id,
      name: row.name,
      secretId: row.secretId,
      created: true,
    })),
    ...shares.map((row) => ({
      prefix: repositoryPrefixOf("file_share", row.id, row.prefix),
      kind: "file_share" as const,
      ownerId: row.id,
      name: row.name,
      secretId: row.secretId,
      created: row.readyAt !== null,
    })),
  ].sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}

/** When each object of the tenant last got a restore point the server recorded (as the worker). */
export async function newestRecordedBackups(
  tx: DbExecutor,
  tenantId: string,
): Promise<Map<string, Date>> {
  const rows = await tx.execute<{ owner: string; at: Date | string | null }>(sql`
    SELECT endpoint_id AS owner, max(finished_at) AS at FROM endpoint_runs
     WHERE tenant_id = ${tenantId} AND snapshot_id IS NOT NULL GROUP BY endpoint_id
    UNION ALL
    SELECT guest_id AS owner, max(created_at) AS at FROM pve_snapshots
     WHERE tenant_id = ${tenantId} AND restic_snapshot_id IS NOT NULL GROUP BY guest_id
    UNION ALL
    SELECT file_share_id AS owner, max(created_at) AS at FROM file_share_snapshots
     WHERE tenant_id = ${tenantId} GROUP BY file_share_id`);
  const out = new Map<string, Date>();
  for (const row of rows.rows) {
    if (row.at) {
      out.set(String(row.owner), new Date(row.at));
    }
  }
  return out;
}

/** The `repository_copies` rows of the tenant on one copy target, by prefix. */
export async function copyRowsOn(
  tx: DbExecutor,
  tenantId: string,
  targetId: string,
): Promise<Map<string, RepositoryCopy>> {
  const rows = await tx
    .select()
    .from(repositoryCopies)
    .where(and(eq(repositoryCopies.tenantId, tenantId), eq(repositoryCopies.targetId, targetId)));
  return new Map(rows.map((row) => [row.prefix, row]));
}

/** One repository as the promotion dialog shows it. */
export interface PromotionRepositoryDto {
  prefix: string;
  kind: RepositoryOwnerKind;
  ownerId: string;
  name: string | null;
  readiness: RepositoryCopyReadiness;
  missingSnapshots: number;
  lastCopiedAt: string | null;
  lastAttemptAt: string | null;
  /** Why the last copy failed, or what its check found. */
  lastError: string | null;
}

export interface RepositoryReadiness {
  readonly repository: PromotionRepository;
  readonly facts: RepositoryCopyFacts;
  readonly readiness: RepositoryCopyReadiness;
  readonly row: RepositoryCopy | null;
}

/** Each repository with its copy on the target and where that copy stands. */
export function repositoryReadinessOf(
  repositories: readonly PromotionRepository[],
  rows: ReadonlyMap<string, RepositoryCopy>,
  newest: ReadonlyMap<string, Date>,
): RepositoryReadiness[] {
  return repositories.map((repository) => {
    const row = rows.get(repository.prefix) ?? null;
    const facts: RepositoryCopyFacts = {
      created: repository.created,
      row: row
        ? {
            state: row.state,
            missingSnapshots: row.missingSnapshots,
            lastAttemptAt: row.lastAttemptAt,
            lastCheckOk: row.lastCheckOk,
          }
        : null,
      newestBackup: newest.get(repository.ownerId) ?? null,
    };
    return { repository, facts, readiness: repositoryCopyReadiness(facts), row };
  });
}

export function toPromotionRepositoryDto(entry: RepositoryReadiness): PromotionRepositoryDto {
  return {
    prefix: entry.repository.prefix,
    kind: entry.repository.kind,
    ownerId: entry.repository.ownerId,
    name: entry.repository.name,
    readiness: entry.readiness,
    missingSnapshots: entry.row?.missingSnapshots ?? 0,
    lastCopiedAt: entry.row?.lastCopiedAt?.toISOString() ?? null,
    lastAttemptAt: entry.row?.lastAttemptAt?.toISOString() ?? null,
    lastError: entry.row?.lastError ?? null,
  };
}

/**
 * Ask the worker to copy these repositories to the target at once ("Catch up now"): a row without
 * an attempt is due in the next pass and taken first, and a worker looks for such rows every
 * half minute (apps/worker repository-copies, `copyRequested`). Rows not there yet are created as
 * `pending` by that pass and are due the same way.
 */
export async function requestCopies(
  tx: DbExecutor,
  tenantId: string,
  targetId: string,
  prefixes: readonly string[],
): Promise<number> {
  if (prefixes.length === 0) {
    return 0;
  }
  const updated = await tx
    .update(repositoryCopies)
    .set({ lastAttemptAt: null })
    .where(
      and(
        eq(repositoryCopies.tenantId, tenantId),
        eq(repositoryCopies.targetId, targetId),
        inArray(repositoryCopies.prefix, [...prefixes]),
      ),
    )
    .returning({ id: repositoryCopies.id });
  return updated.length;
}

// --- Carrying the restore points over -------------------------------------------------------

/** Every distinct snapshot id the database records for one repository, in any column. */
export function recordedSnapshotValues(
  tx: DbExecutor,
  tenantId: string,
  repository: Pick<PromotionRepository, "kind" | "ownerId">,
): Promise<string[]> {
  return recordedSnapshotIds(tx, tenantId, repository.kind, repository.ownerId);
}

/** The primary's listing of a machine's repository, or why there is none. */
export type PrimaryListing = readonly CopiedSnapshot[] | "unreadable" | null;

/**
 * The recorded ids a promotion must find on the copy, or it refuses:
 *
 *   - a container's and a file share's restore points that are not pruned (also those a hold
 *     keeps: retention prunes none while it stands);
 *   - for a machine, every snapshot the server still refers to and the primary still holds (a
 *     hold, a revoked machine or a write-once primary keep more than the retention rules would;
 *     snapshots no run reported but a record names are copied as well), its newest snapshot and
 *     every SQL backup still offered for a restore.
 *
 * `onPrimary` is the listing of the primary's repository (machines only; null for the others).
 * When the primary's repository cannot be read (damaged or gone: the copy may hold the only good
 * data), only the newest snapshot and the SQL backups still offered are required from the
 * database; that the copy holds the rest says its state, which a copy pass computed by listing
 * the primary while it could (`repositoryCopyReadiness`). The run history cannot stand in: runs
 * keep the ids of snapshots retention forgot long ago.
 */
export async function requiredSnapshotIds(
  tx: DbExecutor,
  tenantId: string,
  repository: Pick<PromotionRepository, "kind" | "ownerId">,
  onPrimary: PrimaryListing,
): Promise<string[]> {
  if (repository.kind === "container" || repository.kind === "file_share") {
    const query =
      repository.kind === "container"
        ? sql`SELECT restic_snapshot_id AS id FROM pve_snapshots
               WHERE tenant_id = ${tenantId} AND guest_id = ${repository.ownerId}
                 AND status = 'active' AND restic_snapshot_id IS NOT NULL`
        : sql`SELECT restic_snapshot_id AS id FROM file_share_snapshots
               WHERE tenant_id = ${tenantId} AND file_share_id = ${repository.ownerId}
                 AND status = 'active'`;
    const result = await tx.execute<{ id: string }>(query);
    return [...new Set(result.rows.map((row) => String(row.id)))];
  }
  const offered = await tx.execute<{ id: string }>(sql`
    SELECT last_snapshot_id AS id FROM endpoints
     WHERE tenant_id = ${tenantId} AND id = ${repository.ownerId} AND last_snapshot_id IS NOT NULL
    UNION
    SELECT restic_snapshot_id AS id FROM endpoint_sql_backups
     WHERE tenant_id = ${tenantId} AND endpoint_id = ${repository.ownerId} AND status = 'active'`);
  const required = new Set(offered.rows.map((row) => String(row.id)));
  if (onPrimary === "unreadable" || onPrimary === null) {
    return [...required];
  }
  for (const value of await recordedSnapshotValues(tx, tenantId, repository)) {
    if (onPrimary.some((snapshot) => snapshot.id.startsWith(value))) {
      required.add(value);
    }
  }
  return [...required];
}

/** What carrying one repository's recorded ids over to its copy came to. */
export interface SnapshotRemap {
  /** Required ids the copy does not hold (the promotion is refused when any is). */
  readonly missing: readonly string[];
  /** Distinct recorded ids rewritten. */
  readonly rewritten: number;
}

/**
 * Rewrite every recorded snapshot id of one repository to the id its copy holds it under
 * (`idOnCopy`, by the id itself or by the persistent id an earlier promotion recorded), and
 * record the persistent id of each (`restic_snapshot_origins`), in the caller's transaction.
 * Refuses (returns `missing`, changes nothing) when a required id is not on the copy.
 */
export async function remapRecordedSnapshots(
  tx: DbExecutor,
  tenantId: string,
  repository: Pick<PromotionRepository, "kind" | "ownerId" | "prefix">,
  copies: readonly CopiedSnapshot[],
  onPrimary: PrimaryListing,
): Promise<SnapshotRemap> {
  const origins = await loadSnapshotOrigins(tx, tenantId, repository.prefix);
  const find = (value: string) => matchOnCopy(copies, value, persistentOfRecorded(origins, value));
  const required = await requiredSnapshotIds(tx, tenantId, repository, onPrimary);
  const missing = required.filter((id) => find(id) === null);
  if (missing.length > 0) {
    return { missing, rewritten: 0 };
  }
  let rewritten = 0;
  const recordedOrigins = new Map<string, string>();
  for (const column of RECORDED_SNAPSHOT_COLUMNS[repository.kind]) {
    const pairs: [string, string][] = [];
    const values = await tx.execute<{ value: string }>(
      recordedColumnValuesSql(column, tenantId, repository.ownerId),
    );
    for (const value of values.rows.map((row) => String(row.value))) {
      const match = find(value);
      if (!match) {
        continue;
      }
      recordedOrigins.set(match.id, persistentIdOf(match));
      const next = value.length >= match.id.length ? match.id : match.id.slice(0, value.length);
      if (next !== value) {
        pairs.push([value, next]);
      }
    }
    if (pairs.length === 0) {
      continue;
    }
    await tx.execute(sql`
      UPDATE ${sql.raw(column.table)} AS t SET ${sql.raw(column.column)} = m.next
        FROM unnest(${toTextArray(pairs.map(([value]) => value))},
                    ${toTextArray(pairs.map(([, next]) => next))}) AS m(value, next)
       WHERE t.tenant_id = ${tenantId} AND t.${sql.raw(column.owner)} = ${repository.ownerId}
         AND t.${sql.raw(column.column)} = m.value${recordedColumnWhere(column, "t.")}`);
    rewritten += pairs.length;
  }
  if (recordedOrigins.size > 0) {
    await tx
      .insert(resticSnapshotOrigins)
      .values(
        [...recordedOrigins].map(([snapshotId, persistentId]) => ({
          tenantId,
          prefix: repository.prefix,
          snapshotId,
          persistentId,
        })),
      )
      .onConflictDoNothing();
  }
  return { missing: [], rewritten };
}

function toTextArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * How long one listing may take while the promotion holds the tenant's repository-copy lock: a
 * storage that hangs refuses the promotion and releases the lock instead of holding it.
 */
export const PROMOTION_LISTING_TIMEOUT_MS = 5 * 60 * 1000;

/** Lists the snapshots of a repository on the copy target being promoted, or on the primary. */
export type CopySnapshotLister = (input: {
  readonly backend: StorageBackend;
  readonly role: "copy" | "primary";
  readonly repository: PromotionRepository;
  readonly password: string;
}) => Promise<CopiedSnapshot[]>;

/** The cache folder restic uses for a repository (the copy is another repository: its own). */
function cacheKeyOf(repository: PromotionRepository, role: "copy" | "primary"): string {
  const own =
    repository.kind === "file_share"
      ? fileShareRepositoryKey(repository.ownerId)
      : repository.ownerId;
  return role === "copy" ? `${repository.ownerId}.copy` : own;
}

/** One `restic snapshots` against the repository (no lock). */
export const listCopySnapshots: CopySnapshotLister = async ({
  backend,
  role,
  repository,
  password,
}) => {
  const listed = await withRepository(
    {
      storage: backend,
      prefix: repository.prefix,
      repositoryPassword: password,
      repositoryKey: cacheKeyOf(repository, role),
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
    (session) =>
      resticSnapshots(session, { noLock: true, timeoutMs: PROMOTION_LISTING_TIMEOUT_MS }),
  );
  return listed.map((snapshot) => ({ id: snapshot.id, original: snapshot.original ?? null }));
};
