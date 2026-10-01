import { describe, expect, it } from "vitest";
import { stampAuthMethod } from "./auth-hooks.js";
import {
  authMethodForNewSession,
  authMethodForPath,
  isPathAllowed,
  isSignInPath,
  providerAdminRevocationTarget,
  sessionAssurance,
  wouldRemoveLastProviderAdmin,
} from "./session-assurance.js";

describe("authMethodForPath", () => {
  it("names how the endpoint that creates a session proved the user", () => {
    expect(authMethodForPath("/sign-in/email")).toBe("password");
    expect(authMethodForPath("/two-factor/verify-totp")).toBe("password_totp");
    expect(authMethodForPath("/two-factor/verify-backup-code")).toBe("password_totp");
    expect(authMethodForPath("/passkey/verify-authentication")).toBe("passkey");
    expect(authMethodForPath("/oauth2/callback/:providerId")).toBe("oidc");
    expect(authMethodForPath("/oauth2/callback/microsoft")).toBe("oidc");
    expect(authMethodForPath("/admin/impersonate-user")).toBe("impersonation");
  });

  it("knows nothing about endpoints that only replace a session", () => {
    expect(authMethodForPath("/change-password")).toBeNull();
    expect(authMethodForPath("/two-factor/disable")).toBeNull();
    expect(authMethodForPath(undefined)).toBeNull();
  });
});

describe("authMethodForNewSession and stampAuthMethod", () => {
  it("lets the creating endpoint decide, otherwise keeps the replaced session's method", () => {
    expect(authMethodForNewSession("/two-factor/verify-totp", "password")).toBe("password_totp");
    expect(authMethodForNewSession("/change-password", "passkey")).toBe("passkey");
    expect(authMethodForNewSession(null, null)).toBeNull();
  });

  it("stamps a fresh password sign-in", () => {
    expect(stampAuthMethod({ userId: "u" }, { path: "/sign-in/email" })).toEqual({
      userId: "u",
      authMethod: "password",
    });
  });

  it("lets the enrolment endpoint override the method copied from the enrolling session", () => {
    // better-auth copies the old session's fields into the replacement; the
    // enrolment endpoint itself proves the second factor.
    expect(
      stampAuthMethod({ userId: "u", authMethod: "password" }, { path: "/two-factor/verify-totp" })
        .authMethod,
    ).toBe("password_totp");
  });

  it("inherits from the request's session when a password change issues a new one", () => {
    expect(
      stampAuthMethod(
        { userId: "u" },
        { path: "/change-password", context: { session: { session: { authMethod: "passkey" } } } },
      ).authMethod,
    ).toBe("passkey");
  });

  it("records nothing it cannot know", () => {
    expect(stampAuthMethod({ userId: "u" }, null).authMethod).toBeNull();
  });
});

describe("sessionAssurance", () => {
  it("trusts a passkey, password plus TOTP and Entra sign-in", () => {
    for (const authMethod of ["passkey", "password_totp", "oidc"]) {
      expect(sessionAssurance({ authMethod }, { twoFactorEnabled: false }), authMethod).toBe(
        "full",
      );
    }
  });

  it("confines a password alone to TOTP enrolment", () => {
    expect(sessionAssurance({ authMethod: "password" }, { twoFactorEnabled: false })).toBe(
      "totp_enrollment",
    );
    expect(sessionAssurance({ authMethod: "password" }, { twoFactorEnabled: null })).toBe(
      "totp_enrollment",
    );
  });

  it("discards a password session of an account that has TOTP by now", () => {
    expect(sessionAssurance({ authMethod: "password" }, { twoFactorEnabled: true })).toBe(
      "reauthenticate",
    );
  });

  it("discards sessions whose origin was never recorded", () => {
    expect(sessionAssurance({ authMethod: null }, { twoFactorEnabled: true })).toBe(
      "reauthenticate",
    );
    expect(sessionAssurance({ authMethod: undefined }, { twoFactorEnabled: false })).toBe(
      "reauthenticate",
    );
    expect(sessionAssurance({ authMethod: "magic" }, { twoFactorEnabled: false })).toBe(
      "reauthenticate",
    );
  });

  it("treats a password alone as fully assured only with the demo bypass", () => {
    expect(
      sessionAssurance(
        { authMethod: "password" },
        { twoFactorEnabled: false },
        { demoPasswordBypass: true },
      ),
    ).toBe("full");
  });

  it("leaves every other password session exactly as before when the bypass is off", () => {
    expect(
      sessionAssurance(
        { authMethod: "password" },
        { twoFactorEnabled: false },
        { demoPasswordBypass: false },
      ),
    ).toBe("totp_enrollment");
    expect(
      sessionAssurance(
        { authMethod: "password" },
        { twoFactorEnabled: true },
        { demoPasswordBypass: false },
      ),
    ).toBe("reauthenticate");
    // Passing no options at all is identical to explicitly passing false.
    expect(sessionAssurance({ authMethod: "password" }, { twoFactorEnabled: false })).toBe(
      "totp_enrollment",
    );
  });

  it("never lets the bypass override a strong method or grant more than 'full'", () => {
    expect(
      sessionAssurance(
        { authMethod: "passkey" },
        { twoFactorEnabled: false },
        {
          demoPasswordBypass: true,
        },
      ),
    ).toBe("full");
    expect(
      sessionAssurance(
        { authMethod: "magic" },
        { twoFactorEnabled: false },
        {
          demoPasswordBypass: true,
        },
      ),
    ).toBe("reauthenticate");
  });
});

describe("isPathAllowed", () => {
  it("lets a full session go anywhere", () => {
    expect(isPathAllowed("full", "/passkey/generate-register-options")).toBe(true);
  });

  it("lets an enrolling session enrol, look and leave, but never register a passkey", () => {
    for (const path of [
      "/get-session",
      "/sign-out",
      "/two-factor/enable",
      "/two-factor/get-totp-uri",
      "/two-factor/verify-totp",
    ]) {
      expect(isPathAllowed("totp_enrollment", path), path).toBe(true);
    }
    for (const path of [
      "/passkey/generate-register-options",
      "/passkey/verify-registration",
      "/change-password",
      "/update-user",
      "/list-sessions",
      "/organization/set-active",
      "/two-factor/disable",
    ]) {
      expect(isPathAllowed("totp_enrollment", path), path).toBe(false);
    }
  });

  it("lets a discarded session only read that it is gone, or sign in anew", () => {
    expect(isPathAllowed("reauthenticate", "/get-session")).toBe(true);
    expect(isPathAllowed("reauthenticate", "/sign-in/email")).toBe(true);
    expect(isPathAllowed("reauthenticate", "/two-factor/enable")).toBe(false);
  });

  it("keeps every sign-in path open whatever cookie is still around", () => {
    expect(isSignInPath("/sign-in/email")).toBe(true);
    expect(isSignInPath("/passkey/verify-authentication")).toBe(true);
    expect(isSignInPath("/oauth2/callback/microsoft")).toBe(true);
    expect(isSignInPath("/get-session")).toBe(false);
  });
});

describe("providerAdminRevocationTarget", () => {
  it("spots demotion, ban and removal", () => {
    expect(providerAdminRevocationTarget("/admin/set-role", { userId: "u", role: "user" })).toBe(
      "u",
    );
    expect(providerAdminRevocationTarget("/admin/ban-user", { userId: "u" })).toBe("u");
    expect(providerAdminRevocationTarget("/admin/remove-user", { userId: "u" })).toBe("u");
    expect(
      providerAdminRevocationTarget("/admin/update-user", { userId: "u", data: { role: "user" } }),
    ).toBe("u");
    expect(
      providerAdminRevocationTarget("/admin/update-user", { userId: "u", data: { banned: true } }),
    ).toBe("u");
  });

  it("ignores changes that keep the role", () => {
    expect(
      providerAdminRevocationTarget("/admin/set-role", { userId: "u", role: ["user", "admin"] }),
    ).toBeNull();
    expect(
      providerAdminRevocationTarget("/admin/update-user", { userId: "u", data: { name: "N" } }),
    ).toBeNull();
    expect(providerAdminRevocationTarget("/admin/unban-user", { userId: "u" })).toBeNull();
    expect(providerAdminRevocationTarget("/admin/ban-user", {})).toBeNull();
  });
});

describe("wouldRemoveLastProviderAdmin", () => {
  const admin = (id: string, banned = false) => ({ id, role: "admin", banned });

  it("protects the only active provider admin", () => {
    expect(wouldRemoveLastProviderAdmin("a", [admin("a"), admin("b", true)])).toBe(true);
  });

  it("allows it while another active admin remains, and for non-admins", () => {
    expect(wouldRemoveLastProviderAdmin("a", [admin("a"), admin("b")])).toBe(false);
    expect(wouldRemoveLastProviderAdmin("c", [admin("a")])).toBe(false);
    expect(
      wouldRemoveLastProviderAdmin("a", [
        admin("a"),
        { id: "b", role: "user,admin", banned: null },
      ]),
    ).toBe(false);
  });
});
