import { Hono } from "hono";
import { auth } from "./auth.js";
import { isDatabaseReachable, readWorkerAndScheduler } from "./db.js";
import { authRouteGuards, sessionRouteContributions } from "./extensions.js";
import {
  mountPath as accountsMountPath,
  publicMountPath as accountsPublicMountPath,
} from "./features/accounts/meta.js";
import { accountsPublicRoutes, accountsRoutes } from "./features/accounts/routes.js";
import { mountPath as apikeysMountPath } from "./features/apikeys/meta.js";
import { apikeysRoutes } from "./features/apikeys/routes.js";
import { mountPath as archiveMountPath } from "./features/archive/meta.js";
import { archiveRoutes } from "./features/archive/routes.js";
import { mountPath as backupJobsMountPath } from "./features/backup-jobs/meta.js";
import { backupJobsRoutes } from "./features/backup-jobs/routes.js";
import { mountPath as dashboardMountPath } from "./features/dashboard/meta.js";
import { dashboardRoutes } from "./features/dashboard/routes.js";
import { mountPath as directoryMountPath } from "./features/directory/meta.js";
import { directoryRoutes } from "./features/directory/routes.js";
import { agentRoutes } from "./features/endpoints/agent-routes.js";
import { installRoutes } from "./features/endpoints/install-routes.js";
import {
  AGENT_API_PATH,
  INSTALL_PATH,
  RESTIC_PATH,
  mountPath as endpointsMountPath,
} from "./features/endpoints/meta.js";
import { resticRoutes } from "./features/endpoints/restic-route.js";
import { endpointsRoutes } from "./features/endpoints/routes.js";
import { mountPath as exportsMountPath } from "./features/exports/meta.js";
import { exportsRoutes } from "./features/exports/routes.js";
import { mountPath as historyMountPath, liveMountPath } from "./features/history/meta.js";
import { historyRoutes, liveRoutes } from "./features/history/routes.js";
import { mountPath as importsMountPath } from "./features/imports/meta.js";
import { importsRoutes } from "./features/imports/routes.js";
import { mountPath as jobsMountPath } from "./features/jobs/meta.js";
import { jobsRoutes } from "./features/jobs/routes.js";
import { mountPath as mountsMountPath } from "./features/mounts/meta.js";
import { mountsRoutes } from "./features/mounts/routes.js";
import { mountPath as providerTeamMountPath } from "./features/provider-team/meta.js";
import { providerTeamRoutes } from "./features/provider-team/routes.js";
import {
  PVE_NODE_API_PATH,
  PVE_RESTIC_PATH,
  mountPath as pveMountPath,
} from "./features/pve/meta.js";
import { pveNodeRoutes } from "./features/pve/node-routes.js";
import { pveResticRoutes } from "./features/pve/restic-route.js";
import { pveInstallScript, pveRoutes } from "./features/pve/routes.js";
import {
  NOTIFICATIONS_MOUNT_PATH,
  REPORTS_MOUNT_PATH,
  notificationsRoutes,
  reportsRoutes,
} from "./features/reports/routes.js";
import { mountPath as restoreMountPath } from "./features/restore/meta.js";
import { restoreRoutes } from "./features/restore/routes.js";
import { mountPath as retentionMountPath } from "./features/retention/meta.js";
import { retentionRoutes } from "./features/retention/routes.js";
import { mountPath as schedulesMountPath } from "./features/schedules/meta.js";
import { schedulesRoutes } from "./features/schedules/routes.js";
import { mountPath as settingsMountPath } from "./features/settings/meta.js";
import { settingsRoutes } from "./features/settings/routes.js";
import { mountPath as snapshotsMountPath } from "./features/snapshots/meta.js";
import { snapshotsRoutes } from "./features/snapshots/routes.js";
import { mountPath as sourcesMountPath } from "./features/sources/meta.js";
import { sourcesRoutes } from "./features/sources/routes.js";
import { mountPath as statsMountPath } from "./features/stats/meta.js";
import { statsRoutes } from "./features/stats/routes.js";
import { mountPath as storageMountPath } from "./features/storage/meta.js";
import { storageRoutes } from "./features/storage/routes.js";
import { mountPath as tenantsMountPath } from "./features/tenants/meta.js";
import { tenantsRoutes } from "./features/tenants/routes.js";
import { INTERNAL_MOUNT_PATH, internalRoutes, isUpdater } from "./features/updates/internal.js";
import { maintenanceMountPath, mountPath as updatesMountPath } from "./features/updates/meta.js";
import { maintenanceRoutes, updatesRoutes } from "./features/updates/routes.js";
import { mountPath as usageMountPath } from "./features/usage/meta.js";
import { usageRoutes } from "./features/usage/routes.js";
import { mountPath as verifyMountPath } from "./features/verify/meta.js";
import { verifyRoutes } from "./features/verify/routes.js";
import { mountPath as webhooksMountPath } from "./features/webhooks/meta.js";
import { webhooksRoutes } from "./features/webhooks/routes.js";
import { deniedAudit } from "./lib/denied-audit.js";
import { requestBodyLimit } from "./middleware/body-limit.js";
import { demoGuard } from "./middleware/demo-guard.js";
import { errorHandler, notFoundHandler } from "./problem.js";
import { me } from "./routes/me.js";
import { setup } from "./routes/setup.js";
import { status } from "./routes/status.js";
import { v1, versionSource } from "./routes/v1.js";

/**
 * Build the Hono application: health endpoints, the better-auth handler, the
 * public setup wizard and everything under `/api/v1`.
 *
 * `/api/v1` is shared by two audiences on the same paths:
 *
 *   - the integration API (routes/v1.ts) for RMM/PSA, authenticated by API
 *     key with scopes; it claims only requests that carry an API key and
 *     passes every other request on to the next route for the same path,
 *   - the web UI's feature routes (apps/api/src/features/*), authenticated by
 *     the session cookie plus `X-Restow-Tenant`.
 *
 * So the v1 router is mounted first and the feature routes after it: an
 * integration call to e.g. `POST /restore` reaches the documented operation,
 * the UI's session call to the same path falls through to the feature. Paths
 * only one audience uses are unaffected by the order. The admin-consent
 * callback under `/sources` is public and guarded by its signed state.
 *
 * Extensions (./extensions.ts, loaded from `ee/` by ./ee.ts before this module
 * is imported) add route groups after the core's, each behind the guard the
 * extension supplies: a locked group answers 404 like an unregistered path.
 */

const API_V1 = "/api/v1";

export function buildApp() {
  const app = new Hono();

  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  // Every request body is limited (1 MiB unless the route is listed in
  // middleware/body-limit.ts), before any route, better-auth's included, reads it.
  app.use("*", requestBodyLimit);

  // Demo mode (deploy/demo/README.md): a single, global guard, ahead of every
  // route including better-auth's own. A no-op unless RESTOW_DEMO=true.
  app.use("*", demoGuard);
  // A signed-in user's 403s end up in the audit log, throttled (lib/denied-audit.ts).
  app.use("*", deniedAudit());

  // Liveness: the process is up.
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Readiness: everything a backup needs is in place, which is the database and
  // the two processes that do the work. The worker and the scheduler report in to
  // `service_heartbeats` every 30 seconds; a role whose last beat is older than
  // two minutes is `missing`, and a backup product without a worker or a scheduler
  // is not ready, so either one being missing makes the answer 503 `not_ready`.
  // Liveness stays independent: /healthz only says the api process is up, so a
  // missing worker restarts nobody's api container (docs/ARCHITECTURE.md, Health).
  app.get("/readyz", async (c) => {
    const database = await isDatabaseReachable();
    const services = database
      ? await readWorkerAndScheduler()
      : ({ worker: "missing", scheduler: "missing" } as const);
    const checks = { database, worker: services.worker, scheduler: services.scheduler };
    const ready = database && services.worker === "ok" && services.scheduler === "ok";
    // Only the opt-in updater, which holds the shared secret, learns the running version
    // (it waits for the new one to answer); everyone else gets the document as before.
    const version = (await isUpdater(c.req.header("authorization")))
      ? { version: versionSource.current().running }
      : {};
    return c.json({ status: ready ? "ready" : "not_ready", checks, ...version }, ready ? 200 : 503);
  });

  // Extension guards ahead of better-auth (e.g. the paths of a sign-in plugin
  // its extension keeps switched off answer 404).
  for (const guard of authRouteGuards()) {
    for (const path of guard.paths) {
      app.use(path, guard.handler);
    }
  }

  // better-auth owns every route under /api/auth/*.
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // Public installation setup (runs before any operator account exists).
  app.route(`${API_V1}/setup`, setup);
  // Identity of the signed-in user: role, tenants, enabled features.
  app.route(`${API_V1}/me`, me);

  // Integration API (API key + scope). First, so key-carrying calls reach it;
  // session calls pass through to the routes below.
  app.route(API_V1, v1);

  // For the opt-in updater only (shared secret, never routed by the edge).
  app.route(INTERNAL_MOUNT_PATH, internalRoutes);

  // Endpoint backup (docs/AGENT.md): the agent API, the restic REST endpoint the
  // agents write through and the install scripts. None of them uses the session:
  // an agent authenticates with its own secret (HTTP Basic), enrollment with its
  // one-time token (and the browser request guard, which an agent always passes),
  // and the install scripts are public by design.
  app.route(AGENT_API_PATH, agentRoutes);
  app.route(RESTIC_PATH, resticRoutes);
  // Proxmox VE (docs/PVE.md): restow-pve's API, the restic endpoint of container
  // repositories (per-run credentials) and the node installer.
  app.route(PVE_NODE_API_PATH, pveNodeRoutes);
  app.route(PVE_RESTIC_PATH, pveResticRoutes);
  app.get(`${INSTALL_PATH}/pve.sh`, pveInstallScript);
  app.route(INSTALL_PATH, installRoutes);

  // Web UI (session) routes, in navigation order.
  app.route(`${API_V1}/status`, status);
  app.route(`${API_V1}${dashboardMountPath}`, dashboardRoutes);
  app.route(`${API_V1}${statsMountPath}`, statsRoutes);
  app.route(`${API_V1}${tenantsMountPath}`, tenantsRoutes);
  app.route(`${API_V1}${accountsMountPath}`, accountsRoutes);
  app.route(`${API_V1}${accountsPublicMountPath}`, accountsPublicRoutes);
  app.route(`${API_V1}${providerTeamMountPath}`, providerTeamRoutes);
  app.route(`${API_V1}${sourcesMountPath}`, sourcesRoutes);
  app.route(`${API_V1}${directoryMountPath}`, directoryRoutes);
  app.route(`${API_V1}${schedulesMountPath}`, schedulesRoutes);
  app.route(`${API_V1}${REPORTS_MOUNT_PATH}`, reportsRoutes);
  app.route(`${API_V1}${NOTIFICATIONS_MOUNT_PATH}`, notificationsRoutes);
  app.route(`${API_V1}${jobsMountPath}`, jobsRoutes);
  // The runs under their documented name (the integration API's alias, see routes/v1/jobs.ts).
  app.route(`${API_V1}/runs`, jobsRoutes);
  app.route(`${API_V1}${backupJobsMountPath}`, backupJobsRoutes);
  app.route(`${API_V1}${historyMountPath}`, historyRoutes);
  app.route(`${API_V1}${liveMountPath}`, liveRoutes);
  app.route(`${API_V1}${snapshotsMountPath}`, snapshotsRoutes);
  app.route(`${API_V1}${restoreMountPath}`, restoreRoutes);
  app.route(`${API_V1}${importsMountPath}`, importsRoutes);
  app.route(`${API_V1}${exportsMountPath}`, exportsRoutes);
  app.route(`${API_V1}${verifyMountPath}`, verifyRoutes);
  app.route(`${API_V1}${retentionMountPath}`, retentionRoutes);
  app.route(`${API_V1}${archiveMountPath}`, archiveRoutes);
  app.route(`${API_V1}${storageMountPath}`, storageRoutes);
  app.route(`${API_V1}${apikeysMountPath}`, apikeysRoutes);
  app.route(`${API_V1}${webhooksMountPath}`, webhooksRoutes);
  app.route(`${API_V1}${usageMountPath}`, usageRoutes);
  app.route(`${API_V1}${settingsMountPath}`, settingsRoutes);
  app.route(`${API_V1}${endpointsMountPath}`, endpointsRoutes);
  app.route(`${API_V1}${updatesMountPath}`, updatesRoutes);
  app.route(`${API_V1}${maintenanceMountPath}`, maintenanceRoutes);
  app.route(`${API_V1}${mountsMountPath}`, mountsRoutes);
  app.route(`${API_V1}${pveMountPath}`, pveRoutes);

  // Extension route groups, each behind the guard its extension supplies.
  for (const contribution of sessionRouteContributions()) {
    const group = new Hono();
    if (contribution.guard) {
      group.use("*", contribution.guard);
    }
    group.route("/", contribution.routes);
    app.route(`${API_V1}${contribution.path}`, group);
  }

  return app;
}

export const app = buildApp();
export type AppType = typeof app;
