/**
 * Entra app credentials for worker processes, read from the environment.
 *
 * The backup app registration is one multi-tenant app (docs/ENTRA-SETUP.md);
 * every process that talks to Graph needs its client id plus a secret or a
 * certificate. The values are passed in as plain strings so the caller
 * decides how to load them (process.env, a mounted file) and tests never touch
 * the environment.
 */
import { CERTIFICATE_BLOCK, PRIVATE_KEY_BLOCK } from "../entra/certificate.js";
import type { AppCredentials } from "../graph/auth/token.js";

export interface EntraAppEnv {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  /** Content of the PEM file holding the private key and the certificate. */
  readonly certificatePem: string | undefined;
  readonly authorityHost?: string | undefined;
}

/** What is missing when credentials cannot be built, in operator terms. */
export type CredentialsProblem = "client_id_missing" | "credential_missing";

export type AppCredentialsResult =
  | { ok: true; credentials: AppCredentials }
  | { ok: false; problem: CredentialsProblem; detail: string };

/**
 * Split a combined PEM into its private key and certificate. Both are needed:
 * the key signs the client assertion, the certificate yields the thumbprint
 * Entra matches it against. Order inside the file does not matter.
 */
export function splitCertificatePem(
  pem: string,
): { privateKeyPem: string; certificatePem: string } | null {
  const privateKeyPem = PRIVATE_KEY_BLOCK.exec(pem)?.[0];
  const certificatePem = CERTIFICATE_BLOCK.exec(pem)?.[0];
  return privateKeyPem && certificatePem ? { privateKeyPem, certificatePem } : null;
}

/** Build {@link AppCredentials} from the environment values, preferring the certificate. */
export function appCredentialsFrom(env: EntraAppEnv): AppCredentialsResult {
  const clientId = env.clientId?.trim();
  if (!clientId) {
    return {
      ok: false,
      problem: "client_id_missing",
      detail: "ENTRA_CLIENT_ID is not configured for this process.",
    };
  }
  const authorityHost = env.authorityHost?.trim() || undefined;
  const certificate = env.certificatePem?.trim();
  if (certificate) {
    const parts = splitCertificatePem(certificate);
    if (!parts) {
      return {
        ok: false,
        problem: "credential_missing",
        detail:
          "The Entra certificate file must contain an unencrypted private key and the certificate (PEM).",
      };
    }
    return {
      ok: true,
      credentials: { clientId, credential: { type: "certificate", ...parts }, authorityHost },
    };
  }
  const clientSecret = env.clientSecret?.trim();
  if (clientSecret) {
    return {
      ok: true,
      credentials: { clientId, credential: { type: "secret", clientSecret }, authorityHost },
    };
  }
  return {
    ok: false,
    problem: "credential_missing",
    detail:
      "No Entra client secret or certificate is configured (ENTRA_CLIENT_SECRET or ENTRA_CLIENT_CERT_PATH).",
  };
}
