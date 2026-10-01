import { ApiError, errorMessageKey } from "@/lib/api";

import type { LicenseRejectionReason, LicenseState } from "./types";

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

/** The license terms a key is issued under, in the language of the interface. */
const LICENSE_TERMS_URLS = {
  de: "https://restowbackup.com/de/lizenzbedingungen/",
  en: "https://restowbackup.com/en/license-terms/",
} as const;

export function licenseTermsUrl(language: string | undefined): string {
  return language?.toLowerCase().startsWith("de") ? LICENSE_TERMS_URLS.de : LICENSE_TERMS_URLS.en;
}

const REJECTION_REASONS: readonly LicenseRejectionReason[] = [
  "malformed",
  "bad_signature",
  "invalid_payload",
  "installation_mismatch",
];

function isRejectionReason(value: unknown): value is LicenseRejectionReason {
  return REJECTION_REASONS.includes(value as LicenseRejectionReason);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Explain why installing or removing a key failed, in the operator's terms. */
export function licenseErrorMessage(error: unknown): TranslatedMessage {
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
