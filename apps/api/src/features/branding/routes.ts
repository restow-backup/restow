import type { Database } from "@restow/db";
import { type Context, Hono } from "hono";
import { requestLanguage } from "../../lib/language.js";
import { clientIp } from "../../lib/request.js";
import type { SessionEnv } from "../../middleware/session.js";
import type { Notifier } from "../../notify.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { MAX_LOGO_BYTES } from "./images.js";
import {
  brandingPreview,
  brandingPreviewQuerySchema,
  brandingTestSchema,
  sendBrandingTest,
} from "./preview.js";
import {
  type BrandingActor,
  brandingInputSchema,
  deleteProviderLogo,
  getProviderBranding,
  putProviderBranding,
  putProviderLogo,
} from "./service.js";

/**
 * /api/v1/settings/branding — the provider's branding (0.5.0, docs/NOTIFICATIONS.md
 * "Branding"); mounted inside the settings routes (provider admins only, no API keys).
 *
 *   GET    /              the branding, what the edition offers, the mail transport's From
 *                         rules and whether the public URL is https (every edition)
 *   PUT    /              change it (owner; edition Business, `branding.provider`)
 *   PUT    /logo          upload the logo: the raw PNG or JPEG bytes (owner)
 *   DELETE /logo          remove it (owner)
 *   GET    /preview       a sample alert, digest, summary or customer report in the brand
 *   POST   /test          the sample alert to the signed-in user
 */

export interface BrandingRouteDeps {
  readonly providerDb: Database;
  readonly notifier: () => Promise<Notifier | null>;
}

export function actorOf(c: Context<SessionEnv>): BrandingActor {
  const user = c.get("user");
  return { id: user.id, email: user.email, ip: clientIp(c) };
}

/** The raw body of a logo upload, at most {@link MAX_LOGO_BYTES} (422 `too-large` beyond). */
export async function logoBody(c: Context): Promise<{ bytes: Buffer; type: string | null }> {
  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.length === 0) {
    throw new ProblemError(422, "Invalid image", {
      type: "urn:restow:problem:invalid-image",
      detail: "The request carries no image.",
      extensions: { code: "corrupt", field: "logo" },
    });
  }
  if (buffer.length > MAX_LOGO_BYTES) {
    throw new ProblemError(422, "Invalid image", {
      type: "urn:restow:problem:invalid-image",
      detail: "The logo may be at most 512 KiB.",
      extensions: { code: "too-large", field: "logo" },
    });
  }
  return { bytes: buffer, type: c.req.header("content-type") ?? null };
}

export function buildBrandingRoutes(deps: BrandingRouteDeps): Hono<SessionEnv> {
  const routes = new Hono<SessionEnv>();

  routes.get("/", async (c) => c.json(await getProviderBranding(deps.providerDb)));

  routes.put("/", async (c) => {
    const input = await parseJsonBody(c.req, brandingInputSchema);
    return c.json(await putProviderBranding(deps.providerDb, input, actorOf(c)));
  });

  routes.put("/logo", async (c) => {
    const { bytes, type } = await logoBody(c);
    return c.json(await putProviderLogo(deps.providerDb, bytes, type, actorOf(c)));
  });

  routes.delete("/logo", async (c) => {
    await deleteProviderLogo(deps.providerDb, actorOf(c));
    return c.body(null, 204);
  });

  routes.get("/preview", async (c) => {
    const query = parseOrProblem(brandingPreviewQuerySchema, c.req.query());
    return c.json(await brandingPreview(deps.providerDb, query));
  });

  routes.post("/test", async (c) => {
    const input = await parseJsonBody(c.req, brandingTestSchema);
    return c.json(
      await sendBrandingTest(
        deps.providerDb,
        await deps.notifier(),
        input,
        actorOf(c),
        requestLanguage(c),
      ),
      202,
    );
  });

  return routes;
}
