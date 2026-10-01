import type { ProviderDashboardLoader } from "../../../../apps/api/src/features/dashboard/hooks.js";
import { loadTenantHealthExtras } from "../../../../apps/api/src/features/dashboard/queries.js";
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
      const facts = await settle("provider.tenant", tenant.id, async () => ({
        summary: await loadTenantSummary(db, tenant.id, now),
        ...(await loadTenantHealthExtras(db, tenant.id, now)),
      }));
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
