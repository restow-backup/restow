import { ApiError } from "@/lib/api";

import type { BrandingDto, BrandingInput, MailSenderFacts } from "./api";

/**
 * Pure logic of the branding form (0.5.0): the contrast check of the accent colour (the same
 * rule as packages/core reports/branding.ts, so the page says what the server will answer), the
 * checks a logo file passes before it is uploaded, the From rules of the mail transport, the
 * request a form becomes, and the words of the server's refusals.
 */

/** Dark text on a light accent (packages/core `DARK_TEXT`). */
export const DARK_TEXT = "#0f1b2d";
export const WHITE = "#ffffff";
/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;

/** The longest sender name and footer the server takes. */
export const SENDER_NAME_MAX = 80;
export const FOOTER_MAX = 2000;

/** The logo the server takes: PNG or JPEG of at most 512 KiB. */
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;
export const MAX_LOGO_BYTES = 512 * 1024;

const HEX = /^#[0-9a-f]{6}$/;

/** `#rrggbb` lower-cased, or null for anything else. */
export function normalizeAccent(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  return HEX.test(lowered) ? lowered : null;
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

export interface AccentReadout {
  /** Contrast with white and with the dark text, rounded to two decimals. */
  white: number;
  dark: number;
  /** The text colour on the accent: white first, else dark; null when neither reaches 4.5:1. */
  onAccent: "light" | "dark" | null;
  /** Links take the accent only where it reads on white. */
  linksUseAccent: boolean;
}

/** What the page shows next to the colour picker; null for no (or an invalid) colour. */
export function accentReadout(value: string | null | undefined): AccentReadout | null {
  const hex = normalizeAccent(value);
  if (!hex) return null;
  const round = (ratio: number) => Math.round(ratio * 100) / 100;
  const white = contrastRatio(hex, WHITE);
  const dark = contrastRatio(hex, DARK_TEXT);
  return {
    white: round(white),
    dark: round(dark),
    onAccent: white >= MIN_CONTRAST ? "light" : dark >= MIN_CONTRAST ? "dark" : null,
    linksUseAccent: white >= MIN_CONTRAST,
  };
}

/** Why a chosen file cannot be the logo, checked before it is uploaded; null when it may go. */
export type LogoFileProblem = "svg-not-supported" | "unsupported-type" | "too-large";

export function logoFileProblem(
  file: Pick<File, "name" | "size" | "type">,
): LogoFileProblem | null {
  const type = file.type.toLowerCase();
  if (type === "image/svg+xml" || /\.svgz?$/i.test(file.name)) return "svg-not-supported";
  if (!(LOGO_TYPES as readonly string[]).includes(type)) return "unsupported-type";
  if (file.size > MAX_LOGO_BYTES) return "too-large";
  return null;
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function isPlainEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

/** The address part of a configured From (`Name <a@b>` or `a@b`), lower-cased. */
export function addressOf(from: string | null | undefined): string | null {
  if (!from) return null;
  const angle = /<([^<>]+)>\s*$/.exec(from);
  const address = (angle?.[1] ?? from).trim().toLowerCase();
  return isPlainEmail(address) ? address : null;
}

/** An allowed-senders entry: an exact address, or `@domain` (packages/core). */
export function isAllowedSenderEntry(value: string): boolean {
  const entry = value.trim().toLowerCase();
  if (entry.startsWith("@")) return /^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry);
  return isPlainEmail(entry);
}

/** Whether SMTP may send from `address`: the configured sender, or an allowed entry. */
export function senderAllowed(
  address: string,
  allowedSenders: readonly string[],
  configuredFrom: string | null | undefined,
): boolean {
  const wanted = address.trim().toLowerCase();
  if (!isPlainEmail(wanted)) return false;
  if (addressOf(configuredFrom) === wanted) return true;
  const domain = wanted.slice(wanted.lastIndexOf("@"));
  return allowedSenders.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized.startsWith("@") ? normalized === domain : normalized === wanted;
  });
}

export interface BrandingFormValues {
  senderName: string;
  fromAddress: string;
  replyTo: string;
  /** As typed or picked; empty for none. */
  accentColor: string;
  footerText: string;
}

export function brandingFormFrom(dto: BrandingDto | null): BrandingFormValues {
  return {
    senderName: dto?.senderName ?? "",
    fromAddress: dto?.fromAddress ?? "",
    replyTo: dto?.replyTo ?? "",
    accentColor: dto?.accentColor ?? "",
    footerText: dto?.footerText ?? "",
  };
}

export type BrandingField = keyof BrandingFormValues;

/** The problems of the form, as `settings` keys by field; empty when it can be saved. */
export function validateBranding(
  values: BrandingFormValues,
  mail: MailSenderFacts,
): Partial<Record<BrandingField, string>> {
  const errors: Partial<Record<BrandingField, string>> = {};
  const name = values.senderName.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (name.length > SENDER_NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) {
    errors.senderName = "branding.errors.too-long";
  }
  const from = values.fromAddress.trim().toLowerCase();
  if (from) {
    if (!isPlainEmail(from)) {
      errors.fromAddress = "branding.errors.invalid-email";
    } else if (mail.fromLocked) {
      if (addressOf(mail.defaultFrom) !== from) errors.fromAddress = "branding.errors.from-locked";
    } else if (!senderAllowed(from, mail.allowedSenders, mail.defaultFrom)) {
      errors.fromAddress = "branding.errors.sender-not-allowed";
    }
  }
  const replyTo = values.replyTo.trim().toLowerCase();
  if (replyTo && !isPlainEmail(replyTo)) errors.replyTo = "branding.errors.invalid-email";
  const accent = values.accentColor.trim();
  if (accent) {
    const readout = accentReadout(accent);
    if (!readout) errors.accentColor = "branding.errors.accent-invalid";
    else if (readout.onAccent === null) errors.accentColor = "branding.errors.accent-contrast";
  }
  if (values.footerText.replace(/\r\n?/g, "\n").trim().length > FOOTER_MAX) {
    errors.footerText = "branding.errors.too-long";
  }
  return errors;
}

/** The request of a valid form: blanks become null. */
export function toBrandingInput(values: BrandingFormValues): BrandingInput {
  const text = (value: string) => {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return {
    senderName: text(values.senderName),
    fromAddress: text(values.fromAddress)?.toLowerCase() ?? null,
    replyTo: text(values.replyTo)?.toLowerCase() ?? null,
    accentColor: normalizeAccent(values.accentColor),
    footerText: text(values.footerText.replace(/\r\n?/g, "\n")),
  };
}

/** The codes of the server's refusals the page words (problem `code`). */
const PROBLEM_CODES = [
  "svg-not-supported",
  "unsupported-type",
  "unsupported-image",
  "too-large",
  "dimensions",
  "corrupt",
  "animated",
  "accent-contrast",
  "sender-not-allowed",
  "from-locked",
  "invalid-email",
  "too-long",
] as const;

export interface BrandingProblem {
  /** The form field the refusal is about, when it names one. */
  field: BrandingField | "logo" | null;
  /** The `settings` key of the sentence. */
  key: string;
}

const FIELDS: readonly string[] = [
  "senderName",
  "fromAddress",
  "replyTo",
  "accentColor",
  "footerText",
  "logo",
];

/** A refusal of the branding routes in words; null for anything that is not one of them. */
export function brandingProblem(error: unknown): BrandingProblem | null {
  if (!(error instanceof ApiError) || !error.problem) return null;
  const type = error.problem.type;
  if (
    type !== "urn:restow:problem:invalid-branding" &&
    type !== "urn:restow:problem:invalid-image" &&
    type !== "urn:restow:problem:unsupported-image"
  ) {
    return null;
  }
  const code = typeof error.problem.code === "string" ? error.problem.code : "";
  const rawField = typeof error.problem.field === "string" ? error.problem.field : null;
  const field =
    rawField && FIELDS.includes(rawField) ? (rawField as BrandingProblem["field"]) : null;
  const known = (PROBLEM_CODES as readonly string[]).includes(code);
  return {
    field: field ?? (type === "urn:restow:problem:invalid-branding" ? null : "logo"),
    key: known
      ? `branding.errors.${code}`
      : type === "urn:restow:problem:invalid-branding"
        ? "branding.errors.invalid"
        : "branding.errors.corrupt",
  };
}
