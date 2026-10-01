import {
  APP_REGISTRATION_PERMISSIONS,
  type AppRegistrationPermission,
  type AppTestResult,
  type CertificateInfo,
  type CertificateProblem,
  type EntraAppDocument,
  type EntraAppResolution,
  type EntraAppUnusableReason,
  type EntraCredentialKind,
  adminConsentRedirectUri,
  inspectCertificatePem,
} from "@restow/core";
import { type ValidationIssue, validationProblem } from "../logic.js";
import type { SaveMicrosoftAppInput } from "./schemas.js";

/**
 * Rules of the Microsoft 365 app registration (pure, no I/O): how a save turns
 * into the next sealed document, when the stored credential may be kept, and
 * what the API returns. Secrets never appear in a view, a change list or an
 * issue; only whether one is stored.
 */

/** Path of the end-user sign-in callback (better-auth generic OAuth, provider `microsoft`). */
export const SSO_CALLBACK_PATH = "/api/auth/callback/microsoft";

// --- Save ---------------------------------------------------------------------------------

/** Issue reasons for a certificate the admin supplied, in the API's vocabulary. */
const CERTIFICATE_REASONS: Record<CertificateProblem, string> = {
  certificate_missing: "certificateMissing",
  private_key_missing: "privateKeyMissing",
  private_key_encrypted: "privateKeyEncrypted",
  certificate_invalid: "certificateInvalid",
  private_key_invalid: "privateKeyInvalid",
  unsupported_key_type: "unsupportedKeyType",
  key_mismatch: "keyMismatch",
  expired: "certificateExpired",
  not_yet_valid: "certificateNotYetValid",
};

export interface MicrosoftAppSavePlan {
  document: EntraAppDocument;
  /** Names of what changed, for the audit log (never values of secrets). */
  changes: string[];
  /** A new secret or certificate was supplied. */
  credentialChanged: boolean;
  /** The certificate that will be used, when the credential is one. */
  certificate: CertificateInfo | null;
}

/**
 * The stored credential is only kept for the app and the login host it was
 * saved for: pointing the registration at another app id or another authority
 * must never send the old secret there.
 */
export function mayKeepStoredCredential(
  current: EntraAppDocument | null,
  input: Pick<SaveMicrosoftAppInput, "clientId" | "authorityHost">,
): boolean {
  return (
    current !== null &&
    current.clientId.toLowerCase() === input.clientId &&
    (current.authorityHost ?? null) === input.authorityHost
  );
}

function diff(
  current: EntraAppDocument | null,
  next: EntraAppDocument,
  credentialChanged: boolean,
) {
  const changes: string[] = [];
  const fields = [
    "clientId",
    "credentialKind",
    "secretExpiresAt",
    "homeTenantId",
    "authorityHost",
  ] as const;
  for (const field of fields) {
    if ((current?.[field] ?? null) !== (next[field] ?? null)) {
      changes.push(field);
    }
  }
  if (credentialChanged) {
    changes.push(next.credentialKind === "secret" ? "clientSecret" : "certificate");
  }
  return changes;
}

/**
 * Turn a save into the next document. Every problem is collected and reported
 * at once as a 422 with issue paths the form attaches to its fields.
 */
export function planMicrosoftAppSave(
  current: EntraAppDocument | null,
  input: SaveMicrosoftAppInput,
  actor: string,
  now: Date,
): MicrosoftAppSavePlan {
  const issues: ValidationIssue[] = [];
  let credential:
    | { kind: "secret"; clientSecret: string }
    | { kind: "certificate"; certificatePem: string }
    | null = null;
  let certificate: CertificateInfo | null = null;
  let credentialChanged = false;

  if (input.certificatePem !== undefined) {
    const inspection = inspectCertificatePem(input.certificatePem, now);
    if (inspection.ok) {
      // Stored as key plus certificate only; anything else pasted around them is dropped.
      credential = {
        kind: "certificate",
        certificatePem: `${inspection.privateKeyPem.trim()}\n${inspection.certificatePem.trim()}\n`,
      };
      certificate = inspection.info;
      credentialChanged = true;
    } else {
      issues.push({ path: ["certificatePem"], message: CERTIFICATE_REASONS[inspection.problem] });
    }
  } else if (input.clientSecret !== undefined) {
    credential = { kind: "secret", clientSecret: input.clientSecret };
    credentialChanged = true;
  } else if (current && mayKeepStoredCredential(current, input)) {
    credential =
      current.credentialKind === "secret"
        ? { kind: "secret", clientSecret: current.clientSecret ?? "" }
        : { kind: "certificate", certificatePem: current.certificatePem ?? "" };
  } else {
    const path = current?.credentialKind === "certificate" ? "certificatePem" : "clientSecret";
    issues.push({ path: [path], message: "credentialRequired" });
  }

  if (issues.length > 0 || credential === null) {
    throw validationProblem(issues);
  }

  const document: EntraAppDocument = {
    clientId: input.clientId,
    credentialKind: credential.kind,
    ...(credential.kind === "secret"
      ? { clientSecret: credential.clientSecret }
      : { certificatePem: credential.certificatePem }),
    // An expiry noted for a secret means nothing for a certificate (it carries its own).
    secretExpiresAt: credential.kind === "secret" ? input.secretExpiresAt : null,
    homeTenantId: input.homeTenantId,
    authorityHost: input.authorityHost,
    updatedAt: now.toISOString(),
    updatedBy: actor,
  };
  return {
    document,
    changes: diff(current, document, credentialChanged),
    credentialChanged,
    certificate,
  };
}

// --- View ------------------------------------------------------------------------------------

export interface MicrosoftAppCredentialView {
  kind: EntraCredentialKind | null;
  /** A credential is stored or configured (it is never returned). */
  set: boolean;
  /** End of validity: the certificate's, or the date noted for the secret. */
  expiresAt: string | null;
  certificate: { thumbprint: string; subject: string; notAfter: string } | null;
}

export interface MicrosoftAppView {
  /** Where the registration in use comes from. */
  source: "environment" | "database" | "none";
  clientId: string | null;
  homeTenantId: string | null;
  authorityHost: string | null;
  credential: MicrosoftAppCredentialView;
  /** Configured, but not usable (unreadable certificate file, document sealed under another key). */
  problem: EntraAppUnusableReason | null;
  /** Last change in the web UI (ISO 8601) and who made it; null for the environment. */
  updatedAt: string | null;
  updatedBy: string | null;
  /** The exact URIs to register, or null without a public URL. */
  redirectUris: { adminConsent: string | null; signIn: string | null };
  /** What the app registration lists under "API permissions" (the single catalogue). */
  permissions: AppRegistrationPermission[];
  /** End-user sign-in (the separate SSO app) is configured in the environment. */
  sso: { configured: boolean };
  /** ENTRA_CLIENT_* are set only partly; they are ignored until complete. */
  environmentPartial: boolean;
  /** The last connection test of the registration in use; null when none or outdated. */
  lastTest: AppTestResult | null;
}

export interface MicrosoftAppViewInput {
  resolution: EntraAppResolution;
  publicOrigin: string | null;
  ssoConfigured: boolean;
  environmentPartial: boolean;
  lastTest: AppTestResult | null;
}

function credentialView(resolution: EntraAppResolution): MicrosoftAppCredentialView {
  if (resolution.status !== "ready") {
    return {
      kind: null,
      set: resolution.status === "unusable",
      expiresAt: null,
      certificate: null,
    };
  }
  const { app } = resolution;
  return {
    kind: app.credentialKind,
    set: true,
    expiresAt: app.expiresAt,
    certificate: app.certificate
      ? {
          thumbprint: app.certificate.thumbprint,
          subject: app.certificate.subject,
          notAfter: app.certificate.notAfter,
        }
      : null,
  };
}

function sourceOf(resolution: EntraAppResolution): MicrosoftAppView["source"] {
  switch (resolution.status) {
    case "ready":
      return resolution.app.source;
    case "unusable":
      return resolution.source;
    case "none":
      return "none";
  }
}

function clientIdOf(resolution: EntraAppResolution): string | null {
  switch (resolution.status) {
    case "ready":
      return resolution.app.credentials.clientId;
    case "unusable":
      return resolution.clientId;
    case "none":
      // A lone ENTRA_CLIENT_ID is not a registration; `environmentPartial` says so.
      return null;
  }
}

/** The GET/PUT/DELETE response body. */
export function toMicrosoftAppView(input: MicrosoftAppViewInput): MicrosoftAppView {
  const { resolution } = input;
  const ready = resolution.status === "ready" ? resolution.app : null;
  return {
    source: sourceOf(resolution),
    clientId: clientIdOf(resolution),
    homeTenantId: ready?.homeTenantId ?? null,
    authorityHost: ready?.credentials.authorityHost ?? null,
    credential: credentialView(resolution),
    problem: resolution.status === "unusable" ? resolution.reason : null,
    updatedAt: ready?.updatedAt ?? null,
    updatedBy: ready?.updatedBy ?? null,
    redirectUris: {
      adminConsent: input.publicOrigin ? adminConsentRedirectUri(input.publicOrigin) : null,
      signIn: input.publicOrigin
        ? adminConsentRedirectUri(input.publicOrigin, SSO_CALLBACK_PATH)
        : null,
    },
    permissions: APP_REGISTRATION_PERMISSIONS.map((entry) => ({ ...entry })),
    sso: { configured: input.ssoConfigured },
    environmentPartial: input.environmentPartial,
    lastTest: input.lastTest,
  };
}
