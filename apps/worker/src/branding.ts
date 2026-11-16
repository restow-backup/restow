/**
 * The brand of a chat webhook message (0.5.0, docs/NOTIFICATIONS.md "Webhook branding"): the
 * tenant's own branding while `branding.tenant` is on, else the provider's while
 * `branding.provider` is on, else none (the product name). Logo and accent images are linked by
 * their public URL on the instance, and only when that URL is https: the chat service fetches them.
 * Read on the installation pool (the branding tables carry no tenant data, or are read for one
 * tenant only).
 */
import {
  type BrandingRow,
  type BrandLogo,
  brandingAccentPath,
  brandingImagePath,
  httpsPublicUrl,
  resolveBrand,
} from "@restow/core";
import {
  brandingImages,
  type Database,
  providerBranding,
  type TenantBrandingRow,
  tenantBranding,
} from "@restow/db";
import { productName } from "@restow/i18n";
import { eq } from "drizzle-orm";
import type { WorkerFeatureGate } from "./extensions.js";
import type { ChatBrand } from "./handlers/webhook-formats.js";

type BrandingColumns = Pick<
  TenantBrandingRow,
  "senderName" | "fromAddress" | "replyTo" | "accentColor" | "footerText" | "logoImageId"
>;

async function logoOf(db: Database, imageId: string | null): Promise<BrandLogo | null> {
  if (!imageId) {
    return null;
  }
  const [image] = await db
    .select({
      id: brandingImages.id,
      token: brandingImages.token,
      contentType: brandingImages.contentType,
      width: brandingImages.width,
      height: brandingImages.height,
      sha256: brandingImages.sha256,
    })
    .from(brandingImages)
    .where(eq(brandingImages.id, imageId))
    .limit(1);
  if (!image || (image.contentType !== "image/png" && image.contentType !== "image/jpeg")) {
    return null;
  }
  return {
    imageId: image.id,
    token: image.token,
    contentType: image.contentType,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
  };
}

async function rowOf(db: Database, row: BrandingColumns | undefined): Promise<BrandingRow | null> {
  if (!row) {
    return null;
  }
  return {
    senderName: row.senderName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    accentColor: row.accentColor,
    footerText: row.footerText,
    logo: await logoOf(db, row.logoImageId),
  };
}

/** The chat brand of `tenantId`'s messages, or null when they go out as the product. */
export async function loadChatBrand(
  db: Database,
  tenantId: string,
  gate: WorkerFeatureGate | undefined,
  publicUrl: string | null,
): Promise<ChatBrand | null> {
  if (!gate) {
    return null;
  }
  const providerAllowed = await gate.isEnabled("branding.provider");
  const tenantAllowed = await gate.isEnabled("branding.tenant");
  if (!providerAllowed && !tenantAllowed) {
    return null;
  }
  const [provider] = providerAllowed ? await db.select().from(providerBranding).limit(1) : [];
  const [tenant] = tenantAllowed
    ? await db.select().from(tenantBranding).where(eq(tenantBranding.tenantId, tenantId)).limit(1)
    : [];
  const brand = resolveBrand({
    productName: productName(),
    provider: await rowOf(db, provider),
    tenant: await rowOf(db, tenant),
    providerAllowed,
    tenantAllowed,
    logoUrl: (logo) => httpsPublicUrl(publicUrl, brandingImagePath(logo)),
  });
  if (!brand.branded) {
    return null;
  }
  const accentPath = brand.accentColor ? brandingAccentPath(brand.accentColor) : null;
  return {
    name: brand.senderName,
    avatarUrl: brand.logoUrl,
    logoUrl: brand.logoUrl,
    accentPngUrl: accentPath ? httpsPublicUrl(publicUrl, accentPath) : null,
    accentColor: brand.accentColor,
  };
}
