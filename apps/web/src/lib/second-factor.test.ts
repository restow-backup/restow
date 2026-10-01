import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import {
  TOTP_ENROLLMENT_REQUIRED_PROBLEM,
  isDemoAccountSession,
  isEnrollmentRequiredError,
  requiresAuthenticatorEnrollment,
  sessionAuthMethod,
  signInMethodsOf,
} from "./second-factor";

function session(
  authMethod: unknown,
  twoFactorEnabled: boolean | null | undefined,
  email = "admin@example.com",
) {
  return { session: { id: "s1", authMethod }, user: { twoFactorEnabled, email } };
}

describe("requiresAuthenticatorEnrollment", () => {
  it("sends a password-only session without an authenticator to the enrolment", () => {
    expect(requiresAuthenticatorEnrollment(session("password", false))).toBe(true);
    expect(requiresAuthenticatorEnrollment(session("password", null))).toBe(true);
    expect(requiresAuthenticatorEnrollment(session("password", undefined))).toBe(true);
  });

  it("lets sessions with a second factor or another sign-in method through", () => {
    expect(requiresAuthenticatorEnrollment(session("password_totp", true))).toBe(false);
    expect(requiresAuthenticatorEnrollment(session("passkey", false))).toBe(false);
    expect(requiresAuthenticatorEnrollment(session("oidc", false))).toBe(false);
  });

  it("leaves sessions the API discards anyway to the API", () => {
    // A password session of an account that has enrolled since, or of unknown origin.
    expect(requiresAuthenticatorEnrollment(session("password", true))).toBe(false);
    expect(requiresAuthenticatorEnrollment(session(undefined, false))).toBe(false);
  });

  const demo = { enabled: true, email: "demo@example.org" };

  it("never sends the demo account to enrolment while demo mode is on", () => {
    expect(
      requiresAuthenticatorEnrollment(session("password", false, "demo@example.org"), demo),
    ).toBe(false);
    // Case-insensitive, like the API's own check.
    expect(
      requiresAuthenticatorEnrollment(session("password", false, "Demo@Example.org"), demo),
    ).toBe(false);
  });

  it("still sends every other account to enrolment while demo mode is on", () => {
    expect(
      requiresAuthenticatorEnrollment(session("password", false, "operator@example.org"), demo),
    ).toBe(true);
  });

  it("ignores the demo argument entirely when it is omitted or demo mode is off", () => {
    expect(requiresAuthenticatorEnrollment(session("password", false, "demo@example.org"))).toBe(
      true,
    );
    expect(
      requiresAuthenticatorEnrollment(session("password", false, "demo@example.org"), {
        enabled: false,
        email: "demo@example.org",
      }),
    ).toBe(true);
  });
});

describe("isDemoAccountSession", () => {
  const demo = { enabled: true, email: "demo@example.org" };

  it("matches only the configured demo account while demo mode is on", () => {
    expect(isDemoAccountSession(session("password", false, "demo@example.org"), demo)).toBe(true);
    expect(isDemoAccountSession(session("password", false, "someone@example.org"), demo)).toBe(
      false,
    );
  });

  it("matches nobody when demo mode is off or has no configured email", () => {
    expect(
      isDemoAccountSession(session("password", false, "demo@example.org"), {
        enabled: false,
        email: "demo@example.org",
      }),
    ).toBe(false);
    expect(
      isDemoAccountSession(session("password", false, "demo@example.org"), {
        enabled: true,
        email: null,
      }),
    ).toBe(false);
    expect(isDemoAccountSession(session("password", false, "demo@example.org"), null)).toBe(false);
    expect(isDemoAccountSession(session("password", false, "demo@example.org"), undefined)).toBe(
      false,
    );
  });
});

describe("sessionAuthMethod", () => {
  it("reads the method the API stamped, ignoring anything else", () => {
    expect(sessionAuthMethod(session("passkey", false))).toBe("passkey");
    expect(sessionAuthMethod(session(42, false))).toBeNull();
    expect(sessionAuthMethod({ session: {}, user: {} })).toBeNull();
  });
});

describe("isEnrollmentRequiredError", () => {
  it("recognises the API's enrolment problem", () => {
    const problem = { type: TOTP_ENROLLMENT_REQUIRED_PROBLEM, title: "x", status: 403 };
    expect(isEnrollmentRequiredError(new ApiError(403, problem, "x"))).toBe(true);
    expect(
      isEnrollmentRequiredError(
        new ApiError(403, { type: "about:blank", title: "x", status: 403 }, "x"),
      ),
    ).toBe(false);
    expect(isEnrollmentRequiredError(new Error("x"))).toBe(false);
  });
});

describe("signInMethodsOf", () => {
  it("recognises the emergency password among the linked accounts", () => {
    expect(signInMethodsOf([{ providerId: "microsoft" }, { providerId: "credential" }])).toEqual({
      hasPassword: true,
    });
    expect(signInMethodsOf([{ providerId: "microsoft" }])).toEqual({ hasPassword: false });
    expect(signInMethodsOf([])).toEqual({ hasPassword: false });
  });
});
