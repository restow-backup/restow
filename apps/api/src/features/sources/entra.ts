import {
  ENTRA_APP_SECRET_KIND,
  type EntraAppEnvironment,
  type EntraAppResolution,
  EntraAppResolver,
  FetchGraphClient,
  type GraphClient,
  type RefreshableTokenProvider,
  type ResolvedEntraApp,
  TenantTokenProviders,
  adminConsentRedirectUri,
} from "@restow/core";
import { findInstallationSecret } from "@restow/db";
import { type Config, config as processConfig } from "../../config.js";
import { providerDb } from "../../db.js";
import { installationSecretsKey } from "../../lib/secrets.js";
import { ProblemError } from "../../problem.js";

/**
 * Glue between the operator configuration and the core Entra/Graph modules:
 * which backup app registration applies (docs/ENTRA-SETUP.md, part 1 to 3),
 * one token provider per customer tenant and a throttled Graph client on top.
 *
 * The registration is resolved at the time of use (@restow/core
 * entra/app-registration.ts): ENTRA_CLIENT_* from the environment when they
 * are complete, otherwise the registration a provider admin saved under
 * Settings → Microsoft 365. Token providers are keyed by the registration's
 * fingerprint, so a changed credential is used for the next token without a
 * restart. Nothing here logs credential material.
 */

/** What the UI needs to explain the Entra side before any tenant is connected. */
export interface EntraAppStatus {
  configured: boolean;
  /** Where the registration comes from; `none` until one is set up. */
  source: "environment" | "database" | "none";
  clientId: string | null;
  credential: "secret" | "certificate" | null;
  /** The callback URL that must be registered on the backup app, or null without a public origin. */
  redirectUri: string | null;
  /** Why the app is not usable, for an honest empty state. */
  reasons: EntraAppProblem[];
}

export type EntraAppProblem =
  | "no_client_id"
  | "no_credential"
  | "credential_unusable"
  | "no_public_url";

/** The ENTRA_CLIENT_* part of the configuration, as the resolver reads it. */
export function entraEnvironmentOf(config: Config): EntraAppEnvironment {
  return {
    clientId: config.entra.clientId?.trim() || undefined,
    clientSecret: config.entra.clientSecret?.trim() || undefined,
    certificatePath: config.entra.clientCertPath?.trim() || undefined,
    authorityHost: config.entra.authorityHost?.trim() || undefined,
  };
}

let resolver: EntraAppResolver | null = null;

/** The process-wide resolver: the environment first, then the sealed `entra_app` document. */
export function entraAppResolver(): EntraAppResolver {
  resolver ??= new EntraAppResolver({
    environment: entraEnvironmentOf(processConfig),
    // Installation-level secrets are hidden from tenant sessions: the installation pool.
    loadStored: () => findInstallationSecret(providerDb, ENTRA_APP_SECRET_KIND),
    installationKey: installationSecretsKey,
  });
  return resolver;
}

/** Replace the resolver (tests) and drop every token cached for the previous one. */
export function setEntraAppResolver(next: EntraAppResolver | null): void {
  resolver = next;
  resetTokenProviders();
}

/** The registration that applies right now. */
export function resolveEntraApp(): Promise<EntraAppResolution> {
  return entraAppResolver().resolve();
}

/** Forget the cached registration after it was saved or removed in this process. */
export function invalidateEntraApp(): void {
  entraAppResolver().invalidate();
  resetTokenProviders();
}

/** What is missing to *authenticate* as the backup app (token acquisition, verification). */
export function entraCredentialProblems(resolution: EntraAppResolution): EntraAppProblem[] {
  switch (resolution.status) {
    case "ready":
      return [];
    case "unusable":
      return ["credential_unusable"];
    case "none":
      return resolution.clientId ? ["no_credential"] : ["no_client_id", "no_credential"];
  }
}

/** Reasons the Entra app cannot be used yet (empty when everything is set). */
export function entraProblems(
  resolution: EntraAppResolution,
  publicOrigin: string | null,
): EntraAppProblem[] {
  const reasons = entraCredentialProblems(resolution);
  return publicOrigin ? reasons : [...reasons, "no_public_url"];
}

function clientIdOf(resolution: EntraAppResolution): string | null {
  return resolution.status === "ready" ? resolution.app.credentials.clientId : resolution.clientId;
}

export function entraAppStatus(
  resolution: EntraAppResolution,
  publicOrigin: string | null,
): EntraAppStatus {
  const reasons = entraProblems(resolution, publicOrigin);
  return {
    configured: reasons.length === 0,
    source:
      resolution.status === "ready"
        ? resolution.app.source
        : resolution.status === "unusable"
          ? resolution.source
          : "none",
    clientId: clientIdOf(resolution),
    credential: resolution.status === "ready" ? resolution.app.credentialKind : null,
    redirectUri: publicOrigin ? adminConsentRedirectUri(publicOrigin) : null,
    reasons,
  };
}

/** 503 problem naming what is missing for the Entra integration. */
export function entraNotConfigured(reasons: EntraAppProblem[]): ProblemError {
  return new ProblemError(503, "Entra app not configured", {
    type: "urn:restow:problem:entra-not-configured",
    detail:
      "Enter the Microsoft 365 app registration under Settings → Microsoft 365 (or set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH in the server environment), and configure a public URL, to connect Microsoft 365 tenants.",
    extensions: { reasons },
  });
}

/** The backup app registration; throws the 503 problem when none is usable. */
export async function requireEntraApp(resolution?: EntraAppResolution): Promise<ResolvedEntraApp> {
  const current = resolution ?? (await resolveEntraApp());
  if (current.status !== "ready") {
    throw entraNotConfigured(entraCredentialProblems(current));
  }
  return current.app;
}

/** Token providers for the current registration, one per customer tenant. */
let tokens: { fingerprint: string; providers: TenantTokenProviders } | null = null;

async function currentProviders(): Promise<TenantTokenProviders> {
  const app = await requireEntraApp();
  if (tokens?.fingerprint !== app.fingerprint) {
    // A new credential: tokens obtained with the old one are dropped with it.
    tokens = { fingerprint: app.fingerprint, providers: new TenantTokenProviders(app.credentials) };
  }
  return tokens.providers;
}

/**
 * A token provider for one customer tenant that always follows the current
 * registration. `invalidate` drops the cached token, so the next call fetches
 * a fresh one (with the permissions granted by then).
 */
export function tokenProviderFor(
  entraTenantId: string,
): RefreshableTokenProvider & { invalidate(): void } {
  return {
    getToken: async () => (await currentProviders()).forTenant(entraTenantId).getToken(),
    invalidate: () => tokens?.providers.forget(entraTenantId),
  };
}

/** Forget a tenant's cached token (after disconnecting or deleting the source). */
export function forgetTokenProvider(entraTenantId: string): void {
  tokens?.providers.forget(entraTenantId);
}

/** Drop every cached provider (tests, credential rotation). */
export function resetTokenProviders(): void {
  tokens = null;
}

/** A throttled Graph client bound to one customer tenant. */
export function graphClientFor(entraTenantId: string): GraphClient {
  const provider = tokenProviderFor(entraTenantId);
  return new FetchGraphClient({ accessTokenProvider: () => provider.getToken() });
}
