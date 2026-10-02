import { type Context, Hono } from "hono";
import { db, providerDb } from "../../db.js";
import { clientIp, observedOrigin } from "../../lib/request.js";
import { type TenantEnv, requireTenant, sessionFromRequest } from "../../middleware/session.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { LANDING_CSP, preferredLanguage, renderConsentLanding } from "./landing.js";
import {
  consentLinkSchema,
  createSourceSchema,
  imapTestSchema,
  sourceIdParamSchema,
  updateSourceSchema,
} from "./schemas.js";
import {
  type Actor,
  type ConsentResult,
  createConsentLink,
  createSource,
  deleteSource,
  getEntraStatus,
  getSource,
  handleConsentCallback,
  listSources,
  resolvePublicOrigin,
  testImapConnection,
  testSource,
  updateSource,
  verifySource,
} from "./service.js";

/**
 * /api/v1/sources — Microsoft 365 and IMAP sources of the active tenant.
 *
 * Everything requires the tenant_admin role (or a provider admin) except the
 * admin-consent callback, which Entra calls on behalf of the customer's Global
 * Admin: it is public and bound to the request by its signed state only. It is
 * visited twice per connection: after the admin consent (which only claims a
 * tenant) and after the sign-in that proves who consented, in which tenant.
 *
 *   GET    /                      list
 *   POST   /                      create (m365 | imap)
 *   GET    /entra/status          is the Entra app configured, which callback to register
 *   POST   /imap/test             probe a connection from the form (nothing saved)
 *   GET    /m365/consent/callback public: Entra redirect target
 *   GET    /:id                   detail
 *   PATCH  /:id                   update (name, pause/resume, tenant hint, IMAP connection, password)
 *   DELETE /:id                   delete (and its secret); refused while it holds data
 *   POST   /:id/consent-link      signed admin-consent link
 *   POST   /:id/verify            verify permissions + test call (m365)
 *   POST   /:id/test              probe the stored connection and record it (imap)
 */

export const sourcesRoutes = new Hono<TenantEnv>();

const tenantAdmin = requireTenant("tenant_admin");

/**
 * Where the browser lands after a consent round trip that names no tenant (an invalid or unknown
 * link): the old address of the sources, which leads on to the connections page of the tenant
 * that is active in the browser (web feature `redirects`).
 */
const WEB_SOURCES_PATH = "/sources";

/** The page of one source on its tenant's page (Connections), where the consent outcome is shown. */
function webSourcePath(tenantId: string, sourceId: string): string {
  return `/tenants/${tenantId}/connections/sources/${sourceId}`;
}

function actorOf(c: Context<TenantEnv>): Actor {
  const user = c.get("user");
  return {
    id: user.id,
    email: user.email,
    ip: clientIp(c),
    isProviderAdmin: c.get("isProviderAdmin"),
  };
}

function sourceId(c: Context<TenantEnv>): string {
  return parseOrProblem(sourceIdParamSchema, c.req.param()).id;
}

/** A JSON body that may be absent entirely (actions without parameters). */
async function optionalJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Base for building the relative landing path; never part of a result. */
const PATH_BASE = "http://path.invalid";

/**
 * The web page a signed-in operator should see after the consent round trip:
 * the source on the page of the Restow tenant the link was made for (the page
 * makes that tenant the active one).
 *
 * With an `origin` the result is an absolute URL on it; without one it is a
 * path (`/sources...`) the browser resolves against the origin it called, so
 * the callback never needs to guess an origin from the request headers.
 */
export function consentLandingUrl(origin: string | null, outcome: ConsentResult): string {
  const url = new URL(WEB_SOURCES_PATH, origin ?? PATH_BASE);
  url.searchParams.set("consent", outcome.kind);
  switch (outcome.kind) {
    case "granted":
      url.pathname = webSourcePath(outcome.tenantId, outcome.sourceId);
      if (outcome.verification) {
        url.searchParams.set("verified", outcome.verification.ok ? "ok" : "failed");
      }
      break;
    case "denied":
      url.pathname = webSourcePath(outcome.tenantId, outcome.sourceId);
      url.searchParams.set("error", outcome.error);
      break;
    case "identity_not_verified":
      url.pathname = webSourcePath(outcome.tenantId, outcome.sourceId);
      url.searchParams.set("reason", outcome.reason);
      break;
    case "tenant_already_connected":
    case "tenant_mismatch":
      url.pathname = webSourcePath(outcome.tenantId, outcome.sourceId);
      break;
    case "invalid_state":
      url.searchParams.set("reason", outcome.reason);
      break;
    case "unknown_source":
      break;
  }
  return origin === null ? `${url.pathname}${url.search}` : url.toString();
}

/**
 * The origin the consent callback may send a signed-in operator to: the
 * configured public URL (settings, else environment), or none. The callback
 * is a top-level navigation coming from Microsoft or from any page that links
 * to it, so `Origin`, `Referer` and the forwarding headers describe where the
 * browser came from, not where Restow lives; redirecting there would turn the
 * callback into an open redirect. Without a configured origin the redirect is
 * a same-origin path instead.
 */
async function configuredPublicOrigin(): Promise<string | null> {
  return resolvePublicOrigin(db, null);
}

async function hasRestowSession(headers: Headers): Promise<boolean> {
  try {
    return (await sessionFromRequest(headers)) !== null;
  } catch {
    return false;
  }
}

// --- Public: Entra admin-consent callback -------------------------------------

sourcesRoutes.get("/m365/consent/callback", async (c) => {
  const query = new URL(c.req.url).searchParams;
  const outcome = await handleConsentCallback(db, query, clientIp(c), {
    installation: providerDb,
    observedOrigin: observedOrigin(c),
  });
  // The URL carried the signed state; keep it out of caches and referrers.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");

  if (outcome.kind === "sign_in_required") {
    // The consent itself only claimed a tenant: the admin now signs in there.
    return c.redirect(outcome.url, 302);
  }

  if (await hasRestowSession(c.req.raw.headers)) {
    return c.redirect(consentLandingUrl(await configuredPublicOrigin(), outcome), 302);
  }
  // The customer's admin usually has no Restow account: tell them the outcome here.
  c.header("Content-Security-Policy", LANDING_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  const status = outcome.kind === "invalid_state" || outcome.kind === "unknown_source" ? 400 : 200;
  return c.html(
    renderConsentLanding(outcome.kind, preferredLanguage(c.req.header("accept-language"))),
    status,
  );
});

// --- Tenant admin: status, list, create, inline IMAP test ---------------------

sourcesRoutes.get("/entra/status", tenantAdmin, async (c) => {
  return c.json(await getEntraStatus(db, observedOrigin(c)));
});

sourcesRoutes.post("/imap/test", tenantAdmin, async (c) => {
  const input = await parseJsonBody(c.req, imapTestSchema);
  return c.json(await testImapConnection(db, c.get("tenantId"), input, actorOf(c)));
});

sourcesRoutes.get("/", tenantAdmin, async (c) => {
  return c.json({ items: await listSources(db, c.get("tenantId")) });
});

sourcesRoutes.post("/", tenantAdmin, async (c) => {
  const input = await parseJsonBody(c.req, createSourceSchema);
  return c.json(await createSource(db, c.get("tenantId"), input, actorOf(c)), 201);
});

// --- Tenant admin: one source ---------------------------------------------------

sourcesRoutes.get("/:id", tenantAdmin, async (c) => {
  return c.json(await getSource(db, c.get("tenantId"), sourceId(c)));
});

sourcesRoutes.patch("/:id", tenantAdmin, async (c) => {
  const patch = await parseJsonBody(c.req, updateSourceSchema);
  return c.json(await updateSource(db, c.get("tenantId"), sourceId(c), patch, actorOf(c)));
});

sourcesRoutes.delete("/:id", tenantAdmin, async (c) => {
  await deleteSource(db, c.get("tenantId"), sourceId(c), actorOf(c));
  return c.body(null, 204);
});

sourcesRoutes.post("/:id/consent-link", tenantAdmin, async (c) => {
  const id = sourceId(c);
  const body = parseOrProblem(consentLinkSchema, await optionalJson(c));
  const link = await createConsentLink(db, c.get("tenantId"), id, actorOf(c), {
    tenant: body?.tenant,
    observedOrigin: observedOrigin(c),
  });
  return c.json(link, 201);
});

sourcesRoutes.post("/:id/verify", tenantAdmin, async (c) => {
  return c.json(await verifySource(db, c.get("tenantId"), sourceId(c), actorOf(c)));
});

sourcesRoutes.post("/:id/test", tenantAdmin, async (c) => {
  return c.json(await testSource(db, c.get("tenantId"), sourceId(c), actorOf(c)));
});
