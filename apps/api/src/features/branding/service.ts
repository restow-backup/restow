import { randomBytes } from "node:crypto";
import {
  accentContrast,
  addressOf,
  type BrandingRow,
  type BrandLogo,
  brandingImagePath,
  type EffectiveBrand,
  httpsPublicUrl,
  isPlainEmail,
  isValidSenderName,
  normalizeAccent,
  onAccentFor,
  resolveBrand,
  senderAllowed,
} from "@restow/core";
import {
  brandingImages,
  type Database,
  providerBranding,
  settings,
  tenantBranding,
} from "@restow/db";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import type { MailAttachment } from "../../notify.js";
import { ProblemError } from "../../problem.js";
import type { PdfBrand } from "../reports/hooks.js";
import { logoContentId, type MailBrand } from "../reports/render.js";
import { readStoredMailConfig } from "../settings/logic.js";
import { validateLogo } from "./images.js";

/**
 * Branding (0.5.0, docs/NOTIFICATIONS.md "Branding"): the provider's (edition Business, gate
 * `branding.provider`) and a tenant's own override (edition Service Provider, gate
 * `branding.tenant`). Mails carry the sender name, From and Reply-To, the accent, the footer text
 * and the logo as an inline attachment; chat webhooks the name and the logo by its public URL
 * (apps/worker branding.ts). Stored branding is ignored while its gate is closed (after a
 * downgrade): resolveBrand decides at render time. Every change is audited without its values.
 */

export const BRANDING_AUDIT_ACTIONS = {
  updated: "branding.updated",
  logoUploaded: "branding.logo_uploaded",
  logoRemoved: "branding.logo_removed",
  testSent: "branding.test_sent",
} as const;

export const INVALID_BRANDING_PROBLEM = "urn:restow:problem:invalid-branding";

export interface BrandingActor {
  readonly id: string;
  readonly email: string;
  readonly ip: string | null;
}

export interface LogoDto {
  url: string;
  contentType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  bytes: number;
}

export interface BrandingDto {
  senderName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  accentColor: string | null;
  onAccent: "light" | "dark" | null;
  footerText: string | null;
  logo: LogoDto | null;
  updatedAt: string | null;
}

export interface MailSenderFacts {
  transport: "smtp" | "graph" | "google" | null;
  /** Graph and Google always send from the configured mailbox. */
  fromLocked: boolean;
  defaultFrom: string | null;
  allowedSenders: string[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

const nullableText = (max: number) =>
  z
    .string()
    .max(max * 2)
    .nullable()
    .optional();

/** The body of PUT /settings/branding and of a tenant's override. */
export const brandingInputSchema = z
  .object({
    senderName: nullableText(80),
    fromAddress: nullableText(254),
    replyTo: nullableText(254),
    accentColor: z.string().max(16).nullable().optional(),
    footerText: nullableText(2000),
  })
  .strict();

export type BrandingInput = z.infer<typeof brandingInputSchema>;

export const tenantBrandingInputSchema = z.union([
  z.object({ inherit: z.literal(true) }).strict(),
  brandingInputSchema,
]);

function invalid(field: string, code: string, detail: string, extra: object = {}): ProblemError {
  return new ProblemError(422, "Invalid branding", {
    type: INVALID_BRANDING_PROBLEM,
    detail,
    extensions: { field, code, ...extra },
  });
}

/** How the configured transport sends: which From it uses and whether branding may change it. */
export async function mailSenderFacts(providerDb: DbExecutor): Promise<MailSenderFacts> {
  const [row] = await providerDb
    .select({ mailTransport: settings.mailTransport, mailConfig: settings.mailConfig })
    .from(settings)
    .limit(1);
  const mail = readStoredMailConfig(row?.mailTransport ?? null, row?.mailConfig);
  if (mail?.transport === "smtp") {
    return {
      transport: "smtp",
      fromLocked: false,
      defaultFrom: mail.from,
      allowedSenders: mail.allowedSenders ?? [],
    };
  }
  if (mail) {
    return {
      transport: mail.transport,
      fromLocked: true,
      defaultFrom: mail.sender,
      allowedSenders: [],
    };
  }
  // Nothing saved: the environment's transport (MAIL_TRANSPORT, SMTP_*, GRAPH_MAIL_*).
  if (config.mailTransport === "graph") {
    const sender = config.graphMailSender?.trim() || null;
    return {
      transport: sender ? "graph" : null,
      fromLocked: true,
      defaultFrom: sender,
      allowedSenders: [],
    };
  }
  const from = config.smtp.from?.trim() || null;
  return {
    transport: config.smtp.host?.trim() && from ? "smtp" : null,
    fromLocked: false,
    defaultFrom: from,
    allowedSenders: [],
  };
}

/**
 * Whether the transport may send as `address` right now: with SMTP the configured sender or an
 * allowed sender address; Microsoft 365 and Google Workspace only from their mailbox.
 */
export function brandSenderAllowed(facts: MailSenderFacts, address: string): boolean {
  if (facts.fromLocked) {
    return addressOf(facts.defaultFrom) === address.trim().toLowerCase();
  }
  return senderAllowed(address, facts.allowedSenders, facts.defaultFrom);
}

/** The checked, normalised fields of a branding body. */
export async function normalizeBrandingInput(
  providerDb: DbExecutor,
  input: BrandingInput,
): Promise<{
  senderName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  accentColor: string | null;
  footerText: string | null;
}> {
  const text = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const senderName = text(input.senderName);
  if (senderName !== null && !isValidSenderName(senderName)) {
    throw invalid(
      "senderName",
      senderName.length > 80 ? "too-long" : "invalid",
      "The sender name is one line of at most 80 characters.",
    );
  }
  const footerText = input.footerText?.replace(/\r\n?/g, "\n").trim() || null;
  if (footerText !== null) {
    if (footerText.length > 2000) {
      throw invalid("footerText", "too-long", "The footer text may be at most 2000 characters.");
    }
    if (CONTROL.test(footerText)) {
      throw invalid("footerText", "invalid", "The footer text may not carry control characters.");
    }
  }
  const replyTo = text(input.replyTo)?.toLowerCase() ?? null;
  if (replyTo !== null && !isPlainEmail(replyTo)) {
    throw invalid("replyTo", "invalid-email", "The Reply-To address is not a valid address.");
  }
  const fromAddress = text(input.fromAddress)?.toLowerCase() ?? null;
  if (fromAddress !== null) {
    if (!isPlainEmail(fromAddress)) {
      throw invalid("fromAddress", "invalid-email", "The From address is not a valid address.");
    }
    const facts = await mailSenderFacts(providerDb);
    if (facts.fromLocked) {
      if (!brandSenderAllowed(facts, fromAddress)) {
        throw invalid(
          "fromAddress",
          "from-locked",
          "Microsoft 365 and Google Workspace always send from the configured mailbox; only the sender name and Reply-To can be branded.",
        );
      }
    } else if (!brandSenderAllowed(facts, fromAddress)) {
      throw invalid(
        "fromAddress",
        "sender-not-allowed",
        "Add the address (or its @domain) to the allowed sender addresses of the notification mail first.",
      );
    }
  }
  let accentColor: string | null = null;
  if (input.accentColor !== null && input.accentColor !== undefined && input.accentColor !== "") {
    accentColor = normalizeAccent(input.accentColor);
    if (!accentColor) {
      throw invalid("accentColor", "invalid", "The accent colour is a #rrggbb value.");
    }
    if (onAccentFor(accentColor) === null) {
      throw invalid(
        "accentColor",
        "accent-contrast",
        "Neither white nor dark text reaches a contrast of 4.5:1 on this colour.",
        { contrast: accentContrast(accentColor) },
      );
    }
  }
  return { senderName, fromAddress, replyTo, accentColor, footerText };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface StoredBranding {
  senderName: string | null;
  fromAddress: string | null;
  replyTo: string | null;
  accentColor: string | null;
  footerText: string | null;
  logoImageId: string | null;
  updatedAt: Date;
}

interface StoredImage {
  id: string;
  token: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  sha256: string;
}

async function imageOf(providerDb: DbExecutor, id: string | null): Promise<StoredImage | null> {
  if (!id) {
    return null;
  }
  const [image] = await providerDb
    .select({
      id: brandingImages.id,
      token: brandingImages.token,
      contentType: brandingImages.contentType,
      byteSize: brandingImages.byteSize,
      width: brandingImages.width,
      height: brandingImages.height,
      sha256: brandingImages.sha256,
    })
    .from(brandingImages)
    .where(eq(brandingImages.id, id))
    .limit(1);
  return image ?? null;
}

function logoOfImage(image: StoredImage | null): BrandLogo | null {
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

function logoDto(image: StoredImage | null): LogoDto | null {
  const logo = logoOfImage(image);
  if (!logo || !image) {
    return null;
  }
  return {
    url: brandingImagePath(logo),
    contentType: logo.contentType,
    width: logo.width,
    height: logo.height,
    bytes: image.byteSize,
  };
}

async function brandingDto(
  providerDb: DbExecutor,
  row: StoredBranding | null,
): Promise<BrandingDto> {
  const accent = normalizeAccent(row?.accentColor);
  return {
    senderName: row?.senderName ?? null,
    fromAddress: row?.fromAddress ?? null,
    replyTo: row?.replyTo ?? null,
    accentColor: accent,
    onAccent: accent ? onAccentFor(accent) : null,
    footerText: row?.footerText ?? null,
    logo: logoDto(await imageOf(providerDb, row?.logoImageId ?? null)),
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

async function providerRow(providerDb: DbExecutor): Promise<StoredBranding | null> {
  const [row] = await providerDb.select().from(providerBranding).limit(1);
  return row ?? null;
}

async function tenantRow(providerDb: DbExecutor, tenantId: string): Promise<StoredBranding | null> {
  const [row] = await providerDb
    .select()
    .from(tenantBranding)
    .where(eq(tenantBranding.tenantId, tenantId))
    .limit(1);
  return row ?? null;
}

async function brandingRowOf(
  providerDb: DbExecutor,
  row: StoredBranding | null,
): Promise<BrandingRow | null> {
  if (!row) {
    return null;
  }
  return {
    senderName: row.senderName,
    fromAddress: row.fromAddress,
    replyTo: row.replyTo,
    accentColor: row.accentColor,
    footerText: row.footerText,
    logo: logoOfImage(await imageOf(providerDb, row.logoImageId)),
  };
}

export interface BrandingAvailability {
  provider: boolean;
  tenant: boolean;
  customerReport: boolean;
}

export async function brandingAvailability(providerDb: DbExecutor): Promise<BrandingAvailability> {
  return {
    provider: await featureEnabled("branding.provider", providerDb),
    tenant: await featureEnabled("branding.tenant", providerDb),
    customerReport: await featureEnabled("reports.customer", providerDb),
  };
}

async function publicUrlOf(providerDb: DbExecutor): Promise<string | null> {
  const [row] = await providerDb.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  const raw = row?.publicUrl?.trim() || process.env.RESTOW_PUBLIC_URL?.trim() || null;
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export interface ProviderBrandingView {
  available: BrandingAvailability;
  productName: string;
  provider: BrandingDto;
  mail: MailSenderFacts;
  publicUrl: string | null;
  publicUrlHttps: boolean;
}

/** GET /settings/branding: answers in every edition, so the page can show the lock. */
export async function getProviderBranding(providerDb: DbExecutor): Promise<ProviderBrandingView> {
  const publicUrl = await publicUrlOf(providerDb);
  return {
    available: await brandingAvailability(providerDb),
    productName: config.productName,
    provider: await brandingDto(providerDb, await providerRow(providerDb)),
    mail: await mailSenderFacts(providerDb),
    publicUrl,
    publicUrlHttps: publicUrl?.startsWith("https://") ?? false,
  };
}

// ---------------------------------------------------------------------------
// The effective brand (cached)
// ---------------------------------------------------------------------------

/** The effective brand with the logo's bytes, for a mail's inline attachment. */
export interface LoadedBrand {
  readonly brand: EffectiveBrand;
  readonly logo: {
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly sha256: string;
  } | null;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: LoadedBrand }>();

/** Forget every cached brand (after a write, and in tests). */
export function invalidateBrandCache(): void {
  cache.clear();
}

/**
 * The brand a message about `tenantId` (null: the provider's own messages, installation events)
 * carries right now: gates and fallbacks applied (resolveBrand), the logo's bytes loaded. Cached
 * for a minute per process; every write here clears the cache. The From address is checked
 * against the mail settings on every call, not only when the branding was saved: once the
 * allowed senders, the configured sender or the transport no longer allow it, the mail goes out
 * from the configured sender (with the brand's name).
 */
export async function effectiveBrand(
  providerDb: DbExecutor,
  tenantId: string | null,
  now: number = Date.now(),
): Promise<LoadedBrand> {
  const loaded = await cachedBrand(providerDb, tenantId, now);
  const fromAddress = loaded.brand.fromAddress;
  if (fromAddress && !brandSenderAllowed(await mailSenderFacts(providerDb), fromAddress)) {
    return { ...loaded, brand: { ...loaded.brand, fromAddress: null } };
  }
  return loaded;
}

async function cachedBrand(
  providerDb: DbExecutor,
  tenantId: string | null,
  now: number,
): Promise<LoadedBrand> {
  const key = tenantId ?? "provider";
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) {
    return hit.value;
  }
  const { provider: providerAllowed, tenant: tenantAllowed } =
    await brandingAvailability(providerDb);
  const publicUrl = await publicUrlOf(providerDb);
  const brand = resolveBrand({
    productName: config.productName,
    provider:
      providerAllowed || tenantAllowed
        ? await brandingRowOf(providerDb, await providerRow(providerDb))
        : null,
    tenant:
      tenantAllowed && tenantId
        ? await brandingRowOf(providerDb, await tenantRow(providerDb, tenantId))
        : null,
    providerAllowed,
    tenantAllowed,
    logoUrl: (logo) => httpsPublicUrl(publicUrl, brandingImagePath(logo)),
  });
  let logo: LoadedBrand["logo"] = null;
  if (brand.logo) {
    const [image] = await providerDb
      .select({
        bytes: brandingImages.bytes,
        contentType: brandingImages.contentType,
        sha256: brandingImages.sha256,
      })
      .from(brandingImages)
      .where(eq(brandingImages.id, brand.logo.imageId))
      .limit(1);
    logo = image ?? null;
  }
  const value: LoadedBrand = { brand, logo };
  if (cache.size > 1000) {
    cache.clear();
  }
  cache.set(key, { at: now, value });
  return value;
}

/**
 * The mail side of a brand: what render.ts frames the mail with, the logo as an inline attachment
 * (`cid`), and the sender. `preview` refers to the logo by its public path instead, for the
 * settings page's sandboxed preview. Unbranded: no frame, no attachment, the configured sender.
 */
export function mailBrandOf(
  loaded: LoadedBrand,
  mode: "cid" | "preview" = "cid",
): {
  brand: MailBrand | null;
  attachment: MailAttachment | null;
  from: { name: string; address: string | null } | null;
  replyTo: string | null;
} {
  const { brand } = loaded;
  if (!brand.branded) {
    return { brand: null, attachment: null, from: null, replyTo: null };
  }
  const cid = brand.logo && loaded.logo ? logoContentId(loaded.logo.sha256) : null;
  const logo =
    brand.logo && loaded.logo
      ? {
          src: mode === "cid" ? `cid:${cid}` : brandingImagePath(brand.logo),
          width: brand.logo.width,
          height: brand.logo.height,
        }
      : null;
  return {
    brand: {
      senderName: brand.senderName,
      accentColor: brand.accentColor,
      onAccent: brand.onAccent,
      linkColor: brand.linkColor,
      footerText: brand.footerText,
      logo,
    },
    attachment:
      mode === "cid" && cid && loaded.logo
        ? {
            filename: loaded.logo.contentType === "image/png" ? "logo.png" : "logo.jpg",
            contentType: loaded.logo.contentType,
            content: loaded.logo.bytes,
            cid,
          }
        : null,
    from: { name: brand.senderName, address: brand.fromAddress },
    replyTo: brand.replyTo,
  };
}

/** The PDF side of a brand: name, logo bytes and accent; null when unbranded. */
export function pdfBrandOf(loaded: LoadedBrand): PdfBrand | null {
  const { brand } = loaded;
  if (!brand.branded) {
    return null;
  }
  return {
    name: brand.senderName,
    ...(brand.logo && loaded.logo
      ? {
          logo: {
            data: loaded.logo.bytes,
            format: loaded.logo.contentType === "image/png" ? ("png" as const) : ("jpg" as const),
            width: brand.logo.width,
            height: brand.logo.height,
          },
        }
      : {}),
    accent: brand.accentColor,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function auditEvent(
  tenantId: string | null,
  actor: BrandingActor,
  action: string,
  details: Record<string, unknown>,
) {
  return {
    tenantId,
    actor: actor.email,
    actorUserId: actor.id,
    action,
    target: tenantId ?? "provider",
    targetType: "branding",
    ip: actor.ip,
    details,
  };
}

const BRANDING_FIELDS = [
  "senderName",
  "fromAddress",
  "replyTo",
  "accentColor",
  "footerText",
] as const;

function changedFields(
  before: StoredBranding | null,
  after: Record<(typeof BRANDING_FIELDS)[number], string | null>,
): string[] {
  return BRANDING_FIELDS.filter((field) => (before?.[field] ?? null) !== after[field]);
}

/** PUT /settings/branding (owner, `branding.provider`). */
export async function putProviderBranding(
  providerDb: Database,
  input: BrandingInput,
  actor: BrandingActor,
): Promise<BrandingDto> {
  await requireFeature("branding.provider", providerDb);
  const next = await normalizeBrandingInput(providerDb, input);
  const before = await providerRow(providerDb);
  const now = new Date();
  await providerDb
    .insert(providerBranding)
    .values({ singleton: true, ...next, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({
      target: providerBranding.singleton,
      set: { ...next, updatedBy: actor.id, updatedAt: now },
    });
  invalidateBrandCache();
  await audit(
    providerDb,
    auditEvent(null, actor, BRANDING_AUDIT_ACTIONS.updated, {
      fields: changedFields(before, next),
    }),
  );
  return brandingDto(providerDb, await providerRow(providerDb));
}

/** A new image row with a fresh public token. */
async function storeImage(
  providerDb: DbExecutor,
  bytes: Buffer,
  declaredType: string | null,
): Promise<StoredImage> {
  const logo = await validateLogo(bytes, declaredType);
  const [image] = await providerDb
    .insert(brandingImages)
    .values({
      token: randomBytes(32).toString("base64url"),
      contentType: logo.contentType,
      bytes: logo.bytes,
      byteSize: logo.bytes.length,
      width: logo.width,
      height: logo.height,
      sha256: logo.sha256,
    })
    .returning({
      id: brandingImages.id,
      token: brandingImages.token,
      contentType: brandingImages.contentType,
      byteSize: brandingImages.byteSize,
      width: brandingImages.width,
      height: brandingImages.height,
      sha256: brandingImages.sha256,
    });
  if (!image) {
    throw new Error("the logo could not be stored");
  }
  return image;
}

/** A replaced logo keeps answering for 30 days (mails already sent show it), then it is pruned. */
async function retireImage(providerDb: DbExecutor, id: string | null, now: Date): Promise<void> {
  if (!id) {
    return;
  }
  await providerDb
    .update(brandingImages)
    .set({ retiredAt: now })
    .where(and(eq(brandingImages.id, id), isNull(brandingImages.retiredAt)));
}

/** PUT /settings/branding/logo (owner, `branding.provider`). */
export async function putProviderLogo(
  providerDb: Database,
  bytes: Buffer,
  declaredType: string | null,
  actor: BrandingActor,
): Promise<LogoDto> {
  await requireFeature("branding.provider", providerDb);
  const image = await storeImage(providerDb, bytes, declaredType);
  const before = await providerRow(providerDb);
  const now = new Date();
  await providerDb
    .insert(providerBranding)
    .values({ singleton: true, logoImageId: image.id, updatedBy: actor.id, updatedAt: now })
    .onConflictDoUpdate({
      target: providerBranding.singleton,
      set: { logoImageId: image.id, updatedBy: actor.id, updatedAt: now },
    });
  await retireImage(providerDb, before?.logoImageId ?? null, now);
  invalidateBrandCache();
  await audit(
    providerDb,
    auditEvent(null, actor, BRANDING_AUDIT_ACTIONS.logoUploaded, {
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      bytes: image.byteSize,
    }),
  );
  return logoDto(image) as LogoDto;
}

/** DELETE /settings/branding/logo (owner, `branding.provider`). */
export async function deleteProviderLogo(
  providerDb: Database,
  actor: BrandingActor,
): Promise<void> {
  await requireFeature("branding.provider", providerDb);
  const before = await providerRow(providerDb);
  if (!before?.logoImageId) {
    return;
  }
  const now = new Date();
  await providerDb
    .update(providerBranding)
    .set({ logoImageId: null, updatedBy: actor.id, updatedAt: now })
    .where(eq(providerBranding.singleton, true));
  await retireImage(providerDb, before.logoImageId, now);
  invalidateBrandCache();
  await audit(providerDb, auditEvent(null, actor, BRANDING_AUDIT_ACTIONS.logoRemoved, {}));
}

export interface TenantBrandingView {
  available: boolean;
  inherits: boolean;
  override: BrandingDto | null;
  effective: BrandingDto;
}

/** GET /tenants/:id/branding (`branding.tenant`). */
export async function getTenantBranding(
  providerDb: DbExecutor,
  tenantId: string,
): Promise<TenantBrandingView> {
  const available = await featureEnabled("branding.tenant", providerDb);
  const own = await tenantRow(providerDb, tenantId);
  const provider = await providerRow(providerDb);
  const override = own ? await brandingDto(providerDb, own) : null;
  return {
    available,
    inherits: own === null,
    override,
    effective: available && override ? override : await brandingDto(providerDb, provider),
  };
}

/** PUT /tenants/:id/branding: `{ inherit: true }` removes the override. */
export async function putTenantBranding(
  db: Database,
  providerDb: Database,
  tenantId: string,
  input: z.infer<typeof tenantBrandingInputSchema>,
  actor: BrandingActor,
): Promise<TenantBrandingView> {
  await requireFeature("branding.tenant", providerDb);
  const before = await tenantRow(providerDb, tenantId);
  const now = new Date();
  if ("inherit" in input) {
    if (before) {
      await withTenantTx(db, tenantId, (tx) =>
        tx.delete(tenantBranding).where(eq(tenantBranding.tenantId, tenantId)),
      );
      await retireImage(providerDb, before.logoImageId, now);
    }
    invalidateBrandCache();
    await audit(db, auditEvent(tenantId, actor, BRANDING_AUDIT_ACTIONS.updated, { inherit: true }));
    return getTenantBranding(providerDb, tenantId);
  }
  const next = await normalizeBrandingInput(providerDb, input);
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .insert(tenantBranding)
      .values({ tenantId, ...next, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantBranding.tenantId,
        set: { ...next, updatedBy: actor.id, updatedAt: now },
      }),
  );
  invalidateBrandCache();
  await audit(
    db,
    auditEvent(tenantId, actor, BRANDING_AUDIT_ACTIONS.updated, {
      fields: changedFields(before, next),
    }),
  );
  return getTenantBranding(providerDb, tenantId);
}

/** PUT /tenants/:id/branding/logo. */
export async function putTenantLogo(
  db: Database,
  providerDb: Database,
  tenantId: string,
  bytes: Buffer,
  declaredType: string | null,
  actor: BrandingActor,
): Promise<LogoDto> {
  await requireFeature("branding.tenant", providerDb);
  const image = await storeImage(providerDb, bytes, declaredType);
  const before = await tenantRow(providerDb, tenantId);
  const now = new Date();
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .insert(tenantBranding)
      .values({ tenantId, logoImageId: image.id, updatedBy: actor.id, updatedAt: now })
      .onConflictDoUpdate({
        target: tenantBranding.tenantId,
        set: { logoImageId: image.id, updatedBy: actor.id, updatedAt: now },
      }),
  );
  await retireImage(providerDb, before?.logoImageId ?? null, now);
  invalidateBrandCache();
  await audit(
    db,
    auditEvent(tenantId, actor, BRANDING_AUDIT_ACTIONS.logoUploaded, {
      contentType: image.contentType,
      width: image.width,
      height: image.height,
      bytes: image.byteSize,
    }),
  );
  return logoDto(image) as LogoDto;
}

/** DELETE /tenants/:id/branding/logo. */
export async function deleteTenantLogo(
  db: Database,
  providerDb: Database,
  tenantId: string,
  actor: BrandingActor,
): Promise<void> {
  await requireFeature("branding.tenant", providerDb);
  const before = await tenantRow(providerDb, tenantId);
  if (!before?.logoImageId) {
    return;
  }
  const now = new Date();
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .update(tenantBranding)
      .set({ logoImageId: null, updatedBy: actor.id, updatedAt: now })
      .where(eq(tenantBranding.tenantId, tenantId)),
  );
  await retireImage(providerDb, before.logoImageId, now);
  invalidateBrandCache();
  await audit(db, auditEvent(tenantId, actor, BRANDING_AUDIT_ACTIONS.logoRemoved, {}));
}

/** Delete the logos retired more than 30 days ago that nothing refers to any more. */
export async function pruneRetiredImages(providerDb: DbExecutor, now: Date): Promise<number> {
  const before = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  const deleted = await providerDb
    .delete(brandingImages)
    .where(
      and(
        lt(brandingImages.retiredAt, before),
        sql`NOT EXISTS (SELECT 1 FROM provider_branding p WHERE p.logo_image_id = ${brandingImages.id})`,
        sql`NOT EXISTS (SELECT 1 FROM tenant_branding t WHERE t.logo_image_id = ${brandingImages.id})`,
      ),
    )
    .returning({ id: brandingImages.id });
  return deleted.length;
}
