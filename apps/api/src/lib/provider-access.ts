import { extensionProviderRouteRule } from "../extensions.js";

/**
 * What a provider admin may do (pure functions, no I/O).
 *
 * Every provider admin (better-auth `user.role = "admin"`, middleware/rbac.ts)
 * holds one of four roles from the provider team (packages/db
 * schema/provider-team.ts) and a tenant scope: every tenant, or a chosen few.
 * A provider admin without a team row is an owner with every tenant, which is
 * what every installation had before the team existed.
 *
 * The rules are per API route, in one table ({@link PROVIDER_ROUTE_RULES}) for
 * the core's routes plus the rules each extension contributes for its own
 * (extensions.ts `providerRouteRules`), checked by the session middlewares
 * (middleware/session.ts) for every request a provider admin makes, against
 * the route that actually answers it.
 * A route missing from the table is refused to everyone but an owner (fail
 * closed), and app.provider-access.test.ts fails for every registered route
 * that has no rule, so a new route cannot slip through unclassified.
 *
 * The tenant scope is checked where a request enters a tenant
 * (`resolveTenantAccess`) and, for the provider-wide routes, here: a member
 * limited to some tenants may not use a route that reads or changes every
 * tenant at once, unless its rule names how the route narrows itself to the
 * member's tenants.
 */

export const PROVIDER_ROLES = ["owner", "administrator", "technician", "read_only"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

const RANK: Record<ProviderRole, number> = {
  read_only: 1,
  technician: 2,
  administrator: 3,
  owner: 4,
};

/** True when `role` grants at least what `minimum` requires. */
export function providerRoleSatisfies(role: ProviderRole, minimum: ProviderRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export interface ProviderAccess {
  role: ProviderRole;
  /** Every tenant, including those created later. */
  allTenants: boolean;
  /** The tenants a member limited to some may reach; ignored when `allTenants`. */
  tenantIds: ReadonlySet<string>;
}

/** A provider admin without a team row (the setup wizard's first admin, older installations). */
export const OWNER_ACCESS: ProviderAccess = {
  role: "owner",
  allTenants: true,
  tenantIds: new Set(),
};

/** Whether the member may reach `tenantId` at all. */
export function providerMayEnterTenant(access: ProviderAccess, tenantId: string): boolean {
  return access.allTenants || access.tenantIds.has(tenantId);
}

/**
 * How a route relates to tenants, for a member limited to some of them:
 *
 *   tenant      the request enters one tenant through the tenant context
 *               (requireTenant / resolveTenantAccess), which checks the scope
 *   provider    reads or changes every tenant, or the installation itself:
 *               only for members with every tenant
 *   list        lists tenants and narrows the list to the member's own
 *               (the handler applies {@link providerMayEnterTenant})
 *   param       names one tenant in a path parameter (`param` names it)
 *   none        concerns no tenant (the member's own identity)
 */
export type RouteScope =
  | { kind: "tenant" }
  | { kind: "provider" }
  | { kind: "list" }
  | { kind: "param"; param: string }
  | { kind: "none" };

export interface ProviderRouteRule {
  /** The least role that may use the route. */
  min: ProviderRole;
  scope: RouteScope;
}

const TENANT: RouteScope = { kind: "tenant" };
const PROVIDER: RouteScope = { kind: "provider" };
const LIST: RouteScope = { kind: "list" };
const NONE: RouteScope = { kind: "none" };
const byParam = (param: string): RouteScope => ({ kind: "param", param });

const view = (scope: RouteScope = TENANT): ProviderRouteRule => ({ min: "read_only", scope });
const operate = (scope: RouteScope = TENANT): ProviderRouteRule => ({ min: "technician", scope });
const configure = (scope: RouteScope = TENANT): ProviderRouteRule => ({
  min: "administrator",
  scope,
});
const own = (scope: RouteScope = PROVIDER): ProviderRouteRule => ({ min: "owner", scope });

/**
 * Routes nobody signs in for (setup, set-password links, OpenAPI, the admin
 * consent callback) and the health checks: no provider admin rule applies.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  "GET /healthz",
  "GET /readyz",
  // Guarded by the updater's shared secret, not by a session (features/updates/internal.ts).
  "GET /internal/updater/source-token",
  "GET /api/v1/setup/state",
  "POST /api/v1/setup",
  "POST /api/v1/setup/token",
  "GET /api/v1/accounts/set-password/:token",
  "POST /api/v1/accounts/set-password",
  "GET /api/v1/openapi.json",
  "GET /api/v1/sources/m365/consent/callback",
  "GET /api/auth/*",
  "POST /api/auth/*",
  // Endpoint backup (docs/AGENT.md): the agent authenticates with its own secret
  // (HTTP Basic), and the install scripts and binaries are public downloads.
  "POST /agent/v1/enroll",
  "GET /agent/v1/config",
  "POST /agent/v1/heartbeat",
  "POST /agent/v1/runs",
  "POST /agent/v1/runs/:runId/progress",
  "POST /agent/v1/runs/:runId/finish",
  "GET /agent/v1/update",
  "GET /install/linux.sh",
  "GET /install/macos.sh",
  "GET /install/agent/:version/:file",
  "GET /install/agent/:version/:target/:file",
]);

/**
 * One rule per route, keyed `METHOD /path` exactly as the router registers it.
 *
 * Reading content (mail, files, archived items, restore downloads) needs a
 * technician: a read-only member sees that backups, restores and checks
 * happened, never what they contain.
 */
export const PROVIDER_ROUTE_RULES: Readonly<Record<string, ProviderRouteRule>> = {
  // --- Identity -------------------------------------------------------------
  "GET /api/v1/me": view(NONE),
  "GET /api/v1/settings/passkey-ready": view(NONE),
  // Accepting the operator notice is the operator's decision: owners and
  // administrators only. Technicians and read-only members are held up by the
  // web dialog until one of them has accepted (no tenant involved, so a
  // tenant-scoped administrator may accept as well).
  "POST /api/v1/settings/disclaimer": configure(NONE),

  // --- Tenants and their people -----------------------------------------------
  "GET /api/v1/tenants": view(LIST),
  "POST /api/v1/tenants": configure(PROVIDER),
  // The operator's own organisation. Creating it spans the installation, and marking a
  // tenant may move the mark away from another one: both need every tenant.
  "POST /api/v1/tenants/internal": configure(PROVIDER),
  "POST /api/v1/tenants/:id/internal": configure(PROVIDER),
  "GET /api/v1/tenants/:id": view(byParam("id")),
  "PATCH /api/v1/tenants/:id": configure(byParam("id")),
  "DELETE /api/v1/tenants/:id": own(byParam("id")),
  "PATCH /api/v1/tenants/:id/customer": configure(byParam("id")),
  "PUT /api/v1/tenants/:id/contacts": configure(byParam("id")),
  "PUT /api/v1/tenants/:id/notification-recipients": configure(byParam("id")),
  "GET /api/v1/tenants/:id/members": view(TENANT),
  "POST /api/v1/tenants/:id/members": configure(TENANT),
  "PATCH /api/v1/tenants/:id/members/:userId": configure(TENANT),
  "DELETE /api/v1/tenants/:id/members/:userId": configure(TENANT),
  "DELETE /api/v1/tenants/:id/invitations/:invitationId": configure(TENANT),
  "GET /api/v1/tenants/:tenantId/accounts": view(TENANT),
  "POST /api/v1/tenants/:tenantId/accounts": configure(TENANT),
  "POST /api/v1/tenants/:tenantId/accounts/:userId/reissue": configure(TENANT),
  "GET /api/v1/tenant": view(),

  // --- The provider team (features/provider-team) ---------------------------------
  // Reading for every provider admin with every tenant, changing it for owners.
  "GET /api/v1/provider-team": view(PROVIDER),
  "POST /api/v1/provider-team": own(),
  "PATCH /api/v1/provider-team/:userId": own(),
  "DELETE /api/v1/provider-team/:userId": own(),
  "POST /api/v1/provider-team/:userId/reissue": own(),
  "POST /api/v1/provider-team/:userId/reset-access": own(),

  // --- Installation settings and usage ------------------------------------------
  "GET /api/v1/usage": view(PROVIDER),
  "GET /api/v1/settings": view(PROVIDER),
  "PATCH /api/v1/settings": own(),
  "POST /api/v1/settings/mail/test": configure(PROVIDER),
  "DELETE /api/v1/settings/mail": own(),
  // Marking the notification mail as not needed only decides whether the Start checklist asks for
  // a test mail; it is still a setting of the installation, so it is the owner's, like the mail itself.
  "PUT /api/v1/settings/mail/not-needed": own(),
  "GET /api/v1/settings/microsoft-app": view(PROVIDER),
  "PUT /api/v1/settings/microsoft-app": own(),
  "POST /api/v1/settings/microsoft-app/test": configure(PROVIDER),
  "DELETE /api/v1/settings/microsoft-app": own(),
  // The installation's default storage: reading is for every provider admin, the test writes a
  // probe object to the store, so it is configuration work. Saving or removing it decides where
  // every tenant without a target of its own keeps its backups: the owner's (plus a recent sign-in).
  "GET /api/v1/settings/default-storage": view(PROVIDER),
  "PUT /api/v1/settings/default-storage": own(),
  "DELETE /api/v1/settings/default-storage": own(),
  "POST /api/v1/settings/default-storage/test": configure(PROVIDER),

  // --- Updates -------------------------------------------------------------------
  // Reading is for every provider admin; everything that changes something (the source, a
  // check, announcing, cancelling or dismissing an update, which restarts the installation)
  // is for the owner.
  "GET /api/v1/updates": view(PROVIDER),
  "PATCH /api/v1/updates/settings": own(),
  "POST /api/v1/updates/check": own(),
  "POST /api/v1/updates/maintenance": own(),
  "DELETE /api/v1/updates/maintenance": own(),
  "POST /api/v1/updates/maintenance/dismiss": own(),
  "POST /api/v1/updates/edition/switch": own(),
  "PUT /api/v1/updates/edition/license-key": own(),
  "DELETE /api/v1/updates/edition/license-key": own(),
  // The maintenance state is for everyone who is signed in.
  "GET /api/v1/maintenance": view(NONE),

  // --- Network shares (the opt-in mounter, docs/MOUNTS.md) -----------------------
  // Reading is for every provider admin (the storage form offers the paths of the shares);
  // adding, removing and testing a share run containers on the host and restart the api and
  // the worker: the owner's (adding and removing with a recent sign-in, features/mounts).
  "GET /api/v1/mounts": view(PROVIDER),
  "GET /api/v1/mounts/paths": view(PROVIDER),
  "POST /api/v1/mounts": own(),
  "DELETE /api/v1/mounts/:name": own(),
  "POST /api/v1/mounts/test": own(),

  // --- API keys -----------------------------------------------------------------
  "GET /api/v1/api-keys": view(),
  "POST /api/v1/api-keys": configure(),
  "DELETE /api/v1/api-keys/:id": configure(),
  "GET /api/v1/api-keys/provider": view(PROVIDER),
  "POST /api/v1/api-keys/provider": own(),
  "DELETE /api/v1/api-keys/provider/:id": own(),

  // --- Dashboard, statistics ------------------------------------------------------
  "GET /api/v1/dashboard": view(),
  "GET /api/v1/stats": view(),
  "GET /api/v1/stats/export.csv": view(),
  "GET /api/v1/stats/report.pdf": view(),

  // --- Sources and directory ----------------------------------------------------
  "GET /api/v1/sources": view(),
  "POST /api/v1/sources": configure(),
  "GET /api/v1/sources/:id": view(),
  "PATCH /api/v1/sources/:id": configure(),
  "DELETE /api/v1/sources/:id": configure(),
  "GET /api/v1/sources/entra/status": view(),
  "POST /api/v1/sources/imap/test": configure(),
  "POST /api/v1/sources/:id/consent-link": configure(),
  "PUT /api/v1/sources/:id/own-app": configure(),
  // Attaches the provider's own Microsoft 365 tenant to a customer tenant: owner only.
  "POST /api/v1/sources/:id/connect-own-tenant": own(TENANT),
  "POST /api/v1/sources/:id/verify": operate(),
  "POST /api/v1/sources/:id/test": operate(),
  "GET /api/v1/directory/sources": view(),
  "GET /api/v1/directory/sources/:sourceId/groups": view(),
  "PUT /api/v1/directory/sources/:sourceId/rules": configure(),
  "POST /api/v1/directory/sources/:sourceId/sync": operate(),
  "POST /api/v1/directory/sources/:sourceId/accounts": configure(),
  "POST /api/v1/directory/sources/:sourceId/accounts/import": configure(),
  "POST /api/v1/directory/sources/:sourceId/protection/bulk": configure(),
  "GET /api/v1/directory/people": view(),
  "GET /api/v1/directory/objects": view(),
  "POST /api/v1/directory/objects/:id/protection": configure(),
  "POST /api/v1/directory/objects/:id/credential": configure(),
  "POST /api/v1/directory/objects/:id/credential/test": operate(),
  "DELETE /api/v1/directory/objects/:id": configure(),
  "POST /api/v1/directory/users/:userId/protection": configure(),

  // --- Jobs, schedules, verification --------------------------------------------
  "GET /api/v1/jobs": view(),
  "GET /api/v1/jobs/events": view(),
  "GET /api/v1/jobs/:id": view(),
  "GET /api/v1/jobs/:id/events": view(),
  "GET /api/v1/jobs/objects": view(),
  "GET /api/v1/jobs/objects/:id/snapshots": view(),
  "POST /api/v1/jobs/backup": operate(),
  "POST /api/v1/jobs/:id/cancel": operate(),
  "POST /api/v1/jobs/:id/retry": operate(),
  // The runs under their documented name: the same routes as /jobs.
  "GET /api/v1/runs": view(),
  "GET /api/v1/runs/events": view(),
  "GET /api/v1/runs/:id": view(),
  "GET /api/v1/runs/:id/events": view(),
  "GET /api/v1/runs/objects": view(),
  "GET /api/v1/runs/objects/:id/snapshots": view(),
  "POST /api/v1/runs/backup": operate(),
  "POST /api/v1/runs/:id/cancel": operate(),
  "POST /api/v1/runs/:id/retry": operate(),
  // Backup jobs: what is backed up, when, where and for how long. Reading is for every provider
  // admin (hook texts are masked below the administrator role); running one is an operation;
  // changing the definition or its scope is configuration work.
  "GET /api/v1/backup-jobs": view(),
  "GET /api/v1/backup-jobs/defaults": view(),
  "GET /api/v1/backup-jobs/candidates": view(),
  "POST /api/v1/backup-jobs": configure(),
  "GET /api/v1/backup-jobs/:id": view(),
  "PATCH /api/v1/backup-jobs/:id": configure(),
  "DELETE /api/v1/backup-jobs/:id": configure(),
  "GET /api/v1/backup-jobs/:id/members": view(),
  "PUT /api/v1/backup-jobs/:id/members": configure(),
  "POST /api/v1/backup-jobs/:id/members": configure(),
  "PATCH /api/v1/backup-jobs/:id/members/:targetId": configure(),
  "DELETE /api/v1/backup-jobs/:id/members/:targetId": configure(),
  "POST /api/v1/backup-jobs/:id/run": operate(),
  "GET /api/v1/backup-jobs/:id/runs": view(),
  // History: the runs of the tenant, mail and agent together, and the live channel that keeps
  // them current. Reading is for every provider admin, like the runs under /jobs.
  "GET /api/v1/history": view(),
  "GET /api/v1/history/:id": view(),
  "GET /api/v1/live": view(),
  "GET /api/v1/schedules": view(),
  "POST /api/v1/schedules": configure(),
  "PATCH /api/v1/schedules/:id": configure(),
  "DELETE /api/v1/schedules/:id": configure(),
  "POST /api/v1/schedules/preview": configure(),
  "POST /api/v1/schedules/recommended": configure(),
  "GET /api/v1/verify/latest": view(),
  "GET /api/v1/verify/reports": view(),
  "GET /api/v1/verify/reports/:id": view(),
  "POST /api/v1/verify": operate(),
  "POST /api/v1/verify/scrub": operate(),

  // --- Backed-up content and restore --------------------------------------------
  "GET /api/v1/snapshots": view(),
  "GET /api/v1/snapshots/objects": view(),
  "GET /api/v1/snapshots/objects/:id/versions": view(),
  "GET /api/v1/snapshots/search": operate(),
  "GET /api/v1/snapshots/:id/tree": operate(),
  "GET /api/v1/snapshots/:snapshotId/entries/:entryId/preview": operate(),
  "GET /api/v1/snapshots/:snapshotId/entries/:entryId/attachments/:attachmentId": operate(),
  "GET /api/v1/restore": view(),
  "GET /api/v1/restore/:id": view(),
  "GET /api/v1/restore/targets": operate(),
  "POST /api/v1/restore": operate(),
  "POST /api/v1/restore/:id/cancel": operate(),
  "GET /api/v1/restore/:id/download": operate(),

  // --- Mail file import ------------------------------------------------------------
  // Bringing files in creates a mailbox under the tenant's import source, so it is
  // configuration work; cancelling a running import is an operation.
  "GET /api/v1/imports/config": view(),
  "GET /api/v1/imports/folder": configure(),
  "GET /api/v1/imports/uploads": view(),
  "POST /api/v1/imports/uploads": configure(),
  "GET /api/v1/imports/uploads/:id": view(),
  "PUT /api/v1/imports/uploads/:id/segments/:index": configure(),
  "POST /api/v1/imports/uploads/:id/complete": configure(),
  "DELETE /api/v1/imports/uploads/:id": configure(),
  "POST /api/v1/imports": configure(),
  "GET /api/v1/imports": view(),
  "GET /api/v1/imports/:id": view(),
  "POST /api/v1/imports/:id/cancel": operate(),
  // Mail exports (features/exports): what was exported is content, so requesting and
  // downloading needs a technician; the list and status are as visible as restores.
  "GET /api/v1/exports": view(),
  "GET /api/v1/exports/formats": view(),
  "GET /api/v1/exports/:id": view(),
  "POST /api/v1/exports": operate(),
  "POST /api/v1/exports/:id/cancel": operate(),
  "GET /api/v1/exports/:id/download": operate(),

  // --- Archive -------------------------------------------------------------------
  "GET /api/v1/archive/status": view(),
  "GET /api/v1/archive/chain/verify": view(),
  "GET /api/v1/archive/retention": view(),
  "GET /api/v1/archive/report": view(),
  "GET /api/v1/archive/search": operate(),
  "GET /api/v1/archive/items/:id": operate(),
  "GET /api/v1/retention/policies": view(),
  "POST /api/v1/retention/policies": configure(),
  "POST /api/v1/retention/policies/preview": configure(),
  "PATCH /api/v1/retention/policies/:id": configure(),
  "DELETE /api/v1/retention/policies/:id": configure(),

  // --- Storage ---------------------------------------------------------------------
  "GET /api/v1/storage": view(),
  "GET /api/v1/storage/usage": view(),
  "GET /api/v1/storage/targets": view(),
  "GET /api/v1/storage/targets/:id": view(),
  "POST /api/v1/storage/targets": configure(),
  "PATCH /api/v1/storage/targets/:id": configure(),
  "DELETE /api/v1/storage/targets/:id": configure(),
  "POST /api/v1/storage/targets/probe": configure(),
  "POST /api/v1/storage/targets/:id/test": operate(),
  "POST /api/v1/storage/targets/:id/completeness": operate(),
  "POST /api/v1/storage/targets/:id/promote": configure(),
  "POST /api/v1/storage/targets/:id/migration/cancel": configure(),
  "POST /api/v1/storage/targets/:id/migration/retry": configure(),
  "POST /api/v1/storage/installation-default/test": configure(PROVIDER),

  // --- Endpoint backup (servers and clients, docs/AGENT.md) ------------------------
  // Reading backed-up files (browse, download) and asking an agent to restore
  // needs a technician; a read-only member sees that backups happened, not their content.
  // The detail answers every member, but the hook texts only to who may change
  // the configuration (features/endpoints/routes.ts: a hook may hold credentials).
  "GET /api/v1/endpoints": view(),
  // The tenant's setting for automatic agent updates, and lifting a machine's own pause.
  "GET /api/v1/endpoints/agent-updates": view(),
  "PUT /api/v1/endpoints/agent-updates": configure(),
  "DELETE /api/v1/endpoints/agent-updates/machines/:id": configure(),
  "GET /api/v1/endpoints/tokens": view(),
  "POST /api/v1/endpoints/tokens": configure(),
  "DELETE /api/v1/endpoints/tokens/:tokenId": configure(),
  "GET /api/v1/endpoints/:id": view(),
  "PATCH /api/v1/endpoints/:id": configure(),
  "POST /api/v1/endpoints/:id/revoke": configure(),
  "POST /api/v1/endpoints/:id/uninstall": configure(),
  "POST /api/v1/endpoints/:id/tasks": operate(),
  "POST /api/v1/endpoints/:id/restore-test": operate(),
  "POST /api/v1/endpoints/:id/repository-password": configure(),
  "GET /api/v1/endpoints/:id/runs": view(),
  "GET /api/v1/endpoints/:id/runs/:runId": view(),
  "GET /api/v1/endpoints/:id/snapshots": view(),
  "GET /api/v1/endpoints/:id/browse": operate(),
  "POST /api/v1/endpoints/:id/downloads": operate(),
  "GET /api/v1/endpoints/:id/downloads/:downloadId": operate(),

  // --- Webhooks --------------------------------------------------------------------
  "GET /api/v1/reports/catalog": view(),
  "GET /api/v1/reports/rules": view(),
  "POST /api/v1/reports/rules": configure(),
  "PATCH /api/v1/reports/rules/:id": configure(),
  "DELETE /api/v1/reports/rules/:id": configure(),
  "POST /api/v1/reports/rules/:id/test": operate(),
  "GET /api/v1/reports/deliveries": view(),
  "GET /api/v1/notifications": view(),
  "POST /api/v1/notifications/read": view(),
  // The installation-level entries alone, for a provider admin with no tenant open. The same
  // entries already reach every provider admin through the bell of any tenant they enter.
  "GET /api/v1/notifications/installation": view(NONE),
  "POST /api/v1/notifications/installation/read": view(NONE),
  "GET /api/v1/webhooks": view(),
  "GET /api/v1/webhooks/events": view(),
  "GET /api/v1/webhooks/:id": view(),
  "POST /api/v1/webhooks": configure(),
  "PATCH /api/v1/webhooks/:id": configure(),
  "DELETE /api/v1/webhooks/:id": configure(),
  "POST /api/v1/webhooks/:id/secret": configure(),
  "POST /api/v1/webhooks/:id/test": operate(),
  "GET /api/v1/webhooks/:id/deliveries": view(),
  "GET /api/v1/webhooks/:id/deliveries/:deliveryId": view(),
  "POST /api/v1/webhooks/:id/deliveries/:deliveryId/redeliver": operate(),

  // --- Integration API paths a session can also reach (routes/v1.ts) --------------
  "GET /api/v1/status": view(PROVIDER),
  "GET /api/v1/objects": view(),
  "GET /api/v1/users": view(),
  "POST /api/v1/users/:id/protection": configure(),
};

/**
 * The rule builders of the table above, for extensions that register routes
 * of their own (extensions.ts `ApiExtension.providerRouteRules`).
 */
export const providerRule = {
  view,
  operate,
  configure,
  own,
  scope: { tenant: TENANT, provider: PROVIDER, list: LIST, none: NONE, byParam },
} as const;

/**
 * The rule for `key` (`METHOD /path` as registered): the core's table, else
 * what the extension that registered the route contributed; null for none.
 */
export function providerRouteRule(key: string): ProviderRouteRule | null {
  return PROVIDER_ROUTE_RULES[key] ?? extensionProviderRouteRule(key);
}

export type ProviderRouteDecision =
  | { allowed: true }
  | { allowed: false; reason: "role"; required: ProviderRole }
  | { allowed: false; reason: "scope" };

/**
 * Whether `access` may use `method` `routePath` (the registered pattern, e.g.
 * `/api/v1/tenants/:id`), with `params` the request's path parameters.
 * Owners pass every route, including one without a rule; everyone else
 * needs the route's rule and its tenant scope.
 */
export function decideProviderRoute(
  access: ProviderAccess,
  method: string,
  routePath: string,
  params: Readonly<Record<string, string | undefined>>,
): ProviderRouteDecision {
  if (access.role === "owner" && access.allTenants) {
    return { allowed: true };
  }
  const key = `${method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase()} ${routePath}`;
  if (PUBLIC_ROUTES.has(key)) {
    return { allowed: true };
  }
  const rule = providerRouteRule(key);
  if (!rule) {
    return access.role === "owner"
      ? { allowed: true }
      : { allowed: false, reason: "role", required: "owner" };
  }
  if (!providerRoleSatisfies(access.role, rule.min)) {
    return { allowed: false, reason: "role", required: rule.min };
  }
  if (access.allTenants) {
    return { allowed: true };
  }
  switch (rule.scope.kind) {
    case "provider":
      return { allowed: false, reason: "scope" };
    case "param": {
      const tenantId = params[rule.scope.param];
      return tenantId && providerMayEnterTenant(access, tenantId)
        ? { allowed: true }
        : { allowed: false, reason: "scope" };
    }
    default:
      // tenant: checked where the request enters the tenant; list: the
      // handler narrows the list; none: no tenant involved.
      return { allowed: true };
  }
}
