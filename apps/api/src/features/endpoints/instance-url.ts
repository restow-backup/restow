import { settings } from "@restow/db";
import type { Context } from "hono";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { arrivalOrigin } from "../../middleware/browser-request.js";
import { originOf } from "../../middleware/browser-request.js";

/**
 * The public address of this installation, as an agent must reach it: the
 * origin the setup wizard stored (`settings.public_url`), else the one from
 * the environment (`RESTOW_PUBLIC_URL`), else the origin the request itself
 * arrived at (a local installation has no public URL). Never a hard-coded
 * domain.
 */
export async function instanceUrl(c: Context): Promise<{ url: string; configured: boolean }> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  const configured = originOf(row?.publicUrl) ?? originOf(config.publicUrl);
  if (configured) {
    return { url: configured, configured: true };
  }
  const arrival = arrivalOrigin((name) => c.req.header(name), c.req.url);
  if (!arrival) {
    return { url: "", configured: false };
  }
  return { url: arrival, configured: false };
}

/** Plain HTTP to anything but the machine itself: agents would send their secret unencrypted. */
export function isInsecureTransport(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") {
      return false;
    }
    return !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return true;
  }
}
