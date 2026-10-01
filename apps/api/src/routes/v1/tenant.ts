import { type Database, legalHolds, storageTargets } from "@restow/db";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { loadTenantUsage, totalMailboxes } from "../../features/usage/service.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { ApiKeyContext } from "../../middleware/apiKey.js";
import { type IntegrationApi, READ_ERRORS, type TenantInfo, type V1Deps } from "./api.js";
import { listPolicies, retentionPolicySchema, toRetentionPolicy } from "./archive.js";
import { component } from "./components.js";
import { timestampSchema, uuidSchema } from "./schemas.js";

/**
 * GET /tenant — the tenant as an integration needs it: the protected
 * mailboxes and the cap the provider agreed with the customer, the storage
 * targets and the retention policies. The counts come from the usage feature
 * (features/usage), so the numbers here are the ones the tenant pages show.
 * Nothing limits the number of mailboxes.
 *
 * The usage across the installation describes every tenant of the provider,
 * not the caller's own: only a provider key sees it. A tenant key gets its own
 * usage and its cap.
 */

export const tenantSchema = component(
  "Tenant",
  z.object({
    id: uuidSchema,
    name: z.string(),
    slug: z.string(),
    status: z.enum(["active", "suspended", "deleting"]),
    createdAt: timestampSchema,
    mailboxes: z
      .object({
        used: z
          .number()
          .int()
          .describe(
            "Protected mailboxes of this tenant (a OneDrive next to a protected mailbox does not count twice).",
          ),
        cap: z
          .number()
          .int()
          .nullable()
          .describe(
            "Mailbox cap the provider agreed with this customer; null for none. A reference value: protecting mailboxes is never blocked by it.",
          ),
        installationUsed: z
          .number()
          .int()
          .optional()
          .describe("Protected mailboxes across the installation. Only returned to provider keys."),
      })
      .describe("Mailbox counts. Nothing limits the number of mailboxes."),
    storage: z.object({
      usesInstallationDefault: z
        .boolean()
        .describe("No primary target of its own; the installation default is used."),
      targets: z.array(
        z.object({
          id: uuidSchema,
          name: z.string().nullable(),
          kind: z.enum(["local", "s3", "installation_default"]),
          role: z.enum(["primary", "copy", "previous"]),
          status: z.enum(["unverified", "ok", "error"]),
        }),
      ),
    }),
    retention: z.object({ policies: z.array(retentionPolicySchema) }),
    legalHolds: z.object({ active: z.number().int() }),
  }),
);
export type TenantDto = z.infer<typeof tenantSchema>;

export interface MailboxUsage {
  /** Protected mailboxes of this tenant. */
  used: number;
  /** The cap the provider agreed with this tenant's customer; null = none. */
  cap: number | null;
  /** Protected mailboxes of the whole installation. */
  installationUsed: number;
}

/**
 * Who reads the tenant: a provider key sees the installation's usage next to
 * the tenant's own numbers; a tenant key only its own tenant.
 */
export type TenantAudience = "provider" | "tenant";

/** The audience of an API key. */
export function audienceOf(key: Pick<ApiKeyContext, "isProvider">): TenantAudience {
  return key.isProvider ? "provider" : "tenant";
}

/**
 * The mailbox block: the tenant's own count and cap; the installation-wide
 * figure is left out unless the provider reads.
 */
export function mailboxesOf(usage: MailboxUsage, audience: TenantAudience): TenantDto["mailboxes"] {
  const own = { used: usage.used, cap: usage.cap };
  if (audience === "tenant") {
    return own;
  }
  return { ...own, installationUsed: usage.installationUsed };
}

/**
 * The tenant as an integration sees it. A provider key also reads the
 * installation's mailbox count, which counts every tenant, so that part runs on
 * the installation pool; the tenant's own data on the application pool, pinned.
 */
export async function loadTenant(
  db: Database,
  providerDb: Database,
  tenant: TenantInfo,
  audience: TenantAudience,
): Promise<TenantDto> {
  // Counts every tenant in its own pinned transaction (features/usage).
  const usage = await loadTenantUsage(providerDb);
  const data = await withTenantTx(db, tenant.id, async (tx) => {
    const targets = await tx
      .select({
        id: storageTargets.id,
        name: storageTargets.name,
        kind: storageTargets.kind,
        role: storageTargets.role,
        status: storageTargets.status,
      })
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenant.id))
      .orderBy(asc(storageTargets.role), asc(storageTargets.createdAt));
    const policies = await listPolicies(tx, tenant.id);
    const [holds] = await tx
      .select({ active: count() })
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, tenant.id), eq(legalHolds.active, true)));
    return { targets, policies, activeHolds: holds?.active ?? 0 };
  });

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt.toISOString(),
    mailboxes: mailboxesOf(
      {
        // A tenant being deleted protects nothing and is not counted.
        used: usage.find((entry) => entry.id === tenant.id)?.mailboxes ?? 0,
        cap: tenant.mailboxCap,
        installationUsed: totalMailboxes(usage),
      },
      audience,
    ),
    storage: {
      usesInstallationDefault: !data.targets.some((target) => target.role === "primary"),
      targets: data.targets,
    },
    retention: { policies: data.policies.map(toRetentionPolicy) },
    legalHolds: { active: data.activeHolds },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerTenantRoutes(api: IntegrationApi, deps: V1Deps): void {
  const { db, providerDb } = deps;

  api.tenant(
    {
      method: "get",
      path: "/tenant",
      operationId: "getTenant",
      summary: "The tenant, its mailbox usage, storage and retention",
      tag: "Status",
      scope: "status:read",
      errors: READ_ERRORS,
      response: { status: 200, description: "The tenant.", schema: tenantSchema },
    },
    ({ tenant, key }) => loadTenant(db, providerDb, tenant, audienceOf(key)),
  );
}
