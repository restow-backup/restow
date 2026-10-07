import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Dek } from "../crypto.js";
import { splitCertificatePem } from "../directory/credentials.js";
import { type AppCredentials, isAllowedAuthorityHost } from "../graph/auth/token.js";
import { openSecret } from "../secret-seal.js";
import {
  type CertificateInfo,
  describeCertificate,
  normalizePrivateKeyPem,
} from "./certificate.js";

/**
 * The backup app registration (docs/ENTRA-SETUP.md, part 1 to 3): where its
 * credentials come from, and how every process that talks to Microsoft 365
 * resolves them at the time of use.
 *
 * Two sources, in this order:
 *   1. the server environment: ENTRA_CLIENT_ID plus ENTRA_CLIENT_SECRET or
 *      ENTRA_CLIENT_CERT_PATH (one PEM with private key and certificate; it
 *      wins over the secret when both are set);
 *   2. the registration a provider admin entered under Settings → Microsoft
 *      365: one JSON document sealed in `secrets` (installation level, kind
 *      `entra_app`), opened with the installation secrets key.
 *
 * {@link EntraAppResolver} caches the answer briefly, so the API and every
 * worker pick up a saved change within the TTL without a restart. Each
 * resolved registration carries a fingerprint over client id, credential and
 * authority: caches of token providers key on it, so a new credential never
 * meets a token or client built from the old one. The fingerprint is a cache
 * key only, never shown or logged, and no function here logs or returns
 * credential material in an error.
 */

/** `secrets.kind` of the sealed registration document (installation level). */
export const ENTRA_APP_SECRET_KIND = "entra_app";
/** `secrets.kind` of the last connection test (installation level). */
export const ENTRA_APP_TEST_SECRET_KIND = "entra_app_test";

/** How long a resolution is reused before the environment and the database are read again. */
export const ENTRA_APP_CACHE_TTL_MS = 30_000;

export type EntraCredentialKind = "secret" | "certificate";
export type EntraAppSource = "environment" | "database";

/** The sealed JSON document of a registration entered in the web UI. */
export interface EntraAppDocument {
  /** Application (client) ID. */
  clientId: string;
  credentialKind: EntraCredentialKind;
  /** The client secret's value (`secret` only). */
  clientSecret?: string;
  /** Private key and certificate as PEM (`certificate` only). */
  certificatePem?: string;
  /** When the secret expires, as noted by the admin (ISO 8601); null when unknown. */
  secretExpiresAt: string | null;
  /** Directory (tenant) ID of the app's own tenant, used for the connection test. */
  homeTenantId: string | null;
  /** Login host for sovereign clouds; null for the public cloud. */
  authorityHost: string | null;
  /** ISO 8601. */
  updatedAt: string;
  /** Email of the provider admin who saved it. */
  updatedBy: string;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read a document back defensively. Throws a message that names the problem,
 * never a value from the document.
 */
export function parseEntraAppDocument(json: string): EntraAppDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("the saved app registration is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("the saved app registration is not an object");
  }
  const value = raw as Record<string, unknown>;
  const clientId = optionalString(value.clientId);
  if (!clientId) {
    throw new Error("the saved app registration has no client id");
  }
  const kind = value.credentialKind;
  if (kind !== "secret" && kind !== "certificate") {
    throw new Error("the saved app registration names no credential kind");
  }
  const clientSecret = optionalString(value.clientSecret);
  const certificatePem = optionalString(value.certificatePem);
  if (kind === "secret" ? !clientSecret : !certificatePem) {
    throw new Error("the saved app registration lacks its credential");
  }
  return {
    clientId,
    credentialKind: kind,
    ...(kind === "secret" ? { clientSecret: clientSecret as string } : {}),
    ...(kind === "certificate" ? { certificatePem: certificatePem as string } : {}),
    secretExpiresAt: kind === "secret" ? optionalString(value.secretExpiresAt) : null,
    homeTenantId: optionalString(value.homeTenantId),
    authorityHost: optionalString(value.authorityHost),
    updatedAt: optionalString(value.updatedAt) ?? new Date(0).toISOString(),
    updatedBy: optionalString(value.updatedBy) ?? "",
  };
}

export function serializeEntraAppDocument(document: EntraAppDocument): string {
  return JSON.stringify(document);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** The ENTRA_CLIENT_* values of a process environment (trimmed, empty = unset). */
export interface EntraAppEnvironment {
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** ENTRA_CLIENT_CERT_PATH: a PEM file with private key and certificate. */
  readonly certificatePath?: string;
  readonly authorityHost?: string;
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function entraAppEnvironmentFrom(
  env: Record<string, string | undefined>,
): EntraAppEnvironment {
  return {
    clientId: envValue(env, "ENTRA_CLIENT_ID"),
    clientSecret: envValue(env, "ENTRA_CLIENT_SECRET"),
    certificatePath: envValue(env, "ENTRA_CLIENT_CERT_PATH"),
    authorityHost: envValue(env, "ENTRA_AUTHORITY_HOST"),
  };
}

/** The environment names a complete registration; it then wins over the saved one. */
export function environmentConfiguresEntraApp(env: EntraAppEnvironment): boolean {
  return Boolean(env.clientId && (env.clientSecret || env.certificatePath));
}

/** Some ENTRA_CLIENT_* values are set, but not enough to use them (they are then ignored). */
export function environmentPartiallyConfigured(env: EntraAppEnvironment): boolean {
  return (
    !environmentConfiguresEntraApp(env) &&
    Boolean(env.clientId || env.clientSecret || env.certificatePath)
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A usable registration, wherever it came from. */
export interface ResolvedEntraApp {
  source: EntraAppSource;
  credentials: AppCredentials;
  credentialKind: EntraCredentialKind;
  /** The certificate's end of validity, or the date an admin noted for the secret. */
  expiresAt: string | null;
  /** Thumbprint and validity of the certificate credential. */
  certificate: CertificateInfo | null;
  homeTenantId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Cache key over client id, credential and authority; never shown, never logged. */
  fingerprint: string;
}

/** Why a configured registration cannot be used. */
export type EntraAppUnusableReason =
  | "certificate_unreadable"
  | "certificate_invalid"
  | "document_unreadable"
  | "authority_host_invalid";

export type EntraAppResolution =
  | { status: "ready"; app: ResolvedEntraApp }
  /** Nothing configured. `clientId` is an ENTRA_CLIENT_ID set without a credential. */
  | { status: "none"; clientId: string | null }
  | {
      status: "unusable";
      source: EntraAppSource;
      clientId: string | null;
      reason: EntraAppUnusableReason;
      /** Operator-facing explanation; never contains credential material. */
      detail: string;
    };

/** SHA-256 over what makes a credential distinct; the key for caches of tokens and clients. */
export function appCredentialsFingerprint(app: AppCredentials): string {
  const identity = JSON.stringify([
    app.clientId,
    app.credential,
    app.authorityHost ?? null,
    app.scope ?? null,
  ]);
  return createHash("sha256").update(identity).digest("hex");
}

/** A `secrets` row holding the sealed document, as read from the installation pool. */
export interface StoredEntraAppRow {
  id: string;
  ciphertext: string;
  updatedAt: Date | string;
}

export interface EntraAppResolverOptions {
  environment: EntraAppEnvironment;
  /** Reads the `entra_app` row (installation level); null when none is saved. */
  loadStored: () => Promise<StoredEntraAppRow | null>;
  /** The installation secrets key; only called when a document has to be opened. */
  installationKey: () => Dek;
  /** Reads ENTRA_CLIENT_CERT_PATH (injectable for tests). */
  readTextFile?: (path: string) => Promise<string>;
  ttlMs?: number;
  now?: () => number;
}

function timestampOf(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function resolved(
  source: EntraAppSource,
  credentials: AppCredentials,
  extra: Omit<ResolvedEntraApp, "source" | "credentials" | "credentialKind" | "fingerprint">,
): EntraAppResolution {
  return {
    status: "ready",
    app: {
      source,
      credentials,
      credentialKind: credentials.credential.type,
      fingerprint: appCredentialsFingerprint(credentials),
      ...extra,
    },
  };
}

export function certificateCredentials(
  clientId: string,
  pem: string,
  authorityHost: string | undefined,
): { credentials: AppCredentials; certificate: CertificateInfo | null } | null {
  const parts = splitCertificatePem(pem);
  if (!parts) {
    return null;
  }
  return {
    credentials: {
      clientId,
      credential: {
        type: "certificate",
        privateKeyPem: normalizePrivateKeyPem(parts.privateKeyPem),
        certificatePem: parts.certificatePem,
      },
      ...(authorityHost ? { authorityHost } : {}),
    },
    certificate: describeCertificate(parts.certificatePem),
  };
}

/**
 * Resolves the backup app registration: the environment first, then the saved
 * document. Answers are cached for `ttlMs`; a saved document is only opened
 * again when its row changed. One instance per process.
 */
export class EntraAppResolver {
  private cached: { value: EntraAppResolution; expiresAt: number } | null = null;
  private opened: { key: string; value: EntraAppResolution } | null = null;
  private inFlight: Promise<EntraAppResolution> | null = null;
  private generation = 0;

  constructor(private readonly options: EntraAppResolverOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The registration to use right now. Database errors propagate (a retry may help). */
  resolve(): Promise<EntraAppResolution> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const generation = this.generation;
    const pending = this.load().then((value) => {
      if (generation === this.generation) {
        this.cached = {
          value,
          expiresAt: this.now() + (this.options.ttlMs ?? ENTRA_APP_CACHE_TTL_MS),
        };
      }
      return value;
    });
    this.inFlight = pending;
    const clear = () => {
      if (this.inFlight === pending) {
        this.inFlight = null;
      }
    };
    pending.then(clear, clear);
    return pending;
  }

  /** Forget the cached answer (after this process saved or removed the registration). */
  invalidate(): void {
    this.generation += 1;
    this.cached = null;
    this.opened = null;
    this.inFlight = null;
  }

  private async load(): Promise<EntraAppResolution> {
    const env = this.options.environment;
    if (environmentConfiguresEntraApp(env)) {
      return this.fromEnvironment(env);
    }
    const row = await this.options.loadStored();
    if (!row) {
      return { status: "none", clientId: env.clientId ?? null };
    }
    const key = `${row.id}:${timestampOf(row.updatedAt)}`;
    if (this.opened?.key === key) {
      return this.opened.value;
    }
    const value = this.fromDocument(row);
    this.opened = { key, value };
    return value;
  }

  private async fromEnvironment(env: EntraAppEnvironment): Promise<EntraAppResolution> {
    const clientId = env.clientId as string;
    const common = { homeTenantId: null, updatedAt: null, updatedBy: null };
    if (env.certificatePath) {
      let pem: string;
      try {
        pem = await (this.options.readTextFile ?? ((path) => readFile(path, "utf8")))(
          env.certificatePath,
        );
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return {
          status: "unusable",
          source: "environment",
          clientId,
          reason: "certificate_unreadable",
          detail: `ENTRA_CLIENT_CERT_PATH could not be read${code ? ` (${code})` : ""}.`,
        };
      }
      const built = certificateCredentials(clientId, pem, env.authorityHost);
      if (!built) {
        return {
          status: "unusable",
          source: "environment",
          clientId,
          reason: "certificate_invalid",
          detail:
            "The Entra certificate file must contain an unencrypted private key and the certificate (PEM).",
        };
      }
      return resolved("environment", built.credentials, {
        ...common,
        certificate: built.certificate,
        expiresAt: built.certificate?.notAfter ?? null,
      });
    }
    const credentials: AppCredentials = {
      clientId,
      credential: { type: "secret", clientSecret: env.clientSecret as string },
      ...(env.authorityHost ? { authorityHost: env.authorityHost } : {}),
    };
    return resolved("environment", credentials, { ...common, certificate: null, expiresAt: null });
  }

  private fromDocument(row: StoredEntraAppRow): EntraAppResolution {
    let document: EntraAppDocument;
    try {
      document = parseEntraAppDocument(
        openSecret(this.options.installationKey(), row.id, row.ciphertext),
      );
    } catch {
      return {
        status: "unusable",
        source: "database",
        clientId: null,
        reason: "document_unreadable",
        detail:
          "The saved app registration could not be opened. Was RESTOW_MASTER_KEY changed? Enter the registration again.",
      };
    }
    const authorityHost = document.authorityHost ?? undefined;
    if (authorityHost && !isAllowedAuthorityHost(authorityHost)) {
      // The web UI only ever saves a host from the fixed list (schemas.ts), but this
      // document may predate that check; without this, an outdated row would still
      // drive outbound token requests and customer consent links at an arbitrary host.
      return {
        status: "unusable",
        source: "database",
        clientId: document.clientId,
        reason: "authority_host_invalid",
        detail: "The saved login host is no longer accepted. Enter the registration again.",
      };
    }
    const common = {
      homeTenantId: document.homeTenantId,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
    };
    if (document.credentialKind === "certificate") {
      const built = certificateCredentials(
        document.clientId,
        document.certificatePem ?? "",
        authorityHost,
      );
      if (!built) {
        return {
          status: "unusable",
          source: "database",
          clientId: document.clientId,
          reason: "certificate_invalid",
          detail: "The saved certificate lacks its private key or certificate. Upload it again.",
        };
      }
      return resolved("database", built.credentials, {
        ...common,
        certificate: built.certificate,
        expiresAt: built.certificate?.notAfter ?? null,
      });
    }
    const credentials: AppCredentials = {
      clientId: document.clientId,
      credential: { type: "secret", clientSecret: document.clientSecret ?? "" },
      ...(authorityHost ? { authorityHost } : {}),
    };
    return resolved("database", credentials, {
      ...common,
      certificate: null,
      expiresAt: document.secretExpiresAt,
    });
  }
}

/**
 * The credentials of a resolution, or an operator-facing reason why there are
 * none (for processes that can only report, not fix, the configuration).
 */
export function entraAppCredentialsOf(
  resolution: EntraAppResolution,
): { ok: true; app: ResolvedEntraApp } | { ok: false; detail: string } {
  switch (resolution.status) {
    case "ready":
      return { ok: true, app: resolution.app };
    case "unusable":
      return { ok: false, detail: resolution.detail };
    case "none":
      return {
        ok: false,
        detail:
          "No Microsoft 365 app registration is configured. Enter it under Settings → Microsoft 365, or set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET (or ENTRA_CLIENT_CERT_PATH).",
      };
  }
}
