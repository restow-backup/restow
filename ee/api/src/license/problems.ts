import { ProblemError } from "../../../../apps/api/src/problem.js";
import type { LicenseVerification } from "../../../licensing/src/index.js";

/**
 * RFC 7807 problems of the license feature. Each carries a stable `type` (and,
 * for rejected keys, a `reason`) so the UI can explain the cause in the
 * operator's language instead of showing a generic error.
 */

export const LICENSE_PROBLEM_TYPES = {
  invalid: "urn:restow:problem:license-invalid",
  verificationUnavailable: "urn:restow:problem:license-verification-unavailable",
  notConfigured: "urn:restow:problem:installation-not-configured",
  notInstalled: "urn:restow:problem:license-not-installed",
} as const;

type Rejection = Exclude<LicenseVerification, { ok: true }>;

const REJECTION_DETAILS: Record<Rejection["reason"], string> = {
  malformed: "The text is not a license key. Paste the complete key as issued.",
  bad_signature:
    "The signature does not match: the key was altered, or it was not issued for the verification key of this installation.",
  invalid_payload: "The key is signed, but its content is incomplete or contradictory.",
  installation_mismatch: "The key was issued for a different installation.",
};

/** 422 for a key that failed verification, naming the reason. */
export function licenseRejected(rejection: Rejection, installationId: string): ProblemError {
  const extensions: Record<string, unknown> = { reason: rejection.reason };
  if (rejection.reason === "installation_mismatch") {
    extensions.keyInstallationId = rejection.license.installationId;
    extensions.installationId = installationId;
  }
  return new ProblemError(422, "License key rejected", {
    type: LICENSE_PROBLEM_TYPES.invalid,
    detail: REJECTION_DETAILS[rejection.reason],
    extensions,
  });
}

/** 409 when this build has no usable verification key (placeholder or unreadable override). */
export function verificationUnavailable(status: "unconfigured" | "invalid"): ProblemError {
  return new ProblemError(409, "License verification unavailable", {
    type: LICENSE_PROBLEM_TYPES.verificationUnavailable,
    detail:
      status === "invalid"
        ? "RESTOW_LICENSE_PUBLIC_KEY is set but is not a readable Ed25519 public key."
        : "This build carries no license verification key. Set RESTOW_LICENSE_PUBLIC_KEY or use a release image of the full build.",
    extensions: { verification: status },
  });
}

/** 409 before the setup wizard has created the installation (and with it its id). */
export function installationNotConfigured(): ProblemError {
  return new ProblemError(409, "Installation not configured", {
    type: LICENSE_PROBLEM_TYPES.notConfigured,
    detail: "Complete the setup wizard first; license keys are bound to the installation id.",
  });
}

/** 404 when there is no installed key to remove. */
export function licenseNotInstalled(): ProblemError {
  return new ProblemError(404, "No license key installed", {
    type: LICENSE_PROBLEM_TYPES.notInstalled,
    detail: "The installation runs without a license key.",
  });
}
