import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { tenants } from "./tenants.js";

/** Raw bytes (node-postgres reads and writes `bytea` as a Buffer). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Logos of the branding (0.5.0, docs/NOTIFICATIONS.md "Branding"): PNG or JPEG only, checked and
 * stripped of metadata when uploaded (apps/api features/branding/images.ts), at most 512 KiB. The
 * public image route serves them by `token` (32 random bytes, base64url), never by id; a replaced
 * logo is `retired_at` and still answers for 30 days (mails already sent show it), then it is
 * pruned. Installation-level: the tenant role has no grant on it.
 */
export const brandingImages = pgTable(
  "branding_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull().unique(),
    contentType: text("content_type").notNull(),
    bytes: bytea("bytes").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("branding_images_content_type_ck", sql`${t.contentType} IN ('image/png', 'image/jpeg')`),
    check("branding_images_byte_size_ck", sql`${t.byteSize} <= 524288`),
  ],
);

/** The branding fields a provider and a tenant override share. */
const brandingColumns = () => ({
  senderName: text("sender_name"),
  fromAddress: text("from_address"),
  replyTo: text("reply_to"),
  accentColor: text("accent_color"),
  footerText: text("footer_text"),
  logoImageId: uuid("logo_image_id").references(() => brandingImages.id, {
    onDelete: "set null",
  }),
  updatedBy: text("updated_by"),
});

/**
 * The provider's branding (0.5.0, edition Business): one row for the installation. Mails carry
 * its sender name, From, Reply-To, accent, footer and logo; chat webhooks its name and logo.
 */
export const providerBranding = pgTable(
  "provider_branding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    singleton: boolean("singleton").notNull().default(true),
    ...brandingColumns(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("provider_branding_singleton_uq").on(t.singleton),
    check("provider_branding_accent_ck", sql`${t.accentColor} ~ '^#[0-9a-f]{6}$'`),
    check("provider_branding_footer_ck", sql`length(${t.footerText}) <= 2000`),
  ],
);

/**
 * A tenant's own branding (0.5.0, edition Service Provider), replacing the provider's for the
 * messages about that tenant. Written by provider administrators in the tenant's transaction,
 * read by the renderers on the installation pool.
 */
export const tenantBranding = pgTable(
  "tenant_branding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .unique()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ...brandingColumns(),
    ...timestamps(),
  },
  (t) => [
    check("tenant_branding_accent_ck", sql`${t.accentColor} ~ '^#[0-9a-f]{6}$'`),
    check("tenant_branding_footer_ck", sql`length(${t.footerText}) <= 2000`),
  ],
);

export type BrandingImage = typeof brandingImages.$inferSelect;
export type ProviderBrandingRow = typeof providerBranding.$inferSelect;
export type TenantBrandingRow = typeof tenantBranding.$inferSelect;
