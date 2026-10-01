import type { Edition } from "./edition";

/** Mirrors the license state of ee/api (GET/POST/DELETE /api/v1/license). */

export interface InstalledKey {
  /** Short identifier derived from the signature, `XXXX-XXXX-XXXX-XXXX`. */
  keyId: string | null;
  licensee: string | null;
  issuedAt: string | null;
  installedAt: string;
  installationId: string;
}

export type VerificationStatus = "ready" | "unconfigured" | "invalid";

export interface Verification {
  status: VerificationStatus;
  source: "embedded" | "environment" | null;
  /** `SHA256:<base64>` of the verification key. */
  fingerprint: string | null;
}

export interface LicenseState {
  edition: Edition;
  /** `environment` means that no key is installed. */
  source: "key" | "environment";
  /** The edition that applies without a key (Community, other than in demo mode). */
  environmentEdition: Edition;
  installationId: string | null;
  key: InstalledKey | null;
  verification: Verification;
}

export type LicenseRejectionReason =
  | "malformed"
  | "bad_signature"
  | "invalid_payload"
  | "installation_mismatch";
