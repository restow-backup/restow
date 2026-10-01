import type { Database } from "@restow/db";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../../../apps/api/src/db.js";
import type { SessionRouteContribution } from "../../../../apps/api/src/extensions.js";
import { requestLanguage } from "../../../../apps/api/src/lib/language.js";
import { clientIp } from "../../../../apps/api/src/lib/request.js";
import {
  type SessionEnv,
  requireProviderAdmin,
} from "../../../../apps/api/src/middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../../../apps/api/src/schemas.js";
import { capabilityGuard } from "../license/gate.js";
import { inviteMemberSchema, memberParamSchema, updateMemberSchema } from "./schemas.js";
import {
  type TeamActor,
  type TeamDeps,
  inviteMember,
  listTeam,
  reissueInvitation,
  removeMember,
  updateMember,
} from "./service.js";

/**
 * /api/v1/provider-team: the provider's own admins, their roles and tenants.
 *
 *   GET    /                  the team (every provider admin)
 *   POST   /                  invite a new provider admin
 *   PATCH  /:userId           change role and tenants
 *   DELETE /:userId           remove from the team
 *   POST   /:userId/reissue   a fresh invitation link
 *
 * Provider admins only; what each may do here (reading: everyone with every
 * tenant; changing: owners) is the provider team rule of each route
 * (apps/api lib/provider-access.ts), applied by `requireProviderAdmin`.
 * Mounted behind the `provider.team` capability: without it, 404.
 */

export interface ProviderTeamRoutesDeps extends TeamDeps {
  requireProvider: MiddlewareHandler<SessionEnv>;
}

function actorOf(c: Context<SessionEnv>): TeamActor {
  const user = c.get("user");
  return { userId: user.id, email: user.email, ip: clientIp(c) };
}

export function buildProviderTeamRoutes(deps: ProviderTeamRoutesDeps): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  const team: TeamDeps = { providerDb: deps.providerDb, db: deps.db };

  routes.get("/", deps.requireProvider, async (c) => {
    return c.json({ items: await listTeam(team, c.get("user").id) });
  });

  routes.post("/", deps.requireProvider, async (c) => {
    const input = await parseJsonBody(c.req, inviteMemberSchema);
    return c.json(await inviteMember(team, input, actorOf(c), requestLanguage(c)), 201);
  });

  routes.patch("/:userId", deps.requireProvider, async (c) => {
    const { userId } = parseOrProblem(memberParamSchema, c.req.param());
    const input = await parseJsonBody(c.req, updateMemberSchema);
    return c.json(await updateMember(team, userId, input, actorOf(c)));
  });

  routes.delete("/:userId", deps.requireProvider, async (c) => {
    const { userId } = parseOrProblem(memberParamSchema, c.req.param());
    await removeMember(team, userId, actorOf(c));
    return c.body(null, 204);
  });

  routes.post("/:userId/reissue", deps.requireProvider, async (c) => {
    const { userId } = parseOrProblem(memberParamSchema, c.req.param());
    return c.json(await reissueInvitation(team, userId, actorOf(c), requestLanguage(c)));
  });

  return routes;
}

/** Mount path below /api/v1 of the provider team routes. */
export const PROVIDER_TEAM_PATH = "/provider-team";

export const providerTeamRoutes: SessionRouteContribution = {
  path: PROVIDER_TEAM_PATH,
  guard: capabilityGuard(db, "provider.team"),
  routes: buildProviderTeamRoutes({
    providerDb: providerDb as Database,
    db: db as Database,
    requireProvider: requireProviderAdmin,
  }),
};
