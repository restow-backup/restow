import { type Context, Hono, type MiddlewareHandler } from "hono";
import { db, providerDb } from "../../db.js";
import { requestLanguage } from "../../lib/language.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { type SessionEnv, requireProviderAdmin } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { inviteMemberSchema, memberParamSchema, updateMemberSchema } from "./schemas.js";
import {
  type TeamActor,
  type TeamDeps,
  inviteMember,
  listTeam,
  reissueInvitation,
  removeMember,
  resetAccess,
  updateMember,
} from "./service.js";

/**
 * /api/v1/provider-team: the provider's own admins, their roles and tenants
 * (every edition; limiting a member to chosen tenants is the gated feature
 * `providerTeam.tenantScope`, see ./service.ts).
 *
 *   GET    /                       the team (every provider admin)
 *   POST   /                       invite a new provider admin
 *   PATCH  /:userId                change role and tenants
 *   DELETE /:userId                remove from the team
 *   POST   /:userId/reissue        a fresh invitation link (not signed in yet)
 *   POST   /:userId/reset-access   take an active member's sign-in methods
 *                                  away and issue a fresh set-password link
 *                                  (needs a recent sign-in)
 *
 * Provider admins only; what each may do here (reading: everyone with every
 * tenant; changing: owners) is the provider team rule of each route
 * (lib/provider-access.ts), applied by `requireProviderAdmin`.
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

  routes.post("/:userId/reset-access", deps.requireProvider, async (c) => {
    const { userId } = parseOrProblem(memberParamSchema, c.req.param());
    // The new link opens the member's account; a stolen or forgotten owner
    // session must not hand it out (lib/recent-sign-in.ts).
    assertRecentSignIn(c.get("auth").session);
    return c.json(await resetAccess(team, userId, actorOf(c), requestLanguage(c)));
  });

  return routes;
}

export const providerTeamRoutes = buildProviderTeamRoutes({
  providerDb,
  db,
  requireProvider: requireProviderAdmin,
});
