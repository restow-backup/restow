import {
  resticBinary,
  resticCacheBase,
  resticSnapshots,
  snapshotIdIn,
  withRepository,
} from "@restow/core";
import { storageGenerationSql } from "@restow/db";
import { sql } from "drizzle-orm";
import { providerDb } from "../../db.js";
import { ProblemError } from "../../problem.js";
import { type SearchedTarget, searchedTargets, tenantChunkStore } from "../pve/store.js";

/**
 * Where a restore reads a restic repository from (docs/STORAGE.md, "restic repositories on
 * copies", "Restoring from a copy"): the primary while it holds the repository, else the first
 * other target that does: a copy target's repository copy, a retired target, the installation
 * default. The same search and order as the credentials of container and file share restores
 * (`holdingTarget`, `pinShareRun`), so the snapshot id a restore is handed and the target its
 * credential points at agree.
 *
 * A repository copy holds each restore point under an id of its own (`restic copy` keeps the
 * primary's as `original`), while the database records the primary's: {@link snapshotOnSource}
 * translates before restic on a node, in a runner or on a machine is told what to restore.
 */
export interface RepositorySource {
  readonly target: SearchedTarget;
  /** Another target than the primary holds the repository: the restore reads from it. */
  readonly fallback: boolean;
}

/** What a run, a report and an audit entry say about a restore that read from another target. */
export interface ReadFrom {
  /** A target id, or `installation_default`. */
  readonly targetId: string;
  /** The target's name; null for the installation default and its own copy. */
  readonly targetName: string | null;
  readonly role: SearchedTarget["role"];
}

export function readFromOf(source: RepositorySource): ReadFrom | null {
  return source.fallback
    ? { targetId: source.target.id, targetName: source.target.name, role: source.target.role }
    : null;
}

/** {@link ReadFrom} of a stored value (a task's parameters, a run's statistics), or null. */
export function readFromIn(value: unknown): ReadFrom | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { targetId, targetName, role } = value as Record<string, unknown>;
  if (typeof targetId !== "string" || typeof role !== "string") {
    return null;
  }
  return {
    targetId,
    targetName: typeof targetName === "string" ? targetName : null,
    role: role as ReadFrom["role"],
  };
}

async function currentGeneration(tenantId: string): Promise<string | undefined> {
  try {
    const result = await providerDb.execute(
      sql`select ${storageGenerationSql(tenantId)} as generation`,
    );
    const value = (result.rows[0] as { generation?: unknown } | undefined)?.generation;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The target that holds the repository under `prefix`: the primary first, then the tenant's
 * other targets in their order, then the installation default. The primary when none does (its
 * `fallback` is false: nothing to read from elsewhere, restic says the repository is missing).
 */
export async function repositorySource(
  tenantId: string,
  prefix: string,
): Promise<RepositorySource> {
  // The targets of the tenant's current storage generation: a copy target added a moment ago
  // is searched, a removed one is not.
  const store = await tenantChunkStore(tenantId, Date.now(), await currentGeneration(tenantId));
  const targets = await searchedTargets(store);
  const primary = targets.find((target) => target.id === store.primaryTarget) ?? targets[0];
  if (!primary) {
    throw new Error(`tenant ${tenantId} has no storage target`);
  }
  for (const target of [primary, ...targets.filter((other) => other !== primary)]) {
    if (await target.backend.head(`${prefix}config`).catch(() => null)) {
      return { target, fallback: target !== primary };
    }
  }
  return { target: primary, fallback: false };
}

/**
 * The source a run pinned to `targetId` reads (`file_share_runs.storage_target`,
 * `pve_runs.storage_target`): that target, and whether it is another than the primary. Null for
 * a target the tenant no longer has.
 */
export async function sourceOfTarget(
  tenantId: string,
  targetId: string,
): Promise<RepositorySource | null> {
  const store = await tenantChunkStore(tenantId, Date.now(), await currentGeneration(tenantId));
  const target = (await searchedTargets(store)).find((entry) => entry.id === targetId);
  return target ? { target, fallback: target.id !== store.primaryTarget } : null;
}

/** The restore point is not in the repository the restore would read. */
export function restorePointNotOnSource(source: RepositorySource): ProblemError {
  return new ProblemError(409, "Restore point not on the copy", {
    type: "urn:restow:problem:storage-restore-point-not-on-copy",
    detail: `The primary storage target no longer holds this repository, and its copy on ${
      source.target.name ? `"${source.target.name}"` : "another storage target"
    } does not hold this restore point (it was not copied yet, or retention on the copy removed it).`,
    extensions: { targetId: source.target.id, targetName: source.target.name },
  });
}

/**
 * The id under which `source` holds the restic snapshot `id` (the primary's id, as the database
 * records it; an id of the source itself is taken as it is): `id` on the primary, the snapshot
 * copied from it on a fallback target. One `restic snapshots` against the fallback target, none
 * on the primary. Throws {@link restorePointNotOnSource} when the fallback target does not hold
 * it, so a restore says why before restic on the node reports "no matching ID".
 */
export async function snapshotOnSource(
  source: RepositorySource,
  repository: { prefix: string; password: string; repositoryKey: string },
  id: string,
): Promise<string> {
  if (!source.fallback) {
    return id;
  }
  const listed = await withRepository(
    {
      storage: source.target.backend,
      prefix: repository.prefix,
      repositoryPassword: repository.password,
      repositoryKey: repository.repositoryKey,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
    (session) => resticSnapshots(session, { noLock: true }),
  );
  const found = snapshotIdIn(listed, id);
  if (!found) {
    throw restorePointNotOnSource(source);
  }
  return found;
}
