import { z } from "zod";

/** Request schemas of the dashboard (same style as apps/api/src/schemas.ts). */

export const dashboardQuerySchema = z.object({
  /**
   * Include the provider view (tenant health matrix, provider-wide figures,
   * alerts across tenants). Only provider admins may ask for it, and only
   * while `dashboard.allTenants` is on; everyone else gets a 403.
   */
  provider: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
