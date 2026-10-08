/**
 * Typed fetch client for the Restow REST API (`apps/api`, mounted at
 * `/api/v1`). This is the single place that knows about transport concerns:
 * base URL, cookies, the active-tenant header and the RFC 7807 error shape.
 * Components call the typed helpers and TanStack Query wraps them.
 */

import { queryOptions } from "@tanstack/react-query";

import { getActiveTenantId } from "@/lib/tenant";

const rawBaseUrl = import.meta.env.VITE_API_URL as string | undefined;
const API_BASE_URL = (rawBaseUrl ?? "/api/v1").replace(/\/+$/, "");

/** The OpenAPI description of the integration API (served by the API without a session). */
export const OPENAPI_DOCUMENT_URL = `${API_BASE_URL}/openapi.json`;

/** Header carrying the tenant a request is scoped to (see the spine contract). */
export const TENANT_HEADER = "X-Restow-Tenant";

/** RFC 7807 problem details as returned by the API on every error. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/** Error thrown for any non-2xx response, carrying status and problem body. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null, fallbackMessage: string) {
    super(problem?.detail ?? problem?.title ?? fallbackMessage);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

/** Thrown when the API cannot be reached at all (DNS, connection, CORS). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("The API is not reachable");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

/**
 * The demo guard's problem type (apps/api middleware/demo-guard.ts): a change
 * a public demo visitor is not offered. Checked first so every existing
 * `common:${errorMessageKey(error)}` call site (toasts, inline form errors)
 * shows the friendly demo message without each feature mapping it itself.
 */
export const DEMO_READ_ONLY_PROBLEM = "urn:restow:problem:demo-read-only";

/**
 * A provider admin's team role or tenant scope does not cover the request
 * (apps/api middleware/session.ts `assertProviderRoute`); `reason` tells which.
 */
export const PROVIDER_ROLE_PROBLEM = "urn:restow:problem:provider-role-required";

/**
 * Problem types of a request for a gated core feature (see {@link GatedFeature})
 * that this installation does not enable. The core answers
 * `feature-unavailable`; a server extension may answer with its own type for
 * the same refusal (`edition-required`). The UI words both the same neutral way.
 */
export const FEATURE_UNAVAILABLE_PROBLEMS: ReadonlySet<string> = new Set([
  "urn:restow:problem:feature-unavailable",
  "urn:restow:problem:edition-required",
]);

/** Whether a failed request was refused because the feature is not enabled here. */
export function isFeatureUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.problem !== null &&
    FEATURE_UNAVAILABLE_PROBLEMS.has(error.problem.type)
  );
}

/** Map an unknown thrown value to the i18n key (in `common`) describing it. */
export function errorMessageKey(error: unknown): string {
  if (error instanceof NetworkError) {
    return "errors.network";
  }
  if (error instanceof ApiError) {
    if (error.problem?.type === DEMO_READ_ONLY_PROBLEM) {
      return "errors.demoReadOnly";
    }
    if (isFeatureUnavailable(error)) {
      return "errors.featureUnavailable";
    }
    if (error.problem?.type === PROVIDER_ROLE_PROBLEM) {
      return (error.problem as { reason?: unknown }).reason === "scope"
        ? "errors.providerScope"
        : "errors.providerRole";
    }
    // A gateway in front of a stopped API answers 502/503/504: same story
    // for the operator as a refused connection.
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return "errors.network";
    }
    if (error.status === 401) return "errors.unauthorized";
    if (error.status === 403) return "errors.forbidden";
    if (error.status === 404) return "errors.notFound";
    if (error.status === 409) return "errors.conflict";
    if (error.status === 400 || error.status === 422) return "errors.validation";
    if (error.status >= 500) return "errors.server";
  }
  return "errors.generic";
}

async function readProblem(response: Response): Promise<ProblemDetails | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    return null;
  }
  try {
    const body = (await response.json()) as Partial<ProblemDetails>;
    if (typeof body !== "object" || body === null) {
      return null;
    }
    return {
      type: typeof body.type === "string" ? body.type : "about:blank",
      title: typeof body.title === "string" ? body.title : response.statusText,
      status: typeof body.status === "number" ? body.status : response.status,
      ...body,
    };
  } catch {
    return null;
  }
}

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  /** JSON-serialisable body; encoded and typed for you. */
  body?: unknown;
  /** Override the tenant header for this call (`null` sends none). */
  tenantId?: string | null;
}

/** Perform a JSON request against `/api/v1` and decode the response body. */
export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { body, tenantId, headers: extraHeaders, ...rest } = init;
  const headers = new Headers(extraHeaders);
  headers.set("accept", "application/json");
  if (body !== undefined) {
    headers.set("content-type", "application/json");
  }
  // Texts the server writes for the operator (test mails) follow the UI
  // language, which i18n.ts mirrors into <html lang>.
  const language = typeof document === "undefined" ? "" : document.documentElement.lang;
  if (language && !headers.has("accept-language")) {
    headers.set("accept-language", language);
  }

  const tenant = tenantId === undefined ? getActiveTenantId() : tenantId;
  if (tenant) {
    headers.set(TENANT_HEADER, tenant);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      credentials: "include",
      ...rest,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

  if (!response.ok) {
    const problem = await readProblem(response);
    throw new ApiError(
      response.status,
      problem,
      `Request to ${path} failed with status ${response.status}`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

// --- Contract types -----------------------------------------------------------

export type OperatingMode = "local" | "public";
export type MailTransport = "smtp" | "graph" | "google";
export type SmtpSecurity = "starttls" | "tls" | "none";
export type Role = "provider_admin" | "tenant_admin" | "tenant_user";
export type TenantRole = Exclude<Role, "provider_admin">;

export type PasskeyReadyReason =
  | "mode_not_public"
  | "no_public_url"
  | "not_https"
  | "origin_mismatch";

/**
 * Whether WebAuthn may be offered. The API derives it from the operating mode,
 * public URL and the origin the browser reports (docs/ARCHITECTURE.md, setup and
 * operating modes); the UI shows the reasons instead of hiding them.
 */
export interface PasskeyReady {
  ready: boolean;
  reasons: PasskeyReadyReason[];
  rpId: string | null;
  origin: string | null;
}

export interface DisclaimerState {
  version: string;
  accepted: boolean;
}

/** What accepting the notice answers with. */
export interface DisclaimerAcceptance {
  version: string;
  accepted: true;
  acceptedAt: string;
}

/** Problem types of the operator responsibility notice (apps/api lib/disclaimer.ts). */
export const DISCLAIMER_REQUIRED_PROBLEM = "urn:restow:problem:disclaimer-required";
export const DISCLAIMER_VERSION_PROBLEM = "urn:restow:problem:disclaimer-version-mismatch";

/** Problem type of a setup call without the right setup token (apps/api lib/setup-token.ts). */
export const SETUP_TOKEN_PROBLEM = "urn:restow:problem:setup-token-invalid";

/** The header the wizard sends the setup token in. */
export const SETUP_TOKEN_HEADER = "X-Restow-Setup-Token";

export interface SetupState {
  configured: boolean;
  /**
   * The product name to show (the branding, `RESTOW_PRODUCT_NAME` on the
   * server). Applied to every text through `lib/branding.ts`.
   */
  productName: string;
  operatingMode: OperatingMode | null;
  publicUrl: string | null;
  passkeyReady: PasskeyReady;
  mailTransport: MailTransport | null;
  /**
   * Which transports the wizard can offer: Microsoft 365 through the backup
   * app registration only when that app is usable already. Absent on older
   * servers. The own app registrations (Microsoft 365, Google Workspace) are
   * set up after the setup, under Installation › Notification mail.
   */
  mailOptions?: { graphBackupApp: boolean };
  /**
   * The operator responsibility notice: the version of its current text and
   * whether that version is accepted (always true in demo mode). Before the
   * setup it is never accepted: the wizard sends the acceptance with its setup
   * request. A configured installation shows it once to its provider admin
   * after sign-in.
   */
  disclaimer: DisclaimerState;
  /**
   * Whether the wizard asks for the one-time setup token first, and where the
   * operator finds it: in the api log, or the RESTOW_SETUP_TOKEN variable.
   */
  setupToken: { required: boolean; source: "log" | "environment" | null };
  /** Sign-in with Microsoft (Entra SSO) is offered: SSO app configured, public mode. */
  microsoftSignIn: boolean;
  /**
   * Notification mail can go out: saved in the web interface or set in the
   * server's environment (`mailTransport` names only a saved one). Absent on
   * older servers.
   */
  notificationMail?: boolean;
  /**
   * The login page offers "Forgot your password?" by mail: set up, mail, a
   * public URL, not the demo. Absent on older servers.
   */
  passwordReset?: boolean;
  /**
   * Public demo mode (RESTOW_DEMO). `email`/`password` are intentionally
   * public: the login page prefills them for a one-click demo sign-in.
   */
  demo: { enabled: boolean; email: string | null; password: string | null };
}

export interface SmtpSetup {
  host: string;
  port: number;
  security: SmtpSecurity;
  username?: string;
  password?: string;
  from: string;
}

export interface GraphMailSetup {
  sender: string;
  tenantId?: string;
}

/** Payload the setup wizard submits on completion (POST /api/v1/setup). */
export interface SetupSubmission {
  /** The operator responsibility notice, accepted in the wizard. */
  disclaimer: { version: string; accepted: true };
  operatingMode: OperatingMode;
  publicUrl?: string;
  /**
   * Name of the operator's own organisation. The server stores it as the
   * operator's name and creates the installation's own organisation (a tenant
   * of kind `internal`) with it.
   */
  providerName: string;
  /**
   * The language chosen in the wizard's first step: the language of the own
   * organisation (its mails and reports) and of the test message.
   */
  language?: "de" | "en";
  firstAdmin: { name: string; email: string; password: string };
  /** Absent when the operator skips the mail step: it is set up later in the settings. */
  mail?: { transport: "smtp"; smtp: SmtpSetup } | { transport: "graph"; graph: GraphMailSetup };
  /** Needs `mail`. */
  sendTest?: boolean;
}

export interface SetupResult {
  ok: true;
  passkeyReady: PasskeyReady;
  adminCreated: boolean;
  /**
   * The operator's own organisation the setup creates after the installation is
   * saved. `created: false` means it could not be created: the setup is complete
   * all the same and the dashboard offers to create it. Absent on older servers.
   */
  ownOrganisation?: { created: boolean };
  /**
   * `reason` explains a failed test message (the same codes as the settings
   * test, `settings:mail.test.reasons`); `error` is the technical detail.
   */
  testSend: { attempted: boolean; ok: boolean; reason?: string; error?: string };
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
}

/**
 * What a tenant stands for: a `customer`, or the operator's own organisation
 * (`internal`, at most one; the server lists it first).
 */
export type TenantKind = "customer" | "internal";

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  /** Absent on servers from before 0.2.0, which read as `customer`. */
  kind?: TenantKind;
  /** The provider's customer number for this tenant; null or absent when none is set. */
  customerNumber?: string | null;
  role: TenantRole;
}

/** A provider admin's role in the provider team (apps/api lib/provider-access.ts). */
export type ProviderRole = "owner" | "administrator" | "technician" | "read_only";

/**
 * Core features the server may hold back on an installation (`/api/v1/me`
 * `features` lists the enabled ones). Without any server extension none of
 * them is enabled:
 * - `tenants.additional`   creating a tenant when one already exists
 * - `apiKeys.provider`     creating provider API keys (cross-tenant)
 * - `stats.allTenants`     the statistics over every tenant
 * - `dashboard.allTenants` the provider view of the dashboard
 * - `reports.timed`        time-triggered report rules
 * - `providerTeam.tenantScope` limiting a member of the provider team to chosen tenants
 */
export const GATED_FEATURES = [
  "tenants.additional",
  "apiKeys.provider",
  "stats.allTenants",
  "dashboard.allTenants",
  "reports.timed",
  "providerTeam.tenantScope",
] as const;

export type GatedFeature = (typeof GATED_FEATURES)[number];

/** GET /api/v1/me: who is signed in, with role, tenants, enabled features and the running build. */
export interface Me {
  user: SessionUser;
  role: Role;
  tenants: TenantSummary[];
  activeTenantId: string | null;
  /** The gated core features this installation enables. */
  features: GatedFeature[];
  /**
   * Fields contributed by server extensions, keyed by the extension's field
   * name. Opaque to the core: only the web extension that pairs with the
   * server extension reads them.
   */
  extensions: Record<string, unknown>;
  /** The provider team role and scope; null (or absent, older servers) for everyone else. */
  provider?: { role: ProviderRole; allTenants: boolean } | null;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  /** Absent on servers from before 0.2.0, which read as `customer`. */
  kind?: TenantKind;
  /** The provider's customer number for this tenant; null or absent when none is set. */
  customerNumber?: string | null;
}

export type RecoveryReadiness = "green" | "yellow" | "red";
export type ChainState = "ok" | "broken" | "unknown";

/** GET /api/v1/status, the aggregate the dashboard renders. */
export interface StatusSummary {
  lastSuccess: {
    mail: string | null;
    onedrive: string | null;
    imap: string | null;
    archive: string | null;
  };
  protectedObjects: number;
  /** Objects whose latest finished backup run failed. */
  failedObjects: number;
  /** Objects whose latest finished backup run completed but left items it could not back up. */
  objectsWithItemFailures: number;
  storage: { logicalBytes: number; physicalBytes: number };
  recoveryReadiness: RecoveryReadiness | null;
  lastVerifyAt: string | null;
  archiveChain: ChainState;
  version: string;
  updateAvailable: boolean;
}

export type JobStatus = "queued" | "active" | "completed" | "failed" | "cancelled";

export interface JobSummary {
  id: string;
  queue: string;
  status: JobStatus;
  protectedObjectId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  progress: { total: number; done: number; failed: number; bytes: number } | null;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

// --- Tolerant decoders --------------------------------------------------------

/**
 * Accept both `T[]` and `{ items: T[] }` list shapes. The contract uses pages
 * for most lists; being lenient here keeps the shell working while feature
 * endpoints settle.
 */
export function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }
  if (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as Page<T>).items)
  ) {
    return (payload as Page<T>).items;
  }
  return [];
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const CHAIN_STATES: readonly ChainState[] = ["ok", "broken", "unknown"];
const READINESS: readonly RecoveryReadiness[] = ["green", "yellow", "red"];

/** The API's archive chain states (`Status.archive.chain`) in the dashboard's terms. */
const API_CHAIN_STATES: Readonly<Record<string, ChainState>> = {
  verified: "ok",
  broken: "broken",
  not_verified: "unknown",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Normalise a status payload so stubbed or partial responses still render.
 * Reads the API's `Status` document (`objects`, `archive.chain`, `version`
 * object) and the flat dashboard shape alike.
 */
export function normalizeStatus(payload: unknown): StatusSummary {
  const raw = asRecord(payload);
  const lastSuccess = asRecord(raw.lastSuccess);
  const storage = asRecord(raw.storage);
  const objects = asRecord(raw.objects);
  const archive = asRecord(raw.archive);
  const version = asRecord(raw.version);
  const readiness = raw.recoveryReadiness;
  const chain =
    raw.archiveChain ??
    (typeof archive.chain === "string" ? API_CHAIN_STATES[archive.chain] : undefined);

  return {
    lastSuccess: {
      mail: asNullableString(lastSuccess.mail),
      onedrive: asNullableString(lastSuccess.onedrive),
      imap: asNullableString(lastSuccess.imap),
      archive: asNullableString(lastSuccess.archive),
    },
    protectedObjects: asNumber(raw.protectedObjects ?? objects.active),
    failedObjects: asNumber(raw.failedObjects ?? objects.failed),
    objectsWithItemFailures: asNumber(raw.objectsWithItemFailures ?? objects.withItemFailures),
    storage: {
      logicalBytes: asNumber(storage.logicalBytes),
      physicalBytes: asNumber(storage.physicalBytes),
    },
    recoveryReadiness: READINESS.includes(readiness as RecoveryReadiness)
      ? (readiness as RecoveryReadiness)
      : null,
    lastVerifyAt: asNullableString(raw.lastVerifyAt),
    archiveChain: CHAIN_STATES.includes(chain as ChainState) ? (chain as ChainState) : "unknown",
    version:
      typeof raw.version === "string"
        ? raw.version
        : typeof version.running === "string"
          ? version.running
          : "",
    updateAvailable: raw.updateAvailable === true || version.updateAvailable === true,
  };
}

// --- Query keys ---------------------------------------------------------------

/** Stable query keys so callers and prefetchers share cache entries. */
export const queryKeys = {
  setupState: ["setup", "state"] as const,
  authSession: ["auth", "session"] as const,
  me: ["auth", "me"] as const,
  tenants: ["tenants"] as const,
  status: (tenantId: string | null) => ["tenant", tenantId, "status"] as const,
  recentJobs: (tenantId: string | null) => ["tenant", tenantId, "jobs", "recent"] as const,
};

// --- Endpoints ----------------------------------------------------------------

export function fetchSetupState(): Promise<SetupState> {
  return apiFetch<SetupState>("/setup/state", { tenantId: null });
}

/**
 * Installation state, cached so the root guard, the login page's demo panel
 * and the app shell's demo banner all share one entry (staleTime keeps it
 * from refetching on every navigation). Defined here, not in routes/tree.ts,
 * so lib/session.tsx can read it too without an import cycle between the two.
 */
export const setupStateQueryOptions = queryOptions({
  queryKey: queryKeys.setupState,
  queryFn: fetchSetupState,
  staleTime: 60_000,
});

/** Complete the setup; `setupToken` is the one the operator entered in the first step. */
export function submitSetup(payload: SetupSubmission, setupToken: string): Promise<SetupResult> {
  return apiFetch<SetupResult>("/setup", {
    method: "POST",
    body: payload,
    tenantId: null,
    headers: { [SETUP_TOKEN_HEADER]: setupToken },
  });
}

/** First wizard step: is this the setup token? Resolves when it is (public, until configured). */
export async function verifySetupToken(setupToken: string): Promise<void> {
  await apiFetch<unknown>("/setup/token", {
    method: "POST",
    tenantId: null,
    headers: { [SETUP_TOKEN_HEADER]: setupToken },
  });
}

/** A provider admin of a running installation accepts the notice (settings route, needs a session). */
export function acceptInstallationDisclaimer(version: string): Promise<DisclaimerAcceptance> {
  return apiFetch<DisclaimerAcceptance>("/settings/disclaimer", {
    method: "POST",
    body: { version, accepted: true },
    tenantId: null,
  });
}

export function fetchMe(): Promise<Me> {
  return apiFetch<Me>("/me");
}

export async function fetchTenants(): Promise<Tenant[]> {
  return unwrapList<Tenant>(await apiFetch<unknown>("/tenants", { tenantId: null }));
}

export async function fetchStatus(): Promise<StatusSummary> {
  return normalizeStatus(await apiFetch<unknown>("/status"));
}

export async function fetchRecentJobs(limit = 8): Promise<JobSummary[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  return unwrapList<JobSummary>(await apiFetch<unknown>(`/jobs?${params.toString()}`));
}

/** Whether notification mail can go out, also on a server that does not report it yet. */
export function notificationMailConfigured(
  state: Pick<SetupState, "notificationMail" | "mailTransport"> | null | undefined,
): boolean {
  return state?.notificationMail ?? Boolean(state?.mailTransport);
}
