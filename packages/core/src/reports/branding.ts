/**
 * Branding of mails, reports and chat messages (0.5.0, docs/NOTIFICATIONS.md "Branding"): the
 * pure rules both the API and the worker apply. A provider brands every message (edition
 * Business), a tenant can override it for its own messages (edition Service Provider); without
 * either, or while the gate is closed (after a downgrade), messages carry the product name only.
 */

/** Dark text on a light accent (the product's own ink colour). */
export const DARK_TEXT = "#0f1b2d";
export const WHITE = "#ffffff";
/** The link colour of an unbranded mail, and of a branded one whose accent is too light. */
export const DEFAULT_LINK_COLOR = "#2b4c9b";
/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

/** `#rrggbb` lower-cased, or null for anything else (three-digit forms included). */
export function normalizeAccent(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const lowered = value.trim().toLowerCase();
  return HEX.test(lowered) ? lowered : null;
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG 2.x) of `#rrggbb`. */
export function relativeLuminance(hex: string): number {
  const normalized = normalizeAccent(hex);
  if (!normalized) {
    throw new RangeError(`not a #rrggbb colour: ${hex}`);
  }
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio of two colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Both ratios an accent is checked with, rounded to two decimals (the API answers them). */
export function accentContrast(hex: string): { white: number; dark: number } {
  const round = (value: number) => Math.round(value * 100) / 100;
  return { white: round(contrastRatio(hex, WHITE)), dark: round(contrastRatio(hex, DARK_TEXT)) };
}

/**
 * The text colour on the accent: white when white reaches 4.5:1, else the dark ink when that
 * does; null when neither does (such an accent is refused).
 */
export function onAccentFor(hex: string): "light" | "dark" | null {
  if (contrastRatio(hex, WHITE) >= MIN_CONTRAST) {
    return "light";
  }
  if (contrastRatio(hex, DARK_TEXT) >= MIN_CONTRAST) {
    return "dark";
  }
  return null;
}

/** The colour links take: the accent when it reads on white (4.5:1), else the default blue. */
export function linkColorFor(hex: string | null): string {
  return hex && contrastRatio(hex, WHITE) >= MIN_CONTRAST ? hex : DEFAULT_LINK_COLOR;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

/** A plain address (no display name, no comments, no line breaks), at most 254 characters. */
export function isPlainEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/** An allowed-senders entry: an exact address, or `@domain`. */
export function isAllowedSenderEntry(value: string): boolean {
  const entry = value.trim().toLowerCase();
  if (entry.startsWith("@")) {
    return /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry);
  }
  return isPlainEmail(entry);
}

/** The address part of a configured From (`Name <a@b>` or `a@b`), lower-cased. */
export function addressOf(from: string | null | undefined): string | null {
  if (!from) {
    return null;
  }
  const angle = /<([^<>]+)>\s*$/.exec(from);
  const address = (angle?.[1] ?? from).trim().toLowerCase();
  return isPlainEmail(address) ? address : null;
}

/**
 * Whether a branded From may be used with SMTP: it is the configured sender, or matches an
 * allowed entry (an exact address or `@domain`, the domain compared exactly).
 */
export function senderAllowed(
  address: string,
  allowedSenders: readonly string[],
  configuredFrom: string | null | undefined,
): boolean {
  const wanted = address.trim().toLowerCase();
  if (!isPlainEmail(wanted)) {
    return false;
  }
  if (addressOf(configuredFrom) === wanted) {
    return true;
  }
  const domain = wanted.slice(wanted.lastIndexOf("@"));
  return allowedSenders.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized.startsWith("@") ? normalized === domain : normalized === wanted;
  });
}

/**
 * A Discord webhook username: at most 80 characters; Discord refuses names containing
 * "discord" or "clyde" (and the reserved `everyone`/`here`), so those fall back to the
 * webhook's own name (null).
 */
export function discordUsername(name: string | null | undefined): string | null {
  const flat = (name ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return null;
  }
  const lowered = flat.toLowerCase();
  if (
    lowered.includes("discord") ||
    lowered.includes("clyde") ||
    lowered === "everyone" ||
    lowered === "here"
  ) {
    return null;
  }
  return flat.slice(0, 80);
}

/** A sender name: one line, no control characters, at most 80 characters. */
export function isValidSenderName(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  return value.trim().length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The stored branding of a provider or a tenant (the columns both tables share). */
export interface BrandingRow {
  readonly senderName: string | null;
  readonly fromAddress: string | null;
  readonly replyTo: string | null;
  readonly accentColor: string | null;
  readonly footerText: string | null;
  readonly logo: BrandLogo | null;
}

export interface BrandLogo {
  readonly imageId: string;
  readonly token: string;
  readonly contentType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
}

/** What a message is branded with, after the gates and the fallbacks. */
export interface EffectiveBrand {
  /** The sender name and the name in footers: the brand's, else the product name. */
  readonly senderName: string;
  /** A From address of the brand (validated against the transport when it was saved). */
  readonly fromAddress: string | null;
  readonly replyTo: string | null;
  readonly accentColor: string | null;
  readonly onAccent: "light" | "dark" | null;
  /** The accent when it reads on white, else null (links keep the default colour). */
  readonly linkColor: string | null;
  readonly footerText: string | null;
  readonly logo: BrandLogo | null;
  /** The logo's public URL (chat formats), or null without a public https address. */
  readonly logoUrl: string | null;
  /** Where the branding came from; `product` means unbranded. */
  readonly source: "tenant" | "provider" | "product";
  readonly branded: boolean;
}

export interface ResolveBrandInput {
  readonly productName: string;
  readonly provider: BrandingRow | null;
  readonly tenant: BrandingRow | null;
  /** `branding.provider` is on (Business and up). */
  readonly providerAllowed: boolean;
  /** `branding.tenant` is on (Service Provider). */
  readonly tenantAllowed: boolean;
  /** The public URL of a logo, or null when the instance has no public https address. */
  readonly logoUrl?: (logo: BrandLogo) => string | null;
}

function hasContent(row: BrandingRow | null): row is BrandingRow {
  return (
    row !== null &&
    Boolean(
      row.senderName?.trim() ||
        row.fromAddress ||
        row.replyTo ||
        row.accentColor ||
        row.footerText?.trim() ||
        row.logo,
    )
  );
}

/**
 * The brand a message carries: the tenant's override while `branding.tenant` is on, else the
 * provider's while `branding.provider` is on, else the product name alone. A field the chosen
 * branding leaves empty is not taken from the other one: a tenant override is a whole brand.
 */
export function resolveBrand(input: ResolveBrandInput): EffectiveBrand {
  const chosen: { row: BrandingRow; source: "tenant" | "provider" } | null =
    input.tenantAllowed && hasContent(input.tenant)
      ? { row: input.tenant, source: "tenant" }
      : input.providerAllowed && hasContent(input.provider)
        ? { row: input.provider, source: "provider" }
        : null;
  if (!chosen) {
    return {
      senderName: input.productName,
      fromAddress: null,
      replyTo: null,
      accentColor: null,
      onAccent: null,
      linkColor: null,
      footerText: null,
      logo: null,
      logoUrl: null,
      source: "product",
      branded: false,
    };
  }
  const { row } = chosen;
  const accent = normalizeAccent(row.accentColor);
  const onAccent = accent ? onAccentFor(accent) : null;
  const usableAccent = accent && onAccent ? accent : null;
  return {
    senderName: row.senderName?.trim() || input.productName,
    fromAddress: row.fromAddress && isPlainEmail(row.fromAddress) ? row.fromAddress : null,
    replyTo: row.replyTo && isPlainEmail(row.replyTo) ? row.replyTo : null,
    accentColor: usableAccent,
    onAccent: usableAccent ? onAccent : null,
    linkColor: usableAccent && linkColorFor(usableAccent) === usableAccent ? usableAccent : null,
    footerText: row.footerText?.trim() || null,
    logo: row.logo,
    logoUrl: row.logo && input.logoUrl ? input.logoUrl(row.logo) : null,
    source: chosen.source,
    branded: true,
  };
}

/** The path of a logo under the instance's public URL (the API's public branding route). */
export function brandingImagePath(logo: Pick<BrandLogo, "token" | "contentType">): string {
  return `/api/v1/public/branding/${logo.token}.${logo.contentType === "image/png" ? "png" : "jpg"}`;
}

/** The path of the 1×1 accent image the Teams card stretches into a band. */
export function brandingAccentPath(hex: string): string | null {
  const normalized = normalizeAccent(hex);
  return normalized ? `/api/v1/public/branding/accent/${normalized.slice(1)}.png` : null;
}

/** `<origin><path>` for an https public URL only (chat services fetch images themselves). */
export function httpsPublicUrl(publicUrl: string | null | undefined, path: string): string | null {
  if (!publicUrl) {
    return null;
  }
  try {
    const origin = new URL(publicUrl);
    return origin.protocol === "https:" ? `${origin.origin}${path}` : null;
  } catch {
    return null;
  }
}
