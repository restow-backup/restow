import type { Failure } from "@/features/failures/api";

/**
 * Contract types of `/api/v1/sources` (apps/api/src/features/sources). Kept
 * in sync by hand; the API is the source of truth.
 */

export type SourceKind = "m365" | "imap" | "import";
export type SourceStatus = "pending" | "active" | "error" | "disabled";
export type ImapSecurity = "tls" | "starttls" | "none";

export type PermissionState = "granted" | "read_only" | "missing";

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
  | "notifications";

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

export type TokenFailureHint =
  | "consent_missing"
  | "invalid_credentials"
  | "credentials_expired"
  | "tenant_unknown"
  | "unknown";

export interface TokenFailure {
  hint: TokenFailureHint;
  code: string | null;
  aadsts: string | null;
  status: number | null;
  message: string;
}

export interface UserSample {
  id: string;
  displayName: string | null;
  userPrincipalName: string | null;
}

export type TestCallResult =
  | { ok: true; usersSampled: number; sample: UserSample[] }
  | { ok: false; status: number | null; code: string | null; message: string };

export interface ConnectionVerification {
  checkedAt: string;
  tokenAcquired: boolean;
  tokenError: TokenFailure | null;
  permissions: PermissionDiff | null;
  testCall: TestCallResult | null;
  ok: boolean;
}

export interface PermissionsVerified {
  checkedAt: string;
  granted: string[];
  missing: string[];
}

/** The last admin-consent round trip that did not connect the source. */
export interface ConsentError {
  /**
   * Entra's error code, a binding conflict (`tenant_mismatch`,
   * `tenant_already_connected`) or why the consenting admin could not be
   * verified (`sign_in_failed`, `identity_mismatch`, `not_an_admin`,
   * `role_check_failed`, `app_not_configured`).
   */
  error: string;
  description: string | null;
  at: string;
}

export interface OwnAppInfo {
  clientId: string;
  credentialKind: "secret" | "certificate";
  authorityHost: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface OwnAppInput {
  tenantId: string;
  clientId: string;
  credentialKind: "secret" | "certificate";
  clientSecret?: string | null;
  certificatePem?: string | null;
}

export interface M365SourceDto {
  /** `consent`: the shared backup app after admin consent; `own_app`: the customer's own app. */
  connectionMode: "consent" | "own_app";
  ownApp: OwnAppInfo | null;
  entraTenantId: string | null;
  entraTenantHint: string | null;
  consentGrantedAt: string | null;
  consentBy: string | null;
  consentError: ConsentError | null;
  permissions: PermissionsVerified | null;
  verification: ConnectionVerification | null;
}

export type ImapProbeFailure =
  | "blocked_address"
  | "auth"
  | "timeout"
  | "tls"
  | "starttls_unavailable"
  | "dns"
  | "refused"
  | "unknown";

export interface ImapServerInfo {
  name: string | null;
  vendor: string | null;
  version: string | null;
}

export type ImapProbeResult =
  | {
      ok: true;
      checkedAt: string;
      secure: boolean;
      server: ImapServerInfo | null;
      mailboxes: number;
      specialUse: string[];
      capabilities: string[];
    }
  | {
      ok: false;
      checkedAt: string;
      reason: ImapProbeFailure;
      code: string | null;
      message: string;
    };

/**
 * How the mailboxes of an IMAP source authenticate (docs/IMAP.md): one shared
 * login for every mailbox, one password per mailbox (hosters like Hetzner,
 * IONOS, all-inkl), or one master account impersonating every mailbox.
 */
export type ImapAuthMode = "shared" | "per_mailbox" | "master_user";

export interface MasterUserInput {
  username: string;
  style: "dovecot_separator" | "sasl_authzid";
  separator?: string;
}

export interface ImapSourceDto {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  hasPassword: boolean;
  authKind: "password" | "oauth2";
  lastProbe: ImapProbeResult | null;
  imapAuthMode: ImapAuthMode;
  masterUser: MasterUserInput | null;
}

export interface SourceDto {
  id: string;
  tenantId: string;
  kind: SourceKind;
  name: string;
  status: SourceStatus;
  errorMessage: string | null;
  /**
   * The classified cause behind `errorMessage` (consent missing, wrong
   * password, TLS error, unreachable host ...); null when the source is fine
   * or the error was recorded before causes were kept.
   */
  failure: Failure | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  m365: M365SourceDto | null;
  imap: ImapSourceDto | null;
  /** Only on the source of kind `import`: how many imported mailboxes it holds. */
  importedMailboxes?: number;
}

export type EntraAppProblem =
  | "no_client_id"
  | "no_credential"
  | "credential_unusable"
  | "no_public_url";

export interface EntraAppStatus {
  configured: boolean;
  /** Where the backup app registration comes from; `none` until one is set up. */
  source: "environment" | "database" | "none";
  clientId: string | null;
  credential: "secret" | "certificate" | null;
  redirectUri: string | null;
  reasons: EntraAppProblem[];
  /** The tenant the backup app lives in, when known: it is connected without consent. */
  homeTenantId: string | null;
}

export interface ConsentLinkDto {
  url: string;
  redirectUri: string;
  expiresAt: string;
  tenant: string | null;
}

export interface CreateM365SourceInput {
  kind: "m365";
  name: string;
  entraTenantHint?: string;
  scope?: { mode: "all" | "group"; groupId?: string; exclude?: string[] };
}

export interface ImapConnectionInput {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
}

export interface CreateImapSourceInput extends ImapConnectionInput {
  kind: "imap";
  name: string;
  // Required for "shared" and "master_user" (the master's own credential);
  // omitted for "per_mailbox", where every mailbox seals its own password.
  password?: string;
  imapAuthMode: ImapAuthMode;
  masterUser?: MasterUserInput;
}

export type CreateSourceInput = CreateM365SourceInput | CreateImapSourceInput;

/** The protection scope is not part of it: after creation it belongs to the directory feature. */
export interface UpdateSourceInput {
  name?: string;
  status?: "active" | "disabled";
  entraTenantHint?: string | null;
  host?: string;
  port?: number;
  security?: ImapSecurity;
  username?: string;
  password?: string;
  imapAuthMode?: ImapAuthMode;
  masterUser?: MasterUserInput | null;
}

/** Either a typed password, or the source whose stored password may be reused (same host and username only). */
export type ImapTestInput = ImapConnectionInput &
  ({ password: string; sourceId?: string } | { password?: undefined; sourceId: string });

export interface VerifyResultDto {
  source: SourceDto;
  verification: ConnectionVerification;
}

export interface TestResultDto {
  source: SourceDto;
  probe: ImapProbeResult;
}

/** Data that keeps a source from being deleted (409 `source-has-data`). */
export interface RetainedData {
  snapshots: number;
  archiveItems: number;
  legalHolds: number;
}
