import { type Context, Hono } from "hono";
import { z } from "zod";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { type SessionEnv, refuseApiKeys, requireProviderAdmin } from "../../middleware/session.js";
import { isValidMountName, mountSpecSchema } from "../../mounter/protocol.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody } from "../../schemas.js";
import { mountsService } from "./instance.js";
import type { MountsActor, MountsService } from "./service.js";

/**
 * /api/v1/mounts: Installation > Mounts (docs/MOUNTS.md), for provider admins. Reading
 * is for every provider admin with every tenant (the storage form offers the paths);
 * every change and every test is the owner's (lib/provider-access.ts):
 *
 *   GET    /             the shares, the running or last operation, how to start the mounter
 *   GET    /paths        only the paths of the shares (the storage form)
 *   POST   /             add a share: { mount, whenIdle? }          owner + recent sign-in
 *   DELETE /:name        remove a share                             owner + recent sign-in
 *   DELETE /:name?pending=1  withdraw the add of <name> that waits for running jobs  owner
 *   POST   /test         test settings ({ mount }) or a share ({ name })  owner
 *
 * Adding and removing restart the api and the worker on the host, with a mount the
 * Docker daemon makes as root: like an update, they need a recent sign-in. With
 * `whenIdle: true` an add that would be refused because jobs run waits instead and is
 * applied once none runs (service.ts, pending.ts); withdrawing such a waiting request
 * changes nothing on the host and needs no fresh sign-in. API keys are refused (403):
 * these are web UI routes.
 */

const addMountInputSchema = z
  .object({ mount: mountSpecSchema, whenIdle: z.boolean().optional() })
  .strict();
const testMountInputSchema = z.union([
  z.object({ mount: mountSpecSchema }).strict(),
  z.object({ name: z.string().refine(isValidMountName, "not a share name") }).strict(),
]);

function actorOf(c: Context<SessionEnv>): MountsActor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

export function buildMountsRoutes(service: MountsService): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();
  routes.use("*", refuseApiKeys, requireProviderAdmin);

  routes.get("/", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await service.view({ refresh: refresh === "1" || refresh === "true" }));
  });

  routes.get("/paths", async (c) => c.json({ paths: await service.paths() }));

  routes.post("/", async (c) => {
    const input = await parseJsonBody(c.req, addMountInputSchema);
    assertRecentSignIn(c.get("auth").session);
    return c.json(await service.add(input, actorOf(c)), 202);
  });

  routes.delete("/:name", async (c) => {
    const name = c.req.param("name");
    if (!isValidMountName(name)) {
      throw new ProblemError(422, "Validation failed", {
        detail: "A share name has 1 to 32 characters: a-z, 0-9 and '-'.",
      });
    }
    const pending = c.req.query("pending");
    if (pending === "1" || pending === "true") {
      return c.json(await service.cancelPending(name, actorOf(c)));
    }
    assertRecentSignIn(c.get("auth").session);
    return c.json(await service.remove(name, actorOf(c)), 202);
  });

  routes.post("/test", async (c) => {
    const input = await parseJsonBody(c.req, testMountInputSchema);
    return c.json(await service.test(input, actorOf(c)));
  });

  return routes;
}

export const mountsRoutes = buildMountsRoutes(mountsService);
