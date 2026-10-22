import type { License } from "@restow/db";
import {
  DEFAULT_LICENSE_SERIES,
  type EffectiveLicense,
  type EntitlementReason,
  type LicenseEdition,
  type LicenseVerificationKey,
  type ReleaseBuild,
  updateEntitlement,
  updateTermsOf,
} from "../../../licensing/src/index.js";

/**
 * GET/POST/DELETE /api/v1/license response: the edition in effect, where it
 * comes from, the installed key (never the key text itself) and whether this
 * build can verify keys at all. Usage figures are the core's
 * (/api/v1/usage); nothing here limits them.
 */

export interface InstalledKeyDto {
  /** Short identifier derived from the signature (`XXXX-XXXX-XXXX-XXXX`). */
  keyId: string | null;
  licensee: string | null;
  issuedAt: string | null;
  installedAt: string;
  /** The installation the key is bound to. */
  installationId: string;
  /** Which releases the key covers (docs/LICENSING.md, "Updates"). */
  updates: KeyUpdatesDto;
}

/** The update terms of the installed key and what they mean for the running release. */
export interface KeyUpdatesDto {
  /** The series covered without an update period (`"1"`: every 1.x and 0.x release). */
  series: string;
  /** Last day of the update period (`YYYY-MM-DD`); null: the series decides (beta licence). */
  until: string | null;
  /** Whether the key covers the running release. */
  coversRunning: boolean;
  reason: EntitlementReason;
}

export interface VerificationDto {
  status: "ready" | "unconfigured" | "invalid";
  /** Where the verification key comes from (embedded in the build or the environment). */
  source: "embedded" | "environment" | null;
  /** `SHA256:<base64>` of the verification key, to compare with the vendor's. */
  fingerprint: string | null;
}

export interface LicenseStateDto {
  edition: LicenseEdition;
  /** Where the edition comes from: an installed key or the environment (no key). */
  source: "key" | "environment";
  /** The edition without a key; it applies again when the key is removed. */
  environmentEdition: LicenseEdition;
  /** Installation id to quote when requesting a key; null before setup. */
  installationId: string | null;
  key: InstalledKeyDto | null;
  verification: VerificationDto;
  /**
   * The installed key does not cover the running release and the operator started it
   * with RESTOW_RUN_AS_COMMUNITY: the installation runs as Community until a key
   * that covers it is installed.
   */
  runAsCommunity: boolean;
}

export interface LicenseStateInput {
  effective: EffectiveLicense;
  environmentEdition: LicenseEdition;
  installed: License | null;
  /** Identifier of the installed key; computed from its signature. */
  installedKeyId: string | null;
  installationId: string | null;
  verification: LicenseVerificationKey;
  /** The running release (version and release date). */
  build: ReleaseBuild;
}

function verificationDto(verification: LicenseVerificationKey): VerificationDto {
  switch (verification.status) {
    case "ready":
      return {
        status: "ready",
        source: verification.source,
        fingerprint: verification.fingerprint,
      };
    case "invalid":
      return { status: "invalid", source: verification.source, fingerprint: null };
    case "unconfigured":
      return { status: "unconfigured", source: null, fingerprint: null };
  }
}

/** Assemble the response from already-loaded parts (pure). */
export function buildLicenseState(input: LicenseStateInput): LicenseStateDto {
  const runAsCommunity = input.effective.runAsCommunity === true;
  const installed = input.effective.source === "key" || runAsCommunity ? input.installed : null;
  const entitlement = installed ? updateEntitlement(updateTermsOf(installed), input.build) : null;
  return {
    edition: input.effective.edition,
    source: input.effective.source,
    environmentEdition: input.environmentEdition,
    installationId: input.installationId,
    key: installed
      ? {
          keyId: input.installedKeyId,
          licensee: installed.licensee,
          issuedAt: installed.issuedAt?.toISOString() ?? null,
          installedAt: installed.createdAt.toISOString(),
          installationId: installed.installationId,
          updates: {
            series: installed.series ?? DEFAULT_LICENSE_SERIES,
            until: installed.updatesUntil ?? null,
            coversRunning: entitlement?.entitled ?? true,
            reason: entitlement?.reason ?? "no_key",
          },
        }
      : null,
    verification: verificationDto(input.verification),
    runAsCommunity,
  };
}
