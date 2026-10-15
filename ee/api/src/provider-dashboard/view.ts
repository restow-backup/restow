import type { ProviderDashboardLoader } from "../../../../apps/api/src/features/dashboard/hooks.js";
import {
  loadStaleThresholds,
  loadTenantHealthExtras,
} from "../../../../apps/api/src/features/dashboard/queries.js";
import { loadShareCounts } from "../../../../apps/api/src/features/file-shares/protection.js";
import { loadGuestCounts } from "../../../../apps/api/src/features/pve/protection.js";
import { loadEndpointCounts } from "../../../../apps/api/src/routes/v1/endpoints.js";
import { loadTenantSummary } from "../../../../apps/api/src/routes/v1/status.js";
import { providerAlerts, providerKpis, tenantRow } from "./health.js";

/**
 * The provider view of the dashboard (Service Provider, registered as the
 * `providerDashboard` feature hook): every tenant the mailbox usage lists, its
 * figures read one tenant at a time in its own pinned transaction, as the
 * provider API (../provider-api/routes.ts) reads them. A tenant whose figures
 * fail is reported as unavailable; the others still show.
 */
export const providerDashboardLoader: ProviderDashboardLoader = {
  async load({ db, now, tenants, settle }) {
    const rows = [];
    for (const tenant of tenants) {
      const facts = await settle("provider.tenant", tenant.id, async () => {
        const stale = await loadStaleThresholds(db, tenant.id, now);
        const machines = await loadEndpointCounts(db, tenant.id, now);
        const guests = await loadGuestCounts(db, tenant.id, now);
        const shares = await loadShareCounts(db, tenant.id, now);
        return {
          summary: await loadTenantSummary(db, tenant.id, now),
          ...(await loadTenantHealthExtras(db, tenant.id, now)),
          machines,
          guests: guests.counts,
          fileShares: shares.counts,
          // The tenant is stale only once every kind it protects is: the most relaxed bound applies.
          staleAfterHours: Math.max(
            stale.mail,
            machines.total > 0 ? stale.machines : 0,
            guests.counts.protected > 0 ? guests.staleAfterHours : 0,
            shares.counts.protected > 0 ? shares.staleAfterHours : 0,
          ),
        };
      });
      rows.push(
        tenantRow(tenant, facts.ok ? facts.value : null, {
          mailboxes: tenant.mailboxes,
          cap: tenant.cap,
        }),
      );
    }
    return {
      kpis: providerKpis(rows),
      tenants: rows,
      alerts: providerAlerts(rows, now),
    };
  },
};
