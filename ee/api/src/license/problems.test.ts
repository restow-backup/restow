import { describe, expect, it } from "vitest";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import type { VerifiedLicense } from "../../../licensing/src/index.js";
import {
  LICENSE_PROBLEM_TYPES,
  licenseRejected,
  notCoveringRunningRelease,
  verificationUnavailable,
} from "./problems.js";

const verified: VerifiedLicense = {
  edition: "business",
  multiTenant: false,
  licensee: "Example GmbH",
  installationId: "11111111-1111-4111-8111-111111111111",
  issuedAt: new Date("2026-09-01T08:00:00Z"),
  signature: "c2lnbmF0dXJl",
  keyId: "ABCD-EF01-2345-6789",
  series: "1",
  updatesUntil: null,
  signingKeyId: null,
};

describe("licenseRejected", () => {
  it.each(["malformed", "bad_signature", "invalid_payload", "unknown_signing_key"] as const)(
    "maps %s to a 422 carrying the reason",
    (reason) => {
      const problem = licenseRejected({ ok: false, reason }, "install-1");
      expect(problem).toBeInstanceOf(ProblemError);
      expect(problem.status).toBe(422);
      expect(problem.type).toBe(LICENSE_PROBLEM_TYPES.invalid);
      expect(problem.extensions).toEqual({ reason });
      expect(problem.detail).toBeTruthy();
    },
  );

  it("names both installations on a mismatch", () => {
    const problem = licenseRejected(
      { ok: false, reason: "installation_mismatch", license: verified },
      "22222222-2222-4222-8222-222222222222",
    );
    expect(problem.extensions).toEqual({
      reason: "installation_mismatch",
      keyInstallationId: verified.installationId,
      installationId: "22222222-2222-4222-8222-222222222222",
    });
  });
});

describe("verificationUnavailable", () => {
  it("distinguishes a missing build key from an unreadable override", () => {
    expect(verificationUnavailable("unconfigured").extensions).toEqual({
      verification: "unconfigured",
    });
    const invalid = verificationUnavailable("invalid");
    expect(invalid.status).toBe(409);
    expect(invalid.detail).toContain("RESTOW_LICENSE_PUBLIC_KEY");
  });
});

describe("notCoveringRunningRelease", () => {
  it("names the end of the update period and the running version", () => {
    const problem = notCoveringRunningRelease(
      { entitled: false, reason: "after_period", coveredUntil: "2027-11-30", series: "1" },
      { version: "1.5.0", releasedAt: "2028-01-02T00:00:00Z" },
    );
    expect(problem.status).toBe(422);
    expect(problem.type).toBe(LICENSE_PROBLEM_TYPES.invalid);
    expect(problem.extensions).toEqual({
      reason: "outside_update_period",
      updatesUntil: "2027-11-30",
      series: "1",
      version: "1.5.0",
    });
    expect(problem.detail).toContain("2027-11-30");
  });

  it("names the series of a key without update period", () => {
    const problem = notCoveringRunningRelease(
      { entitled: false, reason: "outside_series", coveredUntil: null, series: "1" },
      { version: "2.0.0", releasedAt: null },
    );
    expect(problem.detail).toContain("1.x");
  });
});
