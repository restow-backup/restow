import { describe, expect, it } from "vitest";
import { demoRequestAllowed } from "../../lib/demo.js";
import { maskEmail, revealSetPasswordToken, setPasswordPath } from "./service.js";

describe("maskEmail", () => {
  it("keeps only the first local-part character and the whole domain", () => {
    expect(maskEmail("jane.doe@contoso.example")).toBe("j*******@contoso.example");
    expect(maskEmail("ab@contoso.example")).toBe("a***@contoso.example");
  });

  it("never reveals the address for malformed input", () => {
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("@contoso.example")).toBe("***");
  });
});

describe("setPasswordPath", () => {
  it("URL-encodes the token into the public route", () => {
    expect(setPasswordPath("abc123")).toBe("/accounts/set-password/abc123");
    expect(setPasswordPath("a/b c")).toBe("/accounts/set-password/a%2Fb%20c");
  });
});

describe("revealSetPasswordToken", () => {
  it("withholds the token once it was actually mailed to the account's own address", () => {
    expect(revealSetPasswordToken("sent", "raw-token")).toBeNull();
  });

  it("still hands the admin the token when there was no other way to deliver it", () => {
    expect(revealSetPasswordToken("not_configured", "raw-token")).toBe("raw-token");
    expect(revealSetPasswordToken("failed", "raw-token")).toBe("raw-token");
  });
});

describe("demo mode", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";
  const userId = "user-1";

  /** `demoRequestAllowed` is what the demo guard actually calls; no seed token, as a visitor never has one. */
  function allowed(method: string, path: string): boolean {
    return demoRequestAllowed({
      method,
      path,
      seedTokenHeader: undefined,
      configuredSeedToken: undefined,
    });
  }

  it("refuses every accounts write", () => {
    expect(allowed("POST", `/api/v1/tenants/${tenantId}/accounts`)).toBe(false);
    expect(allowed("POST", `/api/v1/tenants/${tenantId}/accounts/${userId}/reissue`)).toBe(false);
    expect(allowed("POST", "/api/v1/accounts/set-password")).toBe(false);
  });

  it("still allows reading pending accounts and checking a set-password link", () => {
    expect(allowed("GET", `/api/v1/tenants/${tenantId}/accounts`)).toBe(true);
    expect(allowed("GET", "/api/v1/accounts/set-password/some-token")).toBe(true);
  });
});
