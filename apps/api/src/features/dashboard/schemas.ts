import { z } from "zod";
import { TENANT_WIDGET_IDS, type TenantWidgetId } from "./dto.js";

/** Request schemas of the dashboard (same style as apps/api/src/schemas.ts). */

export const dashboardQuerySchema = z
  .object({
    /**
     * Include the provider view (tenant health matrix, provider-wide figures,
     * alerts across tenants). Only provider admins may ask for it, and only
     * while `dashboard.allTenants` is on; everyone else gets a 403. `only`
     * answers the provider view alone: the tenant's own widgets are left out and
     * not read, which is what the "All tenants" overview needs.
     */
    provider: z.enum(["true", "false", "only"]).default("false"),
    /**
     * A comma separated list of tenant widgets to answer (`setup` for the
     * sidebar's Start checklist); omitted, every widget that applies is. Ids the
     * dashboard does not know are refused.
     */
    widgets: z
      .string()
      .optional()
      .transform((value, ctx): TenantWidgetId[] | null => {
        if (value === undefined) {
          return null;
        }
        const ids = value
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        const unknown = ids.filter((id) => !(TENANT_WIDGET_IDS as readonly string[]).includes(id));
        if (ids.length === 0 || unknown.length > 0) {
          ctx.addIssue({
            code: "custom",
            message: `Expected a comma separated list of: ${TENANT_WIDGET_IDS.join(", ")}.`,
          });
          return z.NEVER;
        }
        return ids as TenantWidgetId[];
      }),
  })
  .transform((query) => ({
    provider: query.provider !== "false",
    /** The tenant's own widgets are answered (not with `provider=only`). */
    tenantWidgets: query.provider !== "only",
    widgets: query.widgets,
  }));
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
