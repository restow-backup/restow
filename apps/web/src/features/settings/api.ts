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

export interface StoredGraphSettings {
  sender: string;
  tenantId: string | null;
}

export type MailSettings =
  | { transport: null }
  | { transport: "smtp"; smtp: StoredSmtpSettings }
  | { transport: "graph"; graph: StoredGraphSettings };

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
  | { transport: "graph"; graph: { sender: string; tenantId: string | null } };

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

export type MailTestFailureReason =
  | "timeout"
  | "graph_app_missing"
  | "graph_tenant_missing"
  | "transport_error";

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
