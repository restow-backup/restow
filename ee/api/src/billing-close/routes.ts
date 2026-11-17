import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import { audit as appendAudit } from "../../../../apps/api/src/lib/audit.js";
import { loadInstallationTimeZone } from "../../../../apps/api/src/lib/installation-time-zone.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  requireProviderAdmin,
  type SessionEnv,
} from "../../../../apps/api/src/middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../../../apps/api/src/schemas.js";
import { capabilityGuard } from "../license/gate.js";
import {
  correctionDto,
  createCorrectionSchema,
  loadClosedPeriodOrProblem,
  openPeriod,
  periodCsv,
  periodDto,
  periodListDto,
  periodParamSchema,
} from "../provider-api/billing-periods.js";
import { BILLING_AUDIT_ACTIONS, createCorrection, listClosedPeriods } from "./service.js";

/**
 * /api/v1/billing (0.6.0, Service Provider): the closed months of the billing close for
 * Installation › Billing in the web UI, the same answers as the integration API's
 * /provider/billing/periods:
 *
 *   GET  /periods                          the closed months and the open one
 *   GET  /periods/:period                  one closed month
 *   GET  /periods/:period/csv              the month as CSV (billing-periods.ts PERIOD_CSV_COLUMNS)
 *   POST /periods/:period/corrections      a correction next to the close
 *
 * Provider admins only; every provider role reads, the owner enters corrections
 * (../provider-rules.ts). An export is recorded in the installation's audit log
 * (`billing.period.exported`), a correction in the tenant's (`billing.correction.created`).
 * Mounted behind `provider.crossTenantApi`: without it every path answers 404.
 */

export interface BillingRoutesDeps {
  providerDb: Database;
  requireProvider: MiddlewareHandler<SessionEnv>;
  audit?: typeof appendAudit;
  now?: () => Date;
}

function actorOf(c: Context<SessionEnv>) {
  const user = c.get("user");
  return { label: user.email, userId: user.id, keyId: null, ip: clientIp(c) };
}

export function buildBillingRoutes(deps: BillingRoutesDeps): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  const now = deps.now ?? (() => new Date());
  const record = deps.audit ?? appendAudit;

  routes.get("/periods", deps.requireProvider, async (c) => {
    const { timeZone } = await loadInstallationTimeZone(deps.providerDb);
    return c.json(
      periodListDto(await listClosedPeriods(deps.providerDb), openPeriod(now(), timeZone)),
    );
  });

  routes.get("/periods/:period", deps.requireProvider, async (c) => {
    const { period } = parseOrProblem(periodParamSchema, c.req.param());
    return c.json(periodDto(await loadClosedPeriodOrProblem(deps.providerDb, period, now())));
  });

  routes.get("/periods/:period/csv", deps.requireProvider, async (c) => {
    const { period } = parseOrProblem(periodParamSchema, c.req.param());
    const loaded = await loadClosedPeriodOrProblem(deps.providerDb, period, now());
    const actor = actorOf(c);
    await record(deps.providerDb, {
      tenantId: null,
      actor: actor.label,
      actorUserId: actor.userId,
      action: BILLING_AUDIT_ACTIONS.exported,
      target: period,
      targetType: "billing_period",
      ip: actor.ip,
      details: { period, tenants: loaded.tenants.length },
    });
    return c.body(periodCsv(loaded), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="billing-${period}.csv"`,
    });
  });

  routes.post("/periods/:period/corrections", deps.requireProvider, async (c) => {
    const { period } = parseOrProblem(periodParamSchema, c.req.param());
    const body = await parseJsonBody(c.req, createCorrectionSchema);
    const actor = actorOf(c);
    const row = await createCorrection(
      { providerDb: deps.providerDb, audit: deps.audit },
      {
        period,
        tenantId: body.tenantId,
        lineType: body.type ?? null,
        amount: body.amount,
        reason: body.reason,
        actor: { label: actor.label, keyId: null, ip: actor.ip, userId: actor.userId },
      },
    );
    return c.json(correctionDto(row), 201);
  });

  return routes;
}

/** Mount path below /api/v1. */
export const BILLING_PATH = "/billing";

export const billingRoutes: SessionRouteContribution = {
  path: BILLING_PATH,
  guard: capabilityGuard(providerDb, "provider.crossTenantApi"),
  routes: buildBillingRoutes({ providerDb, requireProvider: requireProviderAdmin }),
};
