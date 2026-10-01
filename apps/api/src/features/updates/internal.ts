import { readFile } from "node:fs/promises";
import { Hono, type MiddlewareHandler } from "hono";
import { config } from "../../config.js";
import { providerDb } from "../../db.js";
import { updateState } from "./state-instance.js";
import { tokenFor } from "./token.js";
import { DEFAULT_SECRET_FILE, SecretReader, bearerOf, secretMatches } from "./updater-client.js";

/**
 * The api's side of the updater's shared secret (docs/ARCHITECTURE.md, Updates):
 * the secret is a file in a volume the updater writes and the api mounts
 * read-only. Two things accept it:
 *
 *   GET /readyz             adds the running `version` for the updater, so it can wait for the new
 *                           version to answer. Without the secret the answer is unchanged.
 *   GET /internal/updater/source-token
 *                           hands the updater the access token for the update source at the moment
 *                           it fetches a tagged archive (`source` mode). The token is not stored
 *                           in the updater; it holds it in memory for that one request.
 *
 * `/internal/*` is not routed by the Caddy edge; as defence in depth it also refuses any request
 * that carries a proxy header, so even a misrouted request cannot reach it.
 */

const secretFile = process.env.RESTOW_UPDATER_SECRET_FILE?.trim() || DEFAULT_SECRET_FILE;
export const updaterSecret = new SecretReader(
  secretFile,
  (path) => readFile(path, "utf8"),
  Date.now,
);

/** Whether the request presents the updater's shared secret. */
export async function isUpdater(authorization: string | null | undefined): Promise<boolean> {
  if (config.demo.enabled) {
    return false;
  }
  const presented = bearerOf(authorization);
  if (!presented) {
    return false;
  }
  const secret = await updaterSecret.get();
  return secret !== null && secretMatches(presented, secret);
}

const refuseProxied: MiddlewareHandler = async (c, next) => {
  if (c.req.header("x-forwarded-for") || c.req.header("x-forwarded-host") || config.demo.enabled) {
    return c.body(null, 404);
  }
  await next();
};

export const internalRoutes = new Hono();
internalRoutes.use("*", refuseProxied);

internalRoutes.get("/updater/source-token", async (c) => {
  if (!(await isUpdater(c.req.header("authorization")))) {
    return c.body(null, 401);
  }
  const source = updateState.get().source;
  const token =
    updateState.get().origin === "environment" || source.provider === "feed"
      ? null
      : await tokenFor(providerDb, new URL(source.releasesUrl).origin);
  c.header("cache-control", "no-store");
  return c.json({ token });
});

export const INTERNAL_MOUNT_PATH = "/internal";
