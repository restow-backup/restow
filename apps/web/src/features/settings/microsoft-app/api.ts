import { apiFetch } from "@/lib/api";

/**
 * Client for `/api/v1/settings/microsoft-app` (apps/api/src/features/settings/
 * microsoft-app). Installation-level: requests never carry a tenant header.
 * The client secret and the private key are write-only; no response carries
 * them.
 */

export type MicrosoftAppSource = "environment" | "database" | "none";
export type CredentialKind = "secret" | "certificate";
export type UnusableReason =
  | "certificate_unreadable"
  | "certificate_invalid"
  | "document_unreadable"
  | "authority_host_invalid";

export type PermissionPurpose =
  | "mail"
  | "mailboxSettings"
  | "calendar"
  | "contacts"
  | "onedrive"
  | "users"
  | "groups"
  | "directory"
  | "organization"
  | "notifications"
  | "signIn";

export interface AppPermission {
  permission: string;
  type: "application" | "delegated";
  required: boolean;
  purpose: PermissionPurpose;
}

export type PermissionState = "granted" | "read_only" | "missing";

export interface PermissionCheck {
  permission: string;
  required: boolean;
  purpose: PermissionPurpose;
  state: PermissionState;
  grantedInstead: string | null;
}

export interface PermissionDiff {
  checks: PermissionCheck[];
  granted: string[];
  missing: string[];
  readOnlyInstead: { expected: string; granted: string }[];
  unexpected: string[];
  complete: boolean;
}

export type AppTestFailureReason =
  | "invalid_secret"
  | "secret_expired"
  | "app_not_found"
  | "tenant_not_found"
  | "credential_missing"
  | "invalid_certificate"
  | "consent_missing"
  | "permissions_missing"
  | "network"
  | "other";

export interface AppTestResult {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  tenantId: string;
  clientId: string;
  source: Exclude<MicrosoftAppSource, "none">;
  credentialKind: CredentialKind;
  tokenAcquired: boolean;
  reason: AppTestFailureReason | null;
  aadsts: string | null;
  detail: string | null;
  permissions: PermissionDiff | null;
}

export interface MicrosoftAppView {
  source: MicrosoftAppSource;
  clientId: string | null;
  homeTenantId: string | null;
  authorityHost: string | null;
  credential: {
    kind: CredentialKind | null;
    /** A credential is stored or configured; its value is never sent to the browser. */
    set: boolean;
    expiresAt: string | null;
    certificate: { thumbprint: string; subject: string; notAfter: string } | null;
  };
  problem: UnusableReason | null;
  updatedAt: string | null;
  updatedBy: string | null;
  redirectUris: { adminConsent: string | null; signIn: string | null };
  permissions: AppPermission[];
  sso: { configured: boolean };
  environmentPartial: boolean;
  lastTest: AppTestResult | null;
}

export interface SaveMicrosoftAppInput {
  clientId: string;
  /** Omit (with `certificatePem`) to keep the stored credential. */
  clientSecret?: string;
  certificatePem?: string;
  secretExpiresAt: string | null;
  homeTenantId: string | null;
  authorityHost: string | null;
}

export function fetchMicrosoftApp(): Promise<MicrosoftAppView> {
  return apiFetch<MicrosoftAppView>("/settings/microsoft-app", { tenantId: null });
}

export function saveMicrosoftApp(input: SaveMicrosoftAppInput): Promise<MicrosoftAppView> {
  return apiFetch<MicrosoftAppView>("/settings/microsoft-app", {
    method: "PUT",
    body: input,
    tenantId: null,
  });
}

export function removeMicrosoftApp(): Promise<MicrosoftAppView> {
  return apiFetch<MicrosoftAppView>("/settings/microsoft-app", {
    method: "DELETE",
    tenantId: null,
  });
}

export function testMicrosoftApp(tenantId: string | null): Promise<AppTestResult> {
  return apiFetch<AppTestResult>("/settings/microsoft-app/test", {
    method: "POST",
    body: tenantId ? { tenantId } : {},
    tenantId: null,
  });
}
