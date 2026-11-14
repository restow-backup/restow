import {
  endpointPrefix,
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
  type RepositoryCopy,
  repositoryCopies,
  type StorageTarget,
} from "@restow/db";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";
import {
  type CopiedSnapshot,
  idOnCopy,
  type RepositoryCopyFacts,
  type RepositoryCopyReadiness,
  repositoryCopyReadiness,
} from "./rules.js";

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

/** A column that records restic snapshot ids of one kind of repository, and its owner column. */
interface RecordedColumn {
  readonly table: string;
  readonly column: string;
  readonly owner: string;
}

/**
 * Every column that records a restic snapshot id of a repository (fixed identifiers, never input):
 * the restore points themselves and what refers to them (samples for restore tests, reports,
 * flags, downloads, SQL backups, a machine's newest snapshot).
 */
const RECORDED_COLUMNS: Record<RepositoryOwnerKind, readonly RecordedColumn[]> = {
  container: [{ table: "pve_snapshots", column: "restic_snapshot_id", owner: "guest_id" }],
  file_share: [
    { table: "file_share_snapshots", column: "restic_snapshot_id", owner: "file_share_id" },
    { table: "file_share_samples", column: "snapshot_id", owner: "file_share_id" },
    { table: "file_share_reports", column: "snapshot_id", owner: "file_share_id" },
  ],
  machine: [
    { table: "endpoints", column: "last_snapshot_id", owner: "id" },
    { table: "endpoint_runs", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_samples", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_reports", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_snapshot_flags", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_downloads", column: "snapshot_id", owner: "endpoint_id" },
    { table: "endpoint_sql_backups", column: "restic_snapshot_id", owner: "endpoint_id" },
  ],
};

/**
 * The recorded ids a promotion must find on the copy, or it refuses: a container's and a file
 * share's restore points that are not pruned, and a machine's newest snapshot. The other restore
 * points of a machine follow its retention (the copy keeps what the primary's retention keeps,
 * which the copy's state says, `repositoryCopyReadiness`); a recorded id the copy does not hold
 * is left as it is.
 */
export async function requiredSnapshotIds(
  tx: DbExecutor,
  tenantId: string,
  repository: Pick<PromotionRepository, "kind" | "ownerId">,
): Promise<string[]> {
  const query =
    repository.kind === "container"
      ? sql`SELECT restic_snapshot_id AS id FROM pve_snapshots
             WHERE tenant_id = ${tenantId} AND guest_id = ${repository.ownerId}
               AND status = 'active' AND restic_snapshot_id IS NOT NULL`
      : repository.kind === "file_share"
        ? sql`SELECT restic_snapshot_id AS id FROM file_share_snapshots
               WHERE tenant_id = ${tenantId} AND file_share_id = ${repository.ownerId}
                 AND status = 'active'`
        : sql`SELECT last_snapshot_id AS id FROM endpoints
               WHERE tenant_id = ${tenantId} AND id = ${repository.ownerId}
                 AND last_snapshot_id IS NOT NULL`;
  const result = await tx.execute<{ id: string }>(query);
  return [...new Set(result.rows.map((row) => String(row.id)))];
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
 * (`idOnCopy`), in the caller's transaction. Refuses (returns `missing`, changes nothing) when a
 * required id is not on the copy.
 */
export async function remapRecordedSnapshots(
  tx: DbExecutor,
  tenantId: string,
  repository: Pick<PromotionRepository, "kind" | "ownerId">,
  copies: readonly CopiedSnapshot[],
): Promise<SnapshotRemap> {
  const required = await requiredSnapshotIds(tx, tenantId, repository);
  const missing = required.filter((id) => idOnCopy(copies, id) === null);
  if (missing.length > 0) {
    return { missing, rewritten: 0 };
  }
  let rewritten = 0;
  for (const { table, column, owner } of RECORDED_COLUMNS[repository.kind]) {
    const values = await tx.execute<{ value: string }>(sql`
      SELECT DISTINCT ${sql.raw(column)} AS value FROM ${sql.raw(table)}
       WHERE tenant_id = ${tenantId} AND ${sql.raw(owner)} = ${repository.ownerId}
         AND ${sql.raw(column)} IS NOT NULL`);
    const pairs: [string, string][] = [];
    for (const { value } of values.rows) {
      const next = idOnCopy(copies, String(value));
      if (next !== null && next !== value) {
        pairs.push([String(value), next]);
      }
    }
    if (pairs.length === 0) {
      continue;
    }
    await tx.execute(sql`
      UPDATE ${sql.raw(table)} AS t SET ${sql.raw(column)} = m.next
        FROM unnest(${toTextArray(pairs.map(([value]) => value))},
                    ${toTextArray(pairs.map(([, next]) => next))}) AS m(value, next)
       WHERE t.tenant_id = ${tenantId} AND t.${sql.raw(owner)} = ${repository.ownerId}
         AND t.${sql.raw(column)} = m.value`);
    rewritten += pairs.length;
  }
  return { missing: [], rewritten };
}

function toTextArray(values: readonly string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

/** Lists the snapshots of a repository copy on the target being promoted. */
export type CopySnapshotLister = (input: {
  readonly backend: StorageBackend;
  readonly target: Pick<StorageTarget, "id">;
  readonly repository: PromotionRepository;
  readonly password: string;
}) => Promise<CopiedSnapshot[]>;

/** One `restic snapshots` against the repository copy (no lock; a cache folder of the copy's). */
export const listCopySnapshots: CopySnapshotLister = async ({ backend, repository, password }) => {
  const listed = await withRepository(
    {
      storage: backend,
      prefix: repository.prefix,
      repositoryPassword: password,
      // The worker's cache folder of the copy (another repository: its own id and keys).
      repositoryKey: `${repository.ownerId}.copy`,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
    (session) => resticSnapshots(session, { noLock: true }),
  );
  return listed.map((snapshot) => ({ id: snapshot.id, original: snapshot.original ?? null }));
};
