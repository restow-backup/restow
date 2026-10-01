import { type Context, Hono } from "hono";
import { providerDb } from "../../db.js";
import { acceptDisclaimer } from "../../lib/disclaimer.js";
import { requestLanguage } from "../../lib/language.js";
import { clientIp } from "../../lib/request.js";
import { type SessionEnv, refuseApiKeys, requireProviderAdmin } from "../../middleware/session.js";
import { acceptDisclaimerSchema, parseJsonBody, parseOrProblem } from "../../schemas.js";
import { saveMicrosoftAppSchema, testMicrosoftAppSchema } from "./microsoft-app/schemas.js";
import {
  getMicrosoftApp,
  removeMicrosoftApp,
  saveMicrosoftApp,
  testMicrosoftApp,
} from "./microsoft-app/service.js";
import { browserOrigin } from "./origin.js";
import { mailTestSchema, updateSettingsSchema } from "./schemas.js";
import {
  type Actor,
  type RequestContext,
  checkPasskeyReadiness,
  getSettings,
  removeMailConfiguration,
  sendTestMail,
  updateSettings,
} from "./service.js";

/**
 * /api/v1/settings — installation settings for provider admins.
 *
 *   GET    /                      operating mode, public URL, passkey gate, mail transport
 *   PATCH  /                      change mode, public URL and/or the mail transport
 *   POST   /mail/test             send a test notification (stored or draft transport) in the
 *                                  requester's language (Accept-Language)
 *   DELETE /mail                  remove the mail transport and its stored password
 *   GET    /passkey-ready         re-check the passkey gate plus a server-side HTTPS probe
 *   POST   /disclaimer            accept the current operator responsibility notice (provider
 *                                  owner or administrator; for an installation set up before the notice existed, or
 *                                  when its text changed: lib/disclaimer.ts)
 *   GET    /microsoft-app         the Microsoft 365 app registration: where it comes from,
 *                                  redirect URIs, required permissions, last test
 *   PUT    /microsoft-app         save it (client secret or certificate are write-only)
 *   POST   /microsoft-app/test    acquire a Graph token and compare the granted permissions
 *   DELETE /microsoft-app         remove the saved registration
 *
 * Responses never contain secrets; the SMTP password, the client secret and the
 * certificate's private key are write-only. API keys are refused (403): these
 * are web UI routes.
 *
 * Everything here is installation-level: the settings row, the provider's
 * secrets (without tenant) and the installation audit chain. It runs on the
 * installation pool (apps/api/src/db.ts).
 */

export const settingsRoutes = new Hono<SessionEnv>();

settingsRoutes.use("*", refuseApiKeys, requireProviderAdmin);

function actorOf(c: Context<SessionEnv>): Actor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

function requestContext(c: Context<SessionEnv>): RequestContext {
  return { observedOrigin: browserOrigin((name) => c.req.header(name), c.req.url) };
}

settingsRoutes.get("/", async (c) => {
  return c.json(await getSettings(providerDb, requestContext(c)));
});

settingsRoutes.patch("/", async (c) => {
  const patch = await parseJsonBody(c.req, updateSettingsSchema);
  return c.json(await updateSettings(providerDb, patch, actorOf(c), requestContext(c)));
});

settingsRoutes.post("/mail/test", async (c) => {
  const input = await parseJsonBody(c.req, mailTestSchema);
  return c.json(await sendTestMail(providerDb, input, actorOf(c), requestLanguage(c)));
});

settingsRoutes.delete("/mail", async (c) => {
  return c.json(await removeMailConfiguration(providerDb, actorOf(c), requestContext(c)));
});

settingsRoutes.get("/passkey-ready", async (c) => {
  return c.json(await checkPasskeyReadiness(providerDb, requestContext(c)));
});

settingsRoutes.post("/disclaimer", async (c) => {
  const input = await parseJsonBody(c.req, acceptDisclaimerSchema);
  const user = actorOf(c);
  const accepted = await providerDb.transaction((tx) =>
    acceptDisclaimer(tx, {
      version: input.version,
      actor: { id: user.id, email: user.email },
      ip: user.ip,
      via: "sign_in",
    }),
  );
  return c.json(accepted);
});

settingsRoutes.get("/microsoft-app", async (c) => {
  return c.json(await getMicrosoftApp(providerDb, requestContext(c)));
});

settingsRoutes.put("/microsoft-app", async (c) => {
  const input = await parseJsonBody(c.req, saveMicrosoftAppSchema);
  return c.json(await saveMicrosoftApp(providerDb, input, actorOf(c), requestContext(c)));
});

settingsRoutes.post("/microsoft-app/test", async (c) => {
  // The body is optional: without one the saved home tenant is tested.
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const input = parseOrProblem(testMicrosoftAppSchema, body);
  return c.json(await testMicrosoftApp(providerDb, input, actorOf(c)));
});

settingsRoutes.delete("/microsoft-app", async (c) => {
  return c.json(await removeMicrosoftApp(providerDb, actorOf(c), requestContext(c)));
});
