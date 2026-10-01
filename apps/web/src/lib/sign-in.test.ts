import authEn from "@restow/i18n/resources/en/auth.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { demoCredentialsOf, loginReturnPath, microsoftErrorKey, signInErrorKey } from "./sign-in";

type Tree = { [key: string]: string | Tree };

function exists(key: string): boolean {
  let node: string | Tree | undefined = authEn as Tree;
  for (const segment of key.split(".")) {
    node = typeof node === "object" ? node[segment] : undefined;
  }
  return typeof node === "string";
}

const failure = (status: number, code?: string) => ({ status, code, statusText: "" });

describe("signInErrorKey", () => {
  it("names network trouble and lockouts in every phase", () => {
    expect(signInErrorKey(failure(0), "password")).toBe("login.error.network");
    expect(signInErrorKey(failure(503), "totp")).toBe("login.error.network");
    expect(signInErrorKey(failure(429), "backupCode")).toBe("login.error.locked");
    expect(signInErrorKey(failure(401, "ACCOUNT_TEMPORARILY_LOCKED"), "totp")).toBe(
      "login.error.locked",
    );
  });

  it("explains a wrong second factor by the step it came from", () => {
    expect(signInErrorKey(failure(401, "INVALID_CODE"), "totp")).toBe("login.error.invalidTotp");
    expect(signInErrorKey(failure(401, "INVALID_BACKUP_CODE"), "backupCode")).toBe(
      "login.error.invalidBackupCode",
    );
  });

  it("tells a passkey account that its password alone is not accepted", () => {
    expect(signInErrorKey(failure(403, "PASSKEY_SIGN_IN_REQUIRED"), "password")).toBe(
      "login.error.passkeyRequired",
    );
    expect(signInErrorKey(failure(401, "INVALID_EMAIL_OR_PASSWORD"), "password")).toBe(
      "login.error.invalidCredentials",
    );
  });

  it("keeps passkey and Microsoft failures apart", () => {
    expect(signInErrorKey(failure(400, "ERROR_CEREMONY_ABORTED"), "passkey")).toBe(
      "login.error.passkeyCancelled",
    );
    expect(signInErrorKey(failure(400), "passkey")).toBe("login.error.passkeyFailed");
    expect(signInErrorKey(failure(400), "microsoft")).toBe("login.error.microsoftFailed");
  });
});

describe("microsoftErrorKey", () => {
  it("maps the callback error codes to explanations", () => {
    expect(microsoftErrorKey("access_denied")).toBe("login.error.microsoftCancelled");
    expect(microsoftErrorKey("account_not_linked")).toBe("login.error.microsoftNotLinked");
    expect(microsoftErrorKey("email_not_found")).toBe("login.error.microsoftNoEmail");
    expect(microsoftErrorKey("state_mismatch")).toBe("login.error.microsoftFailed");
  });
});

describe("login messages", () => {
  it("exist for every key the mapping can produce", () => {
    const keys = [
      ...["password", "totp", "backupCode", "passkey", "microsoft"].flatMap((phase) =>
        [0, 400, 401, 403, 429].flatMap((status) =>
          ["", "PASSKEY_SIGN_IN_REQUIRED", "ERROR_CEREMONY_ABORTED"].map((code) =>
            signInErrorKey(failure(status, code), phase as Parameters<typeof signInErrorKey>[1]),
          ),
        ),
      ),
      ...["access_denied", "account_not_linked", "email_not_found", "other"].map(microsoftErrorKey),
    ];
    for (const key of new Set(keys)) {
      expect(exists(key), key).toBe(true);
    }
  });
});

describe("loginReturnPath", () => {
  it("keeps the deep link for the way back", () => {
    expect(loginReturnPath("/restore?snapshot=1")).toBe(
      "/login?redirect=%2Frestore%3Fsnapshot%3D1",
    );
    expect(loginReturnPath(null)).toBe("/login");
  });
});

describe("demoCredentialsOf", () => {
  it("is ready only when demo mode is on and both credentials are set", () => {
    expect(
      demoCredentialsOf({ enabled: true, email: "demo@example.org", password: "swordfish" }),
    ).toEqual({ email: "demo@example.org", password: "swordfish" });
  });

  it("is null when demo mode is off, unset, or a credential is missing", () => {
    expect(demoCredentialsOf(undefined)).toBeNull();
    expect(
      demoCredentialsOf({ enabled: false, email: "demo@example.org", password: "swordfish" }),
    ).toBeNull();
    expect(demoCredentialsOf({ enabled: true, email: null, password: "swordfish" })).toBeNull();
    expect(
      demoCredentialsOf({ enabled: true, email: "demo@example.org", password: null }),
    ).toBeNull();
  });
});
