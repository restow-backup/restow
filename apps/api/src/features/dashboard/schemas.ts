import { z } from "zod";
import { TENANT_WIDGET_IDS, type TenantWidgetId } from "./dto.js";
import { STORAGE_DEFAULT_DAYS, STORAGE_MAX_DAYS, STORAGE_MIN_DAYS } from "./growth.js";

/** Request schemas of the dashboard (same style as apps/api/src/schemas.ts). */

/** A whole number of days in a query string, from `min` to a year. */
const days = (min: number) =>
  z
    .string()
    .regex(/^\d{1,3}$/, "Expected a whole number of days.")
    .transform(Number)
    .pipe(z.number().int().min(min).max(STORAGE_MAX_DAYS));

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
    /**
     * Days of history the storage growth chart covers, ending today (7 to 366, 30 by default).
     * The answer is clamped to the history that exists: `days` in the widget says what it shows.
     */
    storageDays: days(STORAGE_MIN_DAYS).optional(),
    /**
     * How far ahead the estimate looks (1 to 366 days); omitted, as far as `storageDays`. Never
     * further than the history shown.
     */
    forecastDays: days(1).optional(),
  })
  .transform((query) => {
    const storageDays = query.storageDays ?? STORAGE_DEFAULT_DAYS;
    return {
      provider: query.provider !== "false",
      /** The tenant's own widgets are answered (not with `provider=only`). */
      tenantWidgets: query.provider !== "only",
      widgets: query.widgets,
      storageDays,
      forecastDays: query.forecastDays ?? storageDays,
    };
  });
type ParsedDashboardQuery = z.infer<typeof dashboardQuerySchema>;
/** A parsed query; callers in the API may leave the storage window to its defaults. */
export type DashboardQuery = Omit<ParsedDashboardQuery, "storageDays" | "forecastDays"> &
  Partial<Pick<ParsedDashboardQuery, "storageDays" | "forecastDays">>;
