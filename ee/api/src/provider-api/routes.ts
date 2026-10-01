import { type Database, tenantContacts, tenants } from "@restow/db";
import { asc, eq, gt, gte } from "drizzle-orm";
import { z } from "zod";
import { hasScope } from "../../../../apps/api/src/features/apikeys/scopes.js";
import { withTenantTx } from "../../../../apps/api/src/lib/tenant-context.js";
import type { IntegrationApi, V1Deps } from "../../../../apps/api/src/routes/v1/api.js";
import { V1_AUDIT_ACTIONS, readRecorder } from "../../../../apps/api/src/routes/v1/audit.js";
import { component } from "../../../../apps/api/src/routes/v1/components.js";
import {
  decodeCursor,
  encodeCursor,
  idCursorSchema,
  slicePage,
} from "../../../../apps/api/src/routes/v1/cursor.js";
import {
  pageQuerySchema,
  pageSchema,
  timestampSchema,
  uuidSchema,
} from "../../../../apps/api/src/routes/v1/schemas.js";
import {
  loadTenantSummary,
  tenantSummarySchema,
} from "../../../../apps/api/src/routes/v1/status.js";
import {
  type DirectoryUserDto,
  directoryUserSchema,
  loadDirectoryUsers,
} from "../../../../apps/api/src/routes/v1/users.js";

/**
 * Cross-tenant overviews for provider keys (Service Provider edition):
 * GET /provider/tenants (every tenant with its status summary, plus contact
 * persons for a key that also carries `users:read`) and GET /provider/users
 * (every directory user with its tenant, for PSA sync and per-mailbox
 * billing).
 *
 * The tenant list itself is an installation-level lookup on the installation
 * pool; everything inside a tenant is read on the application pool in a
 * transaction pinned to that tenant, one tenant at a time, so Row Level
 * Security holds and no query ever spans tenants.
 *
 * Service Provider only (`provider.crossTenantApi`): registered on the
 * integration API through the core's extension point
 * (apps/api/src/extensions.ts, `integrationRoutes`), and
 * `IntegrationApi.provider()` (apps/api/src/routes/v1/api.ts) asks the core's
 * feature gate for `apiKeys.provider` ahead of every operation registered
 * here, which the license gate (../license/gate.ts) opens only with that
 * capability, so a smaller edition or a tenant-scoped key never reaches a
 * handler.
 */

/** The application pool for tenant reads and the installation pool for the tenant list. */
export interface ProviderPools {
  db: Database;
  providerDb: Database;
}

const tenantStatusSchema = z.enum(["active", "suspended", "deleting"]);

export const providerTenantsQuerySchema = pageQuerySchema(50);
export type ProviderTenantsQuery = z.infer<typeof providerTenantsQuerySchema>;

/** A tenant's contact person (tenant wizard), as PSA/billing tooling needs it. */
export const providerTenantContactSchema = component(
  "ProviderTenantContact",
  z.object({
    id: uuidSchema,
    name: z.string(),
    role: z.string().nullable().describe("Free-text function label, not an app role."),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    isPrimary: z.boolean(),
  }),
);
export type ProviderTenantContactDto = z.infer<typeof providerTenantContactSchema>;

export const providerTenantSchema = component(
  "ProviderTenant",
  z.object({
    id: uuidSchema,
    name: z.string(),
    slug: z.string(),
    status: tenantStatusSchema,
    createdAt: timestampSchema,
    customerNumber: z
      .string()
      .nullable()
      .describe("Provider-assigned customer number (tenant wizard); null when not set."),
    contacts: z
      .array(providerTenantContactSchema)
      .describe(
        "Contact persons for PSA sync and support handoff; empty unless the key also carries the users:read scope.",
      ),
    summary: tenantSummarySchema,
  }),
);
export const providerTenantsPageSchema = component(
  "ProviderTenantPage",
  pageSchema(providerTenantSchema),
);
export type ProviderTenantsPageDto = z.infer<typeof providerTenantsPageSchema>;

export const providerUsersQuerySchema = pageQuerySchema(100);
export type ProviderUsersQuery = z.infer<typeof providerUsersQuerySchema>;

export const providerUserSchema = component(
  "ProviderUser",
  directoryUserSchema.extend({
    tenant: z.object({
      id: uuidSchema,
      name: z.string(),
      slug: z.string(),
      status: tenantStatusSchema,
    }),
  }),
);
export type ProviderUserDto = z.infer<typeof providerUserSchema>;

export const providerUsersPageSchema = component(
  "ProviderUserPage",
  pageSchema(providerUserSchema),
);
export type ProviderUsersPageDto = z.infer<typeof providerUsersPageSchema>;

/** Position after a user of a tenant, in (tenant id, created_at, user id) order. */
export const providerUserCursorSchema = z.object({
  tenantId: z.string().uuid(),
  at: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});
export type ProviderUserCursor = z.infer<typeof providerUserCursorSchema>;

const tenantColumns = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  status: tenants.status,
  createdAt: tenants.createdAt,
  customerNumber: tenants.customerNumber,
};

/**
 * One tenant's contacts (tenant wizard), read inside a transaction
 * pinned to that tenant so Row Level Security holds (never a cross-tenant
 * query on the installation pool, same as every other tenant read here).
 */
async function loadContacts(db: Database, tenantId: string): Promise<ProviderTenantContactDto[]> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx.select().from(tenantContacts).where(eq(tenantContacts.tenantId, tenantId)),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    email: row.email,
    phone: row.phone,
    isPrimary: row.isPrimary,
  }));
}

export async function listProviderTenants(
  { db, providerDb }: ProviderPools,
  query: ProviderTenantsQuery,
  now: Date,
  /** Contact persons are personal data: only loaded for a key with `users:read`. */
  includeContacts: boolean,
): Promise<ProviderTenantsPageDto> {
  const cursor = decodeCursor(idCursorSchema, query.cursor);
  const rows = await providerDb
    .select(tenantColumns)
    .from(tenants)
    .where(cursor ? gt(tenants.id, cursor.id) : undefined)
    .orderBy(asc(tenants.id))
    .limit(query.limit + 1);
  const page = slicePage(rows, query.limit, (row) => ({ id: row.id }));
  const items: ProviderTenantsPageDto["items"] = [];
  for (const tenant of page.rows) {
    items.push({
      ...tenant,
      createdAt: tenant.createdAt.toISOString(),
      contacts: includeContacts ? await loadContacts(db, tenant.id) : [],
      summary: await loadTenantSummary(db, tenant.id, now),
    });
  }
  return { items, next: page.next };
}

/** How many users of each tenant a page revealed (each tenant's audit log records its share). */
export function usersPerTenant(items: readonly ProviderUserDto[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.tenant.id, (counts.get(item.tenant.id) ?? 0) + 1);
  }
  return counts;
}

export function providerUserCursor(user: Pick<ProviderUserDto, "id" | "createdAt" | "tenant">) {
  return { tenantId: user.tenant.id, at: user.createdAt, id: user.id };
}

export async function listProviderUsers(
  { db, providerDb }: ProviderPools,
  query: ProviderUsersQuery,
  now: Date,
): Promise<ProviderUsersPageDto> {
  const cursor = decodeCursor(providerUserCursorSchema, query.cursor);
  const tenantRows = await providerDb
    .select(tenantColumns)
    .from(tenants)
    .where(cursor ? gte(tenants.id, cursor.tenantId) : undefined)
    .orderBy(asc(tenants.id));

  // Collect one user more than the page holds: it proves a next page exists.
  const wanted = query.limit + 1;
  const collected: ProviderUserDto[] = [];
  for (const tenant of tenantRows) {
    const after = cursor && tenant.id === cursor.tenantId ? { at: cursor.at, id: cursor.id } : null;
    const slice = await withTenantTx(db, tenant.id, (tx) =>
      loadDirectoryUsers(tx, tenant.id, wanted - collected.length, after, now),
    );
    const block = { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status };
    collected.push(...slice.items.map((user: DirectoryUserDto) => ({ ...user, tenant: block })));
    if (collected.length >= wanted) {
      break;
    }
  }
  const items = collected.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    next: collected.length > query.limit && last ? encodeCursor(providerUserCursor(last)) : null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerProviderRoutes(api: IntegrationApi, deps: V1Deps): void {
  const pools: ProviderPools = { db: deps.db, providerDb: deps.providerDb };
  const recordRead = readRecorder(deps);

  api.provider(
    {
      method: "get",
      path: "/provider/tenants",
      operationId: "listProviderTenants",
      summary: "Every tenant with its status summary",
      description:
        "The summary is the one `GET /status` returns for the tenant, plus the customer number (every key) and the contact persons of the tenant wizard (only a key that also carries the `users:read` scope; otherwise `contacts` is always empty). Pages by tenant id. Reading a tenant's contacts is recorded in that tenant's audit log; a tenant with none gets no entry.",
      tag: "Provider",
      scope: "status:read",
      audited: true,
      query: providerTenantsQuerySchema,
      errors: [400, 422],
      response: {
        status: 200,
        description: "A page of tenants.",
        schema: providerTenantsPageSchema,
      },
    },
    async ({ actor, key, input: { query } }) => {
      const includeContacts = hasScope(key.scopes, "users:read");
      const page = await listProviderTenants(pools, query, deps.now(), includeContacts);
      if (includeContacts) {
        // A tenant's contact persons are personal data, only exposed for a
        // key that also carries `users:read`; the status summary alone
        // (every `status:read` key sees that) is not a read of user data and
        // is not recorded here. A tenant with no contacts exposes nothing,
        // so it gets no entry either.
        for (const item of page.items) {
          if (item.contacts.length === 0) {
            continue;
          }
          await recordRead(item.id, actor, {
            action: V1_AUDIT_ACTIONS.providerTenantsRead,
            target: item.id,
            targetType: "tenant",
            details: { contactCount: item.contacts.length },
          });
        }
      }
      return page;
    },
  );

  api.provider(
    {
      method: "get",
      path: "/provider/users",
      operationId: "listProviderUsers",
      summary: "Directory users of every tenant, for PSA sync and per-mailbox billing",
      description:
        "Pages tenant by tenant (by tenant id), each tenant's users in insertion order. The read is recorded in the audit log of every tenant whose users a page contains.",
      tag: "Provider",
      scope: "users:read",
      audited: true,
      query: providerUsersQuerySchema,
      errors: [400, 422],
      response: {
        status: 200,
        description: "A page of users with their tenant.",
        schema: providerUsersPageSchema,
      },
    },
    async ({ actor, input: { query } }) => {
      const page = await listProviderUsers(pools, query, deps.now());
      for (const [tenantId, count] of usersPerTenant(page.items)) {
        await recordRead(tenantId, actor, {
          action: V1_AUDIT_ACTIONS.providerUsersRead,
          target: tenantId,
          targetType: "tenant",
          details: { count },
        });
      }
      return page;
    },
  );
}
