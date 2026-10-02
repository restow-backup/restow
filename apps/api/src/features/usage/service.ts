import { countProtectedMailboxes } from "@restow/core";
import {
  type Database,
  type TenantKind,
  type TenantStatus,
  protectedObjects,
  tenants,
} from "@restow/db";
import { and, asc, eq, ne } from "drizzle-orm";
import { notImported } from "../../lib/imported-objects.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";

/**
 * Mailbox usage under the counting rule (@restow/core `countProtectedMailboxes`:
 * mailboxes and IMAP accounts count, a OneDrive never counts twice). Nothing
 * limits or enforces the figures; the dashboards, the tenant pages and the
 * integration API show them (for example for a provider's billing).
 *
 * Counting follows the tenant model: each tenant is counted inside its own
 * tenant-pinned transaction, never with one cross-tenant query. Tenants being
 * deleted no longer protect anything and are left out; suspended tenants keep
 * counting, because they can resume at any time.
 */

export interface TenantUsageDto {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  /** `internal`: the operator's own organisation, which is not one of the provider's customers. */
  kind: TenantKind;
  /** Protected mailboxes in this tenant. */
  mailboxes: number;
  /** Mailbox cap the provider agreed with this customer; null = none. Never enforced. */
  cap: number | null;
}

/** GET /api/v1/usage: the installation's protected mailboxes, in total and per tenant. */
export interface UsageDto {
  /** Protected mailboxes across all tenants (OneDrive does not count twice). */
  mailboxes: number;
  tenants: TenantUsageDto[];
}

/**
 * The tenants that are the provider's customers: the operator's own organisation
 * (`kind = internal`) is protected like any other tenant but is not one of them.
 */
export function customerTenants<T extends Pick<TenantUsageDto, "kind">>(usage: readonly T[]): T[] {
  return usage.filter((tenant) => tenant.kind !== "internal");
}

/** Protected mailboxes across the installation. */
export function totalMailboxes(usage: readonly TenantUsageDto[]): number {
  return usage.reduce((sum, tenant) => sum + tenant.mailboxes, 0);
}

/** Protected mailboxes of one tenant. Call inside that tenant's pinned transaction. */
export async function countTenantMailboxes(tx: DbExecutor, tenantId: string): Promise<number> {
  const rows = await tx
    .select({
      kind: protectedObjects.kind,
      status: protectedObjects.status,
      userId: protectedObjects.userId,
    })
    .from(protectedObjects)
    // Imported mailboxes (mail files brought in by hand) are no protected mailboxes: they never count.
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.status, "active"),
        notImported(),
      ),
    );
  return countProtectedMailboxes(rows);
}

/**
 * Usage per tenant, ordered by name. Lists every tenant, so it takes the
 * installation pool (apps/api/src/db.ts `providerDb`); each count still runs in
 * its tenant's own pinned transaction.
 */
export async function loadTenantUsage(providerDb: Database): Promise<TenantUsageDto[]> {
  const rows = await providerDb
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      kind: tenants.kind,
      cap: tenants.mailboxCap,
    })
    .from(tenants)
    .where(ne(tenants.status, "deleting"))
    .orderBy(asc(tenants.name));

  const usage: TenantUsageDto[] = [];
  for (const row of rows) {
    const mailboxes = await withTenantTx(providerDb, row.id, (tx) =>
      countTenantMailboxes(tx, row.id),
    );
    usage.push({ ...row, mailboxes });
  }
  return usage;
}

/** The usage report of the installation (provider admins). */
export async function loadUsage(providerDb: Database): Promise<UsageDto> {
  const usage = await loadTenantUsage(providerDb);
  return { mailboxes: totalMailboxes(usage), tenants: usage };
}
