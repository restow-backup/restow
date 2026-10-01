import { type Database, type Tenant, tenants } from "@restow/db";
import { eq } from "drizzle-orm";
import type { GatedFeature } from "../../lib/features.js";
import { isUuid, withTenantTx } from "../../lib/tenant-context.js";
import type { ApiKeyContext } from "../../middleware/apiKey.js";
import { TENANT_HEADER } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";

/**
 * The tenant an API key acts on, and whether it may act there
 * (docs/ARCHITECTURE.md, "API").
 *
 * One rule set for every surface an API key reaches: the integration API's
 * definer (routes/v1/api.ts) and the feature routes it shares `/api/v1` with
 * (jobs, webhooks, ...). A tenant key acts on its own tenant; a provider key
 * names the tenant in `X-Restow-Tenant`, works only while provider keys are
 * on (`apiKeys.provider`, lib/features.ts), and may read, but not change, a
 * tenant that is suspended or being deleted.
 */

/** What the rules need; injected so tests can replace the database and the feature gate. */
export interface KeyTenantDeps {
  db: Database;
  /** The core's feature gate (lib/features.ts `requireFeature`). */
  requireFeature: (db: Database, feature: GatedFeature) => Promise<void>;
}

/** The tenant a key acts on, as loaded for the handlers. */
export type KeyTenant = Pick<
  Tenant,
  "id" | "name" | "slug" | "status" | "mailboxCap" | "createdAt"
>;

const keyTenantColumns = {
  id: tenants.id,
  name: tenants.name,
  slug: tenants.slug,
  status: tenants.status,
  mailboxCap: tenants.mailboxCap,
  createdAt: tenants.createdAt,
};

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for every HTTP method that may change state (POST, PUT, PATCH, DELETE, ...). */
export function isWriteMethod(method: string): boolean {
  return !READ_ONLY_METHODS.has(method.toUpperCase());
}

/**
 * The tenant id an API key acts on: a tenant key its own (a different tenant
 * in the header is refused), a provider key the one named in the header.
 */
export function tenantForApiKey(
  key: Pick<ApiKeyContext, "tenantId">,
  header: string | undefined,
): string {
  const named = header?.trim() || null;
  if (key.tenantId !== null) {
    if (named !== null && named !== key.tenantId) {
      throw new ProblemError(403, "Tenant mismatch", {
        detail: "A tenant API key can only act on its own tenant.",
      });
    }
    return key.tenantId;
  }
  if (named === null) {
    throw new ProblemError(400, "Tenant context required", {
      detail: `Provider keys name the tenant in the ${TENANT_HEADER} header.`,
    });
  }
  if (!isUuid(named)) {
    throw new ProblemError(400, "Invalid tenant id", {
      detail: `The ${TENANT_HEADER} header must carry a tenant id (UUID).`,
    });
  }
  return named;
}

/**
 * Whether a key may use a tenant in its current state. A suspended (or
 * deleting) tenant stops jobs and logins: its own keys are refused like its
 * users, a provider key may still read, and nobody changes anything.
 */
export function assertTenantUsable(
  status: Tenant["status"],
  isProviderKey: boolean,
  write: boolean,
): void {
  if (status === "active") {
    return;
  }
  if (write) {
    throw new ProblemError(409, "Tenant not active", {
      type: "urn:restow:problem:tenant-not-active",
      detail: `The tenant is ${status}; nothing can be started or changed until it is active again.`,
      extensions: { status },
    });
  }
  if (!isProviderKey) {
    throw new ProblemError(403, "Tenant suspended", {
      detail: "This tenant is currently suspended.",
      extensions: { status },
    });
  }
}

/** Provider keys work only while `apiKeys.provider` is on; switching it off retires them. */
export async function assertProviderKeys(deps: KeyTenantDeps): Promise<void> {
  await deps.requireFeature(deps.db, "apiKeys.provider");
}

/**
 * Resolve and authorize the tenant a key acts on: the feature gate for
 * provider keys, the tenant from the key (and header), its existence and its
 * state for a read or a change. Throws the matching problem otherwise.
 */
export async function resolveKeyTenant(
  deps: KeyTenantDeps,
  key: Pick<ApiKeyContext, "tenantId" | "isProvider">,
  header: string | undefined,
  write: boolean,
): Promise<KeyTenant> {
  if (key.isProvider) {
    await assertProviderKeys(deps);
  }
  const tenantId = tenantForApiKey(key, header);
  const [tenant] = await withTenantTx(deps.db, tenantId, (tx) =>
    tx.select(keyTenantColumns).from(tenants).where(eq(tenants.id, tenantId)).limit(1),
  );
  if (!tenant) {
    throw new ProblemError(404, "Tenant not found");
  }
  assertTenantUsable(tenant.status, key.isProvider, write);
  return tenant;
}
