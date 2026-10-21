import { type Context, Hono } from "hono";
import { providerDb } from "../../db.js";
import { acceptDisclaimer } from "../../lib/disclaimer.js";
import { requestLanguage } from "../../lib/language.js";
import { assertRecentSignIn } from "../../lib/recent-sign-in.js";
import { clientIp } from "../../lib/request.js";
import { refuseApiKeys, requireProviderAdmin, type SessionEnv } from "../../middleware/session.js";
import { acceptDisclaimerSchema, parseJsonBody, parseOrProblem } from "../../schemas.js";
import { getGlobalAgentPolicy, updateGlobalAgentPolicy } from "../endpoints/agent-policy.js";
import { globalAgentPolicySchema } from "../endpoints/schemas.js";
import { getPveSettings, pveSettingsSchema, updatePveSettings } from "../pve/settings.js";
import { ransomwareSettingsSchema } from "../suspicion/schemas.js";
import { getRansomwareSettings, updateRansomwareSettings } from "../suspicion/service.js";
import {
  getDefaultStorage,
  removeDefaultStorage,
  saveDefaultStorage,
  testDefaultStorage,
} from "./default-storage.js";
import { saveMicrosoftAppSchema, testMicrosoftAppSchema } from "./microsoft-app/schemas.js";
import {
  getMicrosoftApp,
  removeMicrosoftApp,
  saveMicrosoftApp,
  testMicrosoftApp,
} from "./microsoft-app/service.js";
import { browserOrigin } from "./origin.js";
import { getPasskeyImpact } from "./passkey-impact.js";
import {
  mailNotNeededSchema,
  mailTestSchema,
  saveDefaultStorageSchema,
  timeZoneSettingSchema,
  updateSettingsSchema,
} from "./schemas.js";
import {
  type Actor,
  checkPasskeyReadiness,
  getSettings,
  type RequestContext,
  removeMailConfiguration,
  sendTestMail,
  setInstallationTimeZone,
  setMailNotNeeded,
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
 *   PUT    /mail/not-needed       mark the notification mail as not needed for the Start
 *                                  checklist, or take the mark back ({ notNeeded: boolean })
 *   PUT    /time-zone             the installation's time zone ({ timeZone: IANA name | null };
 *                                  null takes the choice back: RESTOW_TIME_ZONE, TZ, Europe/Berlin);
 *                                  owner only, audited; GET / carries it as `timeZone`
 *   GET    /passkey-ready         re-check the passkey gate plus a server-side HTTPS probe
 *   GET    /passkey-impact        how many accounts (and whether the requester's own) could no
 *                                  longer sign in once passkeys stop working: asked before
 *                                  leaving public mode or moving the public URL to another host
 *   POST   /disclaimer            accept the current operator responsibility notice (provider
 *                                  owner or administrator; for an installation set up before the notice existed, or
 *                                  when its text changed: lib/disclaimer.ts)
 *   GET    /microsoft-app         the Microsoft 365 app registration: where it comes from,
 *                                  redirect URIs, required permissions, last test
 *   PUT    /microsoft-app         save it (client secret or certificate are write-only)
 *   POST   /microsoft-app/test    acquire a Graph token and compare the granted permissions
 *   DELETE /microsoft-app         remove the saved registration
 *   GET    /ransomware            the thresholds of the ransomware detection, their defaults and
 *                                  ranges, the version of the name signatures
 *   PUT    /ransomware            replace the stored thresholds (what is left out takes its
 *                                  default; `{}` is every default)
 *   GET    /pve                   the installation's Proxmox VE settings (check every new restore
 *                                  point right after its backup) and their defaults
 *   PUT    /pve                   change them (what is left out stays)
 *   GET    /agent-policy          the installation's agent policy, its locks, the defaults
 *   PUT    /agent-policy          replace it; every machine whose effective policy changes gets
 *                                  a new configuration version (all tenants)
 *   GET    /default-storage       the installation's default storage (saved here, else from the
 *                                  environment), how many tenants keep their data on it, which
 *                                  tenants keep it from moving, the last test of it
 *   PUT    /default-storage       save it (local path or S3; the key pair is write-only); probed
 *                                  first, refused (409) while tenants keep data on a default that
 *                                  would move; owner only, recent sign-in (lib/recent-sign-in.ts)
 *   DELETE /default-storage       remove the saved default, so the environment applies again
 *                                  (same checks as PUT)
 *   POST   /default-storage/test  write/read/list/delete probe and Object Lock detection on the
 *                                  default; recorded in the installation audit chain
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

settingsRoutes.put("/mail/not-needed", async (c) => {
  const input = await parseJsonBody(c.req, mailNotNeededSchema);
  return c.json(await setMailNotNeeded(providerDb, input.notNeeded, actorOf(c)));
});

// The installation's time zone (0.4.2): planned updates are read in it, new tenants start with it.
settingsRoutes.put("/time-zone", async (c) => {
  const input = await parseJsonBody(c.req, timeZoneSettingSchema);
  return c.json(await setInstallationTimeZone(providerDb, input, actorOf(c), requestContext(c)));
});

settingsRoutes.get("/passkey-ready", async (c) => {
  return c.json(await checkPasskeyReadiness(providerDb, requestContext(c)));
});

settingsRoutes.get("/passkey-impact", async (c) => {
  return c.json(await getPasskeyImpact(providerDb, c.get("user").id));
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

// Ransomware detection (docs/RANSOMWARE.md): the thresholds every provider admin reads and the
// owner changes (lib/provider-access.ts).
settingsRoutes.get("/ransomware", async (c) => {
  return c.json(await getRansomwareSettings(providerDb));
});

settingsRoutes.put("/ransomware", async (c) => {
  const input = await parseJsonBody(c.req, ransomwareSettingsSchema);
  return c.json(await updateRansomwareSettings(providerDb, input, actorOf(c)));
});

// Proxmox VE (docs/PVE.md, "Restore check"): every provider admin reads, the owner changes.
settingsRoutes.get("/pve", async (c) => {
  return c.json(await getPveSettings(providerDb));
});

settingsRoutes.put("/pve", async (c) => {
  const input = await parseJsonBody(c.req, pveSettingsSchema);
  return c.json(await updatePveSettings(providerDb, input, actorOf(c)));
});

// Agent policies (docs/AGENT.md, "Richtlinien"): every provider admin reads the installation's
// policy, administrators with every tenant change it (lib/provider-access.ts); a change writes the
// configuration of every machine whose effective policy changes, in every tenant.
settingsRoutes.get("/agent-policy", async (c) => {
  return c.json(await getGlobalAgentPolicy(providerDb));
});

settingsRoutes.put("/agent-policy", async (c) => {
  const input = await parseJsonBody(c.req, globalAgentPolicySchema);
  return c.json(await updateGlobalAgentPolicy(input, actorOf(c)));
});

settingsRoutes.get("/default-storage", async (c) => {
  return c.json(await getDefaultStorage(providerDb));
});

settingsRoutes.post("/default-storage/test", async (c) => {
  return c.json(await testDefaultStorage(providerDb, actorOf(c)));
});

// Pointing the default elsewhere decides where every tenant without a storage target of its own
// keeps its backups, and a local path is part of the host: a recent sign-in on top of the owner role.
settingsRoutes.put("/default-storage", async (c) => {
  assertRecentSignIn(c.get("auth").session);
  const input = await parseJsonBody(c.req, saveDefaultStorageSchema);
  return c.json(await saveDefaultStorage(providerDb, input, actorOf(c)));
});

settingsRoutes.delete("/default-storage", async (c) => {
  assertRecentSignIn(c.get("auth").session);
  return c.json(await removeDefaultStorage(providerDb, actorOf(c)));
});
