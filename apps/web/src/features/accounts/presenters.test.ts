import { describe, expect, it } from "vitest";

import { ApiError, type ProblemDetails } from "@/lib/api";

import { linkStatusBadge, mailOutcomeView, provisionError, setPasswordError } from "./presenters";

function problem(status: number, fields: Partial<ProblemDetails> = {}): ApiError {
  return new ApiError(status, { type: "about:blank", title: "Problem", status, ...fields }, "x");
}

describe("linkStatusBadge", () => {
  it("has a badge for every link status", () => {
    expect(linkStatusBadge("valid")).toEqual({
      variant: "outline",
      labelKey: "accounts:pending.linkStatus.valid",
    });
    expect(linkStatusBadge("expired").variant).toBe("warning");
    expect(linkStatusBadge("used").variant).toBe("muted");
    expect(linkStatusBadge("invalid").variant).toBe("destructive");
  });
});

describe("mailOutcomeView", () => {
  it("never claims mail was sent unless it actually was", () => {
    expect(mailOutcomeView("sent")).toEqual({
      variant: "default",
      titleKey: "accounts:provision.mail.sent",
    });
    expect(mailOutcomeView("failed")).toEqual({
      variant: "warning",
      titleKey: "accounts:provision.mail.failed",
    });
    expect(mailOutcomeView("not_configured")).toEqual({
      variant: "info",
      titleKey: "accounts:provision.mail.notConfigured",
    });
  });
});

describe("provisionError", () => {
  it("names the actual cause for the API's typed refusals", () => {
    expect(
      provisionError(problem(403, { type: "urn:restow:problem:account-cross-tenant" })),
    ).toEqual({ key: "accounts:provision.errors.crossTenant" });
    expect(
      provisionError(problem(403, { type: "urn:restow:problem:account-provider-admin-target" })),
    ).toEqual({ key: "accounts:provision.errors.providerAdminTarget" });
    expect(
      provisionError(problem(409, { type: "urn:restow:problem:account-not-pending" })),
    ).toEqual({ key: "accounts:provision.errors.notPending" });
  });

  it("falls back to the generic status message for anything else", () => {
    expect(provisionError(problem(403))).toEqual({ key: "common:errors.forbidden" });
    expect(provisionError(problem(409))).toEqual({ key: "common:errors.conflict" });
    expect(provisionError(new Error("offline"))).toEqual({ key: "common:errors.generic" });
  });
});

describe("setPasswordError", () => {
  it("names the link problem for a known status", () => {
    expect(
      setPasswordError(problem(409, { type: "urn:restow:problem:account-link-used" })),
    ).toEqual({ key: "accounts:setPassword.linkError.used" });
    expect(
      setPasswordError(problem(409, { type: "urn:restow:problem:account-link-expired" })),
    ).toEqual({ key: "accounts:setPassword.linkError.expired" });
    expect(
      setPasswordError(problem(404, { type: "urn:restow:problem:account-link-invalid" })),
    ).toEqual({ key: "accounts:setPassword.linkError.invalid" });
  });

  it("recognises the rate-limit status before looking at the problem type", () => {
    expect(setPasswordError(problem(429))).toEqual({ key: "accounts:setPassword.rateLimited" });
  });

  it("falls back to the generic message for an unknown problem type", () => {
    expect(setPasswordError(problem(409, { type: "urn:restow:problem:something-else" }))).toEqual({
      key: "common:errors.conflict",
    });
    expect(setPasswordError(new Error("offline"))).toEqual({ key: "common:errors.generic" });
  });
});
