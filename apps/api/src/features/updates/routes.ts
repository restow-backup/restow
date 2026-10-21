import { type Context, Hono } from "hono";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import {
  refuseApiKeys,
  requireProviderAdmin,
  requireSession,
  type SessionEnv,
} from "../../middleware/session.js";
import { parseJsonBody } from "../../schemas.js";
import type { DatabaseService } from "./database.js";
import { databaseService, restartService, updateService } from "./instance.js";
import type { RestartService } from "./restarts.js";
import {
  databaseDirectoryInputSchema,
  pendingLicenseKeyInputSchema,
  scheduleUpdateInputSchema,
  switchBuildInputSchema,
  updateSettingsInputSchema,
} from "./schemas.js";
import type { Actor, UpdateService } from "./service.js";

/**
 * /api/v1/updates — the Updates tab of the settings, for provider admins
 * (changes need the provider team's owner role, lib/provider-access.ts):
 *
 *   GET    /                        settings, check, releases, updater, maintenance, last run
 *   PATCH  /settings                switch the check, source, channel, access token (write-only)
 *   POST   /check                   check now
 *   POST   /maintenance             announce an update: { version, leadSeconds, jobs?, at? } (at: plan it)
 *   DELETE /maintenance             cancel an announced or planned update (until it starts)
 *   POST   /maintenance/dismiss     clear a finished run from the tab
 *   POST   /maintenance/start-now   an update that waits for running jobs: announce it now
 *   GET    /jobs                    what runs and waits right now (the install dialog, #46)
 *   POST   /fleet/update-now        nodes and agents behind the server update now (0.4.3)
 *   POST   /edition/switch          Community only: switch to the full build of this version
 *   PUT    /edition/license-key     Community only: keep a license key for the full build
 *   DELETE /edition/license-key     ... and remove it again
 *   GET    /restarts                services that need a restart, and how (restarts.ts)
 *   POST   /restarts/:service       "Restart now": the updater restarts that one service
 *   GET    /database                the database location, its disk and the repository's (database.ts)
 *   POST   /database/check          check a directory for the database: { targetDir }
 *   POST   /database/move           move the database there: { targetDir } (recent sign-in)
 *   DELETE /database/old-copies/:id remove an old copy a move left (recent sign-in)
 *   POST   /dumps/:file/download    a one-time download link of a pre-update dump (recent sign-in)
 *   GET    /dumps/:file?ticket=     the download itself, with that link's ticket
 *   DELETE /dumps/:file             delete a pre-update dump (recent sign-in)
 *
 * /api/v1/maintenance — every signed-in user:
 *
 *   GET    /                        whether an update is announced or running (banner, modal)
 *
 * Responses never contain the access token. API keys are refused (403): these
 * are web UI routes.
 *
 * Changing the source or the access token and announcing an update decide what
 * code the updater runs on the host. They need a recent sign-in on top of the
 * owner role (lib/recent-sign-in.ts): an older session gets 403
 * `urn:restow:problem:recent-sign-in-required` and the web app asks the person
 * to confirm with their passkey or to sign in again.
 */

function actorOf(c: Context<SessionEnv>): Actor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

export function buildUpdatesRoutes(
  service: UpdateService,
  restarts?: RestartService,
  database?: DatabaseService,
): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireProviderAdmin);

  routes.get("/", async (c) => c.json(await service.view()));

  routes.patch("/settings", async (c) => {
    const input = await parseJsonBody(c.req, updateSettingsInputSchema);
    if (input.sourceUrl !== undefined || input.token !== undefined) {
      assertRecentSignIn(c.get("auth").session);
    }
    return c.json(await service.saveSettings(input, actorOf(c)));
  });

  routes.post("/check", async (c) => c.json(await service.checkNow(actorOf(c))));

  routes.post("/maintenance", async (c) => {
    const input = await parseJsonBody(c.req, scheduleUpdateInputSchema);
    assertRecentSignIn(c.get("auth").session);
    return c.json(await service.schedule(input, actorOf(c)));
  });

  routes.delete("/maintenance", async (c) => c.json(await service.cancel(actorOf(c))));

  routes.post("/maintenance/dismiss", async (c) => c.json(await service.dismiss(actorOf(c))));

  // The update was confirmed with a recent sign-in already; not waiting any longer needs none.
  routes.post("/maintenance/start-now", async (c) => c.json(await service.startNow(actorOf(c))));

  routes.get("/jobs", async (c) => c.json(await service.activity()));

  // Nodes and agents install the release the server already runs (the code they install is
  // the server's own, signed): no recent sign-in, like "update now" on a node's page.
  routes.post("/fleet/update-now", async (c) => c.json(await service.updateFleetNow(actorOf(c))));

  // The build switch decides what code runs, like an update: a recent sign-in as well.
  routes.post("/edition/switch", async (c) => {
    const input = await parseJsonBody(c.req, switchBuildInputSchema);
    assertRecentSignIn(c.get("auth").session);
    return c.json(await service.switchToFullBuild(input, actorOf(c)));
  });

  routes.put("/edition/license-key", async (c) => {
    const input = await parseJsonBody(c.req, pendingLicenseKeyInputSchema);
    return c.json(await service.storeLicenseKey(input, actorOf(c)));
  });

  routes.delete("/edition/license-key", async (c) =>
    c.json(await service.removeLicenseKey(actorOf(c))),
  );

  if (restarts) {
    routes.get("/restarts", async (c) => c.json(await restarts.view()));
    // Restarting a service interrupts what it does (the worker's jobs checkpoint and continue
    // afterwards); it changes no code, so the owner role suffices, without a recent sign-in.
    routes.post("/restarts/:service", async (c) =>
      c.json(await restarts.restart(c.req.param("service"), actorOf(c))),
    );
  }

  if (database) {
    routes.get("/database", async (c) =>
      c.json(await database.view({ fresh: c.req.query("refresh") === "1" })),
    );
    // Checking writes and removes one test file in the directory, nothing else: the owner's,
    // without a recent sign-in.
    routes.post("/database/check", async (c) => {
      const input = await parseJsonBody(c.req, databaseDirectoryInputSchema);
      return c.json(await database.check(input.targetDir, actorOf(c)));
    });
    // Moving stops the whole application and rewrites .env; removing deletes data: a recent
    // sign-in on top of the owner role, like an update.
    routes.post("/database/move", async (c) => {
      const input = await parseJsonBody(c.req, databaseDirectoryInputSchema);
      assertRecentSignIn(c.get("auth").session);
      return c.json(await database.move(input.targetDir, actorOf(c)));
    });
    routes.delete("/database/old-copies/:id", async (c) => {
      assertRecentSignIn(c.get("auth").session);
      return c.json(await database.removeOldCopy(c.req.param("id"), actorOf(c)));
    });
    // A dump holds the whole database: downloading it is the most sensitive export there is.
    routes.post("/dumps/:file/download", async (c) => {
      assertRecentSignIn(c.get("auth").session);
      return c.json(await database.issueDumpTicket(c.req.param("file"), actorOf(c)));
    });
    // The browser follows the link the step above issued: the ticket stands for the recent
    // sign-in (it is single use, a minute long and bound to the person and the file).
    routes.get("/dumps/:file", async (c) =>
      database.downloadDump(c.req.param("file"), c.req.query("ticket"), actorOf(c)),
    );
    routes.delete("/dumps/:file", async (c) => {
      assertRecentSignIn(c.get("auth").session);
      await database.deleteDump(c.req.param("file"), actorOf(c));
      return c.json(await service.view());
    });
  }

  return routes;
}

export function buildMaintenanceRoutes(service: UpdateService): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireSession);
  routes.get("/", async (c) => c.json(await service.maintenance()));
  return routes;
}

export const updatesRoutes = buildUpdatesRoutes(updateService, restartService, databaseService);
export const maintenanceRoutes = buildMaintenanceRoutes(updateService);
