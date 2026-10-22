import { ApiError, errorMessageKey } from "@/lib/api";

import type { InstalledKey, LicenseRejectionReason, LicenseState } from "./types";

/**
 * Pure view logic of the license section. Messages are returned as namespaced
 * i18n keys plus values, so callers translate with a plain
 * `t(message.key, message.values)`.
 */

/** Problem types the license API answers with (ee/api). */
export const LICENSE_PROBLEM_TYPES = {
  invalid: "urn:restow:problem:license-invalid",
  verificationUnavailable: "urn:restow:problem:license-verification-unavailable",
  notConfigured: "urn:restow:problem:installation-not-configured",
  notInstalled: "urn:restow:problem:license-not-installed",
} as const;

export interface TranslatedMessage {
  key: string;
  values?: Record<string, string | number>;
}

/**
 * Where the edition in effect comes from, for its badge: a key, the
 * environment of a demo installation, or nothing to mention (Community
 * without a key).
 */
export type EditionOrigin = "key" | "environment" | null;

export function editionOrigin(state: Pick<LicenseState, "source" | "edition">): EditionOrigin {
  if (state.source === "key") {
    return "key";
  }
  return state.edition === "community" ? null : "environment";
}

/** Whether a key can be installed right now, or why not. */
export type InstallReadiness = "ready" | "not_configured" | "unconfigured" | "invalid";

export function installReadiness(state: LicenseState): InstallReadiness {
  if (state.verification.status !== "ready") {
    return state.verification.status;
  }
  return state.installationId === null ? "not_configured" : "ready";
}

/**
 * The vendor's website: where the editions are compared and a key is requested. The one place
 * its address is written; the links below are built from it.
 */
export const VENDOR_WEBSITE_URL = "https://restowbackup.com";

const isGerman = (language: string | undefined) =>
  language?.toLowerCase().startsWith("de") ?? false;

/** The license terms a key is issued under, in the language of the interface. */
export function licenseTermsUrl(language: string | undefined): string {
  return isGerman(language)
    ? `${VENDOR_WEBSITE_URL}/de/lizenzbedingungen/`
    : `${VENDOR_WEBSITE_URL}/en/license-terms/`;
}

/** Where the editions are compared and a key is requested, in the language of the interface. */
export function licenseRequestUrl(language: string | undefined): string {
  return `${VENDOR_WEBSITE_URL}/${isGerman(language) ? "de" : "en"}/`;
}

const REJECTION_REASONS: readonly LicenseRejectionReason[] = [
  "malformed",
  "bad_signature",
  "invalid_payload",
  "installation_mismatch",
  "unknown_signing_key",
];

/** A day `YYYY-MM-DD` in the language of the interface, never shifted by the time zone. */
export function formatDay(value: string, language: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/** The line "Updates: ..." of the installed key, or null for a server before 0.4.5. */
export function updatesLine(key: InstalledKey, language: string): TranslatedMessage | null {
  const updates = key.updates;
  if (!updates) {
    return null;
  }
  return updates.until === null
    ? { key: "license:updates.series", values: { series: updates.series } }
    : { key: "license:updates.until", values: { date: formatDay(updates.until, language) } };
}

/** How far ahead of its end the license page mentions the end of the update period. */
export const UPDATES_NOTICE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calm notice about the end of the update period: from {@link UPDATES_NOTICE_DAYS}
 * days before its last day, and after it. Only on this page; nothing is mailed. The clock
 * decides only what is said here, never what works.
 */
export function updatesNotice(
  key: InstalledKey | null,
  now: number,
  language: string,
): TranslatedMessage | null {
  const until = key?.updates?.until;
  if (!until) {
    return null;
  }
  const end = Date.parse(`${until}T23:59:59.999Z`);
  if (Number.isNaN(end)) {
    return null;
  }
  const date = formatDay(until, language);
  if (now > end) {
    return { key: "license:updates.ended", values: { date } };
  }
  if (end - now <= UPDATES_NOTICE_DAYS * DAY_MS) {
    return { key: "license:updates.endingSoon", values: { date } };
  }
  return null;
}

function isRejectionReason(value: unknown): value is LicenseRejectionReason {
  return REJECTION_REASONS.includes(value as LicenseRejectionReason);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Explain why installing or removing a key failed, in the operator's terms. */
export function licenseErrorMessage(error: unknown, language = "en"): TranslatedMessage {
  const problem = error instanceof ApiError ? error.problem : null;
  switch (problem?.type) {
    case LICENSE_PROBLEM_TYPES.invalid: {
      const reason = problem.reason;
      if (reason === "installation_mismatch") {
        return {
          key: "license:errors.installation_mismatch",
          values: {
            keyInstallation: text(problem.keyInstallationId),
            installation: text(problem.installationId),
          },
        };
      }
      if (reason === "outside_update_period") {
        return typeof problem.updatesUntil === "string"
          ? {
              key: "license:errors.outside_update_period",
              values: {
                date: formatDay(problem.updatesUntil, language),
                version: text(problem.version),
              },
            }
          : {
              key: "license:errors.outside_series",
              values: { series: text(problem.series), version: text(problem.version) },
            };
      }
      if (isRejectionReason(reason)) {
        return { key: `license:errors.${reason}` };
      }
      break;
    }
    case LICENSE_PROBLEM_TYPES.verificationUnavailable:
      return { key: "license:errors.unavailable" };
    case LICENSE_PROBLEM_TYPES.notConfigured:
      return { key: "license:errors.notConfigured" };
    case LICENSE_PROBLEM_TYPES.notInstalled:
      return { key: "license:errors.notInstalled" };
  }
  return { key: `common:${errorMessageKey(error)}` };
}
