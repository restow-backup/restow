import { deflateSync } from "node:zlib";
import { brandingImages } from "@restow/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { crc32 } from "./images.js";

/**
 * The public branding images (0.5.0, docs/NOTIFICATIONS.md "Branding"): the logo chat services
 * show (Discord avatar, Teams header) and the 1×1 accent image Teams stretches into a band. No
 * session: the services fetch them themselves. The route serves only the image bytes, by an
 * unguessable token (32 random bytes), never a tenant id or any other data; a retired logo keeps
 * answering until it is pruned 30 days later, so mails and posts already sent still show it.
 *
 * Mounted at `/api/v1/public/branding` (app.ts), before every session middleware, and under
 * `/api/*`, so the edge needs no change.
 */

export const PUBLIC_BRANDING_MOUNT_PATH = "/public/branding";

const TOKEN_FILE = /^([A-Za-z0-9_-]{20,128})\.(png|jpg)$/;
const ACCENT_FILE = /^([0-9a-f]{6})\.png$/;

/** Headers of every image answer: cached for a year, never sniffed, never run as a document. */
function imageHeaders(contentType: string, length: number): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Length": String(length),
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": "inline",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
  };
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A 1×1 RGB PNG of `hex` (`rrggbb`), built by hand. */
export function accentPng(hex: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixel = Buffer.from([
    0,
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixel)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function buildPublicBrandingRoutes(deps: { readonly providerDb: DbExecutor }): Hono {
  const routes = new Hono();

  routes.get("/accent/:file", (c) => {
    const match = ACCENT_FILE.exec(c.req.param("file"));
    if (!match?.[1]) {
      return c.body(null, 404);
    }
    const png = accentPng(match[1]);
    return c.body(new Uint8Array(png), 200, imageHeaders("image/png", png.length));
  });

  routes.get("/:file", async (c) => {
    const match = TOKEN_FILE.exec(c.req.param("file"));
    if (!match?.[1]) {
      return c.body(null, 404);
    }
    const [image] = await deps.providerDb
      .select({ bytes: brandingImages.bytes, contentType: brandingImages.contentType })
      .from(brandingImages)
      .where(eq(brandingImages.token, match[1]))
      .limit(1);
    const extension = image?.contentType === "image/png" ? "png" : "jpg";
    if (!image || extension !== match[2]) {
      return c.body(null, 404);
    }
    return c.body(
      new Uint8Array(image.bytes),
      200,
      imageHeaders(image.contentType, image.bytes.length),
    );
  });

  return routes;
}
