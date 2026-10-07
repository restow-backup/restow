import {
  type MailTransport,
  type OperatingMode,
  type PasskeyReady,
  type SmtpSecurity,
  apiFetch,
} from "@/lib/api";

/**
 * Client for `/api/v1/settings` (apps/api/src/features/settings). Installation
 * settings are provider-level: requests never carry a tenant header.
 */

export interface StoredSmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  from: string;
  username: string | null;
  /** A password is stored; its value is never sent to the browser. */
  passwordStored: boolean;
}

/** Which app registration Microsoft 365 (Graph sendMail) sends as. */
export type GraphMailApp = "backup" | "own";
export type CredentialKind = "secret" | "certificate";

export interface StoredGraphSettings {
  sender: string;
  tenantId: string | null;
  app: GraphMailApp;
  /** The notification mail's own app registration; null while the backup app sends. */
  ownApp: {
    clientId: string;
    credentialKind: CredentialKind;
    /** The secret or certificate is stored; its value never reaches the browser. */
    credentialStored: boolean;
  } | null;
}

export interface StoredGoogleSettings {
  sender: string;
  serviceAccountEmail: string;
  /** The OAuth client id the domain-wide delegation entry names. */
  clientId: string;
  /** The key is stored; it never reaches the browser. */
  keyStored: boolean;
}

export type MailSettings =
  | { transport: null }
  | { transport: "smtp"; smtp: StoredSmtpSettings }
  | { transport: "graph"; graph: StoredGraphSettings }
  | { transport: "google"; google: StoredGoogleSettings };

export interface EnvironmentInfo {
  /** RESTOW_PUBLIC_URL the server runs with. */
  publicUrl: string | null;
  /** The environment names a different origin than the saved public URL. */
  publicUrlMismatch: boolean;
}

/** The operator responsibility notice as this installation holds it (apps/api lib/disclaimer.ts). */
export interface DisclaimerRecord {
  /** The version that was accepted; null before the first acceptance. */
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** The version the server asks to be accepted now. */
  currentVersion: string;
}

export interface InstallationSettings {
  operatingMode: OperatingMode | null;
  publicUrl: string | null;
  passkeyReady: PasskeyReady;
  environment: EnvironmentInfo;
  mail: MailSettings;
  capabilities: {
    graphMail: { appConfigured: boolean; defaultTenantId: string | null };
  };
  disclaimer: DisclaimerRecord;
  updatedAt: string | null;
}

export type MailInput =
  | {
      transport: "smtp";
      smtp: {
        host: string;
        port: number;
        security: SmtpSecurity;
        from: string;
        username: string | null;
        /** Omit to keep the stored password (same host and username only). */
        password?: string;
      };
    }
  | {
      transport: "graph";
      graph: {
        sender: string;
        tenantId: string | null;
        app: GraphMailApp;
        /** Required for `own`; omit the secret or certificate to keep the stored one. */
        ownApp?: {
          clientId: string;
          credentialKind: CredentialKind;
          clientSecret?: string;
          certificatePem?: string;
        };
      };
    }
  | {
      transport: "google";
      /** Omit the key to keep the stored one. */
      google: { sender: string; serviceAccountKey?: string };
    };

export interface SettingsPatch {
  operatingMode?: OperatingMode;
  publicUrl?: string | null;
  mail?: MailInput;
}

export interface MailTestRequest {
  /** Defaults to the signed-in admin. */
  to?: string;
  /** The unsaved form values; omit to test the stored transport. */
  mail?: MailInput;
}

/** Why a test send failed (apps/api notify-core.ts `MAIL_FAILURE_REASONS`). */
export const MAIL_TEST_FAILURE_REASONS = [
  "timeout",
  "transport_error",
  "smtp_auth_failed",
  "smtp_connection_failed",
  "smtp_tls_failed",
  "graph_app_missing",
  "graph_credential_missing",
  "graph_tenant_missing",
  "graph_tenant_not_found",
  "graph_app_not_found",
  "graph_secret_invalid",
  "graph_secret_expired",
  "graph_certificate_invalid",
  "graph_token_failed",
  "graph_send_denied",
  "graph_sender_not_found",
  "google_key_missing",
  "google_key_invalid",
  "google_delegation_missing",
  "google_sender_not_found",
  "google_api_disabled",
  "google_send_denied",
  "google_token_failed",
] as const;

export type MailTestFailureReason = (typeof MAIL_TEST_FAILURE_REASONS)[number];

export interface MailTestResult {
  ok: boolean;
  transport: MailTransport;
  recipient: string;
  durationMs: number;
  failure: { reason: MailTestFailureReason; detail: string | null } | null;
}

export type ReachabilityStatus =
  | "ok"
  | "skipped"
  | "unreachable"
  | "timeout"
  | "certificate_invalid"
  | "unexpected_response";

export interface ReachabilityProbe {
  status: ReachabilityStatus;
  url: string | null;
  detail: string | null;
  checkedAt: string;
}

export interface PasskeyReadinessCheck {
  passkeyReady: PasskeyReady;
  probe: ReachabilityProbe;
  environment: EnvironmentInfo;
}

export function fetchSettings(): Promise<InstallationSettings> {
  return apiFetch<InstallationSettings>("/settings", { tenantId: null });
}

export function patchSettings(patch: SettingsPatch): Promise<InstallationSettings> {
  return apiFetch<InstallationSettings>("/settings", {
    method: "PATCH",
    body: patch,
    tenantId: null,
  });
}

export function sendTestMail(request: MailTestRequest): Promise<MailTestResult> {
  return apiFetch<MailTestResult>("/settings/mail/test", {
    method: "POST",
    body: request,
    tenantId: null,
  });
}

export function deleteMailConfiguration(): Promise<InstallationSettings> {
  return apiFetch<InstallationSettings>("/settings/mail", { method: "DELETE", tenantId: null });
}

export function fetchPasskeyReadiness(): Promise<PasskeyReadinessCheck> {
  return apiFetch<PasskeyReadinessCheck>("/settings/passkey-ready", { tenantId: null });
}

/** Who could no longer sign in once passkeys stop working (apps/api settings/passkey-impact.ts). */
export interface PasskeyImpact {
  accountsWithPasskeys: number;
  accountsLockedOut: number;
  self: {
    hasPasskey: boolean;
    hasPassword: boolean;
    hasAuthenticator: boolean;
    lockedOut: boolean;
  };
}

export function fetchPasskeyImpact(): Promise<PasskeyImpact> {
  return apiFetch<PasskeyImpact>("/settings/passkey-impact", { tenantId: null });
}
