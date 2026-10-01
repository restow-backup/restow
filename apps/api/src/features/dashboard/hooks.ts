import type { Database } from "@restow/db";
import type { TenantUsageDto } from "../usage/service.js";
import type { ProviderViewDto } from "./dto.js";

/** One data source of the dashboard, loaded on its own: a failure is logged, never thrown. */
export type SettledSource<T> = { ok: true; value: T } | { ok: false };

/**
 * Extension point for the provider view of the dashboard: the core decides
 * who may ask for it (provider admins, while `dashboard.allTenants` is on,
 * lib/features.ts) and loads the tenant list; an extension (ee/api) builds
 * the cross-tenant matrix, its alerts and figures. Without it the provider
 * view is reported as unavailable.
 */
export interface ProviderDashboardLoader {
  load(input: {
    /** The application pool: every tenant's figures are read in its own pinned transaction. */
    readonly db: Database;
    readonly now: Date;
    /** Every tenant with its mailbox usage, by name. */
    readonly tenants: readonly TenantUsageDto[];
    /** Loads one source and logs its failure the way the dashboard does. */
    readonly settle: <T>(
      source: string,
      tenantId: string | null,
      run: () => Promise<T>,
    ) => Promise<SettledSource<T>>;
  }): Promise<ProviderViewDto>;
}

declare module "../../extensions.js" {
  interface FeatureHooks {
    providerDashboard: ProviderDashboardLoader;
  }
}
