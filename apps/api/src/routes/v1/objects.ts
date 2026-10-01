import {
  type Database,
  type ProtectedObject,
  type Source,
  protectedObjects,
  sources,
  users,
} from "@restow/db";
import { type SQL, and, asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { failureDto } from "../../features/failures/dto.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps } from "./api.js";
import { V1_AUDIT_ACTIONS, presentFilters, readRecorder } from "./audit.js";
import { component } from "./components.js";
import {
  afterCreated,
  createdAtMs,
  createdCursorOf,
  createdCursorSchema,
  decodeCursor,
  slicePage,
} from "./cursor.js";
import {
  NO_FACTS,
  type ObjectFacts,
  loadObjectFacts,
  objectReadinessSchema,
  readinessOf,
} from "./facts.js";
import {
  failureSchema,
  jobStatusSchema,
  objectKindSchema,
  objectStatusSchema,
  pageQuerySchema,
  pageSchema,
  sourceKindSchema,
  timestampSchema,
  uuidSchema,
} from "./schemas.js";

/**
 * GET /objects — the protected objects of the tenant with their newest
 * restorable snapshot, its size, the newest backup job and the readiness.
 * Paged in insertion order so a PSA can mirror the list; `total` counts every
 * match (e.g. the protected mailboxes on the first of the month for billing).
 */

export const objectsQuerySchema = pageQuerySchema(100).extend({
  kind: objectKindSchema.optional(),
  status: objectStatusSchema.optional(),
  sourceId: uuidSchema.optional().describe("Only objects of this source."),
});
export type ObjectsQuery = z.infer<typeof objectsQuerySchema>;

export const lastSnapshotSchema = component(
  "SnapshotSummary",
  z
    .object({
      id: uuidSchema,
      sequence: z.number().int(),
      completedAt: timestampSchema.nullable(),
      itemCount: z.number().int(),
      byteSize: z.number().int().describe("Logical size of the snapshot in bytes."),
    })
    .describe("The newest snapshot that can be restored."),
);

export const lastBackupJobSchema = component(
  "BackupJobSummary",
  z.object({
    id: uuidSchema,
    status: jobStatusSchema,
    createdAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    errorMessage: z.string().nullable(),
    failure: failureSchema
      .nullable()
      .describe("Why that backup failed, with the steps to fix it; null when it did not fail."),
  }),
);

export const protectedObjectSchema = component(
  "ProtectedObject",
  z.object({
    id: uuidSchema,
    kind: objectKindSchema,
    status: objectStatusSchema,
    origin: z.enum(["directory_sync", "manual"]),
    externalId: z.string().describe("Mailbox address, drive id or IMAP login."),
    displayName: z.string().nullable(),
    source: z.object({ id: uuidSchema, name: z.string(), kind: sourceKindSchema }),
    userId: uuidSchema.nullable().describe("Directory user the object belongs to."),
    email: z.string().nullable(),
    upn: z.string().nullable(),
    lastSnapshot: lastSnapshotSchema.nullable(),
    byteSize: z.number().int().describe("Size of the newest restorable snapshot; 0 without one."),
    lastBackupJob: lastBackupJobSchema.nullable(),
    readiness: objectReadinessSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export type ProtectedObjectDto = z.infer<typeof protectedObjectSchema>;

export const objectsPageSchema = component(
  "ProtectedObjectPage",
  pageSchema(protectedObjectSchema).extend({
    total: z.number().int().describe("Objects matching the filters, over all pages."),
  }),
);
export type ObjectsPageDto = z.infer<typeof objectsPageSchema>;

export interface ObjectRow {
  object: ProtectedObject;
  source: { id: Source["id"]; name: Source["name"]; kind: "m365" | "imap" };
  email: string | null;
  upn: string | null;
}

export function toProtectedObjectDto(
  row: ObjectRow,
  facts: ObjectFacts,
  now: Date,
): ProtectedObjectDto {
  const { object } = row;
  const { snapshot, job } = facts;
  return {
    id: object.id,
    kind: object.kind,
    status: object.status,
    origin: object.origin,
    externalId: object.externalId,
    displayName: object.displayName,
    source: row.source,
    userId: object.userId,
    email: row.email,
    upn: row.upn,
    lastSnapshot: snapshot
      ? {
          id: snapshot.id,
          sequence: snapshot.sequence,
          completedAt: snapshot.completedAt?.toISOString() ?? null,
          itemCount: snapshot.itemCount,
          byteSize: snapshot.byteSize,
        }
      : null,
    byteSize: snapshot?.byteSize ?? 0,
    lastBackupJob: job
      ? {
          id: job.id,
          status: job.status,
          createdAt: job.createdAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
          errorMessage: job.errorMessage,
          failure: job.status === "completed" ? null : failureDto(job.failure),
        }
      : null,
    readiness: readinessOf(facts, now),
    createdAt: object.createdAt.toISOString(),
    updatedAt: object.updatedAt.toISOString(),
  };
}

function objectFilters(tenantId: string, query: ObjectsQuery): SQL[] {
  // Imported mailboxes (source kind `import`) are not protected objects: nothing is
  // backed up from them, so the integration API never lists them (docs/IMPORT.md).
  const filters: SQL[] = [
    eq(protectedObjects.tenantId, tenantId),
    sql`${protectedObjects.sourceId} NOT IN (SELECT id FROM sources WHERE kind = 'import')`,
  ];
  if (query.kind) {
    filters.push(eq(protectedObjects.kind, query.kind));
  }
  if (query.status) {
    filters.push(eq(protectedObjects.status, query.status));
  }
  if (query.sourceId) {
    filters.push(eq(protectedObjects.sourceId, query.sourceId));
  }
  return filters;
}

export async function listProtectedObjects(
  db: Database,
  tenantId: string,
  query: ObjectsQuery,
  now: Date,
): Promise<ObjectsPageDto> {
  const cursor = decodeCursor(createdCursorSchema, query.cursor);
  return withTenantTx(db, tenantId, async (tx) => {
    const filters = objectFilters(tenantId, query);
    const [total] = await tx
      .select({ n: count() })
      .from(protectedObjects)
      .where(and(...filters));
    const rows = await tx
      .select({
        object: protectedObjects,
        source: {
          id: sources.id,
          name: sources.name,
          kind: sql<"m365" | "imap">`${sources.kind}`,
        },
        email: users.email,
        upn: users.upn,
      })
      .from(protectedObjects)
      .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
      .leftJoin(users, eq(users.id, protectedObjects.userId))
      .where(
        and(
          ...filters,
          ...(cursor
            ? [afterCreated(protectedObjects.createdAt, protectedObjects.id, cursor)]
            : []),
        ),
      )
      .orderBy(asc(createdAtMs(protectedObjects.createdAt)), asc(protectedObjects.id))
      .limit(query.limit + 1);
    const page = slicePage(rows, query.limit, (row) => createdCursorOf(row.object));
    const facts = await loadObjectFacts(
      tx,
      tenantId,
      page.rows.map((row) => row.object.id),
    );
    return {
      items: page.rows.map((row) =>
        toProtectedObjectDto(row, facts.get(row.object.id) ?? NO_FACTS, now),
      ),
      next: page.next,
      total: total?.n ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerObjectRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/objects",
      operationId: "listObjects",
      summary: "Protected objects with their latest snapshot, size and readiness",
      description:
        "Pages in insertion order, so a mirror that pages through the list picks up objects added meanwhile at the end. `total` counts every match, e.g. the protected mailboxes for billing.",
      tag: "Objects",
      scope: "items:read",
      audited: true,
      query: objectsQuerySchema,
      errors: READ_ERRORS,
      response: {
        status: 200,
        description: "A page of protected objects.",
        schema: objectsPageSchema,
      },
    },
    async ({ tenant, actor, input: { query } }) => {
      const page = await listProtectedObjects(db, tenant.id, query, deps.now());
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.objectsRead,
        target: tenant.id,
        targetType: "tenant",
        details: {
          count: page.items.length,
          filters: presentFilters({
            kind: query.kind,
            status: query.status,
            sourceId: query.sourceId,
          }),
        },
      });
      return page;
    },
  );
}
