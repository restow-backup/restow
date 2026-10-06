import { type AppCredentials, isAllowedAuthorityHost } from "../graph/auth/token.js";
import { certificateCredentials } from "./app-registration.js";

/**
 * A customer's own Graph app for one Microsoft 365 source, entered by hand
 * instead of the admin-consent round trip with the shared backup app
 * (docs/ENTRA-SETUP.md, "Your own app per source").
 *
 * The credential lives in the tenant's secret store, referenced by
 * `sources.secret_ref`, as one sealed JSON document of kind `m365_app`. A
 * plain, non-JSON secret on an m365 source is the older "client secret of the
 * shared app" form; {@link parseSourceAppSecret} answers null for it so the
 * caller keeps that behaviour.
 *
 * Nothing here logs or returns credential material in an error.
 */

/** `secrets.kind` of the sealed document. */
export const SOURCE_APP_SECRET_KIND = "m365_app";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SourceAppCredentialKind = "secret" | "certificate";

/** The sealed document. */
export interface SourceAppDocument {
  version: 1;
  clientId: string;
  credentialKind: SourceAppCredentialKind;
  clientSecret?: string;
  /** One PEM with the private key and the certificate. */
  certificatePem?: string;
  /** Login host for sovereign clouds; null for the public cloud. */
  authorityHost: string | null;
}

export type SourceAppInputProblem =
  | "client_id"
  | "credential"
  | "certificate"
  | "authority_host"
  | "tenant_id";

export type SourceAppInput =
  | {
      ok: true;
      /** Lower-case directory (tenant) ID. */
      tenantId: string;
      document: SourceAppDocument;
      credentials: AppCredentials;
    }
  | { ok: false; problem: SourceAppInputProblem };

export interface SourceAppFormInput {
  tenantId: string;
  clientId: string;
  credentialKind: SourceAppCredentialKind;
  clientSecret?: string | null;
  certificatePem?: string | null;
  authorityHost?: string | null;
}

/** Validate what an admin typed and build the document and the credentials from it. */
export function buildSourceApp(input: SourceAppFormInput): SourceAppInput {
  const tenantId = input.tenantId.trim().toLowerCase();
  if (!GUID.test(tenantId)) {
    return { ok: false, problem: "tenant_id" };
  }
  const clientId = input.clientId.trim().toLowerCase();
  if (!GUID.test(clientId)) {
    return { ok: false, problem: "client_id" };
  }
  const authorityHost = input.authorityHost?.trim() || null;
  if (authorityHost && !isAllowedAuthorityHost(authorityHost)) {
    return { ok: false, problem: "authority_host" };
  }
  if (input.credentialKind === "secret") {
    const clientSecret = input.clientSecret?.trim();
    if (!clientSecret) {
      return { ok: false, problem: "credential" };
    }
    return {
      ok: true,
      tenantId,
      document: { version: 1, clientId, credentialKind: "secret", clientSecret, authorityHost },
      credentials: {
        clientId,
        credential: { type: "secret", clientSecret },
        ...(authorityHost ? { authorityHost } : {}),
      },
    };
  }
  const pem = input.certificatePem?.trim();
  if (!pem) {
    return { ok: false, problem: "credential" };
  }
  const built = certificateCredentials(clientId, pem, authorityHost ?? undefined);
  if (!built) {
    return { ok: false, problem: "certificate" };
  }
  return {
    ok: true,
    tenantId,
    document: {
      version: 1,
      clientId,
      credentialKind: "certificate",
      certificatePem: pem,
      authorityHost,
    },
    credentials: built.credentials,
  };
}

export function serializeSourceAppDocument(document: SourceAppDocument): string {
  return JSON.stringify(document);
}

/**
 * The credentials a stored secret describes, or null when it is not a source
 * app document (the older plain client secret). Throws a message that names
 * the problem, never a value, when a document is damaged.
 */
export function parseSourceAppSecret(plaintext: string): AppCredentials | null {
  const text = plaintext.trimStart();
  if (!text.startsWith("{")) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || (raw as { version?: unknown }).version !== 1) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const clientId = typeof value.clientId === "string" ? value.clientId : "";
  const authorityHost =
    typeof value.authorityHost === "string" && isAllowedAuthorityHost(value.authorityHost)
      ? value.authorityHost
      : undefined;
  if (!clientId) {
    throw new Error("the saved app of this source has no client id");
  }
  if (value.credentialKind === "secret" && typeof value.clientSecret === "string") {
    return {
      clientId,
      credential: { type: "secret", clientSecret: value.clientSecret },
      ...(authorityHost ? { authorityHost } : {}),
    };
  }
  if (value.credentialKind === "certificate" && typeof value.certificatePem === "string") {
    const built = certificateCredentials(clientId, value.certificatePem, authorityHost);
    if (!built) {
      throw new Error("the saved certificate of this source's app cannot be read");
    }
    return built.credentials;
  }
  throw new Error("the saved app of this source lacks its credential");
}
