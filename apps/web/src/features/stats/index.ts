import "./i18n.js";

/**
 * Statistics feature: key figures, trends and tables of one period against
 * the previous one, with CSV exports per dataset and a PDF report. Tenant
 * admins see their tenant; provider admins also see the totals of all
 * tenants where the installation enables it. Period and scope live in the URL.
 *
 * It is the tab "Statistics" of Overview (features/dashboard), so it brings
 * no route and no menu entry of its own; its old address `/stats` leads
 * there (features/redirects).
 */

export { STATS_ROLES } from "./hooks.js";
export { STATS_VIEW, parseStatsSearch } from "./period.js";
export { StatsPage } from "./stats-page.js";

export const routes = [];

export const navItems = [];
