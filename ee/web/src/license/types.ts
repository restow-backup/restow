import type { Edition } from "./edition";

/** Mirrors the license state of ee/api (GET/POST/DELETE /api/v1/license). */

export interface InstalledKey {
  /** Short identifier derived from the signature, `XXXX-XXXX-XXXX-XXXX`. */
  keyId: string | null;
  licensee: string | null;
  issuedAt: string | null;
  installedAt: string;
  installationId: string;
  /** Which releases the key covers (0.4.5; older servers: absent). */
  updates?: KeyUpdates;
}

/** The update terms of the installed key (docs/LICENSING.md, "Updates"). */
export interface KeyUpdates {
  /** The series covered without an update period (`"1"`: every 1.x and 0.x release). */
  series: string;
  /** Last day of the update period (`YYYY-MM-DD`); null for a beta licence. */
  until: string | null;
  /** Whether the key covers the running release. */
  coversRunning: boolean;
  reason: string;
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
  /**
   * The key does not cover the running release, which the operator started as Community
   * (RESTOW_RUN_AS_COMMUNITY). 0.4.5; older servers: absent.
   */
  runAsCommunity?: boolean;
}

export type LicenseRejectionReason =
  | "malformed"
  | "bad_signature"
  | "invalid_payload"
  | "installation_mismatch"
  | "unknown_signing_key";
