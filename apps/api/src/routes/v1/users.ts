import { countProtectedMailboxes, inactiveState } from "@restow/core";
import { type Database, protectedObjects, sources, type User, users } from "@restow/db";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type SyncQueueResult,
  setUserProtection,
  type UserProtectionResult,
} from "../../features/directory/service.js";
import { overallReadiness } from "../../features/verify/summary.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { type IntegrationApi, READ_ERRORS, type V1Deps, WRITE_ERRORS } from "./api.js";
import { readRecorder, V1_AUDIT_ACTIONS } from "./audit.js";
import { component } from "./components.js";
import {
  afterCreated,
  type CreatedCursor,
  createdAtMs,
  createdCursorSchema,
  decodeCursor,
  encodeCursor,
} from "./cursor.js";
import {
  countsForReadiness,
  loadObjectFacts,
  NO_FACTS,
  type ObjectFacts,
  objectReadinessSchema,
  readinessOf,
} from "./facts.js";
import {
  idParamSchema,
  objectKindSchema,
  objectStatusSchema,
  pageQuerySchema,
  pageSchema,
  readinessSchema,
  sourceKindSchema,
  timestampSchema,
  uuidSchema,
} from "./schemas.js";

/**
 * GET /users — the tenant's directory (the people whose mailboxes and drives
 * Restow protects) for PSA contact/asset sync and per-mailbox billing, and
 * POST /users/:id/protection for on-/offboarding from an RMM or PSA.
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const usersQuerySchema = pageQuerySchema(100);
export type UsersQuery = z.infer<typeof usersQuerySchema>;

export const protectionStatusSchema = component(
  "ProtectionStatus",
  z
    .enum(["active", "excluded", "orphaned", "none"])
    .describe(
      "`active` when at least one of the user's objects is protected, `excluded` when all remaining ones were taken out, `orphaned` when they all disappeared from the source, `none` without any object.",
    ),
);
export type ProtectionStatus = z.infer<typeof protectionStatusSchema>;

export const userObjectSchema = component(
  "UserObject",
  z.object({
    id: uuidSchema,
    kind: objectKindSchema,
    status: objectStatusSchema,
    statusReason: z
      .enum(["account_disabled", "no_license", "locked"])
      .nullable()
      .optional()
      .describe(
        "Why an `orphaned` object is not backed up although it is still at the source: the account is disabled, it has no Exchange Online licence, or Microsoft locked the OneDrive or site (HTTP 423). Its backups are kept and backups resume by themselves once the account is enabled or licensed, or the lock is lifted. Null for every other object.",
      ),
    inactiveSince: timestampSchema
      .nullable()
      .optional()
      .describe("When an `orphaned` object stopped being backed up. Null for every other object."),
    statusConfirmedAt: timestampSchema
      .nullable()
      .optional()
      .describe(
        "When an admin confirmed that an `orphaned` object is intentionally no longer backed up. Null while unconfirmed (the tenant's readiness reads at least yellow then) and for every other object.",
      ),
    externalId: z.string(),
    displayName: z.string().nullable(),
    lastBackupAt: timestampSchema.nullable(),
    readiness: objectReadinessSchema,
  }),
);

export const directoryUserSchema = component(
  "DirectoryUser",
  z.object({
    id: uuidSchema,
    displayName: z.string().nullable(),
    email: z.string(),
    upn: z.string().nullable(),
    entraObjectId: z.string().nullable().describe("Entra ID object id (oid) of M365 users."),
    source: sourceKindSchema.nullable(),
    protectionStatus: protectionStatusSchema,
    hasProtectedMailbox: z.boolean().describe("The user has at least one protected mailbox."),
    protectedMailboxes: z
      .number()
      .int()
      .describe(
        "Protected mailboxes this user accounts for: a protected mailbox (with its OneDrive) counts once, a OneDrive without a protected mailbox once, every IMAP account once.",
      ),
    lastBackupAt: timestampSchema.nullable().describe("Newest restorable backup of any object."),
    recoveryReadiness: readinessSchema
      .nullable()
      .describe(
        "Worst rating over the user's protected objects; yellow while an object waits for confirmation (no longer backed up, `statusConfirmedAt` null), even one without a backup; null without any.",
      ),
    objects: z.array(userObjectSchema),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  }),
);
export type DirectoryUserDto = z.infer<typeof directoryUserSchema>;

export const directoryUsersPageSchema = component(
  "DirectoryUserPage",
  pageSchema(directoryUserSchema).extend({
    total: z.number().int().describe("Directory users of the tenant, over all pages."),
  }),
);
export type DirectoryUsersPageDto = z.infer<typeof directoryUsersPageSchema>;

export const protectionRequestSchema = z.object({
  action: z
    .enum(["include", "exclude", "reset"])
    .describe(
      "`include` protects every object of the user, `exclude` takes them out of protection (backups stay restorable), `reset` returns them to the tenant's protection rules.",
    ),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe("Why, e.g. the on-/offboarding ticket; written to the audit log."),
});

export const directorySyncSchema = component(
  "DirectorySync",
  z
    .object({
      status: z.enum(["queued", "already_queued", "not_queued", "not_needed"]),
      jobId: uuidSchema.nullable(),
      reason: z.enum(["source_disabled", "consent_outstanding", "queue_unavailable"]).nullable(),
    })
    .describe("A `reset` is settled by a directory sync, which evaluates the rules."),
);

export const protectionResultSchema = component(
  "ProtectionResult",
  z.object({
    userId: uuidSchema,
    action: z.enum(["include", "exclude", "reset"]),
    objects: z.array(
      z.object({
        id: uuidSchema,
        kind: objectKindSchema,
        externalId: z.string(),
        displayName: z.string().nullable(),
        status: objectStatusSchema,
      }),
    ),
    directorySync: directorySyncSchema,
  }),
);
export type ProtectionResultDto = z.infer<typeof protectionResultSchema>;

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

export interface UserObjectRow {
  id: string;
  userId: string | null;
  kind: "mailbox" | "onedrive" | "imap" | "site" | "group";
  status: "active" | "excluded" | "orphaned";
  /** See the `statusReason` of {@link userObjectSchema}; absent reads as null. */
  statusReason?: "account_disabled" | "no_license" | "locked" | null;
  /** See {@link userObjectSchema}; absent reads as null. */
  inactiveSince?: Date | null;
  statusConfirmedAt?: Date | null;
  externalId: string;
  displayName: string | null;
  sourceKind: "m365" | "imap";
}

export function protectionStatusOf(statuses: readonly UserObjectRow["status"][]): ProtectionStatus {
  if (statuses.length === 0) {
    return "none";
  }
  if (statuses.includes("active")) {
    return "active";
  }
  return statuses.includes("excluded") ? "excluded" : "orphaned";
}

function sourceOf(user: Pick<User, "entraObjectId">, objects: readonly UserObjectRow[]) {
  if (objects.some((object) => object.sourceKind === "m365")) {
    return "m365" as const;
  }
  if (objects.some((object) => object.sourceKind === "imap")) {
    return "imap" as const;
  }
  return user.entraObjectId ? ("m365" as const) : null;
}

function latest(dates: readonly (Date | null)[]): Date | null {
  return dates.reduce<Date | null>(
    (newest, date) => (date && (!newest || date > newest) ? date : newest),
    null,
  );
}

export function toDirectoryUser(
  user: User,
  objects: readonly UserObjectRow[],
  facts: ReadonlyMap<string, ObjectFacts>,
  now: Date,
): DirectoryUserDto {
  const withFacts = objects.map((object) => ({ object, facts: facts.get(object.id) ?? NO_FACTS }));
  const rated = withFacts
    .filter((entry) => countsForReadiness(entry.object.status, entry.facts.snapshot !== null))
    .map((entry) => {
      const readiness = readinessOf(entry.facts, now, entry.object.status);
      return {
        state: readiness.state,
        overdue: readiness.overdue,
        checkedAt: entry.facts.verify?.checkedAt ?? null,
        toConfirm: inactiveState(entry.object) === "to_confirm",
      };
    });
  // Unconfirmed objects no longer backed up without a backup to rate still wait for a decision:
  // yellow like the tenant readiness, /v1/status and /v1/verify (verify/summary.ts `toConfirm`).
  const unratedToConfirm = withFacts.filter(
    (entry) =>
      !countsForReadiness(entry.object.status, entry.facts.snapshot !== null) &&
      inactiveState(entry.object) === "to_confirm",
  ).length;
  const protectedMailboxes = countProtectedMailboxes(
    objects.map((object) => ({ kind: object.kind, status: object.status, userId: user.id })),
  );
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    upn: user.upn,
    entraObjectId: user.entraObjectId,
    source: sourceOf(user, objects),
    protectionStatus: protectionStatusOf(objects.map((object) => object.status)),
    hasProtectedMailbox: protectedMailboxes > 0,
    protectedMailboxes,
    lastBackupAt:
      latest(withFacts.map((entry) => entry.facts.snapshot?.completedAt ?? null))?.toISOString() ??
      null,
    recoveryReadiness: overallReadiness(rated, unratedToConfirm),
    objects: withFacts.map(({ object, facts: objectFacts }) => ({
      id: object.id,
      kind: object.kind,
      status: object.status,
      statusReason: object.status === "orphaned" ? (object.statusReason ?? null) : null,
      inactiveSince:
        object.status === "orphaned" ? (object.inactiveSince?.toISOString() ?? null) : null,
      statusConfirmedAt:
        object.status === "orphaned" ? (object.statusConfirmedAt?.toISOString() ?? null) : null,
      externalId: object.externalId,
      displayName: object.displayName,
      lastBackupAt: objectFacts.snapshot?.completedAt?.toISOString() ?? null,
      readiness: readinessOf(objectFacts, now, object.status),
    })),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function directorySyncOf(sync: SyncQueueResult | null): ProtectionResultDto["directorySync"] {
  if (sync === null) {
    return { status: "not_needed", jobId: null, reason: null };
  }
  if (sync.status === "not_queued") {
    return { status: "not_queued", jobId: null, reason: sync.reason };
  }
  return { status: sync.status, jobId: sync.jobId, reason: null };
}

export function toProtectionResult(result: UserProtectionResult): ProtectionResultDto {
  return {
    userId: result.userId,
    action: result.action,
    objects: result.objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      externalId: object.externalId,
      displayName: object.displayName,
      status: object.status,
    })),
    directorySync: directorySyncOf(result.sync),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface DirectoryUsersSlice {
  items: DirectoryUserDto[];
  /** More users follow the last item in this tenant. */
  hasMore: boolean;
}

/** One page of a tenant's directory, in insertion order, inside the caller's tenant transaction. */
export async function loadDirectoryUsers(
  tx: Transaction,
  tenantId: string,
  limit: number,
  cursor: CreatedCursor | null,
  now: Date,
): Promise<DirectoryUsersSlice> {
  const rows = await tx
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, tenantId),
        ...(cursor ? [afterCreated(users.createdAt, users.id, cursor)] : []),
      ),
    )
    .orderBy(asc(createdAtMs(users.createdAt)), asc(users.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const userIds = page.map((user) => user.id);
  const objects: UserObjectRow[] =
    userIds.length === 0
      ? []
      : await tx
          .select({
            id: protectedObjects.id,
            userId: protectedObjects.userId,
            kind: protectedObjects.kind,
            status: protectedObjects.status,
            statusReason: protectedObjects.statusReason,
            inactiveSince: protectedObjects.inactiveSince,
            statusConfirmedAt: protectedObjects.statusConfirmedAt,
            externalId: protectedObjects.externalId,
            displayName: protectedObjects.displayName,
            sourceKind: sql<"m365" | "imap">`${sources.kind}`,
          })
          .from(protectedObjects)
          .innerJoin(sources, eq(sources.id, protectedObjects.sourceId))
          .where(
            and(
              eq(protectedObjects.tenantId, tenantId),
              inArray(protectedObjects.userId, userIds),
              ne(sources.kind, "import"),
            ),
          )
          .orderBy(asc(protectedObjects.kind), asc(protectedObjects.externalId));
  const facts = await loadObjectFacts(
    tx,
    tenantId,
    objects.map((object) => object.id),
  );
  const byUser = new Map<string, UserObjectRow[]>();
  for (const object of objects) {
    if (object.userId) {
      byUser.set(object.userId, [...(byUser.get(object.userId) ?? []), object]);
    }
  }
  return {
    items: page.map((user) => toDirectoryUser(user, byUser.get(user.id) ?? [], facts, now)),
    hasMore: rows.length > limit,
  };
}

/** The cursor continuing after a directory user. */
export function userCursor(user: Pick<DirectoryUserDto, "id" | "createdAt">): CreatedCursor {
  return { at: user.createdAt, id: user.id };
}

export async function listDirectoryUsers(
  db: Database,
  tenantId: string,
  query: UsersQuery,
  now: Date,
): Promise<DirectoryUsersPageDto> {
  const cursor = decodeCursor(createdCursorSchema, query.cursor);
  return withTenantTx(db, tenantId, async (tx) => {
    const [total] = await tx.select({ n: count() }).from(users).where(eq(users.tenantId, tenantId));
    const slice = await loadDirectoryUsers(tx, tenantId, query.limit, cursor, now);
    const last = slice.items.at(-1);
    return {
      items: slice.items,
      next: slice.hasMore && last ? encodeCursor(userCursor(last)) : null,
      total: total?.n ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerUserRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db } = deps;
  const recordRead = readRecorder(deps);

  api.tenant(
    {
      method: "get",
      path: "/users",
      operationId: "listUsers",
      summary: "Directory users with protection status, mailbox count and readiness",
      description:
        "The tenant's users and mailboxes for PSA contact/asset sync and billing. Pages in insertion order, so users added while a sync pages through the list appear at the end.",
      tag: "Directory",
      scope: "users:read",
      audited: true,
      query: usersQuerySchema,
      errors: READ_ERRORS,
      response: {
        status: 200,
        description: "A page of directory users.",
        schema: directoryUsersPageSchema,
      },
    },
    async ({ tenant, actor, input: { query } }) => {
      const page = await listDirectoryUsers(db, tenant.id, query, deps.now());
      await recordRead(tenant.id, actor, {
        action: V1_AUDIT_ACTIONS.usersRead,
        target: tenant.id,
        targetType: "tenant",
        details: { count: page.items.length },
      });
      return page;
    },
  );

  api.tenant(
    {
      method: "post",
      path: "/users/:id/protection",
      operationId: "setUserProtection",
      summary: "Include, exclude or reset the protection of a user (on-/offboarding)",
      description:
        "Applies to every protected object of the user. Excluding stops new backups; existing backups stay restorable. Audited with the reason.",
      tag: "Directory",
      scope: "users:write",
      write: true,
      params: idParamSchema,
      body: protectionRequestSchema,
      errors: WRITE_ERRORS,
      response: {
        status: 200,
        description: "The user's objects after the change.",
        schema: protectionResultSchema,
      },
    },
    async ({ tenant, actor, input: { params, body } }) =>
      toProtectionResult(await setUserProtection(db, tenant.id, params.id, body, actor)),
  );
}
