import { REPORT_CADENCES } from "@restow/core";
import type { Database } from "@restow/db";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requestLanguage } from "../../lib/language.js";
import { clientIp } from "../../lib/request.js";
import type { SessionEnv } from "../../middleware/session.js";
import type { Notifier } from "../../notify.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import {
  getProviderRecipients,
  getProviderSummaryReports,
  type ProviderActor,
  providerRecipientsSchema,
  putProviderRecipients,
  putProviderSummaryReport,
  sendProviderRecipientTest,
  sendProviderSummaryTest,
  summaryReportUpdateSchema,
} from "./service.js";

/**
 * The provider's notification recipients and summary reports (0.5.0), inside the settings routes
 * (provider admins only, no API keys):
 *
 *   GET  /notification-recipients              the list, the catalog, the floor's events
 *   PUT  /notification-recipients              replace it (the owners stay; `mandatory` by owners)
 *   POST /notification-recipients/:id/test     the test notification to one recipient
 *   GET  /summary-reports                      the daily, weekly and monthly report across tenants
 *   PUT  /summary-reports/:cadence             switch one on or off, PDF, hour (`reports.timed`)
 *   POST /summary-reports/:cadence/test        queue it for the signed-in user (`reports.timed`)
 */

export interface ProviderNotificationRouteDeps {
  readonly providerDb: Database;
  readonly notifier: () => Promise<Notifier | null>;
}

function actorOf(c: Context<SessionEnv>): ProviderActor {
  const user = c.get("user");
  const access = c.get("providerAccess");
  return {
    id: user.id,
    email: user.email,
    ip: clientIp(c),
    owner: (access?.role ?? "owner") === "owner",
  };
}

const idParamSchema = z.object({ id: z.uuid() });
const cadenceParamSchema = z.object({ cadence: z.enum(REPORT_CADENCES) });

export function buildProviderNotificationRoutes(
  deps: ProviderNotificationRouteDeps,
): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();

  routes.get("/notification-recipients", async (c) =>
    c.json(await getProviderRecipients(deps.providerDb, actorOf(c).owner)),
  );

  routes.put("/notification-recipients", async (c) => {
    const input = await parseJsonBody(c.req, providerRecipientsSchema);
    return c.json(await putProviderRecipients(deps.providerDb, input, actorOf(c)));
  });

  routes.post("/notification-recipients/:id/test", async (c) => {
    const { id } = parseOrProblem(idParamSchema, c.req.param());
    return c.json(
      await sendProviderRecipientTest(
        deps.providerDb,
        await deps.notifier(),
        id,
        actorOf(c),
        requestLanguage(c),
      ),
      202,
    );
  });

  routes.get("/summary-reports", async (c) =>
    c.json(await getProviderSummaryReports(deps.providerDb)),
  );

  routes.put("/summary-reports/:cadence", async (c) => {
    const { cadence } = parseOrProblem(cadenceParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, summaryReportUpdateSchema);
    return c.json(await putProviderSummaryReport(deps.providerDb, cadence, input, actorOf(c)));
  });

  routes.post("/summary-reports/:cadence/test", async (c) => {
    const { cadence } = parseOrProblem(cadenceParamSchema, c.req.param());
    return c.json(await sendProviderSummaryTest(deps.providerDb, cadence, actorOf(c)), 202);
  });

  return routes;
}
