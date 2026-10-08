import {
  type AppCredentials,
  ClientCredentialsTokenProvider,
  type ConnectionVerification,
  type ConsentIdentityFailure,
  type ConsentIdentityProof,
  type ConsentStatePayload,
  type ConsentingAdmin,
  FetchGraphClient,
  type PermissionDiff,
  SOURCE_APP_SECRET_KIND,
  type SourceAppFormInput,
  adminConsentRedirectUri,
  buildAdminConsentUrl,
  buildConsentSignInUrl,
  buildSourceApp,
  causeOfVerification,
  parseAdminConsentCallback,
  parseConsentSignInCallback,
  proveConsentingAdmin,
  readDirectoryState,
  serializeSourceAppDocument,
  signConsentState,
  verifyConsentState,
  verifyTenantConnection,
} from "@restow/core";
import {
  type Database,
  ENTRA_TENANT_UNIQUE_INDEX,
  type ImapSecurity,
  type PermissionsVerified,
  type Source,
  type SourceConfig,
  type SourceStatus,
  archiveItemMailboxes,
  archiveItems,
  legalHolds,
  protectedObjects,
  settings,
  snapshots,
  sources,
} from "@restow/db";
import { type SQL, and, asc, count, eq, inArray, ne, or, sql } from "drizzle-orm";
import { config as processConfig } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { deleteSecret, readSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { enqueueDirectorySync } from "../directory/enqueue.js";
import { DIRECTORY_AUDIT_ACTIONS } from "../directory/service.js";
import { type FailureDto, causeToRecord, failureDto } from "../failures/dto.js";
import { causeOfImapProbe } from "../failures/probe.js";
import {
  type EntraAppStatus,
  entraAppStatus,
  entraCredentialProblems,
  entraNotConfigured,
  entraProblems,
  forgetSourceProviders,
  forgetTokenProvider,
  graphClientFor,
  graphClientForSource,
  resolveEntraApp,
  tokenProviderFor,
  tokenProviderForSource,
} from "./entra.js";
import {
  type ImapHostContext,
  approveImapHost,
  probeMayReachPrivateNetworks,
  storedHostMayBePrivate,
} from "./imap-host.js";
import { type ImapProbeInput, type ImapProbeResult, probeImapConnection } from "./imap.js";
import type {
  CreateSourceInput,
  ImapAuthMode,
  ImapTestInput,
  MasterUserInput,
  UpdateSourceInput,
} from "./schemas.js";

/**
 * Sources: the Microsoft 365 tenants and IMAP mailboxes a tenant backs up.
 *
 * M365 sources are connected through admin consent (docs/ENTRA-SETUP.md): a
 * signed link, a public callback, a second sign-in of the consenting admin
 * that proves which Entra tenant consented (the callback's own `tenant`
 * parameter is unsigned and never trusted), and a verification that acquires a
 * token, diffs the granted application permissions against the required ones
 * and lists the first users. IMAP
 * sources carry their connection details plus a password that lives only in
 * the encrypted secret store and is only ever sent to the host it was stored
 * for. Every change is audited.
 *
 * `sources.config` is shared with the directory feature (`scope`,
 * `directory`); this module only ever merges its own keys into it, atomically.
 */

/** Audit actions written by this feature. */
export const SOURCE_AUDIT_ACTIONS = {
  created: "source.created",
  ownAppConnected: "source.own_app.connected",
  updated: "source.updated",
  deleted: "source.deleted",
  consentLinkCreated: "source.consent.link_created",
  consentSignInStarted: "source.consent.sign_in_started",
  consentGranted: "source.consent.granted",
  ownTenantConnected: "source.own_tenant.connected",
  consentDenied: "source.consent.denied",
  consentRejected: "source.consent.rejected",
  verified: "source.verified",
  tested: "source.tested",
  imapProbed: "source.imap.probed",
} as const;

/** Actor label for the consent callback, which is not a Restow session. */
const CONSENT_CALLBACK_ACTOR = "entra:admin-consent";

/** Who performs an action, for the audit log. */
export interface Actor {
  id: string;
  email: string;
  ip: string | null;
  /** Provider admins may connect IMAP sources to internal servers (./imap-host.ts). */
  isProviderAdmin: boolean;
}

/** What the IMAP host policy needs to know about an actor saving or testing a host. */
function imapHostContext(actor: Actor): ImapHostContext {
  return {
    isProviderAdmin: actor.isProviderAdmin,
    privateNetworksAllowed: processConfig.imapAllowPrivateNetworks,
    actorEmail: actor.email,
    now: new Date(),
  };
}

/** The last admin-consent round trip that did not connect the source, and why. */
export interface ConsentError {
  /**
   * Entra's error code (`access_denied`, ...), a binding conflict
   * (`tenant_mismatch`, `tenant_already_connected`) or why the consenting admin
   * could not be verified ({@link ConsentIdentityReason}).
   */
  error: string;
  description: string | null;
  /** ISO-8601 time the callback arrived. */
  at: string;
}

/**
 * This feature's keys in `sources.config` (jsonb). The detailed verification
 * and probe have no columns of their own; `scope` is written once at creation
 * and then belongs to the directory feature.
 */
export interface SourceConfigExt extends SourceConfig {
  /** Tenant id or domain the admin typed to pre-fill the consent link. */
  entraTenantHint?: string | null;
  consentError?: ConsentError | null;
  lastVerification?: ConnectionVerification | null;
  lastProbe?: ImapProbeResult | null;
  /** m365: public facts of the source's own Graph app; its credential is a sealed secret. */
  ownApp?: OwnAppInfo | null;
}

/** What the UI may know about a source's own Graph app: never its credential. */
export interface OwnAppInfo {
  clientId: string;
  credentialKind: "secret" | "certificate";
  authorityHost: string | null;
  updatedAt: string;
  updatedBy: string;
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

export interface ImapSourceDto {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  hasPassword: boolean;
  authKind: "password" | "oauth2";
  lastProbe: ImapProbeResult | null;
  /** How mailboxes of this source authenticate (docs/IMAP.md); "shared" when absent. */
  imapAuthMode: ImapAuthMode;
  /** The master account's login shape, only meaningful for `imapAuthMode: "master_user"`. */
  masterUser: MasterUserInput | null;
}

export interface SourceDto {
  id: string;
  tenantId: string;
  kind: Source["kind"];
  name: string;
  status: SourceStatus;
  errorMessage: string | null;
  /**
   * The classified cause behind `errorMessage` (why the connection or sync is
   * broken, what to do); null for a healthy source and for rows that keep only
   * the text.
   */
  failure: FailureDto | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
  m365: M365SourceDto | null;
  imap: ImapSourceDto | null;
  /**
   * Import source only (mail files brought in by hand, docs/IMPORT.md): how many
   * imported mailboxes it holds, i.e. what deleting the source would remove.
   * Null for every other kind.
   */
  importedMailboxes: number | null;
}

export interface ConsentLinkDto {
  url: string;
  redirectUri: string;
  expiresAt: string;
  /** The audience the link targets: the hint the admin gave, or null for `organizations`. */
  tenant: string | null;
}

export interface VerifyResultDto {
  source: SourceDto;
  /** The full result, including the user sample that is not persisted. */
  verification: ConnectionVerification;
}

export interface TestResultDto {
  source: SourceDto;
  probe: ImapProbeResult;
}

/**
 * Why the admin behind a consent could not be verified: the proof sign-in
 * failed ({@link ConsentIdentityFailure}), or the backup app lacks what the
 * proof needs (client id, credentials, public callback).
 */
export type ConsentIdentityReason = ConsentIdentityFailure | "app_not_configured";

/** Where a consent round trip ended, turned into a page or redirect by the route. */
export type ConsentResult =
  | {
      kind: "granted";
      tenantId: string;
      sourceId: string;
      verification: ConnectionVerification | null;
    }
  | { kind: "denied"; tenantId: string; sourceId: string; error: string }
  | {
      kind: "identity_not_verified";
      tenantId: string;
      sourceId: string;
      reason: ConsentIdentityReason;
    }
  | { kind: "tenant_already_connected"; tenantId: string; sourceId: string; entraTenantId: string }
  | { kind: "tenant_mismatch"; tenantId: string; sourceId: string; entraTenantId: string }
  | { kind: "invalid_state"; reason: "malformed" | "bad_signature" | "expired" | "missing" }
  | { kind: "unknown_source" };

export type ConsentCallbackKind = ConsentResult["kind"];

/**
 * Outcome of the public consent callback: a result, or (after the admin
 * consent itself) the proof sign-in the browser is sent to next.
 */
export type ConsentCallbackOutcome = ConsentResult | { kind: "sign_in_required"; url: string };

/** Rows that must survive a source: deleting it would cascade into them. */
export interface RetainedData {
  snapshots: number;
  archiveItems: number;
  legalHolds: number;
}

function configOf(row: Pick<Source, "config">): SourceConfigExt {
  return (row.config ?? {}) as SourceConfigExt;
}

/**
 * Merge top-level keys into `config` in one statement, so a concurrent write
 * by the directory feature (its own keys) is never lost.
 */
function mergeConfig(patch: Partial<SourceConfigExt>): SQL {
  return sql`coalesce(${sources.config}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toDto(row: Source, importedMailboxes: number | null = null): SourceDto {
  const cfg = configOf(row);
  const base = {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    name: row.name,
    status: row.status,
    errorMessage: row.errorMessage,
    failure: failureDto(row.failure),
    lastSyncAt: iso(row.lastSyncAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  if (row.kind === "m365") {
    return {
      ...base,
      m365: {
        connectionMode: cfg.ownApp ? "own_app" : "consent",
        ownApp: cfg.ownApp ?? null,
        entraTenantId: row.entraTenantId,
        entraTenantHint: cfg.entraTenantHint ?? null,
        consentGrantedAt: iso(row.consentGrantedAt),
        consentBy: row.consentBy,
        consentError: cfg.consentError ?? null,
        permissions: row.permissionsVerified ?? null,
        verification: cfg.lastVerification ?? null,
      },
      imap: null,
      importedMailboxes: null,
    };
  }
  if (row.kind === "import") {
    // No host, port, login or secret: the files come from the person's own computer or the server's import folder.
    return { ...base, m365: null, imap: null, importedMailboxes: importedMailboxes ?? 0 };
  }
  return {
    ...base,
    importedMailboxes: null,
    m365: null,
    imap: {
      host: row.host ?? "",
      port: row.port ?? 0,
      security: row.security ?? "tls",
      username: row.username ?? "",
      hasPassword: row.secretRef !== null,
      authKind: cfg.authKind ?? "password",
      lastProbe: cfg.lastProbe ?? null,
      imapAuthMode: cfg.imapAuthMode ?? "shared",
      masterUser: cfg.masterUser ?? null,
    },
  };
}

function notFound(): ProblemError {
  return new ProblemError(404, "Source not found");
}

// --- Pure rules (unit-tested) ---------------------------------------------------

/** The column subset of the verification that the schema defines (other features read it). */
export function toPermissionsVerified(verification: ConnectionVerification): PermissionsVerified {
  const diff: PermissionDiff | null = verification.permissions;
  return {
    checkedAt: verification.checkedAt,
    granted: diff?.granted ?? [],
    missing: diff?.missing ?? [],
  };
}

/**
 * The verification as it is persisted: without the user sample. Names and
 * UPNs are proof that the test call worked right now; keeping them in the
 * source row would copy personal data nobody asked to store.
 */
export function withoutUserSample(verification: ConnectionVerification): ConnectionVerification {
  const testCall = verification.testCall;
  if (!testCall?.ok || testCall.sample.length === 0) {
    return verification;
  }
  return { ...verification, testCall: { ...testCall, sample: [] } };
}

/** One diagnostic line for `error_message` that says what verification found; null when green. */
export function verificationSummary(verification: ConnectionVerification): string | null {
  if (verification.ok) {
    return null;
  }
  if (verification.tokenError) {
    return `Token: ${verification.tokenError.hint} (${verification.tokenError.aadsts ?? verification.tokenError.code ?? "error"})`;
  }
  const parts: string[] = [];
  const permissions = verification.permissions;
  if (permissions && !permissions.complete) {
    const readOnly = permissions.readOnlyInstead.map(
      (entry) => `${entry.granted} instead of ${entry.expected}`,
    );
    const missing = permissions.missing.filter(
      (name) => !permissions.readOnlyInstead.some((entry) => entry.expected === name),
    );
    if (readOnly.length > 0) {
      parts.push(`Read-only: ${readOnly.join(", ")}`);
    }
    if (missing.length > 0) {
      parts.push(`Missing: ${missing.join(", ")}`);
    }
  }
  if (verification.testCall && !verification.testCall.ok) {
    parts.push(
      `Test call failed: ${verification.testCall.code ?? verification.testCall.status ?? "error"}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : "Verification failed";
}

/** One diagnostic line for `error_message` from an IMAP probe; null when green. */
export function probeSummary(probe: ImapProbeResult): string | null {
  if (probe.ok) {
    return null;
  }
  return `IMAP ${probe.reason}${probe.code ? ` (${probe.code})` : ""}: ${probe.message}`;
}

/**
 * The status a source has earned through its last check. Used when an
 * operator resumes a paused source: "active" is never simply asserted, it
 * follows from a green verification or connection test.
 */
export function derivedStatus(
  row: Pick<Source, "kind" | "entraTenantId" | "config">,
): Exclude<SourceStatus, "disabled"> {
  const cfg = configOf(row);
  if (row.kind === "m365") {
    const verification = row.entraTenantId ? cfg.lastVerification : null;
    return verification ? (verification.ok ? "active" : "error") : "pending";
  }
  if ((cfg.imapAuthMode ?? "shared") === "per_mailbox") {
    // A per_mailbox source carries no login of its own to probe: every
    // mailbox seals its own password, and readiness lives on the object
    // (protected_objects.credential_status), not on the source. Leaving the
    // source "pending" until an operator-facing source-level test succeeds
    // would block it forever, since that test can never run.
    return "active";
  }
  const probe = cfg.lastProbe;
  return probe ? (probe.ok ? "active" : "error") : "pending";
}

/**
 * The status after an operator's patch: pausing always wins, a changed IMAP
 * connection needs a new test, resuming falls back to what the last check earned.
 * `nextImapAuthMode` is the mode the patch results in (only meaningful for IMAP
 * sources): a source that just switched to `per_mailbox` skips the "pending
 * until tested" step the same way a freshly created one does, since it has
 * nothing of its own left to test (see {@link derivedStatus}).
 */
export function statusAfterPatch(
  current: Pick<Source, "kind" | "entraTenantId" | "config" | "status">,
  requested: "active" | "disabled" | undefined,
  connectionChanged: boolean,
  nextImapAuthMode?: ImapAuthMode,
): SourceStatus {
  const paused = (requested ?? current.status) === "disabled";
  if (paused) {
    return "disabled";
  }
  if (connectionChanged) {
    if (current.kind === "imap" && nextImapAuthMode === "per_mailbox") {
      return "active";
    }
    return "pending";
  }
  if (current.status === "disabled") {
    return derivedStatus(current);
  }
  return current.status;
}

function sameHost(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * A stored IMAP password may only ever travel to the host and account it was
 * stored for. Changing either needs the password again, so nobody can point a
 * source at another server and have Restow hand the secret over.
 */
export function mayReuseStoredPassword(
  stored: { host: string | null; username: string | null },
  next: { host: string; username: string },
): boolean {
  return sameHost(stored.host, next.host) && (stored.username ?? "") === next.username.trim();
}

/** Whether an IMAP patch must carry a new password (see {@link mayReuseStoredPassword}). */
export function patchNeedsPassword(
  current: { host: string | null; username: string | null },
  patch: Pick<UpdateSourceInput, "host" | "username" | "password">,
): boolean {
  if (patch.password !== undefined) {
    return false;
  }
  return !mayReuseStoredPassword(current, {
    host: patch.host ?? current.host ?? "",
    username: patch.username ?? current.username ?? "",
  });
}

function passwordRequired(): ProblemError {
  return new ProblemError(422, "Password required", {
    type: "urn:restow:problem:password-required",
    detail:
      "Enter the password again when changing the server or username; the stored one is only used for the server it was saved for.",
    extensions: { field: "password" },
  });
}

/** 409 when deleting would take backups, archived mail or legal holds with it; null otherwise. */
export function retainedDataProblem(
  retained: RetainedData,
  kind: Source["kind"] = "m365",
  importedMailboxes?: number,
): ProblemError | null {
  if (retained.snapshots === 0 && retained.archiveItems === 0 && retained.legalHolds === 0) {
    return null;
  }
  return new ProblemError(409, "Source still holds data", {
    type: "urn:restow:problem:source-has-data",
    detail:
      kind === "import"
        ? "The imported mailboxes of this source hold imported mail, archived mail or legal holds. Deleting the source would remove their index; retention decides when the data expires."
        : "This source has backups, archived mail or legal holds. Deleting it would remove their index, so pause the source instead; retention decides when data expires.",
    extensions: {
      retained,
      ...(kind === "import" && importedMailboxes !== undefined ? { importedMailboxes } : {}),
    },
  });
}

/**
 * Which tenant a consent link targets. A connected source can only be
 * re-consented in its own tenant; otherwise the requested value wins (`null`
 * = the admin picks their organisation), and omitted falls back to the stored hint.
 */
export function consentLinkTarget(
  entraTenantId: string | null,
  storedHint: string | null | undefined,
  requested: string | null | undefined,
): string | null {
  if (entraTenantId) {
    return entraTenantId;
  }
  return requested !== undefined ? requested : (storedHint ?? null);
}

export type BindingConflict = "tenant_mismatch" | "tenant_already_connected";

/**
 * Why a source cannot be bound to `entraTenantId`, or null when it can. A
 * source stays bound to the Entra tenant it was first connected to (its
 * snapshots come from there), and an Entra tenant belongs to one source of
 * the whole installation. The caller passes what Row Level Security lets it
 * see (the sources of its own tenant); the installation-wide unique index
 * catches the rest when the binding is written.
 */
export function bindingConflict(
  source: { entraTenantId: string | null },
  entraTenantId: string,
  takenByAnotherSource: boolean,
): BindingConflict | null {
  if (source.entraTenantId && source.entraTenantId.toLowerCase() !== entraTenantId.toLowerCase()) {
    return "tenant_mismatch";
  }
  return takenByAnotherSource ? "tenant_already_connected" : null;
}

/** True when `error` (or its cause) is Postgres' unique violation on `constraint`. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === constraint) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/**
 * The consent error recorded on the source for a failed proof. Entra's and
 * Graph's own messages are kept for the operator; for the other reasons the
 * code says everything and the technical detail stays in the audit log.
 */
export function identityConsentError(
  reason: ConsentIdentityReason,
  detail: string | null,
  at: string,
): ConsentError {
  const keepsDetail = reason === "sign_in_failed" || reason === "role_check_failed";
  return { error: reason, description: keepsDetail ? detail : null, at };
}

/** Who consented, as stored in `consent_by`. */
export function consentingAdminLabel(
  admin: Pick<ConsentingAdmin, "username" | "objectId">,
): string {
  return admin.username ?? admin.objectId;
}

/** The public origin (settings row, else environment, else what the browser reported). */
export async function resolvePublicOrigin(
  db: DbExecutor,
  observed: string | null,
): Promise<string | null> {
  const [row] = await db.select({ publicUrl: settings.publicUrl }).from(settings).limit(1);
  const candidate = row?.publicUrl ?? processConfig.publicUrl ?? observed;
  if (!candidate) {
    return null;
  }
  try {
    return new URL(candidate).origin;
  } catch {
    return null;
  }
}

// --- Queries -----------------------------------------------------------------

/** Imported mailboxes per import source of the tenant (a source without any is absent). */
async function importedMailboxCounts(
  tx: DbExecutor,
  tenantId: string,
  sourceIds: readonly string[],
): Promise<Map<string, number>> {
  if (sourceIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ sourceId: protectedObjects.sourceId, n: count() })
    .from(protectedObjects)
    .where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        inArray(protectedObjects.sourceId, [...sourceIds]),
      ),
    )
    .groupBy(protectedObjects.sourceId);
  return new Map(rows.map((row) => [row.sourceId, row.n]));
}

export async function listSources(db: Database, tenantId: string): Promise<SourceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(sources)
      .where(eq(sources.tenantId, tenantId))
      .orderBy(asc(sources.name));
    const imported = await importedMailboxCounts(
      tx,
      tenantId,
      rows.filter((row) => row.kind === "import").map((row) => row.id),
    );
    return rows.map((row) => toDto(row, imported.get(row.id) ?? 0));
  });
}

async function findSource(tx: DbExecutor, tenantId: string, id: string): Promise<Source | null> {
  const [row] = await tx
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)))
    .limit(1);
  return row ?? null;
}

async function requireSource(tx: DbExecutor, tenantId: string, id: string): Promise<Source> {
  const row = await findSource(tx, tenantId, id);
  if (!row) {
    throw notFound();
  }
  return row;
}

export async function getSource(db: Database, tenantId: string, id: string): Promise<SourceDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const row = await requireSource(tx, tenantId, id);
    const imported = await importedMailboxCounts(tx, tenantId, row.kind === "import" ? [id] : []);
    return toDto(row, imported.get(id) ?? 0);
  });
}

/** What the UI needs before connecting a tenant: is the Entra app usable, which callback to register. */
export async function getEntraStatus(
  db: Database,
  observedOrigin: string | null,
): Promise<EntraAppStatus> {
  return entraAppStatus(await resolveEntraApp(), await resolvePublicOrigin(db, observedOrigin));
}

async function retainedData(tx: DbExecutor, sourceId: string): Promise<RetainedData> {
  const objects = tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .where(eq(protectedObjects.sourceId, sourceId));
  const [snapshotRow] = await tx
    .select({ n: count() })
    .from(snapshots)
    .where(inArray(snapshots.protectedObjectId, objects));
  // Journal reports assigned to the source's mailboxes count too (#32).
  const assigned = tx
    .select({ id: archiveItemMailboxes.archiveItemId })
    .from(archiveItemMailboxes)
    .where(inArray(archiveItemMailboxes.protectedObjectId, objects));
  const [archiveRow] = await tx
    .select({ n: count() })
    .from(archiveItems)
    .where(
      or(inArray(archiveItems.protectedObjectId, objects), inArray(archiveItems.id, assigned)),
    );
  const [holdRow] = await tx
    .select({ n: count() })
    .from(legalHolds)
    .where(inArray(legalHolds.protectedObjectId, objects));
  return {
    snapshots: snapshotRow?.n ?? 0,
    archiveItems: archiveRow?.n ?? 0,
    legalHolds: holdRow?.n ?? 0,
  };
}

// --- Create / update / delete ------------------------------------------------

async function nameTaken(
  tx: DbExecutor,
  tenantId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.tenantId, tenantId),
        eq(sources.name, name),
        exceptId ? ne(sources.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}

function nameConflict(name: string): ProblemError {
  return new ProblemError(409, "Source name already in use", {
    type: "urn:restow:problem:source-name-taken",
    detail: `A source named '${name}' already exists in this tenant.`,
    extensions: { name, field: "name" },
  });
}

export async function createSource(
  db: Database,
  tenantId: string,
  input: CreateSourceInput,
  actor: Actor,
): Promise<SourceDto> {
  // Judged before the transaction: it may ask the resolver.
  const privateNetworkApproval =
    input.kind === "imap" ? await approveImapHost(input.host, imapHostContext(actor)) : null;
  return withTenantTx(db, tenantId, async (tx) => {
    if (await nameTaken(tx, tenantId, input.name)) {
      throw nameConflict(input.name);
    }

    let values: typeof sources.$inferInsert;
    if (input.kind === "m365") {
      const cfg: SourceConfigExt = {
        // The directory feature's rule record (mode, groupId, exclude); it owns it from here on.
        scope: input.scope ?? { mode: "all", exclude: [] },
        entraTenantHint: input.entraTenantHint ?? null,
      };
      values = { tenantId, kind: "m365", name: input.name, status: "pending", config: cfg };
    } else {
      const mode = input.imapAuthMode;
      if (mode === "per_mailbox" && input.password !== undefined) {
        throw new ProblemError(422, "Validation failed", {
          detail:
            "Per-mailbox sources have no password of their own; set each mailbox's password separately.",
        });
      }
      if (mode === "master_user" && !input.masterUser) {
        throw new ProblemError(422, "Validation failed", {
          detail: "Master-user sources need the master account's login and login style.",
        });
      }
      if ((mode === "shared" || mode === "master_user") && input.password === undefined) {
        throw passwordRequired();
      }
      const secret =
        input.password !== undefined
          ? await storeSecret(tx, { tenantId, kind: "imap_password", plaintext: input.password })
          : null;
      const cfg: SourceConfigExt = {
        authKind: "password",
        privateNetworkApproval,
        imapAuthMode: mode,
        ...(input.masterUser ? { masterUser: input.masterUser } : {}),
      };
      values = {
        tenantId,
        kind: "imap",
        name: input.name,
        // per_mailbox has no source-level login to prove before it is usable
        // (see derivedStatus); it starts active, same as a freshly earned status.
        status: mode === "per_mailbox" ? "active" : "pending",
        host: input.host,
        port: input.port,
        security: input.security,
        username: input.username,
        secretRef: secret?.id ?? null,
        config: cfg,
      };
    }

    const [row] = await tx.insert(sources).values(values).returning();
    if (!row) {
      throw new Error("source insert returned no row");
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.created,
      target: row.id,
      targetType: "source",
      ip: actor.ip,
      details: {
        kind: row.kind,
        name: row.name,
        host: row.host ?? undefined,
        privateNetworkApproved: privateNetworkApproval ? true : undefined,
      },
    });
    return toDto(row);
  });
}

const IMAP_FIELDS = ["host", "port", "security", "username", "password"] as const;

export async function updateSource(
  db: Database,
  tenantId: string,
  id: string,
  patch: UpdateSourceInput,
  actor: Actor,
): Promise<SourceDto> {
  return withTenantTx(db, tenantId, async (tx) => {
    const current = await requireSource(tx, tenantId, id);
    if (current.kind === "import") {
      throw importSourceLocked();
    }
    if (patch.name !== undefined && (await nameTaken(tx, tenantId, patch.name, id))) {
      throw nameConflict(patch.name);
    }
    if (current.kind === "m365" && IMAP_FIELDS.some((field) => patch[field] !== undefined)) {
      throw new ProblemError(422, "Validation failed", {
        detail: "IMAP connection fields cannot be set on a Microsoft 365 source.",
      });
    }
    if (current.kind === "imap" && patch.entraTenantHint !== undefined) {
      throw new ProblemError(422, "Validation failed", {
        detail: "Entra fields cannot be set on an IMAP source.",
      });
    }

    const changes: Record<string, unknown> = {};
    const set: Partial<Record<keyof typeof sources.$inferInsert, unknown>> = {};
    const configPatch: Partial<SourceConfigExt> = {};

    if (patch.name !== undefined && patch.name !== current.name) {
      set.name = patch.name;
      changes.name = patch.name;
    }
    if (patch.entraTenantHint !== undefined) {
      configPatch.entraTenantHint = patch.entraTenantHint;
      changes.entraTenantHint = patch.entraTenantHint;
    }

    let connectionChanged = false;
    let nextImapAuthMode: ImapAuthMode | undefined;
    if (current.kind === "imap") {
      const next = {
        host: patch.host !== undefined && !sameHost(patch.host, current.host) ? patch.host : null,
        port: patch.port !== undefined && patch.port !== current.port ? patch.port : null,
        security:
          patch.security !== undefined && patch.security !== current.security
            ? patch.security
            : null,
        username:
          patch.username !== undefined && patch.username !== current.username
            ? patch.username
            : null,
      };
      const currentCfg = configOf(current);
      const currentMode: ImapAuthMode = currentCfg.imapAuthMode ?? "shared";
      const nextMode: ImapAuthMode = patch.imapAuthMode ?? currentMode;
      nextImapAuthMode = nextMode;
      // Gate on whether a source-level secret actually exists rather than on
      // `nextMode`: a per_mailbox source with no secret of its own may have
      // its host or username changed freely (nothing to protect), but a
      // shared/master_user source that still holds a stored password must
      // prove it again for a new endpoint even when the same patch also
      // moves it into per_mailbox. Gating on `nextMode` instead let the mode
      // switch itself dodge the guard while `secret_ref` kept pointing at
      // the old secret (mayReuseStoredPassword's invariant: a stored
      // password only ever travels to the host and account it was stored for).
      if (current.secretRef !== null && patchNeedsPassword(current, patch)) {
        throw passwordRequired();
      }
      if (nextMode === "per_mailbox" && current.secretRef !== null) {
        // Nothing in per_mailbox mode ever reads the source-level secret
        // again (every mailbox seals its own instead), so leaving it in
        // place would let a later patch back to shared/master_user reuse it
        // without a fresh password, as long as the host and username end up
        // matching again by then. Clear it the moment the source stops
        // needing it, rather than relying only on the guard above.
        await deleteSecret(tx, { id: current.secretRef, tenantId });
        set.secretRef = null;
        changes.sourceCredentialCleared = true;
      }
      const nextMasterUser =
        patch.masterUser === undefined ? (currentCfg.masterUser ?? null) : patch.masterUser;
      if (nextMode === "master_user" && !nextMasterUser) {
        throw new ProblemError(422, "Validation failed", {
          detail: "Master-user sources need the master account's login and login style.",
        });
      }
      if (nextMode === "per_mailbox" && patch.password !== undefined) {
        throw new ProblemError(422, "Validation failed", {
          detail:
            "Per-mailbox sources have no password of their own; set each mailbox's password separately.",
        });
      }
      if (
        (nextMode === "shared" || nextMode === "master_user") &&
        patch.password === undefined &&
        current.secretRef === null
      ) {
        throw passwordRequired();
      }
      if (
        patch.imapAuthMode !== undefined &&
        patch.imapAuthMode !== (currentCfg.imapAuthMode ?? "shared")
      ) {
        configPatch.imapAuthMode = patch.imapAuthMode;
        changes.imapAuthMode = patch.imapAuthMode;
        // A mode change alters how every mailbox authenticates; the last probe no
        // longer describes it, same as changing host, port or username.
        connectionChanged = true;
      }
      if (patch.masterUser !== undefined) {
        // `null` clears it (back to no master user); the config type has no
        // null variant since a fresh source never writes one, so this merge
        // patch is widened locally rather than loosening the shared type.
        (configPatch as Record<string, unknown>).masterUser = patch.masterUser;
        changes.masterUser = patch.masterUser ? "replaced" : null;
        connectionChanged = true;
      }
      if (next.host !== null || next.port !== null) {
        // A new endpoint is judged again; an approval covers only the endpoint it was given for.
        const approval = await approveImapHost(
          next.host ?? current.host ?? "",
          imapHostContext(actor),
        );
        configPatch.privateNetworkApproval = approval;
        if (approval) {
          changes.privateNetworkApproved = true;
        }
      }
      for (const [field, value] of Object.entries(next)) {
        if (value !== null) {
          set[field as keyof typeof next] = value;
          changes[field] = value;
          connectionChanged = true;
        }
      }
      const hostOrPortChanged = next.host !== null || next.port !== null;
      const leavingPerMailbox = currentMode === "per_mailbox" && nextMode !== "per_mailbox";
      if (
        (currentMode === "per_mailbox" || nextMode === "per_mailbox") &&
        (hostOrPortChanged || leavingPerMailbox)
      ) {
        // mayReuseStoredPassword's invariant (a stored password only ever
        // travels to the host it was sealed for) is enforced above for the
        // source-level secret, but per_mailbox has no source-level secret:
        // each mailbox seals its own. The same invariant must hold for those
        // too, and the reset must run on the host/port change itself,
        // whatever mode the same patch also carries (a mode change and a
        // host change can arrive together), and when the mode simply moves
        // away from per_mailbox, since nothing reads these secrets again
        // once it does (the risk requirePerMailboxObject's comment names).
        // Otherwise a two-step patch (change host/mode, then change it back)
        // could silently send a mailbox's password to a different endpoint
        // on the next backup, restore or test login. Each object goes back
        // to needing a fresh password and a fresh test.
        const perMailboxSecrets = await tx
          .select({ id: protectedObjects.id, secretRef: protectedObjects.secretRef })
          .from(protectedObjects)
          .where(
            and(
              eq(protectedObjects.tenantId, tenantId),
              eq(protectedObjects.sourceId, id),
              eq(protectedObjects.kind, "imap"),
            ),
          );
        for (const object of perMailboxSecrets) {
          if (object.secretRef) {
            await deleteSecret(tx, { id: object.secretRef, tenantId });
          }
        }
        if (perMailboxSecrets.length > 0) {
          await tx
            .update(protectedObjects)
            .set({
              secretRef: null,
              credentialStatus: null,
              credentialCheckedAt: null,
              credentialError: null,
              credentialFailure: null,
            })
            .where(
              and(
                eq(protectedObjects.tenantId, tenantId),
                eq(protectedObjects.sourceId, id),
                eq(protectedObjects.kind, "imap"),
              ),
            );
          changes.perMailboxCredentialsReset = perMailboxSecrets.length;
        }
      }
      if (patch.password !== undefined) {
        if (current.secretRef) {
          await replaceSecret(tx, { id: current.secretRef, tenantId }, patch.password);
        } else {
          const secret = await storeSecret(tx, {
            tenantId,
            kind: "imap_password",
            plaintext: patch.password,
          });
          set.secretRef = secret.id;
        }
        changes.password = "replaced";
        connectionChanged = true;
      }
      if (connectionChanged) {
        // The stored probe described the old connection; a new test is due.
        configPatch.lastProbe = null;
      }
    }

    const nextStatus = statusAfterPatch(current, patch.status, connectionChanged, nextImapAuthMode);
    if (nextStatus !== current.status) {
      set.status = nextStatus;
      changes.status = nextStatus;
      if (nextStatus !== "error") {
        set.errorMessage = null;
        set.failure = null;
      }
    }

    if (Object.keys(configPatch).length > 0) {
      set.config = mergeConfig(configPatch);
    }
    if (Object.keys(set).length === 0) {
      return toDto(current);
    }

    const [row] = await tx
      .update(sources)
      .set(set as Partial<typeof sources.$inferInsert>)
      .where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)))
      .returning();
    if (!row) {
      throw notFound();
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.updated,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: { kind: row.kind, changes, status: row.status },
    });
    return toDto(row);
  });
}

export async function deleteSource(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const current = await requireSource(tx, tenantId, id);
    const importedMailboxes =
      current.kind === "import"
        ? ((await importedMailboxCounts(tx, tenantId, [id])).get(id) ?? 0)
        : undefined;
    const blocked = retainedDataProblem(
      await retainedData(tx, id),
      current.kind,
      importedMailboxes,
    );
    if (blocked) {
      throw blocked;
    }
    // Collect before the delete: the source row cascades into its
    // protected_objects, and their own sealed per-mailbox passwords
    // (docs/IMAP.md) have no reference pointing back at them once that
    // happens, so they would otherwise sit in `secrets` forever as
    // unreferenced, still-decryptable credentials.
    const perMailboxSecrets =
      current.kind === "imap"
        ? await tx
            .select({ secretRef: protectedObjects.secretRef })
            .from(protectedObjects)
            .where(
              and(
                eq(protectedObjects.tenantId, tenantId),
                eq(protectedObjects.sourceId, id),
                eq(protectedObjects.kind, "imap"),
              ),
            )
        : [];
    await tx.delete(sources).where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)));
    if (current.secretRef) {
      await deleteSecret(tx, { id: current.secretRef, tenantId });
    }
    for (const object of perMailboxSecrets) {
      if (object.secretRef) {
        await deleteSecret(tx, { id: object.secretRef, tenantId });
      }
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.deleted,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: {
        kind: current.kind,
        name: current.name,
        ...(importedMailboxes !== undefined ? { importedMailboxes } : {}),
      },
    });
    if (current.entraTenantId) {
      forgetTokenProvider(current.entraTenantId);
    }
  });
}

// --- Microsoft 365: consent ---------------------------------------------------

/** The import source has no connection to edit, test or pause: it is created and managed by the imports. */
function importSourceLocked(): ProblemError {
  return new ProblemError(409, "Import source cannot be changed", {
    type: "urn:restow:problem:source-kind-mismatch",
    detail:
      "This source holds mail files that were imported by hand. It has no connection to edit, test or pause; delete it to remove it.",
  });
}

/**
 * Before anything that needs the Entra app or a network round trip: an import
 * source is refused with its own clear problem instead of a configuration error
 * about a connection it does not have. Unknown ids fall through to the caller.
 */
async function rejectImportSource(db: Database, tenantId: string, id: string): Promise<void> {
  const kind = await withTenantTx(
    db,
    tenantId,
    async (tx) => (await findSource(tx, tenantId, id))?.kind,
  );
  if (kind === "import") {
    throw importSourceLocked();
  }
}

function requireM365(row: Source): Source {
  if (row.kind !== "m365") {
    throw new ProblemError(409, "Not a Microsoft 365 source", {
      type: "urn:restow:problem:source-kind-mismatch",
      detail: "This action is only available for Microsoft 365 sources.",
    });
  }
  return row;
}

function requireImap(row: Source): Source {
  if (row.kind !== "imap") {
    throw new ProblemError(409, "Not an IMAP source", {
      type: "urn:restow:problem:source-kind-mismatch",
      detail: "This action is only available for IMAP sources.",
    });
  }
  return row;
}

/** Secret that signs consent states: the better-auth secret (required at startup), HKDF-separated. */
function consentStateSecret(): string {
  const secret = processConfig.betterAuthSecret;
  if (!secret) {
    throw new ProblemError(503, "Signing secret not configured", {
      detail: "BETTER_AUTH_SECRET is required to sign consent links.",
    });
  }
  return secret;
}

export async function createConsentLink(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
  options: { tenant?: string | null; observedOrigin: string | null },
): Promise<ConsentLinkDto> {
  await rejectImportSource(db, tenantId, id);
  const publicOrigin = await resolvePublicOrigin(db, options.observedOrigin);
  // The credentials are needed as well: the round trip ends with the sign-in
  // that proves the consenting tenant, and that code is redeemed as the app.
  const resolution = await resolveEntraApp();
  const problems = entraProblems(resolution, publicOrigin);
  if (problems.length > 0 || !publicOrigin || resolution.status !== "ready") {
    throw entraNotConfigured(problems);
  }
  const { clientId, authorityHost } = resolution.app.credentials;

  return withTenantTx(db, tenantId, async (tx) => {
    const source = requireM365(await requireSource(tx, tenantId, id));
    const cfg = configOf(source);
    if (cfg.ownApp) {
      throw ownAppSourceProblem();
    }
    const tenantHint = consentLinkTarget(source.entraTenantId, cfg.entraTenantHint, options.tenant);
    if (!source.entraTenantId && tenantHint !== (cfg.entraTenantHint ?? null)) {
      // Remember what the admin chose for the next link.
      await tx
        .update(sources)
        .set({ config: mergeConfig({ entraTenantHint: tenantHint }) })
        .where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)));
    }

    const redirectUri = adminConsentRedirectUri(publicOrigin);
    const { state, payload } = signConsentState(consentStateSecret(), {
      tenantId,
      sourceId: id,
    });
    const url = buildAdminConsentUrl({
      clientId,
      tenant: tenantHint,
      redirectUri,
      state,
      authorityHost,
    });
    const expiresAt = new Date(payload.expiresAt).toISOString();

    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.consentLinkCreated,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: { tenant: tenantHint, expiresAt },
    });
    return { url, redirectUri, expiresAt, tenant: tenantHint };
  });
}

/** Persist a verification result on the source; status follows the outcome unless paused. */
async function applyVerification(
  tx: DbExecutor,
  source: Source,
  verification: ConnectionVerification,
): Promise<Source> {
  const status: SourceStatus =
    source.status === "disabled" ? "disabled" : verification.ok ? "active" : "error";
  const [row] = await tx
    .update(sources)
    .set({
      permissionsVerified: toPermissionsVerified(verification),
      errorMessage: verificationSummary(verification),
      failure: causeToRecord(causeOfVerification(verification), new Date()),
      status,
      config: mergeConfig({ lastVerification: withoutUserSample(verification) }),
    })
    .where(and(eq(sources.tenantId, source.tenantId), eq(sources.id, source.id)))
    .returning();
  if (!row) {
    throw notFound();
  }
  return row;
}

/** Run the verification for a consented tenant; Entra/Graph problems are part of the result. */
async function runVerification(entraTenantId: string): Promise<ConnectionVerification> {
  return verifyTenantConnection({
    tokenProvider: tokenProviderFor(entraTenantId),
    graph: graphClientFor(entraTenantId),
  });
}

/** Verification with the source's own app when it has one, else the shared backup app. */
async function runSourceVerification(
  db: Database,
  source: Pick<Source, "id" | "tenantId" | "secretRef">,
  entraTenantId: string,
): Promise<ConnectionVerification> {
  const ref = {
    id: source.id,
    tenantId: source.tenantId,
    entraTenantId,
    secretRef: source.secretRef,
  };
  return verifyTenantConnection({
    tokenProvider: tokenProviderForSource(db, ref),
    graph: graphClientForSource(db, ref),
  });
}

function ownAppSourceProblem(): ProblemError {
  return new ProblemError(409, "Source uses its own app", {
    type: "urn:restow:problem:source-uses-own-app",
    detail:
      "This source is connected through an app of its own, so there is no consent link for it. Replace the app's credentials instead.",
  });
}

/**
 * Queue the source's first directory sync (idempotent: a sync already queued
 * or running is left alone) and audit it like a manual one, so a source that
 * just became usable starts populating its directory without waiting for the
 * next scheduled run. Best effort: a queueing problem here must not fail the
 * consent flow or a verification the admin is watching; the scheduled sync
 * (or a manual one) picks it up.
 */
export async function enqueueInitialDirectorySync(
  db: Database,
  tenantId: string,
  sourceId: string,
  actor: { label: string; userId?: string | null; ip: string | null },
): Promise<void> {
  try {
    await enqueueDirectorySync(db, tenantId, sourceId);
    await audit(db, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId ?? null,
      action: DIRECTORY_AUDIT_ACTIONS.syncRequested,
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: { full: false, auto: true },
    });
  } catch {
    // Nothing to recover: the scheduled sync (every DIRECTORY_FULL_SYNC_HOURS)
    // or a manual "Sync now" applies the directory just the same.
  }
}

/** Database handles the consent callback works with. */
export interface ConsentCallbackContext {
  /** The installation pool (BYPASSRLS), only for the cross-tenant ownership check. */
  installation: Database;
  /** The origin the browser reported, the fallback for the public origin. */
  observedOrigin: string | null;
}

/**
 * Whether another source anywhere in the installation holds `entraTenantId`.
 * Read on the installation pool, since the sources of other Restow tenants are
 * invisible under RLS; the answer is only yes or no, never whose.
 */
async function entraTenantBoundElsewhere(
  installation: Database,
  sourceId: string,
  entraTenantId: string,
): Promise<boolean> {
  const [other] = await installation
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.entraTenantId, entraTenantId.toLowerCase()), ne(sources.id, sourceId)))
    .limit(1);
  return other !== undefined;
}

/** Record a consent attempt that did not connect the source; an existing connection stays. */
async function recordConsentFailure(
  tx: DbExecutor,
  source: Pick<Source, "tenantId" | "id">,
  consentError: ConsentError,
  event: { action: string; ip: string | null; details: Record<string, unknown> },
): Promise<void> {
  await tx
    .update(sources)
    .set({ config: mergeConfig({ consentError }) })
    .where(and(eq(sources.tenantId, source.tenantId), eq(sources.id, source.id)));
  await audit(tx, {
    tenantId: source.tenantId,
    actor: CONSENT_CALLBACK_ACTOR,
    action: event.action,
    target: source.id,
    targetType: "source",
    ip: event.ip,
    details: event.details,
  });
}

/**
 * Write the proven binding. The update runs in a savepoint so that a clash
 * with the installation-wide unique index (another source took the Entra
 * tenant since the check) becomes a conflict the caller can record instead of
 * an aborted transaction.
 */
async function bindSource(
  tx: DbExecutor,
  source: Pick<Source, "tenantId" | "id">,
  admin: ConsentingAdmin,
  at: Date,
): Promise<BindingConflict | null> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint
        .update(sources)
        .set({
          entraTenantId: admin.tenantId,
          consentGrantedAt: at,
          consentBy: consentingAdminLabel(admin),
          config: mergeConfig({ consentError: null }),
        })
        .where(and(eq(sources.tenantId, source.tenantId), eq(sources.id, source.id)));
    });
    return null;
  } catch (error) {
    if (isUniqueViolation(error, ENTRA_TENANT_UNIQUE_INDEX)) {
      return "tenant_already_connected";
    }
    throw error;
  }
}

/** The app credentials and callback the proof sign-in needs, or null when the app is incomplete. */
async function signInPrerequisites(
  db: Database,
  observedOrigin: string | null,
): Promise<{ app: AppCredentials; redirectUri: string } | null> {
  const publicOrigin = await resolvePublicOrigin(db, observedOrigin);
  const resolution = await resolveEntraApp();
  if (
    !publicOrigin ||
    resolution.status !== "ready" ||
    entraProblems(resolution, publicOrigin).length > 0
  ) {
    return null;
  }
  return { app: resolution.app.credentials, redirectUri: adminConsentRedirectUri(publicOrigin) };
}

/**
 * First leg: Entra returns from the admin consent. Its `tenant` is only a
 * claim, so nothing is bound here. A decline is recorded; otherwise the
 * browser goes on to the sign-in that proves the claim, in that tenant.
 */
async function acceptAdminConsent(
  db: Database,
  state: ConsentStatePayload,
  query: URLSearchParams,
  requestIp: string | null,
  context: ConsentCallbackContext,
): Promise<ConsentCallbackOutcome> {
  const { tenantId, sourceId } = state;
  const callback = parseAdminConsentCallback(query);
  const prerequisites = await signInPrerequisites(db, context.observedOrigin);
  const claimedElsewhere = callback.ok
    ? await entraTenantBoundElsewhere(context.installation, sourceId, callback.claimedTenantId)
    : false;

  return withTenantTx(db, tenantId, async (tx): Promise<ConsentCallbackOutcome> => {
    const source = await findSource(tx, tenantId, sourceId);
    if (!source || source.kind !== "m365") {
      return { kind: "unknown_source" };
    }
    const at = new Date().toISOString();

    if (!callback.ok) {
      await recordConsentFailure(
        tx,
        source,
        { error: callback.error, description: callback.errorDescription, at },
        {
          action: SOURCE_AUDIT_ACTIONS.consentDenied,
          ip: requestIp,
          details: { error: callback.error, description: callback.errorDescription },
        },
      );
      return { kind: "denied", tenantId, sourceId, error: callback.error };
    }

    const claimed = callback.claimedTenantId;
    const reject = (reason: BindingConflict | "app_not_configured") =>
      recordConsentFailure(
        tx,
        source,
        { error: reason, description: null, at },
        {
          action: SOURCE_AUDIT_ACTIONS.consentRejected,
          ip: requestIp,
          details: { reason, claimedEntraTenantId: claimed },
        },
      );

    // Conflicts are reported before the admin signs in again; the binding
    // itself re-checks them against the proven tenant.
    const conflict = bindingConflict(source, claimed, claimedElsewhere);
    if (conflict) {
      await reject(conflict);
      return { kind: conflict, tenantId, sourceId, entraTenantId: claimed };
    }
    if (!prerequisites) {
      await reject("app_not_configured");
      return { kind: "identity_not_verified", tenantId, sourceId, reason: "app_not_configured" };
    }

    const signIn = signConsentState(consentStateSecret(), {
      tenantId,
      sourceId,
      phase: "signin",
      entraTenantId: claimed,
    });
    await audit(tx, {
      tenantId,
      actor: CONSENT_CALLBACK_ACTOR,
      action: SOURCE_AUDIT_ACTIONS.consentSignInStarted,
      target: sourceId,
      targetType: "source",
      ip: requestIp,
      details: { claimedEntraTenantId: claimed, scope: callback.scope },
    });
    return {
      kind: "sign_in_required",
      url: buildConsentSignInUrl({
        clientId: prerequisites.app.clientId,
        tenantId: claimed,
        redirectUri: prerequisites.redirectUri,
        state: signIn.state,
        nonce: signIn.payload.nonce,
        authorityHost: prerequisites.app.authorityHost,
      }),
    };
  });
}

type ProofResult =
  | ConsentIdentityProof
  | { ok: false; reason: "app_not_configured"; detail: string | null; account: null };

/** Redeem the sign-in and establish who signed in, in which tenant, with which role. */
async function proveConsent(
  db: Database,
  state: ConsentStatePayload & { entraTenantId: string },
  query: URLSearchParams,
  observedOrigin: string | null,
): Promise<ProofResult> {
  const callback = parseConsentSignInCallback(query);
  if (!callback.ok) {
    const detail = callback.errorDescription
      ? `${callback.error}: ${callback.errorDescription}`
      : callback.error;
    return { ok: false, reason: "sign_in_failed", detail, account: null };
  }
  const prerequisites = await signInPrerequisites(db, observedOrigin);
  if (!prerequisites) {
    return { ok: false, reason: "app_not_configured", detail: null, account: null };
  }
  const entraTenantId = state.entraTenantId;
  try {
    return await proveConsentingAdmin({
      app: prerequisites.app,
      tenantId: entraTenantId,
      code: callback.code,
      redirectUri: prerequisites.redirectUri,
      nonce: state.nonce,
      graph: graphClientFor(entraTenantId),
      // A token fetched a moment after the consent may not carry the roles yet.
      onRoleLookupRetry: () => tokenProviderFor(entraTenantId).invalidate(),
    });
  } catch (error) {
    if (error instanceof ProblemError) {
      // The registration became unusable meanwhile: an operator problem, not the admin's.
      return {
        ok: false,
        reason: "app_not_configured",
        detail: error.detail ?? null,
        account: null,
      };
    }
    throw error;
  }
}

/**
 * Second leg: the consenting admin signed in. Only now, and only to the tenant
 * the id_token proves (checked against the claim the signed state carries),
 * is the source bound.
 */
async function completeConsentSignIn(
  db: Database,
  state: ConsentStatePayload & { entraTenantId: string },
  query: URLSearchParams,
  requestIp: string | null,
  context: ConsentCallbackContext,
): Promise<ConsentResult> {
  const { tenantId, sourceId } = state;
  const proof = await proveConsent(db, state, query, context.observedOrigin);
  const provenElsewhere = proof.ok
    ? await entraTenantBoundElsewhere(context.installation, sourceId, proof.admin.tenantId)
    : false;

  const outcome = await withTenantTx(db, tenantId, async (tx): Promise<ConsentResult> => {
    const source = await findSource(tx, tenantId, sourceId);
    if (!source || source.kind !== "m365") {
      return { kind: "unknown_source" };
    }
    const at = new Date();

    if (!proof.ok) {
      await recordConsentFailure(
        tx,
        source,
        identityConsentError(proof.reason, proof.detail, at.toISOString()),
        {
          action: SOURCE_AUDIT_ACTIONS.consentRejected,
          ip: requestIp,
          details: {
            reason: proof.reason,
            detail: proof.detail,
            claimedEntraTenantId: state.entraTenantId,
            account: proof.account,
          },
        },
      );
      return { kind: "identity_not_verified", tenantId, sourceId, reason: proof.reason };
    }

    const admin = proof.admin;
    const conflict =
      bindingConflict(source, admin.tenantId, provenElsewhere) ??
      (await bindSource(tx, source, admin, at));
    if (conflict) {
      await recordConsentFailure(
        tx,
        source,
        { error: conflict, description: null, at: at.toISOString() },
        {
          action: SOURCE_AUDIT_ACTIONS.consentRejected,
          ip: requestIp,
          details: {
            reason: conflict,
            entraTenantId: admin.tenantId,
            consentBy: consentingAdminLabel(admin),
          },
        },
      );
      return { kind: conflict, tenantId, sourceId, entraTenantId: admin.tenantId };
    }
    await audit(tx, {
      tenantId,
      actor: CONSENT_CALLBACK_ACTOR,
      action: SOURCE_AUDIT_ACTIONS.consentGranted,
      target: sourceId,
      targetType: "source",
      ip: requestIp,
      details: {
        entraTenantId: admin.tenantId,
        consentBy: consentingAdminLabel(admin),
        consentByObjectId: admin.objectId,
      },
    });
    return { kind: "granted", tenantId, sourceId, verification: null };
  });

  if (outcome.kind !== "granted" || !proof.ok) {
    return outcome;
  }

  // The binding succeeded: queue the first directory sync regardless of how
  // the verification below turns out, so the mailbox/OneDrive list starts
  // filling in even if Graph is momentarily unhappy about a permission.
  await enqueueInitialDirectorySync(db, tenantId, sourceId, {
    label: CONSENT_CALLBACK_ACTOR,
    ip: requestIp,
  });

  // Verify right away so the admin sees green/red on landing. Failures here
  // are recorded on the source, never surfaced as a broken callback.
  const entraTenantId = proof.admin.tenantId;
  try {
    const verification = await runVerification(entraTenantId);
    await withTenantTx(db, tenantId, async (tx) => {
      const source = await findSource(tx, tenantId, sourceId);
      if (!source) {
        return;
      }
      await applyVerification(tx, source, verification);
      await audit(tx, {
        tenantId,
        actor: CONSENT_CALLBACK_ACTOR,
        action: SOURCE_AUDIT_ACTIONS.verified,
        target: sourceId,
        targetType: "source",
        ip: requestIp,
        details: { ok: verification.ok, missing: verification.permissions?.missing ?? [] },
      });
    });
    return { ...outcome, verification };
  } catch {
    return outcome;
  }
}

/**
 * Handle a redirect from Entra to the consent callback. Public: the signed
 * state is the only credential, and it names the leg it belongs to — the
 * admin consent, or the sign-in that proves who gave it. Rejections are
 * recorded on the source (`config.consentError`) so the admin who started the
 * flow sees them while the page polls.
 */
export async function handleConsentCallback(
  db: Database,
  query: URLSearchParams,
  requestIp: string | null,
  context: ConsentCallbackContext,
): Promise<ConsentCallbackOutcome> {
  const rawState = query.get("state");
  if (!rawState) {
    return { kind: "invalid_state", reason: "missing" };
  }
  const verified = verifyConsentState(consentStateSecret(), rawState);
  if (!verified.ok) {
    return { kind: "invalid_state", reason: verified.reason };
  }
  const state = verified.payload;
  if (state.phase === "signin" && state.entraTenantId) {
    return completeConsentSignIn(
      db,
      { ...state, entraTenantId: state.entraTenantId },
      query,
      requestIp,
      context,
    );
  }
  return acceptAdminConsent(db, state, query, requestIp, context);
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function tenantConflictProblem(conflict: BindingConflict): ProblemError {
  return new ProblemError(409, "Tenant cannot be connected", {
    type: `urn:restow:problem:${conflict.replaceAll("_", "-")}`,
    detail:
      conflict === "tenant_already_connected"
        ? "This Microsoft 365 tenant is already connected to another source."
        : "This source is connected to a different Microsoft 365 tenant.",
  });
}

/**
 * Connect the app's own tenant (the home tenant of the registration) without an admin
 * consent round trip: the app already lives there, so there is nothing to consent to and no
 * second party to prove. A working token for that tenant is the proof. Restricted to provider
 * admins and to the home tenant the provider configured, so a tenant admin can never bind a
 * foreign Entra tenant this way.
 */
export async function connectOwnTenant(
  db: Database,
  installation: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<VerifyResultDto> {
  await rejectImportSource(db, tenantId, id);
  const resolution = await resolveEntraApp();
  const problems = entraCredentialProblems(resolution);
  if (problems.length > 0 || resolution.status !== "ready") {
    throw entraNotConfigured(problems);
  }
  if (!actor.isProviderAdmin) {
    throw new ProblemError(403, "Provider role required", {
      type: "urn:restow:problem:own-tenant-provider-only",
      detail: "Only a provider admin can connect the tenant the backup app lives in.",
    });
  }
  const homeTenantId = resolution.app.homeTenantId?.trim().toLowerCase() ?? null;
  if (!homeTenantId || !GUID.test(homeTenantId)) {
    // A domain would be stored as the binding and slip past the uniqueness check, which
    // compares tenant ids: only the GUID of the directory is accepted here.
    throw new ProblemError(409, "Home tenant unknown", {
      type: "urn:restow:problem:own-tenant-unknown",
      detail:
        "The backup app has no home tenant ID (GUID) set. Enter the directory (tenant) ID of the app under Settings, Microsoft 365, or use the consent link.",
    });
  }
  const source = await withTenantTx(db, tenantId, async (tx) =>
    requireM365(await requireSource(tx, tenantId, id)),
  );
  if (configOf(source).ownApp) {
    throw ownAppSourceProblem();
  }
  if (source.entraTenantId) {
    throw new ProblemError(409, "Already connected", {
      type: "urn:restow:problem:own-tenant-already-connected",
      detail: "This source is already connected to a Microsoft 365 tenant.",
    });
  }
  const hint = configOf(source).entraTenantHint?.trim().toLowerCase() || null;
  if (hint && hint !== homeTenantId) {
    throw new ProblemError(409, "Not the home tenant", {
      type: "urn:restow:problem:own-tenant-mismatch",
      detail: "The tenant ID of this source is not the tenant the backup app lives in.",
    });
  }
  const conflict = bindingConflict(
    source,
    homeTenantId,
    await entraTenantBoundElsewhere(installation, id, homeTenantId),
  );
  if (conflict) {
    throw tenantConflictProblem(conflict);
  }

  const verification = await runVerification(homeTenantId);
  if (!verification.tokenAcquired) {
    throw new ProblemError(409, "Backup app not usable in this tenant", {
      type: "urn:restow:problem:own-tenant-no-token",
      detail:
        verification.tokenError?.message ??
        "The backup app could not sign in to its own tenant. Use the consent link instead.",
    });
  }

  const updated = await withTenantTx(db, tenantId, async (tx) => {
    const fresh = await requireSource(tx, tenantId, id);
    // Verification took a network round trip: a consent may have bound the source meanwhile.
    if (fresh.entraTenantId) {
      throw new ProblemError(409, "Already connected", {
        type: "urn:restow:problem:own-tenant-already-connected",
        detail: "This source is already connected to a Microsoft 365 tenant.",
      });
    }
    const taken = await bindSource(
      tx,
      fresh,
      {
        tenantId: homeTenantId,
        objectId: actor.id,
        username: `${actor.email} (own tenant)`,
        name: null,
        roleTemplateIds: null,
      },
      new Date(),
    );
    if (taken) {
      throw tenantConflictProblem(taken);
    }
    const row = await applyVerification(tx, await requireSource(tx, tenantId, id), verification);
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.ownTenantConnected,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: {
        entraTenantId: homeTenantId,
        ok: verification.ok,
        missing: verification.permissions?.missing ?? [],
      },
    });
    return row;
  });
  await enqueueInitialDirectorySync(db, tenantId, id, {
    label: actor.email,
    userId: actor.id,
    ip: actor.ip,
  });
  return { source: toDto(updated), verification };
}

/**
 * Connect a source through a Graph app of the customer's own, created by hand in the
 * customer's tenant (docs/ENTRA-SETUP.md, "Your own app per source"), instead of the
 * admin-consent round trip with the shared backup app. Whoever holds a working credential
 * for an app in that tenant is the proof: the token request is answered by that tenant
 * only. The credential is sealed in the tenant's secret store; the source keeps only the
 * public facts. Calling it again replaces the credential (rotation) for the same tenant.
 */
export async function connectOwnApp(
  db: Database,
  installation: Database,
  tenantId: string,
  id: string,
  actor: Actor,
  input: SourceAppFormInput,
): Promise<VerifyResultDto> {
  await rejectImportSource(db, tenantId, id);
  const built = buildSourceApp(input);
  if (!built.ok) {
    throw new ProblemError(422, "Invalid app details", {
      type: "urn:restow:problem:own-app-invalid",
      detail: `The app details are not usable (${built.problem}).`,
      extensions: { field: built.problem },
    });
  }
  const source = await withTenantTx(db, tenantId, async (tx) =>
    requireM365(await requireSource(tx, tenantId, id)),
  );
  const conflict = bindingConflict(
    source,
    built.tenantId,
    await entraTenantBoundElsewhere(installation, id, built.tenantId),
  );
  if (conflict) {
    throw tenantConflictProblem(conflict);
  }

  const provider = new ClientCredentialsTokenProvider({
    tenantId: built.tenantId,
    app: built.credentials,
  });
  const verification = await verifyTenantConnection({
    tokenProvider: provider,
    graph: new FetchGraphClient({ accessTokenProvider: () => provider.getToken() }),
  });
  if (!verification.tokenAcquired) {
    throw new ProblemError(409, "The app could not sign in", {
      type: "urn:restow:problem:own-app-no-token",
      detail:
        verification.tokenError?.message ??
        "Microsoft did not issue a token for this app in this tenant.",
      extensions: { hint: verification.tokenError?.hint ?? null },
    });
  }

  const at = new Date();
  const updated = await withTenantTx(db, tenantId, async (tx) => {
    const fresh = await requireSource(tx, tenantId, id);
    // Verification took a network round trip: re-check the binding against the fresh row.
    const raced = bindingConflict(fresh, built.tenantId, false);
    if (raced) {
      throw tenantConflictProblem(raced);
    }
    const plaintext = serializeSourceAppDocument(built.document);
    let secretRef = fresh.secretRef;
    if (secretRef) {
      await replaceSecret(tx, { id: secretRef, tenantId }, plaintext);
    } else {
      secretRef = (await storeSecret(tx, { tenantId, kind: SOURCE_APP_SECRET_KIND, plaintext })).id;
    }
    const info: OwnAppInfo = {
      clientId: built.document.clientId,
      credentialKind: built.document.credentialKind,
      authorityHost: built.document.authorityHost,
      updatedAt: at.toISOString(),
      updatedBy: actor.email,
    };
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .update(sources)
          .set({
            entraTenantId: built.tenantId,
            secretRef,
            consentGrantedAt: fresh.consentGrantedAt ?? at,
            consentBy: `${actor.email} (own app)`,
            config: mergeConfig({ ownApp: info, consentError: null }),
          })
          .where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)));
      });
    } catch (error) {
      if (isUniqueViolation(error, ENTRA_TENANT_UNIQUE_INDEX)) {
        throw tenantConflictProblem("tenant_already_connected");
      }
      throw error;
    }
    const row = await applyVerification(tx, await requireSource(tx, tenantId, id), verification);
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.ownAppConnected,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: {
        entraTenantId: built.tenantId,
        clientId: info.clientId,
        credentialKind: info.credentialKind,
        ok: verification.ok,
        missing: verification.permissions?.missing ?? [],
      },
    });
    return row;
  });
  forgetSourceProviders(id);
  await enqueueInitialDirectorySync(db, tenantId, id, {
    label: actor.email,
    userId: actor.id,
    ip: actor.ip,
  });
  return { source: toDto(updated), verification };
}

/** "Verify permissions": token, permission diff and a first Graph call, stored on the source. */
export async function verifySource(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<VerifyResultDto> {
  await rejectImportSource(db, tenantId, id);
  const source = await withTenantTx(db, tenantId, async (tx) =>
    requireM365(await requireSource(tx, tenantId, id)),
  );
  // A source with an app of its own does not depend on the shared registration.
  const problems = configOf(source).ownApp ? [] : entraCredentialProblems(await resolveEntraApp());
  if (problems.length > 0) {
    throw entraNotConfigured(problems);
  }
  if (!source.entraTenantId) {
    throw new ProblemError(409, "Admin consent required", {
      type: "urn:restow:problem:consent-required",
      detail: "Connect the Microsoft 365 tenant through the admin-consent link first.",
    });
  }

  const verification = await runSourceVerification(db, source, source.entraTenantId);
  const updated = await withTenantTx(db, tenantId, async (tx) => {
    const fresh = await requireSource(tx, tenantId, id);
    const row = await applyVerification(tx, fresh, verification);
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.verified,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: {
        ok: verification.ok,
        tokenError: verification.tokenError?.hint,
        missing: verification.permissions?.missing ?? [],
        readOnlyInstead: verification.permissions?.readOnlyInstead ?? [],
        testCallOk: verification.testCall?.ok ?? null,
        usersSampled: verification.testCall?.ok ? verification.testCall.usersSampled : undefined,
      },
    });
    return row;
  });
  // A source that just turned green and has never run a directory sync gets
  // its first one now, instead of waiting up to DIRECTORY_FULL_SYNC_HOURS.
  if (verification.ok && readDirectoryState(updated.config).lastRun === null) {
    await enqueueInitialDirectorySync(db, tenantId, id, {
      label: actor.email,
      userId: actor.id,
      ip: actor.ip,
    });
  }
  return { source: toDto(updated), verification };
}

// --- IMAP: test connection ----------------------------------------------------

/**
 * Probe a connection from the form, before anything is saved. Without a typed
 * password the stored one of `sourceId` is used — only for its own host and
 * username. Nothing is recorded on the source; the attempt is audited.
 */
export async function testImapConnection(
  db: Database,
  tenantId: string,
  input: ImapTestInput,
  actor: Actor,
): Promise<ImapProbeResult> {
  const sourceId = input.sourceId;
  const stored =
    sourceId === undefined
      ? null
      : await withTenantTx(db, tenantId, async (tx) =>
          requireImap(await requireSource(tx, tenantId, sourceId)),
        );
  let password = input.password ?? null;
  if (password === null && stored !== null) {
    if (!mayReuseStoredPassword(stored, input) || !stored.secretRef) {
      throw passwordRequired();
    }
    password = await readSecret(db, { id: stored.secretRef, tenantId });
  }
  if (!password) {
    throw passwordRequired();
  }

  const probe = await probeImapConnection(
    {
      host: input.host,
      port: input.port,
      security: input.security,
      username: input.username,
      password,
    },
    {
      allowPrivateNetworks: probeMayReachPrivateNetworks(
        imapHostContext(actor),
        stored && { host: stored.host, port: stored.port, config: configOf(stored) },
        input,
      ),
    },
  );
  await audit(db, {
    tenantId,
    actor: actor.email,
    actorUserId: actor.id,
    action: SOURCE_AUDIT_ACTIONS.imapProbed,
    targetType: input.sourceId ? "source" : "imap",
    target: input.sourceId ?? `${input.username}@${input.host}:${input.port}`,
    ip: actor.ip,
    details: {
      host: input.host,
      port: input.port,
      security: input.security,
      storedPassword: input.password === undefined,
      ok: probe.ok,
      reason: probe.ok ? undefined : probe.reason,
    },
  });
  return probe;
}

/** 409 raised when a per_mailbox source is asked for a source-level test it cannot run. */
function perMailboxHasNoSourceLogin(): ProblemError {
  return new ProblemError(409, "Per-mailbox source has no login of its own", {
    type: "urn:restow:problem:source-per-mailbox",
    detail:
      "This source has no password of its own; every mailbox authenticates with its own password. Test each one from the accounts list instead.",
  });
}

/** One protected object of this IMAP source, to prove a master-user login the way a backup would use it. */
async function sampleImapAccount(
  db: Database,
  tenantId: string,
  sourceId: string,
): Promise<{ externalId: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ externalId: protectedObjects.externalId })
      .from(protectedObjects)
      .where(
        and(
          eq(protectedObjects.tenantId, tenantId),
          eq(protectedObjects.sourceId, sourceId),
          eq(protectedObjects.kind, "imap"),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Probe a stored IMAP source with its stored credentials and record the
 * outcome. `per_mailbox` sources have no login of their own ({@link
 * perMailboxHasNoSourceLogin}); `master_user` sources are tested with the
 * real master login shape, impersonating one of the source's own mailboxes
 * when one already exists, so the result proves what the worker will
 * actually do rather than a bare master login Dovecot may refuse outright.
 * Without a sample mailbox yet, the bare master login is tried as a weaker
 * connectivity check; the per-mailbox "Test login" stays the authoritative
 * proof either way (docs/IMAP.md).
 */
export async function testSource(
  db: Database,
  tenantId: string,
  id: string,
  actor: Actor,
): Promise<TestResultDto> {
  const source = await withTenantTx(db, tenantId, async (tx) =>
    requireImap(await requireSource(tx, tenantId, id)),
  );
  const cfg = configOf(source);
  const mode: ImapAuthMode = cfg.imapAuthMode ?? "shared";
  if (mode === "per_mailbox") {
    throw perMailboxHasNoSourceLogin();
  }
  const password = source.secretRef
    ? await readSecret(db, { id: source.secretRef, tenantId })
    : null;
  if (!password || !source.host || !source.port || !source.security || !source.username) {
    throw new ProblemError(409, "IMAP source incomplete", {
      type: "urn:restow:problem:source-incomplete",
      detail: "The source has no stored password or connection details; edit it first.",
    });
  }
  let sampleExternalId: string | null = null;
  let loginUsername = source.username;
  let authzid: string | undefined;
  if (mode === "master_user") {
    const masterUser = cfg.masterUser;
    if (!masterUser?.username) {
      throw new ProblemError(409, "IMAP source incomplete", {
        type: "urn:restow:problem:source-incomplete",
        detail: "The master account's login shape is not configured yet; edit it first.",
      });
    }
    const sample = await sampleImapAccount(db, tenantId, id);
    sampleExternalId = sample?.externalId ?? null;
    if (sample && masterUser.style === "sasl_authzid") {
      loginUsername = masterUser.username;
      authzid = sample.externalId;
    } else if (sample) {
      loginUsername = `${masterUser.username}${masterUser.separator ?? "*"}${sample.externalId}`;
    } else {
      loginUsername = masterUser.username;
    }
  }
  const input: ImapProbeInput = {
    host: source.host,
    port: source.port,
    security: source.security,
    username: loginUsername,
    password,
    ...(authzid ? { authzid } : {}),
  };
  // The stored endpoint is tested exactly as the worker will connect to it.
  const probe = await probeImapConnection(input, {
    allowPrivateNetworks: storedHostMayBePrivate(
      configOf(source),
      processConfig.imapAllowPrivateNetworks,
    ),
  });

  const updated = await withTenantTx(db, tenantId, async (tx) => {
    const fresh = await requireSource(tx, tenantId, id);
    const status: SourceStatus =
      fresh.status === "disabled" ? "disabled" : probe.ok ? "active" : "error";
    const [row] = await tx
      .update(sources)
      .set({
        status,
        errorMessage: probeSummary(probe),
        failure: causeToRecord(
          causeOfImapProbe(probe, { host: fresh.host, port: fresh.port }),
          new Date(),
        ),
        config: mergeConfig({ lastProbe: probe }),
      })
      .where(and(eq(sources.tenantId, tenantId), eq(sources.id, id)))
      .returning();
    if (!row) {
      throw notFound();
    }
    await audit(tx, {
      tenantId,
      actor: actor.email,
      actorUserId: actor.id,
      action: SOURCE_AUDIT_ACTIONS.tested,
      target: id,
      targetType: "source",
      ip: actor.ip,
      details: {
        ok: probe.ok,
        reason: probe.ok ? undefined : probe.reason,
        secure: probe.ok ? probe.secure : undefined,
        authMode: mode,
        impersonatedSample: mode === "master_user" ? sampleExternalId !== null : undefined,
      },
    });
    return row;
  });
  return { source: toDto(updated), probe };
}
