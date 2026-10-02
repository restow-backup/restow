import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { config } from "../../../../apps/api/src/config.js";
import { db, providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  type SessionEnv,
  type TenantEnv,
  requireProviderAdmin,
  requireTenant,
} from "../../../../apps/api/src/middleware/session.js";
import { capabilityGuard } from "../license/gate.js";
import {
  type JournalSetupEnvironment,
  getJournalReceiver,
  getJournalSetup,
  rotateJournalAddress,
} from "./setup.js";

/**
 * /api/v1/archive/journal (docs/ARCHIVE.md, journal setup section), next to the
 * core archive routes:
 *
 *   GET    /          the tenant's journal setup: its address (issued on the
 *                     first call), the receiver state, the last report and the
 *                     requirements for DNS, the firewall and Exchange Online
 *   POST   /rotate    issue a new address; the old one stops working at once
 *   GET    /receiver  the receiver itself, for every tenant: whether it listens,
 *                     why not, the journal host, port, TLS and size limit
 *
 * The first two are for tenant administrators; the receiver is installation
 * level and for provider admins (it names no tenant). Mounted behind
 * the `archive.journalReceiver` capability (apps/api/src/app.ts): without it
 * every path here answers 404.
 */

export interface JournalRoutesDeps {
  db: Database;
  /** The installation pool: the receiver's activity spans every tenant. */
  providerDb: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
  /** Authenticates and admits provider admins (the installation level). */
  requireProvider: MiddlewareHandler<SessionEnv>;
  environment: () => JournalSetupEnvironment;
}

function actorOf(c: Context<TenantEnv>): ArchiveActor {
  const user = c.get("user");
  return { userId: user.id, label: user.email, ip: clientIp(c) };
}

export function buildJournalRoutes(deps: JournalRoutesDeps): Hono<TenantEnv> {
  const routes = new Hono<TenantEnv>();

  routes.get("/", deps.requireAdmin, async (c) => {
    return c.json(
      await getJournalSetup(deps.db, c.get("tenantId"), actorOf(c), deps.environment()),
    );
  });

  // The receiver concerns no tenant, so the guard is the session one; the router here is typed
  // for the tenant routes next to it.
  const requireProvider = deps.requireProvider as unknown as MiddlewareHandler<TenantEnv>;
  routes.get("/receiver", requireProvider, async (c) => {
    return c.json(await getJournalReceiver(deps.providerDb, deps.environment()));
  });

  routes.post("/rotate", deps.requireAdmin, async (c) => {
    return c.json(
      await rotateJournalAddress(deps.db, c.get("tenantId"), actorOf(c), deps.environment()),
    );
  });

  return routes;
}

/** Mount path below /api/v1 of the journal setup routes. */
export const JOURNAL_PATH = "/archive/journal";

export const journalRoutes: SessionRouteContribution = {
  path: JOURNAL_PATH,
  guard: capabilityGuard(db, "archive.journalReceiver"),
  routes: buildJournalRoutes({
    db,
    providerDb,
    requireAdmin: requireTenant("tenant_admin"),
    requireProvider: requireProviderAdmin,
    environment: () => ({
      journal: config.journal,
      docsTroubleshootingUrl: config.docsTroubleshootingUrl,
    }),
  }),
};
