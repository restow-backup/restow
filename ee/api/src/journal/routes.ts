import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { config } from "../../../../apps/api/src/config.js";
import { db } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import type { ArchiveActor } from "../../../../apps/api/src/features/archive/service.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import { type TenantEnv, requireTenant } from "../../../../apps/api/src/middleware/session.js";
import { capabilityGuard } from "../license/gate.js";
import { type JournalSetupEnvironment, getJournalSetup, rotateJournalAddress } from "./setup.js";

/**
 * /api/v1/archive/journal (docs/ARCHIVE.md, journal setup section), next to the
 * core archive routes:
 *
 *   GET    /         the tenant's journal setup: its address (issued on the
 *                    first call), the receiver state, the last report and the
 *                    requirements for DNS, the firewall and Exchange Online
 *   POST   /rotate   issue a new address; the old one stops working at once
 *
 * Tenant administrators only. Mounted behind the `archive.journalReceiver`
 * capability (apps/api/src/app.ts): without it every path here answers 404.
 */

export interface JournalRoutesDeps {
  db: Database;
  requireAdmin: MiddlewareHandler<TenantEnv>;
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
    requireAdmin: requireTenant("tenant_admin"),
    environment: () => ({
      journal: config.journal,
      docsTroubleshootingUrl: config.docsTroubleshootingUrl,
    }),
  }),
};
