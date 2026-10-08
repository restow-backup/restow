import type { StatusTone } from "@/components/kit";
import { ApiError, errorMessageKey } from "@/lib/api";
import type { AppPermission, AppTestFailureReason, MicrosoftAppView } from "./api";

/**
 * Pure mapping from the app registration's state to what the guide shows:
 * i18n keys, tones and the few language-independent strings (commands, the
 * portal address). No visible text lives here.
 */

/** The Microsoft Entra admin center, app registrations list. */
export const ENTRA_ADMIN_CENTER_URL =
  "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";

/**
 * The certificate's common name from the product name: only characters that
 * OpenSSL's `-subj` and the shell both take literally stay (the name is typed
 * into a command the operator copies), and something always remains.
 */
export function certificateSubjectName(productName: string): string {
  const safe = productName
    .replace(/[^A-Za-z0-9 ._-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > 0 ? safe : "Backup";
}

/**
 * Key pair for the certificate credential (docs/ENTRA-SETUP.md, part 3), then
 * one PEM for the product. The file names are technical and stay as they are.
 */
export function opensslCommands(productName: string): string {
  return [
    `openssl req -x509 -newkey rsa:4096 -keyout restow-entra.key -out restow-entra.crt -days 730 -nodes -subj "/CN=${certificateSubjectName(productName)}"`,
    "cat restow-entra.key restow-entra.crt > restow-entra.pem",
  ].join("\n");
}

/** A credential this close to its end is flagged (docs/ENTRA-SETUP.md: warn 60 days ahead). */
export const EXPIRY_WARNING_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryState =
  | { kind: "unknown" }
  | { kind: "expired" }
  | { kind: "soon"; days: number }
  | { kind: "valid"; date: string };

/** How the credential's end of validity reads right now. */
export function expiryState(expiresAt: string | null, now: number = Date.now()): ExpiryState {
  if (!expiresAt) {
    return { kind: "unknown" };
  }
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) {
    return { kind: "unknown" };
  }
  if (end <= now) {
    return { kind: "expired" };
  }
  const days = Math.floor((end - now) / DAY_MS);
  return days < EXPIRY_WARNING_DAYS ? { kind: "soon", days } : { kind: "valid", date: expiresAt };
}

/** Overall state of the registration for the status badge (a tone of the kit's StatusBadge). */
export function registrationStatus(view: MicrosoftAppView): {
  key: "ready" | "none" | "unusable";
  tone: Extract<StatusTone, "neutral" | "warning" | "destructive">;
} {
  if (view.problem) {
    return { key: "unusable", tone: "destructive" };
  }
  if (view.source === "none") {
    return { key: "none", tone: "warning" };
  }
  // A registration that is set up is a state, not a proof: neutral, never green.
  return { key: "ready", tone: "neutral" };
}

/** The permission list as the admin copies it into a ticket or checklist. */
export function permissionsCopyText(permissions: readonly AppPermission[]): string {
  return permissions
    .map((entry) => `${entry.permission} (${entry.type}${entry.required ? "" : ", optional"})`)
    .join("\n");
}

export function testReasonKey(reason: AppTestFailureReason): string {
  return `microsoftApp.test.reasons.${reason}`;
}

/** Field reasons the API and the form share, explained under `settings:microsoftApp.validation`. */
export const MICROSOFT_APP_FIELD_REASONS: ReadonlySet<string> = new Set([
  "guid",
  "tenantId",
  "secretIsId",
  "credentialRequired",
  "credentialConflict",
  "certificateMissing",
  "privateKeyMissing",
  "privateKeyEncrypted",
  "certificateInvalid",
  "privateKeyInvalid",
  "unsupportedKeyType",
  "keyMismatch",
  "certificateExpired",
  "certificateNotYetValid",
  "date",
  "authorityHost",
  "tooLong",
]);

/**
 * The i18n key (with namespace) for a field reason. Anything else reads as
 * "required", which is always true for a failed field and never leaks
 * untranslated text (the convention of lib/form.ts).
 */
export function fieldReasonKey(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  return MICROSOFT_APP_FIELD_REASONS.has(reason)
    ? `settings:microsoftApp.validation.${reason}`
    : "common:validation.required";
}

const PROBLEM_KEYS: Record<string, string> = {
  "urn:restow:problem:microsoft-app-managed-by-environment": "settings:errors.microsoftAppManaged",
  "urn:restow:problem:microsoft-app-not-configured": "settings:errors.microsoftAppNotConfigured",
  "urn:restow:problem:master-key-missing": "settings:errors.masterKey",
  "urn:restow:problem:master-key-invalid": "settings:errors.masterKey",
};

/** The i18n key (with namespace) that explains a failed request of this section. */
export function microsoftAppErrorKey(error: unknown): string {
  if (error instanceof ApiError && error.problem) {
    const key = PROBLEM_KEYS[error.problem.type];
    if (key) {
      return key;
    }
  }
  return `common:${errorMessageKey(error)}`;
}
