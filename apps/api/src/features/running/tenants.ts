import { type Database, safeErrorMessage, tenants } from "@restow/db";
import { asc, ne } from "drizzle-orm";
import { mapBounded } from "../../lib/bounded-map.js";
import { type ProviderAccess, providerMayEnterTenant } from "../../lib/provider-access.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { TenantFiguresCache } from "../tenant-jobs/figures-cache.js";
import { TENANT_READS_AT_ONCE } from "../tenant-jobs/service.js";
import type { AllTenantsRunningDto, RunningNowDto, TenantRunningDto } from "./dto.js";
import { readRunning } from "./read.js";

/**
 * What runs right now in every tenant, for the provider's "All tenants" start page.
 *
 * It follows the Jobs overview of all tenants (features/tenant-jobs): the tenant list is read on
 * the installation pool, narrowed to the tenants the member's team role covers, and each tenant
 * is then read on the application pool in its own pinned transaction, a few at a time. A tenant's
 * answer is kept for a few seconds for every viewer (the page asks about as often as the live
 * channel speaks), so several open pages cost the database no more than one.
 */

/** How long a tenant's answer is served again; about the live channel's own cadence. */
export const RUNNING_TTL_MS = 8000;

export interface AllTenantsRunningDeps {
  /** The application pool (Row Level Security applies). */
  db: Database;
  /** The installation pool, for the tenant list only. */
  providerDb: Database;
  /** Each tenant's answer, kept for a short while; without it every request reads them. */
  cache?: TenantFiguresCache<RunningNowDto>;
}

interface TenantRow {
  id: string;
  name: string;
}

async function listTenants(
  providerDb: Database,
  access: ProviderAccess | null,
): Promise<TenantRow[]> {
  const rows = await providerDb
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(ne(tenants.status, "deleting"))
    .orderBy(asc(tenants.name));
  return access ? rows.filter((row) => providerMayEnterTenant(access, row.id)) : rows;
}

function readTenant(deps: AllTenantsRunningDeps, tenantId: string, now: Date) {
  const load = () => withTenantTx(deps.db, tenantId, (tx) => readRunning(tx, tenantId, now));
  return deps.cache ? deps.cache.get(tenantId, load) : load();
}

/** GET /api/v1/tenant-running: the tenants that have something running, and the next start. */
export async function loadAllTenantsRunning(
  deps: AllTenantsRunningDeps,
  access: ProviderAccess | null,
  now: Date = new Date(),
): Promise<AllTenantsRunningDto> {
  const rows = await listTenants(deps.providerDb, access);
  deps.cache?.prune();
  const answers = await mapBounded(rows, TENANT_READS_AT_ONCE, async (row) => {
    try {
      return { row, running: await readTenant(deps, row.id, now) };
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "tenant running read failed",
          tenantId: row.id,
          // Never the failed query with its bound parameters.
          errorMessage: safeErrorMessage(error),
        }),
      );
      return { row, running: null };
    }
  });
  const busy: TenantRunningDto[] = [];
  let next: AllTenantsRunningDto["next"] = null;
  let unavailable = 0;
  for (const { row, running } of answers) {
    if (!running) {
      unavailable++;
      continue;
    }
    if (running.runs.length > 0 || running.pve.length > 0) {
      busy.push({
        tenantId: row.id,
        name: row.name,
        runs: running.runs,
        pve: running.pve,
        truncated: running.truncated,
        nextRunAt: running.nextRunAt,
      });
    }
    if (
      running.nextRunAt &&
      (next === null || Date.parse(running.nextRunAt) < Date.parse(next.at))
    ) {
      next = { at: running.nextRunAt, tenantId: row.id, name: row.name };
    }
  }
  return { generatedAt: now.toISOString(), tenants: busy, next, unavailable };
}
