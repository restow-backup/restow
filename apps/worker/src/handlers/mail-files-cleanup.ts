/**
 * Housekeeping for mail file import and export (docs/IMPORT.md), run inside the
 * `retention` job of every tenant.
 *
 *   staged uploads   temporary by definition: deleted when they expired without
 *                    being used, when the person cancelled them, and when the
 *                    import that consumed them ended for good (finished, failed
 *                    without retry, cancelled). While an import can still be
 *                    retried its staged files stay.
 *   finished exports the download link expires; the file is deleted at that
 *                    point and the row keeps a `purged_at`.
 *   failed exports   an export that failed or was cancelled has no expiry (it never got a
 *                    file), but a worker that died while writing can leave segments:
 *                    they are deleted an hour after the job ended, so a run that is
 *                    still stopping is not cut off, and the row is marked purged.
 *   stray scopes     nothing else lives under tenants/<tid>/staging or tenants/<tid>/exports,
 *                    so a scope that no row knows (its rows went with the tenant's data, an
 *                    upload that was never recorded) is deleted as well.
 *
 * Both areas are also counted against the tenant's storage budgets
 * (docs/IMPORT.md), so what is left behind is not only untidy but takes room.
 */
import { mailfiles } from "@restow/core";
import { importUploads, jobs, mailExports, mailImports, safeErrorMessage } from "@restow/db";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { withTenantTx } from "./framework.js";
import type { RetentionTask } from "./retention.js";

/** Job states after which an import or export never runs again. */
const TERMINAL: readonly string[] = ["completed", "failed", "cancelled"];
/** A run that ended this long ago is not still writing: its leftovers can go. */
const FAILED_EXPORT_GRACE_MS = 3_600_000;
/** An upload or export whose job row vanished is judged by its own age. */
const ORPHAN_GRACE_MS = 48 * 3_600_000;
/** Ids looked up in the database per query. */
const ID_BATCH = 500;

export interface MailFilesCleanupSummary {
  readonly uploadsExpired: number;
  readonly uploadsCleared: number;
  readonly exportsPurged: number;
  readonly failedExportsPurged: number;
  readonly strayScopesRemoved: number;
  readonly errors: number;
  readonly dryRun: boolean;
}

export const mailFilesCleanupTask: RetentionTask = {
  name: "mail-files",

  async run(ctx, options): Promise<Record<string, unknown>> {
    const logger = ctx.logger.child({ task: "mail-files" });
    const segments = new mailfiles.SegmentStore({ storage: ctx.storage.primary, keys: ctx.keys });
    const now = ctx.now();
    let uploadsExpired = 0;
    let uploadsCleared = 0;
    let exportsPurged = 0;
    let failedExportsPurged = 0;
    let strayScopesRemoved = 0;
    let errors = 0;

    const removeScope = async (scope: mailfiles.SegmentScope): Promise<boolean> => {
      try {
        await segments.delete(scope);
        return true;
      } catch (error) {
        errors++;
        logger.warn("could not delete staged or exported segments", {
          id: scope.id,
          errorMessage: safeErrorMessage(error),
        });
        return false;
      }
    };

    // 1. Uploads that expired without being used.
    const expired = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
      tx
        .select({ id: importUploads.id })
        .from(importUploads)
        .where(
          and(
            eq(importUploads.tenantId, ctx.tenantId),
            inArray(importUploads.status, ["uploading", "ready"]),
            lt(importUploads.expiresAt, now),
          ),
        )
        .limit(500),
    );
    for (const upload of expired) {
      if (options.dryRun) {
        uploadsExpired++;
        continue;
      }
      if (await removeScope({ tenantId: ctx.tenantId, kind: "staging", id: upload.id })) {
        await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          tx
            .update(importUploads)
            .set({ status: "expired" })
            .where(and(eq(importUploads.tenantId, ctx.tenantId), eq(importUploads.id, upload.id))),
        );
        uploadsExpired++;
      }
    }

    // 2. Cancelled uploads, and uploads of imports that ended for good.
    const finished = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
      tx
        .select({ id: importUploads.id, status: importUploads.status, jobStatus: jobs.status })
        .from(importUploads)
        .leftJoin(mailImports, eq(mailImports.id, importUploads.importId))
        .leftJoin(jobs, eq(jobs.id, mailImports.jobId))
        .where(
          and(
            eq(importUploads.tenantId, ctx.tenantId),
            or(
              eq(importUploads.status, "cancelled"),
              and(eq(importUploads.status, "consumed"), inArray(jobs.status, TERMINAL as never)),
              // The import or its job row is gone and the worker's own clean-up never ran.
              and(
                eq(importUploads.status, "consumed"),
                isNull(jobs.id),
                lt(importUploads.updatedAt, new Date(now.getTime() - ORPHAN_GRACE_MS)),
              ),
            ),
          ),
        )
        .limit(500),
    );
    for (const upload of finished) {
      const scope: mailfiles.SegmentScope = {
        tenantId: ctx.tenantId,
        kind: "staging",
        id: upload.id,
      };
      if (options.dryRun) {
        if ((await segments.indexes(scope)).length > 0) {
          uploadsCleared++;
        }
        continue;
      }
      const left = await segments.indexes(scope).catch(() => []);
      if (left.length === 0) {
        continue;
      }
      if (await removeScope(scope)) {
        uploadsCleared++;
      }
    }

    // 3. Exports whose download link ran out, and exports that ended without a file.
    const due = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
      tx
        .select({ id: mailExports.id })
        .from(mailExports)
        .where(
          and(
            eq(mailExports.tenantId, ctx.tenantId),
            isNull(mailExports.purgedAt),
            isNotNull(mailExports.expiresAt),
            lt(mailExports.expiresAt, now),
          ),
        )
        .limit(500),
    );
    for (const item of due) {
      if (options.dryRun) {
        exportsPurged++;
        continue;
      }
      if (await removeScope({ tenantId: ctx.tenantId, kind: "export", id: item.id })) {
        await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          tx
            .update(mailExports)
            .set({ purgedAt: now })
            .where(and(eq(mailExports.tenantId, ctx.tenantId), eq(mailExports.id, item.id))),
        );
        exportsPurged++;
      }
    }

    // 4. Exports that ended without a file.
    const ended = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
      tx
        .select({ id: mailExports.id })
        .from(mailExports)
        .leftJoin(jobs, eq(jobs.id, mailExports.jobId))
        .where(
          and(
            eq(mailExports.tenantId, ctx.tenantId),
            isNull(mailExports.purgedAt),
            isNull(mailExports.expiresAt),
            or(
              and(
                inArray(jobs.status, ["failed", "cancelled"]),
                lt(
                  sql`coalesce(${jobs.completedAt}, ${jobs.updatedAt})`,
                  new Date(now.getTime() - FAILED_EXPORT_GRACE_MS),
                ),
              ),
              and(
                isNull(jobs.id),
                lt(mailExports.createdAt, new Date(now.getTime() - ORPHAN_GRACE_MS)),
              ),
            ),
          ),
        )
        .limit(500),
    );
    for (const item of ended) {
      if (options.dryRun) {
        failedExportsPurged++;
        continue;
      }
      if (await removeScope({ tenantId: ctx.tenantId, kind: "export", id: item.id })) {
        await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          tx
            .update(mailExports)
            .set({ purgedAt: now })
            .where(and(eq(mailExports.tenantId, ctx.tenantId), eq(mailExports.id, item.id))),
        );
        failedExportsPurged++;
      }
    }

    // 5. Scopes in storage that no row knows.
    const known = async (kind: "staging" | "export", ids: string[]): Promise<Set<string>> => {
      const found = new Set<string>();
      for (let offset = 0; offset < ids.length; offset += ID_BATCH) {
        const batch = ids.slice(offset, offset + ID_BATCH);
        const rows = await withTenantTx(ctx.db, ctx.tenantId, (tx) =>
          kind === "staging"
            ? tx
                .select({ id: importUploads.id })
                .from(importUploads)
                .where(
                  and(eq(importUploads.tenantId, ctx.tenantId), inArray(importUploads.id, batch)),
                )
            : tx
                .select({ id: mailExports.id })
                .from(mailExports)
                .where(and(eq(mailExports.tenantId, ctx.tenantId), inArray(mailExports.id, batch))),
        );
        for (const row of rows) {
          found.add(row.id);
        }
      }
      return found;
    };
    for (const kind of ["staging", "export"] as const) {
      let scopeIds: string[];
      try {
        scopeIds = (await segments.scopeIds(ctx.tenantId, kind)).filter((id) => isUuidLike(id));
      } catch (error) {
        errors++;
        logger.warn("could not list the stored segments", {
          kind,
          errorMessage: safeErrorMessage(error),
        });
        continue;
      }
      const rows = await known(kind, scopeIds);
      for (const id of scopeIds.filter((candidate) => !rows.has(candidate))) {
        if (options.dryRun) {
          strayScopesRemoved++;
          continue;
        }
        if (await removeScope({ tenantId: ctx.tenantId, kind, id })) {
          strayScopesRemoved++;
        }
      }
    }

    const summary: MailFilesCleanupSummary = {
      uploadsExpired,
      uploadsCleared,
      exportsPurged,
      failedExportsPurged,
      strayScopesRemoved,
      errors,
      dryRun: options.dryRun,
    };
    logger.info("mail file cleanup finished", { ...summary });
    return { ...summary };
  },
};

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Scope ids of this feature are UUIDs; anything else under the prefix is not ours to delete. */
function isUuidLike(id: string): boolean {
  return UUID_LIKE.test(id);
}
