import type { MailProtectionKind, PreviewUnavailableReason } from "@/features/restore/api";

/**
 * Presentation helpers for rights-protected and S/MIME-encrypted mail. Kept
 * separate from the wire values (`MailProtectionKind`, `PreviewUnavailableReason`)
 * so the ICU `select` case names in restore.json never have to match the
 * API's hyphenated identifiers.
 */

/** The i18n `select` case for a protection kind ("purview" and "smime" in restore.json). */
export type ProtectionSelectKind = "purview" | "smime";

const PROTECTION_SELECT_KIND: Record<MailProtectionKind, ProtectionSelectKind> = {
  "rights-protected": "purview",
  "smime-encrypted": "smime",
};

/** `undefined` for unprotected mail, so `t(key, { kind: undefined })` falls back to "other". */
export function protectionSelectKind(
  protection: MailProtectionKind | null | undefined,
): ProtectionSelectKind | undefined {
  return protection ? PROTECTION_SELECT_KIND[protection] : undefined;
}

/** Whether the reading pane cannot show a body because of rights/S-MIME protection (not size or format). */
export function isProtectionReason(reason: PreviewUnavailableReason): reason is MailProtectionKind {
  return reason === "rights-protected" || reason === "smime-encrypted";
}

/** The reading pane's "why can't I see this" translation key, one per reason the API returns. */
const UNAVAILABLE_KEY: Record<PreviewUnavailableReason, string> = {
  "rights-protected": "details.reading.unavailable.rightsProtected",
  "smime-encrypted": "details.reading.unavailable.smimeEncrypted",
  "too-large": "details.reading.unavailable.tooLarge",
  "unsupported-format": "details.reading.unavailable.unsupportedFormat",
  unreadable: "details.reading.unavailable.unreadable",
};

export function unavailableReasonKey(reason: PreviewUnavailableReason): string {
  return UNAVAILABLE_KEY[reason];
}
