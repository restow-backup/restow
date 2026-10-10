import type { Readable } from "node:stream";
import {
  type DirectoryPosition,
  type OpenRepository,
  type RepositoryAccess,
  SHARE_SNAPSHOT_ROOT,
  SelectionError,
  fileShareRepositoryKey,
  fileShareRepositoryPrefix,
  openRepository,
  resolveSelection,
  resticBinary,
  resticCacheBase,
  resticListDirectory,
  streamSnapshotZip,
} from "@restow/core";
import {
  type Database,
  EndpointRepositoryBusyError,
  type FileShare,
  type FileShareSnapshot,
  acquireEndpointRepositoryLock,
  fileShareCatalog,
  fileShareDownloads,
  fileShareReports,
  fileShareSnapshots,
} from "@restow/db";
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { readSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { decodeCursor, encodeCursor } from "../../routes/v1/cursor.js";
import { tenantStorage } from "../endpoints/repository.js";
import { resticGate } from "../endpoints/restic-gate.js";
import { resticProblem } from "../endpoints/restic-problem.js";
import { FILE_SHARE_TENANT_AUDIT_ACTIONS as A, type FileShareActor, auditShare } from "./audit.js";
import { FILE_SHARE_PROBLEMS } from "./constants.js";
import { type ShareSnapshotDto, shareSnapshotDto } from "./dto.js";
import type { CreateDownloadInput } from "./schemas.js";
import { loadShare } from "./service.js";

/**
 * Reading a share's backups (docs/FILESHARES.md 9.1): the restore points, one folder of one
 * (restic through the loopback stack, `/share` shown as the root, `/.restow` hidden), the
 * catalog's search and version history (8.5), and ZIP downloads. Every read of content is
 * audited. A read holds the repository shared with other reads, never beside retention or the
 * check (the endpoints' advisory lock space, keyed `file-share:<id>` like the worker's).
 */

let snapshotRoot = SHARE_SNAPSHOT_ROOT;

/** Tests: where the share root is in the restore points they make (`/share` in production). */
export function setShareSnapshotRoot(root: string | null): void {
  snapshotRoot = root ?? SHARE_SNAPSHOT_ROOT;
}

/** A path below the share root (`/a/b`, `/`) as it is in a restore point. */
export function toSnapshotPath(sharePath: string): string {
  const clean = sharePath.replace(/^\/+|\/+$/g, "");
  return clean ? `${snapshotRoot}/${clean}` : snapshotRoot;
}

/** A path of a restore point as the browser shows it, or null outside the share root. */
export function toSharePath(snapshotPath: string): string | null {
  if (snapshotPath === snapshotRoot) {
    return "/";
  }
  return snapshotPath.startsWith(`${snapshotRoot}/`)
    ? snapshotPath.slice(snapshotRoot.length)
    : null;
}

const READ_LOCK_WAIT_MS = 2_000;

async function holdForRead(database: Database, shareId: string): Promise<() => Promise<void>> {
  try {
    return await acquireEndpointRepositoryLock(database.$client, `file-share:${shareId}`, {
      mode: "shared",
      waitMs: READ_LOCK_WAIT_MS,
      pollMs: 200,
    });
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      throw new ProblemError(503, "Repository busy", {
        type: FILE_SHARE_PROBLEMS.busy,
        detail:
          "The server is maintaining this file share's backups (retention or a check). Try again shortly.",
      });
    }
    throw error;
  }
}

function noRepository(): ProblemError {
  return new ProblemError(409, "No backups yet", {
    type: FILE_SHARE_PROBLEMS.repositoryUnavailable,
    detail: "This file share has no backups yet.",
  });
}

async function accessOf(database: Database, share: FileShare): Promise<RepositoryAccess> {
  if (!share.repositorySecretId) {
    throw noRepository();
  }
  const password = await readSecret(database, {
    id: share.repositorySecretId,
    tenantId: share.tenantId,
  });
  if (password === null) {
    throw noRepository();
  }
  const targets = await tenantStorage(database, share.tenantId);
  return {
    storage: targets.storage,
    prefix: fileShareRepositoryPrefix(share.id),
    repositoryPassword: password,
    repositoryKey: fileShareRepositoryKey(share.id),
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

async function openFor(
  database: Database,
  share: FileShare,
): Promise<() => Promise<OpenRepository>> {
  const access = await accessOf(database, share);
  return async () => {
    const release = await holdForRead(database, share.id);
    try {
      const repository = await openRepository(access);
      return {
        session: repository.session,
        close: async () => {
          try {
            await repository.close();
          } finally {
            await release();
          }
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  };
}

async function loadSnapshot(
  tx: Transaction,
  shareId: string,
  snapshotId: string,
): Promise<FileShareSnapshot> {
  const [row] = await tx
    .select()
    .from(fileShareSnapshots)
    .where(
      and(
        eq(fileShareSnapshots.fileShareId, shareId),
        eq(fileShareSnapshots.id, snapshotId),
        eq(fileShareSnapshots.status, "active"),
      ),
    )
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Restore point not found", {
      detail: "The restore point does not exist (any more) for this file share.",
    });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Restore points
// ---------------------------------------------------------------------------

export async function listSnapshots(
  database: Database,
  tenantId: string,
  id: string,
): Promise<{ items: ShareSnapshotDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    await loadShare(tx, tenantId, id);
    const rows = await tx
      .select()
      .from(fileShareSnapshots)
      .where(and(eq(fileShareSnapshots.fileShareId, id), eq(fileShareSnapshots.status, "active")))
      .orderBy(desc(fileShareSnapshots.sequence));
    const reports = await tx
      .select({
        snapshotId: fileShareReports.snapshotId,
        readiness: fileShareReports.readiness,
        checkedAt: fileShareReports.checkedAt,
      })
      .from(fileShareReports)
      .where(
        and(
          eq(fileShareReports.fileShareId, id),
          eq(fileShareReports.kind, "restore_test"),
          isNotNull(fileShareReports.snapshotId),
        ),
      )
      .orderBy(desc(fileShareReports.checkedAt));
    const newest = new Map<string, ShareSnapshotDto["verification"]>();
    for (const report of reports) {
      const key = report.snapshotId as string;
      if (!newest.has(key) && report.readiness) {
        newest.set(key, { state: report.readiness, checkedAt: report.checkedAt.toISOString() });
      }
    }
    return {
      items: rows.map((row) =>
        shareSnapshotDto(
          row,
          newest.get(row.resticSnapshotId) ?? { state: "unverified", checkedAt: null },
        ),
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

const browseCursorSchema = z.object({ g: z.enum(["0", "1"]), n: z.string().min(1).max(4096) });

function decodeBrowseCursor(raw: string | undefined): DirectoryPosition | null {
  try {
    const cursor = decodeCursor(browseCursorSchema, raw);
    return cursor ? { folder: cursor.g === "0", name: cursor.n } : null;
  } catch {
    throw new ProblemError(400, "Invalid cursor", {
      detail: "The cursor is not one this folder listing issued. Start again from the first page.",
    });
  }
}

export interface ShareBrowseEntryDto {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  mtime: string | null;
}

export interface ShareBrowseDto {
  snapshotId: string;
  path: string;
  entries: ShareBrowseEntryDto[];
  nextCursor: string | null;
  permissions: FileShareSnapshot["permissions"];
}

export async function browseSnapshot(
  database: Database,
  tenantId: string,
  id: string,
  query: { snapshot: string; path: string; limit: number; cursor?: string },
  actor: FileShareActor,
  signal?: AbortSignal,
): Promise<ShareBrowseDto> {
  const after = decodeBrowseCursor(query.cursor);
  const { share, snapshot } = await withTenantTx(database, tenantId, async (tx) => ({
    share: await loadShare(tx, tenantId, id),
    snapshot: await loadSnapshot(tx, id, query.snapshot),
  }));
  const open = await openFor(database, share);
  const listing = await resticGate.run(tenantId, async () => {
    const repository = await open();
    try {
      return await resticListDirectory(
        repository.session,
        snapshot.resticSnapshotId,
        toSnapshotPath(query.path),
        { limit: query.limit, after, signal },
      );
    } catch (error) {
      throw resticProblem(error);
    } finally {
      await repository.close();
    }
  });
  const entries = listing.entries.flatMap((entry): ShareBrowseEntryDto[] => {
    const path = toSharePath(entry.path);
    return path === null
      ? []
      : [{ name: entry.name, path, type: entry.type, size: entry.size, mtime: entry.mtime }];
  });
  const last = listing.entries.at(-1);
  const nextCursor =
    listing.hasMore && last
      ? encodeCursor({ g: last.type === "dir" ? "0" : "1", n: last.name })
      : null;
  await withTenantTx(database, tenantId, (tx) =>
    auditShare(tx, {
      tenantId,
      actor,
      action: A.browsed,
      shareId: id,
      details: {
        name: share.name,
        snapshot: snapshot.resticSnapshotId.slice(0, 8),
        path: query.path,
        entries: entries.length,
        continued: after !== null,
      },
    }),
  );
  return {
    snapshotId: snapshot.id,
    path: query.path,
    entries,
    nextCursor,
    permissions: snapshot.permissions,
  };
}

// ---------------------------------------------------------------------------
// Catalog (8.5)
// ---------------------------------------------------------------------------

function catalogUnavailable(): ProblemError {
  return new ProblemError(409, "Search not available", {
    type: FILE_SHARE_PROBLEMS.catalogUnavailable,
    detail:
      "Search is not available for this file share yet: its restore points are not in the catalog (or it has too many files).",
  });
}

export interface ShareSearchHitDto {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  /** The newest restore point that holds this version. */
  snapshotId: string | null;
  snapshotTime: string | null;
  /** The version is in the newest restore point. */
  current: boolean;
}

/** The newest active restore point whose sequence lies in [first, end). */
async function snapshotsIn(
  tx: Transaction,
  shareId: string,
): Promise<{ id: string; sequence: number; time: Date }[]> {
  return tx
    .select({
      id: fileShareSnapshots.id,
      sequence: fileShareSnapshots.sequence,
      time: fileShareSnapshots.snapshotTime,
    })
    .from(fileShareSnapshots)
    .where(
      and(eq(fileShareSnapshots.fileShareId, shareId), eq(fileShareSnapshots.status, "active")),
    )
    .orderBy(desc(fileShareSnapshots.sequence));
}

function newestIn(
  points: readonly { id: string; sequence: number; time: Date }[],
  first: number,
  end: number | null,
) {
  return points.find((point) => point.sequence >= first && (end === null || point.sequence < end));
}

export async function searchCatalog(
  database: Database,
  tenantId: string,
  id: string,
  query: { q: string; snapshot?: string; limit: number },
  actor: FileShareActor,
): Promise<{ items: ShareSearchHitDto[]; truncated: boolean }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (!share.lastCatalogAt) {
      throw catalogUnavailable();
    }
    const points = await snapshotsIn(tx, id);
    let sequence: number | null = null;
    if (query.snapshot) {
      sequence = (await loadSnapshot(tx, id, query.snapshot)).sequence;
    }
    const term = `%${query.q.toLowerCase().replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
    const rows = await tx
      .select()
      .from(fileShareCatalog)
      .where(
        and(
          eq(fileShareCatalog.fileShareId, id),
          sql`lower(${fileShareCatalog.name}) LIKE ${term}`,
          sequence === null
            ? undefined
            : and(
                sql`${fileShareCatalog.firstSeq} <= ${sequence}`,
                or(isNull(fileShareCatalog.endSeq), gt(fileShareCatalog.endSeq, sequence)),
              ),
        ),
      )
      .orderBy(
        sql`${fileShareCatalog.endSeq} IS NOT NULL`,
        fileShareCatalog.path,
        desc(fileShareCatalog.firstSeq),
      )
      .limit(query.limit * 4 + 1);
    // One hit per path: its newest version (in the restore point asked for).
    const seen = new Set<string>();
    const items: ShareSearchHitDto[] = [];
    for (const row of rows) {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      const point =
        sequence !== null
          ? points.find((candidate) => candidate.sequence === sequence)
          : newestIn(points, row.firstSeq, row.endSeq);
      items.push({
        path: `/${row.path}`,
        name: row.name,
        size: row.size,
        mtime: row.mtime ? row.mtime.toISOString() : null,
        snapshotId: point?.id ?? null,
        snapshotTime: point ? point.time.toISOString() : null,
        current: row.endSeq === null,
      });
      if (items.length >= query.limit) break;
    }
    await auditShare(tx, {
      tenantId,
      actor,
      action: A.searched,
      shareId: id,
      details: { name: share.name, q: query.q, hits: items.length },
    });
    return { items, truncated: rows.length > items.length && items.length >= query.limit };
  });
}

export interface ShareVersionDto {
  size: number;
  mtime: string | null;
  firstSequence: number;
  endSequence: number | null;
  /** The newest restore point that holds this version; null when retention removed them all. */
  snapshotId: string | null;
  snapshotTime: string | null;
  /** The oldest restore point that holds it. */
  since: string | null;
  current: boolean;
}

export async function fileVersions(
  database: Database,
  tenantId: string,
  id: string,
  path: string,
): Promise<{ path: string; items: ShareVersionDto[] }> {
  return withTenantTx(database, tenantId, async (tx) => {
    const share = await loadShare(tx, tenantId, id);
    if (!share.lastCatalogAt) {
      throw catalogUnavailable();
    }
    const relative = path.replace(/^\/+/, "");
    const points = await snapshotsIn(tx, id);
    const rows = await tx
      .select()
      .from(fileShareCatalog)
      .where(and(eq(fileShareCatalog.fileShareId, id), eq(fileShareCatalog.path, relative)))
      .orderBy(desc(fileShareCatalog.firstSeq));
    return {
      path,
      items: rows.map((row) => {
        const newest = newestIn(points, row.firstSeq, row.endSeq);
        const oldest = [...points]
          .reverse()
          .find(
            (point) =>
              point.sequence >= row.firstSeq &&
              (row.endSeq === null || point.sequence < row.endSeq),
          );
        return {
          size: row.size,
          mtime: row.mtime ? row.mtime.toISOString() : null,
          firstSequence: row.firstSeq,
          endSequence: row.endSeq,
          snapshotId: newest?.id ?? null,
          snapshotTime: newest ? newest.time.toISOString() : null,
          since: oldest ? oldest.time.toISOString() : null,
          current: row.endSeq === null,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// ZIP downloads
// ---------------------------------------------------------------------------

export const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_KEEP_MS = 60 * 60 * 1000;

function downloadGone(): ProblemError {
  return new ProblemError(404, "Download not found", {
    type: FILE_SHARE_PROBLEMS.downloadGone,
    detail: "The download is unknown, has expired or was started already. Prepare it again.",
  });
}

export interface PreparedShareDownloadDto {
  id: string;
  expiresAt: string;
  items: number;
}

/** Step one: check the selection against the restore point and keep it (single use, 10 minutes). */
export async function prepareDownload(
  database: Database,
  tenantId: string,
  id: string,
  input: CreateDownloadInput,
  actor: FileShareActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<PreparedShareDownloadDto> {
  const { share, snapshot } = await withTenantTx(database, tenantId, async (tx) => ({
    share: await loadShare(tx, tenantId, id),
    snapshot: await loadSnapshot(tx, id, input.snapshotId),
  }));
  const open = await openFor(database, share);
  const release = resticGate.acquire(tenantId);
  let repository: OpenRepository | null = null;
  try {
    repository = await open();
    const selection = await resolveSelection(
      repository.session,
      snapshot.resticSnapshotId,
      input.paths.map(toSnapshotPath),
      { signal },
    ).catch((error) => {
      if (error instanceof SelectionError) {
        throw new ProblemError(404, "Path not found in the restore point", {
          type: FILE_SHARE_PROBLEMS.pathNotFound,
          detail: "A selected path is not a file or folder of this restore point.",
        });
      }
      throw resticProblem(error);
    });
    const expiresAt = new Date(now.getTime() + DOWNLOAD_TTL_MS);
    const row = await withTenantTx(database, tenantId, async (tx) => {
      await tx
        .delete(fileShareDownloads)
        .where(
          and(
            eq(fileShareDownloads.tenantId, tenantId),
            lt(fileShareDownloads.expiresAt, new Date(now.getTime() - DOWNLOAD_KEEP_MS)),
          ),
        );
      const [created] = await tx
        .insert(fileShareDownloads)
        .values({
          tenantId,
          fileShareId: id,
          snapshotId: snapshot.id,
          selection,
          createdBy: actor.userId,
          createdAt: now,
          expiresAt,
        })
        .returning();
      if (!created) {
        throw new Error("download insert returned no row");
      }
      await auditShare(tx, {
        tenantId,
        actor,
        action: A.downloadCreated,
        shareId: id,
        details: {
          name: share.name,
          snapshot: snapshot.resticSnapshotId.slice(0, 8),
          downloadId: created.id,
          paths: input.paths.slice(0, 50),
          pathCount: input.paths.length,
        },
      });
      return created;
    });
    return { id: row.id, expiresAt: row.expiresAt.toISOString(), items: selection.length };
  } finally {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
  }
}

/** Step two: start a prepared download, once, by the admin who prepared it; streamed. */
export async function openDownload(
  database: Database,
  tenantId: string,
  id: string,
  downloadId: string,
  actor: FileShareActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<{ stream: Readable; fileName: string }> {
  const share = await withTenantTx(database, tenantId, (tx) => loadShare(tx, tenantId, id));
  const open = await openFor(database, share);
  const release = resticGate.acquire(tenantId);
  let repository: OpenRepository | null = null;
  try {
    repository = await open();
    const claimed = await withTenantTx(database, tenantId, async (tx) => {
      const [row] = await tx
        .update(fileShareDownloads)
        .set({ startedAt: now })
        .where(
          and(
            eq(fileShareDownloads.tenantId, tenantId),
            eq(fileShareDownloads.fileShareId, id),
            eq(fileShareDownloads.id, downloadId),
            actor.userId
              ? eq(fileShareDownloads.createdBy, actor.userId)
              : isNull(fileShareDownloads.createdBy),
            isNull(fileShareDownloads.startedAt),
            gt(fileShareDownloads.expiresAt, now),
          ),
        )
        .returning();
      if (!row) {
        return null;
      }
      const [snapshot] = await tx
        .select()
        .from(fileShareSnapshots)
        .where(eq(fileShareSnapshots.id, row.snapshotId))
        .limit(1);
      await auditShare(tx, {
        tenantId,
        actor,
        action: A.downloaded,
        shareId: id,
        details: {
          name: share.name,
          downloadId: row.id,
          paths: row.selection.slice(0, 50).map((item) => toSharePath(item.path) ?? item.path),
          pathCount: row.selection.length,
        },
      });
      return snapshot ? { row, snapshot } : null;
    });
    if (!claimed) {
      throw downloadGone();
    }
    const zip = streamSnapshotZip({
      session: repository.session,
      snapshotId: claimed.snapshot.resticSnapshotId,
      paths: claimed.row.selection.map((item) => item.path),
      selection: claimed.row.selection,
      signal,
      comment: `Restow file share backup, ${share.name}, restore point ${claimed.snapshot.resticSnapshotId.slice(0, 8)}`,
    });
    const opened = repository;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      void opened.close().finally(release);
    };
    zip.stream.once("close", finish);
    zip.stream.once("error", finish);
    return { stream: zip.stream, fileName: `${share.name}-${zip.fileName}` };
  } catch (error) {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
    throw error;
  }
}
